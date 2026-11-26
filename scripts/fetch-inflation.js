#!/usr/bin/env node
"use strict";
/*
 * fetch-inflation.js
 *
 * Downloads the monthly harmonised consumer prices (HICP, all items) of Austria and Hungary from Eurostat (and, if Eurostat does not answer, from FRED's copy of
 * the same series) and saves them in data/inflation.json. Since 26 Nov 2026 it also saves the prices by group (the 13 divisions of COICOP 2018 and their
 * weights, Eurostat) in data/inflation-groups.json, for your own inflation rate on the Spending area's Inflation tab. It is made by the Austria Tax Tracker and
 * runs as a scheduled job of this repository (see .github/workflows/fetch-inflation.yml). It needs Node 18 or newer and no packages.
 *
 * The figures are only used for the "real" (inflation-adjusted) returns of the Performance tab and for your own inflation rate. They are never used for the tax.
 * A country is saved only when every check passes: a known layout, every month there and a number, and the new figures agree with the ones the tracker already
 * has for the months they share (a changed base or definition shows there). Otherwise the file keeps what it had for that country and the job fails, so that
 * GitHub tells you. Nothing is guessed, filled in or rescaled.
 *
 * Usage: node scripts/fetch-inflation.js [data/inflation.json] [data/inflation-groups.json]
 */

// ---- the inflation reader, the same one the tracker uses (src/perf/inflation.js) ------------------------------------------------
const Inflation = (function () {
  const module = { exports: {} };
/*
 * Inflation: the price level of a country on any day, and the factor that turns a euro amount of one day into the euros of the last day of the data
 * ("today's euros"), for the real returns of the Performance tab (architecture 35). Pure functions; nothing here is a tax figure and nothing here
 * feeds the tax.
 *
 * The rules, in the order they matter:
 *  1. The data is a monthly price level per country (HICP, all items, 2025 = 100): { start: "YYYY-MM", values: [...] }, one value for each month with
 *     no gap. The page has a baseline (inflation-data.js) and may read a newer file from the repository (merge: a month the file has replaces the
 *     baseline's; a file that does not fit the baseline is not used, so a changed base or definition cannot slip in).
 *  2. A day has a level (level): the level of a month is put on the 15th, between two 15ths the level is interpolated geometrically (a constant
 *     monthly rate), before the first and from the 15th of the last known month on it is flat. The page says so: nothing is guessed forward.
 *  3. Austria is the HICP of Austria. Hungary is the HICP of Hungary divided by the forint per euro of the month (the monthly mean of the ECB rates the
 *     page holds, interpolated the same way): the euro price of the Hungarian basket, what a euro buys at Hungarian prices. "Where I lived" is Hungary
 *     until the day before the move and Austria from the day of the move, scaled so that there is no jump on that day.
 *  4. The factor of a day is F(day) = P(end) / P(day): older euros are worth more in today's money. A euro amount of that day times F is its real amount.
 *     The same factor is used for every amount of that day (a value, a purchase, a dividend), so a sub-period return in real terms is exactly the
 *     nominal one times P(start) / P(end of the period) (Fisher), and a money-weighted return is the rate of the deflated flows.
 *
 * Nothing that is passed in is changed.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Inflation = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "inflation-0.2.0";
  const DAY = 86400000;
  const BASE = "2025=100";
  /** The day he moved to Austria (the tax engine's relocation date); Hungary before it, Austria from it. */
  const MOVE = "2020-01-28";
  const COUNTRIES = [
    { key: "AT", label: "Austria", text: "the prices of Austria (HICP)" },
    { key: "HU", label: "Hungary", text: "the prices of Hungary (HICP), in euro" },
    { key: "LIVED", label: "Where I lived", text: "Hungary until the move to Austria (28 Jan 2020), Austria since" },
  ];

  const monthIdx = (dn) => {
    const t = new Date(dn * DAY);
    return t.getUTCFullYear() * 12 + t.getUTCMonth();
  };
  const midDn = (mi) => Math.round(Date.UTC(Math.floor(mi / 12), mi % 12, 15) / DAY);
  const isoToDn = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY) : null;
  };
  const parseMonth = (s) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(s));
    if (!m) return null;
    const mo = Number(m[2]);
    return mo >= 1 && mo <= 12 ? Number(m[1]) * 12 + mo - 1 : null;
  };
  const monthText = (mi) => Math.floor(mi / 12) + "-" + String((mi % 12) + 1).padStart(2, "0");

  /** A series { start, values } made ready for level(): { i0, values, logs, last (text of the last month) } or null when it cannot be used. */
  function prepare(s) {
    if (!s || typeof s !== "object" || !Array.isArray(s.values) || !s.values.length) return null;
    const i0 = parseMonth(s.start);
    if (i0 === null) return null;
    const values = [];
    for (const v of s.values) {
      const x = Number(v);
      if (!(x > 0) || !Number.isFinite(x)) return null; // a month without a usable value: the whole series is refused, nothing is bridged
      values.push(x);
    }
    return { i0, values, logs: values.map(Math.log), first: monthText(i0), last: monthText(i0 + values.length - 1) };
  }

  /** The level of a prepared series on a day number: geometric between the 15ths, flat before the first 15th and from the last one on. */
  function level(p, dn) {
    const n = p.values.length;
    const rel = monthIdx(dn) - p.i0;
    const k = dn >= midDn(p.i0 + rel) ? rel : rel - 1; // the 15th at or before the day
    if (k < 0) return p.values[0];
    if (k >= n - 1) return p.values[n - 1];
    const a = midDn(p.i0 + k);
    const b = midDn(p.i0 + k + 1);
    const t = (dn - a) / (b - a);
    return Math.exp((1 - t) * p.logs[k] + t * p.logs[k + 1]);
  }

  // ---------------------------------------------------------------- the data: the baseline and a newer file

  /** What a downloaded file must look like: { version, base, AT: { start, values }, HU: { start, values } }. Returns { ok, data } or { ok: false, reason }. */
  function parseFile(text) {
    let j;
    try {
      j = JSON.parse(String(text));
    } catch (e) {
      return { ok: false, reason: "The inflation file is not readable (it is not JSON)." };
    }
    if (!j || typeof j !== "object") return { ok: false, reason: "The inflation file is empty." };
    if (j.base !== BASE) return { ok: false, reason: "The inflation file is on another base (" + String(j.base).slice(0, 20) + ", the page expects " + BASE + "). It is not used." };
    const data = { version: j.version, base: j.base, generated: typeof j.generated === "string" ? j.generated.slice(0, 10) : "", source: typeof j.source === "string" ? j.source.slice(0, 200) : "" };
    for (const c of ["AT", "HU"]) {
      if (j[c] === undefined) continue;
      if (!prepare(j[c])) return { ok: false, reason: "The inflation file has a gap or an unusable value for " + c + ". It is not used." };
      data[c] = { start: j[c].start, values: j[c].values.map(Number) };
    }
    if (!data.AT && !data.HU) return { ok: false, reason: "The inflation file has neither Austria nor Hungary." };
    return { ok: true, data };
  }

  const MEDIAN_LIMIT = 0.003; // the median difference of the months a file shares with the baseline
  const MAX_LIMIT = 0.01; // the largest difference of one of those months (the monthly job's own limit)
  const MAX_STEP = 0.1; // the largest move of a month after the baseline from the month before (the largest in the baseline since 1996: 3.8 %)

  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };

  /**
   * The baseline with a newer file on top: for each country the months of the file replace those of the baseline and the series goes on where the file
   * goes on. A file series that leaves a gap after the baseline, or that does not fit it (the median difference over the months both have is more than
   * 0.3 %, one of those months is more than 1 % off, or fewer than 6 months in common), or whose months after the baseline move by more than 10 % from one
   * month to the next, is left out for that country and says why (the 1 % and the 10 % since the review of 24 Nov 2026, RR-2: the median alone let a file
   * with single wrong months through; the monthly job refuses the same files). Returns { AT, HU, asOf, used: { AT: "baseline"|"file", HU }, notes: [text] }.
   */
  function merge(baseline, file) {
    const out = { AT: null, HU: null, asOf: baseline && baseline.asOf ? baseline.asOf : "", used: { AT: "baseline", HU: "baseline" }, notes: [] };
    for (const c of ["AT", "HU"]) {
      const b = baseline ? prepare(baseline[c]) : null;
      const f = file && file[c] ? prepare(file[c]) : null;
      if (!b && !f) continue;
      if (!f) {
        out[c] = { start: baseline[c].start, values: baseline[c].values.slice() };
        continue;
      }
      if (!b) {
        out[c] = { start: file[c].start, values: file[c].values.map(Number) };
        out.used[c] = "file";
        continue;
      }
      const lo = Math.max(b.i0, f.i0);
      const hi = Math.min(b.i0 + b.values.length - 1, f.i0 + f.values.length - 1);
      const diffs = [];
      for (let i = lo; i <= hi; i++) diffs.push(Math.abs(f.values[i - f.i0] / b.values[i - b.i0] - 1));
      const gap = f.i0 > b.i0 + b.values.length;
      const worst = diffs.length ? Math.max(...diffs) : 0;
      // a month after the last one of the baseline has nothing to be compared with: it may not move more than MAX_STEP from the month before it
      let jump = -1;
      const bEnd = b.i0 + b.values.length - 1;
      for (let i = Math.max(bEnd + 1, f.i0 + 1); i <= f.i0 + f.values.length - 1; i++) {
        if (Math.abs(f.values[i - f.i0] / f.values[i - 1 - f.i0] - 1) > MAX_STEP) {
          jump = i;
          break;
        }
      }
      if (gap || diffs.length < 6 || median(diffs) > MEDIAN_LIMIT || worst > MAX_LIMIT || jump >= 0) {
        out[c] = { start: baseline[c].start, values: baseline[c].values.slice() };
        const why = gap
          ? "a gap before its first month"
          : diffs.length < 6
            ? "fewer than 6 months in common"
            : median(diffs) > MEDIAN_LIMIT
              ? "it differs by " + (median(diffs) * 100).toFixed(2) + " % on average"
              : worst > MAX_LIMIT
                ? "one month differs by " + (worst * 100).toFixed(2) + " %, more than " + MAX_LIMIT * 100 + " %"
                : monthText(jump) + " moves by more than " + MAX_STEP * 100 + " % from the month before";
        out.notes.push((c === "AT" ? "Austria" : "Hungary") + ": the file does not fit the baseline (" + why + "), the baseline is used.");
        continue;
      }
      const i0 = Math.min(b.i0, f.i0);
      const i1 = Math.max(b.i0 + b.values.length - 1, f.i0 + f.values.length - 1);
      const values = [];
      for (let i = i0; i <= i1; i++) values.push(i >= f.i0 && i < f.i0 + f.values.length ? f.values[i - f.i0] : b.values[i - b.i0]);
      out[c] = { start: monthText(i0), values };
      if (i1 > b.i0 + b.values.length - 1 || diffs.some((d) => d > 0)) out.used[c] = "file";
    }
    if (file && file.generated && out.used.AT === "file") out.asOf = file.generated;
    else if (file && file.generated && out.used.HU === "file") out.asOf = file.generated;
    return out;
  }

  // ---------------------------------------------------------------- the price level of a choice, and the factor

  /**
   * The deflator for a choice of country.
   *  data      { AT, HU } (merge's result or the baseline)
   *  country   "AT" | "HU" | "LIVED"
   *  endDn     the day whose euros everything is expressed in (the last day of the data)
   *  o         { move: "YYYY-MM-DD" (default the day he moved), eurhuf: { start, values } (forint per euro, monthly mean; Hungary and "where I lived" need it),
   *              firstDn: the first day of the data (a series that starts after it is refused: its flat start would be a guess) }
   * Returns { ok, country, factor(dn), level(dn), last: "YYYY-MM" (the last month the choice knows), flatFrom: text, reason } where factor(dn) = P(end)/P(dn).
   */
  function deflator(data, country, endDn, o) {
    const opt = o || {};
    const fail = (reason, code) => ({ ok: false, country, reason, code });
    if (!Number.isFinite(endDn)) return fail("There is no last day to express the euros in.", "NO_END");
    const at = data ? prepare(data.AT) : null;
    const hu = data ? prepare(data.HU) : null;
    const hf = opt.eurhuf ? prepare(opt.eurhuf) : null;
    const moveDn = isoToDn(opt.move || MOVE);
    const firstMi = Number.isFinite(opt.firstDn) ? monthIdx(opt.firstDn) : null;
    const late = (p) => firstMi !== null && p.i0 > firstMi; // the series starts after the first day of the data
    let P;
    let last;
    if (country === "AT") {
      if (!at) return fail("There are no Austrian prices.", "NO_AT");
      if (late(at)) return fail("The Austrian prices start in " + at.first + ", after your first transaction.", "TOO_SHORT");
      P = (dn) => level(at, dn);
      last = at.last;
    } else if (country === "HU" || country === "LIVED") {
      if (!hu) return fail("There are no Hungarian prices.", "NO_HU");
      if (!hf) return fail("The euro price of the Hungarian basket needs the forint rates of the ECB (load the ECB rate file for HUF, step 4 of the Data tab).", "NO_HUF");
      const needHu = country === "HU" || (moveDn !== null && Number.isFinite(opt.firstDn) && opt.firstDn < moveDn);
      if (needHu && late(hu)) return fail("The Hungarian prices start in " + hu.first + ", after your first transaction.", "TOO_SHORT");
      if (needHu && late(hf)) return fail("The forint rates of the ECB start in " + hf.first + ", after your first transaction.", "TOO_SHORT");
      const hue = (dn) => level(hu, dn) / level(hf, dn);
      if (country === "HU") {
        P = hue;
        last = hu.last < hf.last ? hu.last : hf.last;
      } else {
        if (!at) return fail("There are no Austrian prices.", "NO_AT");
        if (moveDn === null) return fail("The day of the move is not a date.", "BAD_MOVE");
        if (late(at)) return fail("The Austrian prices start in " + at.first + ", after your first transaction.", "TOO_SHORT");
        const k = level(at, moveDn) / hue(moveDn); // joins the two without a jump on the day of the move
        P = (dn) => (dn < moveDn ? k * hue(dn) : level(at, dn));
        last = at.last;
      }
    } else return fail("Unknown choice of prices.", "BAD_COUNTRY");
    const pEnd = P(endDn);
    if (!(pEnd > 0) || !Number.isFinite(pEnd)) return fail("The price level of the last day cannot be worked out.", "BAD_END");
    // a day is worked out once: the factor is asked for many times a day
    const memo = new Map();
    const factor = (dn) => {
      let f = memo.get(dn);
      if (f === undefined) {
        f = pEnd / P(dn);
        memo.set(dn, f);
      }
      return f;
    };
    const lastMi = parseMonth(last);
    const endMi = monthIdx(endDn);
    return { ok: true, country, factor, level: P, last, flat: endMi > lastMi, flatFrom: last, reason: "" };
  }

  /** The text for the screen under a real figure: which prices, and what is flat. */
  function describe(d) {
    if (!d || !d.ok) return d && d.reason ? d.reason : "";
    const c = COUNTRIES.find((x) => x.key === d.country);
    const month = (s) => {
      const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return names[Number(s.slice(5, 7)) - 1] + " " + s.slice(0, 4);
    };
    return "Real: in today\u2019s euros, with " + (c ? c.text : d.country) + (d.flat ? "; prices after " + month(d.last) + " are not known yet and are held flat" : "") + ".";
  }

  /** The months a series has: { first, last, n } or null. */
  function span(s) {
    const p = prepare(s);
    return p ? { first: p.first, last: p.last, n: p.values.length } : null;
  }

  /**
   * The monthly mean of a daily rate, for the forint per euro. rateOn(iso) => { ok, rate, lagDays } (the ECB ledger's rateOn); only the days on which the ECB
   * published (lagDays 0) count, so a month is the mean of its published rates. Months from the first to the last day it has. Returns { start, values } or null.
   */
  function monthlyMeans(rateOn, firstIso, lastIso) {
    const d0 = isoToDn(firstIso);
    const d1 = isoToDn(lastIso);
    if (d0 === null || d1 === null || d1 < d0) return null;
    const m0 = monthIdx(d0);
    const m1 = monthIdx(d1);
    const values = [];
    for (let mi = m0; mi <= m1; mi++) {
      const a = Math.max(d0, Math.round(Date.UTC(Math.floor(mi / 12), mi % 12, 1) / DAY));
      const b = Math.min(d1, Math.round(Date.UTC(Math.floor(mi / 12), (mi % 12) + 1, 0) / DAY));
      let sum = 0;
      let n = 0;
      for (let dn = a; dn <= b; dn++) {
        const r = rateOn(new Date(dn * DAY).toISOString().slice(0, 10));
        if (r && r.ok && r.lagDays === 0 && Number(r.rate) > 0) {
          sum += Number(r.rate);
          n++;
        }
      }
      if (!n) return null; // a month with no published rate: no series (the first and last months of a file can be short, never empty)
      values.push(sum / n);
    }
    return { start: monthText(m0), values };
  }

  return { VERSION, BASE, MOVE, COUNTRIES, parseFile, merge, prepare, level, deflator, describe, span, monthlyMeans, monthIdx, midDn, parseMonth, monthText, dayOf: isoToDn };
});

  return module.exports;
})();

// ---- the figures inside the tracker, the baseline the new ones are compared with (src/perf/inflation-data.js) --------------------
const InflationData = (function () {
  const module = { exports: {} };
/*
 * GENERATED by tools/inflation/make-baseline.js from the files in tools/inflation/. Do not edit by hand: change the files there and run the script again.
 *
 * InflationData: the price levels of Austria and Hungary that are inside the page (HICP, all items, monthly, 2025 = 100). The page reads a newer file from the
 * repository when there is one (src/app/inflation-update.js); this is what it uses without one. Real returns only (architecture 35); nothing here feeds the tax.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InflationData = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  return {
    version: "inflation-data-1",
    asOf: "2026-11-24",
    base: "2025=100",
    sources: {
      AT: "Eurostat HICP all items: OECD copy to 2023-11, Statistik Austria from 2023-12 (2015 base put on 2025 = 100 by 100/139.01)",
      HU: "Eurostat HICP all items via FRED CP0000HUM086NEST (2025 = 100)",
    },
    AT: { start: "1996-01", values: [51.32,51.471,51.629,51.572,51.521,51.68,51.73,51.572,51.572,51.68,51.831,51.989,51.939,52.198,52.248,52.198,52.198,52.198,52.198,52.248,52.198,52.248,52.399,52.507,52.557,52.708,52.766,52.816,52.708,52.608,52.608,52.608,52.507,52.608,52.658,52.766,52.708,52.816,52.867,52.867,52.917,52.708,52.766,52.867,52.816,53.018,53.176,53.644,53.435,53.845,53.895,53.795,53.744,53.953,53.795,53.845,54.054,54.205,54.413,54.622,54.644,54.823,54.91,55.183,55.291,55.363,55.284,55.147,55.356,55.464,55.442,55.586,55.679,55.773,55.845,56.097,56.197,56.19,56.097,56.248,56.248,56.37,56.37,56.521,56.622,56.723,56.874,56.816,56.744,56.751,56.679,56.838,56.989,56.974,57.118,57.276,57.312,57.564,57.794,57.722,57.931,58.039,57.866,58.089,58.039,58.312,58.427,58.715,58.701,58.895,59.176,59.046,59.053,59.204,59.082,59.176,59.514,59.542,59.442,59.614,59.593,59.794,59.953,60.298,60.305,60.312,60.219,60.406,60.319,60.283,60.363,60.586,60.629,60.816,61.104,61.362,61.47,61.47,61.427,61.449,61.6,62.01,62.305,62.686,62.506,62.701,63.269,63.434,63.78,63.952,63.765,63.65,63.895,63.873,63.708,63.607,63.233,63.542,63.657,63.772,63.816,63.751,63.492,63.751,63.88,63.952,64.082,64.276,64.01,64.139,64.808,64.945,64.909,64.902,64.571,64.744,64.995,65.233,65.233,65.679,65.636,66.161,66.966,67.362,67.305,67.283,67.038,67.146,67.549,67.7,67.743,67.909,67.535,67.894,68.736,68.93,68.794,68.786,68.434,68.679,69.455,69.671,69.722,69.887,69.448,69.686,70.355,70.369,70.455,70.333,69.887,70.045,70.722,70.714,70.736,71.275,70.506,70.714,71.376,71.47,71.534,71.527,71.052,71.067,71.714,71.721,71.822,71.851,70.844,71.038,72.045,72.139,72.261,72.225,71.858,71.743,72.117,72.189,72.167,72.621,71.829,71.765,72.527,72.606,72.685,72.685,72.29,72.175,72.894,73.175,73.225,73.772,73.311,73.47,74.052,74.29,74.246,74.139,73.714,73.707,74.743,74.901,75.009,75.491,74.714,74.901,75.57,75.743,75.822,75.865,75.412,75.405,76.333,76.7,76.714,76.786,75.98,75.973,76.836,77.059,77.102,77.052,76.441,76.498,77.275,77.491,77.635,78.189,77.628,77.635,78.052,78.232,77.556,77.872,77.793,77.563,78.174,78.361,78.505,78.98,78.448,78.699,79.627,79.728,79.879,80.052,79.98,80.016,80.735,81.311,81.735,81.973,81.958,83.016,84.886,85.426,86.037,87.037,87.526,87.418,89.619,90.706,90.864,90.612,91.439,92.188,92.713,93.432,93.562,93.821,93.641,93.943,94.777,95.13,95.295,95.749,95.389,95.864,96.482,96.59,96.676,96.712,96.36,96.23,96.489,96.849,97.115,97.777,98.648,99.144,99.468,99.734,99.561,99.827,99.906,100.223,100.259,100.755,100.978,101.496,100.68,101.45,102.62,103.15,103.24,102.99,102.59,103.16,103.89,104.26] },
    HU: { start: "1996-01", values: [16.85,17.25,17.52,17.82,18.2,18.34,18.42,18.47,18.73,18.98,19.15,19.33,20.06,20.5,20.86,21.14,21.43,21.81,21.78,21.81,22.12,22.38,22.67,22.93,23.62,24.04,24.33,24.59,24.88,24.93,24.84,24.73,24.88,25.12,25.17,25.24,25.9,26.25,26.56,26.85,27.03,27.14,27.34,27.45,27.6,27.76,27.91,28.13,28.55,28.88,29.15,29.39,29.53,29.68,30.03,30.15,30.52,30.72,30.84,30.93,31.41,31.85,32.14,32.4,32.7,32.79,32.84,32.77,32.93,33.02,33.03,33.04,33.48,33.81,34.06,34.35,34.52,34.35,34.31,34.21,34.44,34.63,34.61,34.65,35.1,35.38,35.68,35.69,35.72,35.86,35.94,35.83,36.03,36.3,36.54,36.59,37.43,37.86,38.06,38.17,38.51,38.52,38.53,38.41,38.44,38.62,38.65,38.62,38.92,39.13,39.32,39.6,39.84,39.95,39.93,39.74,39.81,39.82,39.89,39.87,39.87,40.02,40.25,40.55,40.99,41.1,41.18,41.6,42.16,42.35,42.45,42.5,43.23,43.61,43.87,44.07,44.43,44.6,44.6,44.57,44.88,45.26,45.5,45.64,46.41,46.52,46.81,47.07,47.5,47.56,47.71,47.42,47.39,47.57,47.35,47.17,47.52,47.89,48.13,48.56,49.3,49.33,50.03,49.77,49.64,49.56,49.82,49.73,50.46,50.58,50.9,51.34,51.7,51.79,51.81,51.57,51.49,51.7,51.8,52.02,52.48,52.69,53.23,53.61,53.71,53.59,53.44,53.37,53.4,53.68,54.01,54.14,55.42,55.73,56.18,56.63,56.59,56.59,56.49,56.56,56.82,56.91,56.87,56.89,56.98,57.34,57.49,57.65,57.58,57.72,57.48,57.45,57.71,57.53,57.09,57.23,57.44,57.49,57.61,57.55,57.59,57.65,57.75,57.61,57.41,57.36,57.14,56.75,56.66,56.95,57.31,57.54,57.95,58.05,58.04,57.69,57.35,57.5,57.49,57.29,57.21,57.13,57.21,57.7,57.86,57.98,57.88,57.65,57.74,58.12,58.09,58.32,58.56,58.76,58.75,59,59.09,59.12,59.16,59.18,59.22,59.4,59.59,59.6,59.79,59.89,59.95,60.39,60.79,60.99,61.19,61.22,61.41,61.71,61.49,61.27,61.44,61.78,62.22,62.77,63.23,63.09,63.22,63.17,63.18,63.57,63.61,63.78,64.33,64.51,64.66,64.36,64.64,64.91,65.68,65.67,65.36,65.48,65.37,65.58,66.17,66.65,67.16,67.69,68.06,68.36,68.74,68.9,68.99,69.78,70.25,70.43,71.43,72.22,72.95,74.17,75.44,76.97,78.84,81.74,83.25,85.03,86.5,88.03,90.14,90.87,91.64,92.3,91.97,92.29,92.62,93.34,93.41,93.18,93.17,92.87,93.48,94.15,94.92,95.62,95.6,95.61,96.41,96.48,96.24,96.31,96.81,97.32,98.79,99.51,99.52,99.63,99.86,100.04,100.48,100.52,100.34,100.37,100.4,100.52,101.11,101.13,101.64,102.19,102.15,102.15,102.13,102.31,102.43] },
  };
});

  return module.exports;
})();

// ---- the job (src/inflation/job.js) --------------------------------------------------------------------------------------------
const InflationJob = (function () {
  const module = { exports: {} };
const require = (p) => { if (p === "../perf/inflation.js") return Inflation; if (p === "../perf/inflation-data.js") return InflationData; throw new Error("unexpected require " + p); };
/*
 * InflationJob: the monthly job that downloads the harmonised consumer prices (HICP, all items) of Austria and Hungary and keeps the inflation file of the
 * owner's own GitHub repository (data/inflation.json) up to date (architecture 35.7).
 *
 * It runs as a scheduled job of the owner's repository, not in the tracker page. The tracker reads the file this job writes (next to the page, on the same
 * site, or from the repository itself) and uses it for the real returns of the Performance tab. Nothing here touches the tax.
 *
 * Where the figures come from, in this order, for each country:
 *   1. Eurostat's dissemination interface, dataset prc_hicp_minr (the monthly index on 2025 = 100, unit I25). Since January 2026 Eurostat uses the classification
 *      ECOICOP 2 and the old dataset (prc_hicp_midx, base 2015) stopped at December 2025, so the all-items code is not assumed: a first small request lists the
 *      codes of the dataset and the job picks TOTAL or CP00 (or the one labelled "all-items"), then asks for that one.
 *   2. FRED's csv of Eurostat's series (CP0000ATM086NEST, CP0000HUM086NEST), if Eurostat does not answer or answers in a layout the job does not know. FRED
 *      showed these two on 2015 = 100 until the end of 2025 and on 2025 = 100 from 1996 on in 2026 (their data pages say "Index 2025=100"); a copy that is on another
 *      base fails the comparison with the known figures below and is refused, never rescaled.
 *
 * What it saves: the whole series of both countries from 1996 (the baseline inside the page, the file already saved and the new months on top), values to
 * three decimals, twelve to a line so that a month added is a small change in the repository.
 *
 * Rules of this module:
 *  - The network, the clock and the pauses are passed in, so the tests run it without any of them.
 *  - A country is updated only if every check passes: the answer is read in a known layout; every month is there and is a number; over the months that the
 *    new figures share with what is already known they agree (median within 0.3 %, none beyond 1 %: a changed base or definition shows here); the newest month is not
 *    older than the one already saved and not more than three months before today. A country that fails keeps what it had, the job says why and ends with an
 *    error so that GitHub tells the owner; the other country is still saved.
 *  - Nothing is guessed, filled in or repaired.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../perf/inflation.js"), require("../perf/inflation-data.js"));
  else root.InflationJob = factory(root.Inflation, root.InflationData);
})(typeof self !== "undefined" ? self : this, function (Inflation, Baseline) {
  "use strict";

  const VERSION = "inflationjob-0.1.0";
  const EUROSTAT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/";
  const DATASET = "prc_hicp_minr";
  const UNIT = "I25"; // 2025 = 100
  const ITEM_CODES = ["TOTAL", "CP00"]; // the all-items code, in the order they are tried
  const FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";
  const FRED_IDS = { AT: "CP0000ATM086NEST", HU: "CP0000HUM086NEST" };
  const COUNTRIES = ["AT", "HU"];
  const SINCE = "2024-01"; // what is asked for: a stretch of figures that the baseline shares, to check against, and the newest months
  const MEDIAN_LIMIT = 0.003;
  const MAX_LIMIT = 0.01;
  const MIN_OVERLAP = 12;
  const REVISED_MIN = 0.0002; // a known month that differs by more than 0.02 % is called revised; less is the rounding of another source (the baseline holds months rescaled from the old 2015 base)
  const MAX_LAG_MONTHS = 3;
  const TRIES = 3;
  const BACKOFF_MS = [2000, 6000];
  const TIMEOUT_MS = 60000;
  const LIMIT_BYTES = 20 * 1000 * 1000;
  const USER_AGENT = "Mozilla/5.0 (compatible; AustriaTaxTracker-InflationJob/0.1)";
  const NAMES = { AT: "Austria", HU: "Hungary" };

  const clip = (s, n) => String(s === undefined || s === null ? "" : s).slice(0, n || 80);
  const mi = Inflation.parseMonth;
  const text = Inflation.monthText;

  // ---------------------------------------------------------------- reading Eurostat's answer (JSON-stat 2.0)

  /** The position of a category code in a dimension of a JSON-stat answer, or -1. */
  function posOf(dim, code) {
    const idx = dim && dim.category ? dim.category.index : null;
    if (Array.isArray(idx)) return idx.indexOf(code);
    if (idx && typeof idx === "object" && Object.prototype.hasOwnProperty.call(idx, code)) return Number(idx[code]);
    return -1;
  }
  /** The categories of a dimension, in order of their position: [{ code, label }]. */
  function categories(dim) {
    const idx = dim && dim.category ? dim.category.index : null;
    const labels = dim && dim.category && dim.category.label ? dim.category.label : {};
    let codes = [];
    if (Array.isArray(idx)) codes = idx.slice();
    else if (idx && typeof idx === "object") codes = Object.keys(idx).sort((a, b) => idx[a] - idx[b]);
    return codes.map((code) => ({ code, label: String(labels[code] === undefined ? "" : labels[code]) }));
  }

  function openStat(body) {
    let j;
    try {
      j = JSON.parse(String(body));
    } catch (e) {
      return { ok: false, error: "The answer is not JSON (" + clip(body, 40).replace(/\s+/g, " ") + ")." };
    }
    if (j && j.error) return { ok: false, error: "Eurostat answered with an error: " + clip(JSON.stringify(j.error), 160) };
    if (!j || !Array.isArray(j.id) || !Array.isArray(j.size) || j.id.length !== j.size.length || !j.dimension || typeof j.dimension !== "object") return { ok: false, error: "The answer is not a JSON-stat data set, its layout may have changed." };
    return { ok: true, j };
  }

  /** The all-items code and the unit of a first, small answer. Returns { ok, item, itemDim, error }. */
  function discover(body) {
    const o = openStat(body);
    if (!o.ok) return o;
    const j = o.j;
    const itemDim = j.id.find((d) => /^coicop/i.test(d));
    if (!itemDim) return { ok: false, error: "The data set has no classification dimension (coicop), its layout may have changed." };
    const units = categories(j.dimension.unit).map((c) => c.code);
    if (!units.includes(UNIT)) return { ok: false, error: "The data set has no unit " + UNIT + " (2025 = 100); it has " + clip(units.join(", "), 60) + "." };
    const items = categories(j.dimension[itemDim]);
    let item = null;
    for (const c of ITEM_CODES) if (items.some((x) => x.code === c)) {
      item = c;
      break;
    }
    if (!item) {
      const lab = items.find((x) => /^all[- ]items\b/i.test(x.label));
      if (lab) item = lab.code;
    }
    if (!item) return { ok: false, error: "No all-items code (" + ITEM_CODES.join(" or ") + ") among the " + items.length + " items of the data set." };
    return { ok: true, item, itemDim };
  }

  /**
   * The series of the countries from an answer for one item and one unit: { ok, series: { AT: { start, values }, ... }, error }. Every month between the first and
   * the last of a country has to be there and be a number; months at the ends that a country does not have (yet) are left out.
   */
  function extract(body, want) {
    const o = openStat(body);
    if (!o.ok) return o;
    const j = o.j;
    const ids = j.id;
    const sizes = j.size;
    const stride = {};
    let s = 1;
    for (let k = ids.length - 1; k >= 0; k--) {
      stride[ids[k]] = s;
      s *= sizes[k];
    }
    const need = (d) => (j.dimension[d] ? true : false);
    if (!need("geo") || !need("time")) return { ok: false, error: "The answer has no geo or time dimension, its layout may have changed." };
    const itemDim = ids.find((d) => /^coicop/i.test(d));
    let base = 0;
    for (const d of ids) {
      if (d === "geo" || d === "time") continue;
      const code = d === "unit" ? UNIT : d === itemDim ? want.item : null;
      const cats = categories(j.dimension[d]);
      let p = 0;
      if (code !== null) {
        p = posOf(j.dimension[d], code);
        if (p < 0) return { ok: false, error: "The answer has no " + code + " in " + d + "." };
      } else if (cats.length !== 1) return { ok: false, error: "The answer has " + cats.length + " values for " + d + " where one was asked for." };
      base += p * stride[d];
    }
    const times = categories(j.dimension.time).map((c) => c.code);
    const value = j.value;
    const at = (i) => (Array.isArray(value) ? value[i] : value && typeof value === "object" ? value[String(i)] : undefined);
    const series = {};
    for (const g of want.geos) {
      const gp = posOf(j.dimension.geo, g);
      if (gp < 0) continue;
      const months = [];
      for (const t of times) {
        const tp = posOf(j.dimension.time, t);
        const m = mi(t);
        if (m === null) return { ok: false, error: "The time " + JSON.stringify(clip(t, 12)) + " is not a month." };
        const v = at(base + gp * stride.geo + tp * stride.time);
        months.push([m, v]);
      }
      months.sort((a, b) => a[0] - b[0]);
      // The list of months is the one of all countries asked for: a country that has not published the newest month yet (or that starts later) has nothing there.
      // Those months at the ends are left out; a month without a value in the middle is a gap and is refused.
      const absent = (v) => v === null || v === undefined;
      while (months.length && absent(months[months.length - 1][1])) months.pop();
      while (months.length && absent(months[0][1])) months.shift();
      const vals = [];
      for (let k = 0; k < months.length; k++) {
        const [m, v] = months[k];
        if (k > 0 && m !== months[k - 1][0] + 1) return { ok: false, error: NAMES[g] + ": a month is missing between " + text(months[k - 1][0]) + " and " + text(m) + "." };
        if (!(Number(v) > 0) || !Number.isFinite(Number(v))) return { ok: false, error: NAMES[g] + ": " + text(m) + " has no usable value." };
        vals.push(Number(v));
      }
      if (vals.length) series[g] = { start: text(months[0][0]), values: vals };
    }
    return { ok: true, series };
  }

  // ---------------------------------------------------------------- reading FRED's csv

  /** "observation_date,SERIES" and one "YYYY-MM-DD,value" line per month; a "." is a month without a value. */
  function parseFred(body, id) {
    const lines = String(body).split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
    if (/^\s*</.test(lines[0] || "")) return { ok: false, error: "This is a web page, not FRED's csv." };
    const head = (lines.shift() || "").split(",").map((x) => x.trim());
    if (!/^(observation_date|date)$/i.test(head[0] || "") || head[1] !== id) return { ok: false, error: "The header is not the one of " + id + " (" + clip(head.join(","), 60) + "), the layout may have changed." };
    const months = [];
    for (const l of lines) {
      const c = l.split(",");
      const m = /^(\d{4}-\d{2})-\d{2}$/.exec((c[0] || "").trim());
      if (!m) return { ok: false, error: "A line starts with " + JSON.stringify(clip(c[0], 14)) + ", which is not a date." };
      months.push([mi(m[1]), (c[1] || "").trim()]);
    }
    if (!months.length) return { ok: false, error: "The file has no months." };
    const vals = [];
    for (let k = 0; k < months.length; k++) {
      const [m, v] = months[k];
      if (k > 0 && m !== months[k - 1][0] + 1) return { ok: false, error: "A month is missing between " + text(months[k - 1][0]) + " and " + text(m) + "." };
      if (!(Number(v) > 0) || !Number.isFinite(Number(v))) return { ok: false, error: text(m) + " has no usable value (" + JSON.stringify(clip(v, 12)) + ")." };
      vals.push(Number(v));
    }
    return { ok: true, series: { start: text(months[0][0]), values: vals } };
  }

  // ---------------------------------------------------------------- the checks

  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };

  /**
   * The new figures of a country on top of what is known. known: { start, values } (the baseline with the saved file); got: { start, values }; today "YYYY-MM-DD".
   * Returns { ok, series, error, added, revised }.
   */
  function overlay(country, known, got, today) {
    const name = NAMES[country];
    const kp = Inflation.prepare(known);
    const gp = Inflation.prepare(got);
    if (!gp) return { ok: false, error: name + ": the new figures have a gap or an unusable value." };
    if (!kp) return { ok: true, series: got, added: got.values.length, revised: 0 };
    const lo = Math.max(kp.i0, gp.i0);
    const hi = Math.min(kp.i0 + kp.values.length - 1, gp.i0 + gp.values.length - 1);
    if (hi - lo + 1 < MIN_OVERLAP) return { ok: false, error: name + ": the new figures share only " + Math.max(0, hi - lo + 1) + " months with what is known, too few to check that they fit (" + MIN_OVERLAP + " are needed)." };
    const diffs = [];
    for (let m = lo; m <= hi; m++) diffs.push(Math.abs(gp.values[m - gp.i0] / kp.values[m - kp.i0] - 1));
    if (median(diffs) > MEDIAN_LIMIT) return { ok: false, error: name + ": the new figures differ from the known ones by " + (median(diffs) * 100).toFixed(2) + " % on average over " + diffs.length + " months. A changed base or definition? Nothing was changed for " + name + "." };
    const worst = Math.max(...diffs);
    if (worst > MAX_LIMIT) return { ok: false, error: name + ": one month differs by " + (worst * 100).toFixed(2) + " % from the known figure (the limit is " + MAX_LIMIT * 100 + " %). Nothing was changed for " + name + "." };
    const lastKnown = kp.i0 + kp.values.length - 1;
    const lastNew = gp.i0 + gp.values.length - 1;
    if (lastNew < lastKnown) return { ok: false, error: name + ": the newest month of the new figures (" + text(lastNew) + ") is older than the newest known (" + text(lastKnown) + "). Nothing was changed for " + name + "." };
    const t = Inflation.dayOf(today);
    if (t !== null && lastNew < Inflation.monthIdx(t) - MAX_LAG_MONTHS) return { ok: false, error: name + ": the newest month is " + text(lastNew) + ", more than " + MAX_LAG_MONTHS + " months before " + today + ". The source is not being updated, or the job read an old copy." };
    const i0 = Math.min(kp.i0, gp.i0);
    const values = [];
    let revised = 0;
    for (let m = i0; m <= lastNew; m++) {
      if (m >= gp.i0) {
        const v = gp.values[m - gp.i0];
        if (m >= kp.i0 && m <= lastKnown && Math.abs(v / kp.values[m - kp.i0] - 1) > REVISED_MIN) revised++;
        values.push(v);
      } else values.push(kp.values[m - kp.i0]);
    }
    return { ok: true, series: { start: text(i0), values }, added: Math.max(0, lastNew - lastKnown), revised };
  }

  // ---------------------------------------------------------------- the download

  /** The text of an address, or { ok: false, error }. A network error, a 429 or a server error is tried again; any other answer is final. */
  async function get(o, url, accept) {
    const tries = o.tries || TRIES;
    const backoff = o.backoffMs || BACKOFF_MS;
    const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let last = "The download did not work.";
    for (let k = 0; k < tries; k++) {
      if (k > 0) await sleep(backoff[Math.min(k - 1, backoff.length - 1)]);
      let res;
      let body;
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs || TIMEOUT_MS) : null;
      try {
        res = await o.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: ctl ? ctl.signal : undefined, redirect: "follow" });
        if (res.status === 200) body = await res.text();
      } catch (e) {
        last = "The download failed: " + (e && e.message ? e.message : String(e)) + ".";
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.status === 200) {
        if (body.length > LIMIT_BYTES) return { ok: false, error: "The answer is larger than " + LIMIT_BYTES / 1000000 + " million characters." };
        return { ok: true, body };
      }
      last = "The server answered with HTTP " + res.status + " for " + clip(url, 100) + ".";
      if (res.status !== 429 && res.status < 500) return { ok: false, error: last };
    }
    return { ok: false, error: last + " It was tried " + tries + " times." };
  }

  const eurostatUrl = (extra) => EUROSTAT + DATASET + "?format=JSON&lang=EN&unit=" + UNIT + extra;

  /** Both countries from Eurostat in two requests: a small one to find the all-items code, then the series. Returns { ok, series, item, error }. */
  async function fromEurostat(o) {
    const first = await get(o, eurostatUrl("&geo=AT&time=" + o.probeMonth), "application/json");
    if (!first.ok) return first;
    const d = discover(first.body);
    if (!d.ok) return d;
    const url = eurostatUrl("&" + d.itemDim + "=" + encodeURIComponent(d.item) + COUNTRIES.map((c) => "&geo=" + c).join("") + "&sinceTimePeriod=" + SINCE);
    const second = await get(o, url, "application/json");
    if (!second.ok) return second;
    const x = extract(second.body, { geos: COUNTRIES, item: d.item });
    if (!x.ok) return x;
    return { ok: true, series: x.series, item: d.item };
  }

  async function fromFred(o, country) {
    const r = await get(o, FRED + FRED_IDS[country], "text/csv");
    if (!r.ok) return r;
    const p = parseFred(r.body, FRED_IDS[country]);
    if (!p.ok) return p;
    // only the stretch that is asked for from Eurostat: the baseline has the rest
    const k = Math.max(0, mi(SINCE) - mi(p.series.start));
    return { ok: true, series: { start: text(mi(p.series.start) + k), values: p.series.values.slice(k) } };
  }

  // ---------------------------------------------------------------- the file

  /** The text of the file: the two series, twelve values to a line. */
  function serialize(data) {
    const rows = (a) => {
      const out = [];
      for (let k = 0; k < a.length; k += 12) out.push("      " + a.slice(k, k + 12).join(", "));
      return out.join(",\n");
    };
    const one = (c) => '  "' + c + '": {\n    "start": "' + data[c].start + '",\n    "values": [\n' + rows(data[c].values) + "\n    ]\n  }";
    return "{\n" + '  "version": 1,\n  "base": "' + Inflation.BASE + '",\n  "generated": "' + data.generated + '",\n  "source": ' + JSON.stringify(data.source) + ",\n" + COUNTRIES.map(one).join(",\n") + "\n}\n";
  }

  /**
   * o: { fetch, previousText, now (ISO timestamp), sleep, log, tries, backoffMs, timeoutMs }.
   * Returns { ok, error, changed, text, summary: { AT: { last, via, added, revised } | null, HU }, lines, warnings }.
   * text is "" when there is nothing to save; ok is false when any country could not be updated (the other one is still saved).
   */
  async function run(o) {
    const lines = [];
    const warnings = [];
    const say = (s) => {
      lines.push(s);
      if (o.log) o.log(s);
    };
    const summary = { AT: null, HU: null };
    const now = String(o.now || "").replace(/\.\d+Z$/, "Z");
    const today = now.slice(0, 10);
    const t = Inflation.dayOf(today);
    if (t === null) {
      const e = "The clock gave no usable date (" + JSON.stringify(now.slice(0, 30)) + "), so the age of the figures cannot be checked.";
      lines.push(e);
      return { ok: false, error: e, changed: false, text: "", summary, lines, warnings };
    }
    // what is known: the baseline of the page with the file already saved on top
    let prev = null;
    if (typeof o.previousText === "string" && o.previousText.trim() !== "") {
      const p = Inflation.parseFile(o.previousText);
      if (p.ok) prev = p.data;
      else warnings.push("The file already saved could not be read (" + p.reason + "). It is made again from the baseline.");
    }
    const known = Inflation.merge(Baseline, prev);
    // the month asked for in the first request: two months before today, which Eurostat has
    o.probeMonth = text(Inflation.monthIdx(t) - 2);

    say("Downloading the harmonised consumer prices of Austria and Hungary.");
    const errors = [];
    const got = {};
    const euro = await fromEurostat(o);
    if (euro.ok) {
      say("Eurostat answered (data set " + DATASET + ", item " + euro.item + ", unit " + UNIT + ").");
      for (const c of COUNTRIES) if (euro.series[c]) got[c] = { via: "Eurostat", series: euro.series[c] };
    } else warnings.push("Eurostat could not be used: " + euro.error + " FRED is tried instead.");
    for (const c of COUNTRIES) {
      if (got[c]) continue;
      const f = await fromFred(o, c);
      if (f.ok) got[c] = { via: "FRED", series: f.series };
      else errors.push(NAMES[c] + ": " + (euro.ok ? "Eurostat has no " + NAMES[c] + ", and " : "") + "FRED did not work either: " + f.error);
    }
    const out = { version: 1, generated: today, source: "Eurostat HICP, all items, 2025 = 100 (Eurostat " + DATASET + "; FRED CP0000ATM086NEST and CP0000HUM086NEST as the fallback); the months before 2024 are the baseline of the tracker", AT: known.AT, HU: known.HU };
    for (const c of COUNTRIES) {
      if (!got[c]) continue;
      const r = overlay(c, known[c], got[c].series, today);
      if (!r.ok) {
        errors.push(r.error);
        continue;
      }
      out[c] = r.series;
      summary[c] = { last: Inflation.span(r.series).last, via: got[c].via, added: r.added, revised: r.revised };
      say(NAMES[c] + ": " + text(Inflation.parseMonth(r.series.start)) + " to " + summary[c].last + " from " + got[c].via + " (" + r.added + " new month(s), " + r.revised + " revised).");
      if (r.revised) warnings.push(NAMES[c] + ": " + r.revised + " month(s) already known were revised by the source. The new figures are saved.");
    }
    for (const c of COUNTRIES) if (!summary[c]) summary[c] = null;
    const saved = COUNTRIES.some((c) => summary[c]);
    const error = errors.join(" ");
    for (const e of errors) lines.push(e);
    if (!saved) return { ok: false, error: error || "Nothing could be read.", changed: false, text: "", summary, lines, warnings };
    // the text that is saved must read back through the tracker's own reader and fit its baseline
    const body = serialize(out);
    const back = Inflation.parseFile(body);
    if (!back.ok) return { ok: false, error: "The new file did not read back (" + back.reason + "), so it was not saved.", changed: false, text: "", summary, lines, warnings };
    const fit = Inflation.merge(Baseline, back.data);
    if (fit.notes.length) return { ok: false, error: "The new file does not fit the baseline of the tracker (" + fit.notes.join(" ") + "), so it was not saved.", changed: false, text: "", summary, lines, warnings };
    const same = typeof o.previousText === "string" && o.previousText.replace(/\r\n|\r/g, "\n").replace(/"generated": "[^"]*"/, "") === body.replace(/"generated": "[^"]*"/, "");
    say(same ? "Nothing changed." : "The file has changed.");
    return { ok: errors.length === 0, error, changed: !same, text: same ? "" : body, summary, lines, warnings };
  }

  return { VERSION, EUROSTAT, DATASET, UNIT, FRED_IDS, SINCE, USER_AGENT, discover, extract, parseFred, overlay, serialize, get, fromEurostat, fromFred, run, openStat, categories, posOf };
});

  return module.exports;
})();

// ---- the reader of the prices by group, the same one the tracker uses (src/perf/infl-groups.js) -----------------------------------
const InflGroups = (function () {
  const module = { exports: {} };
const require = (p) => { if (p === "./inflation.js") return Inflation; throw new Error("unexpected require " + p); };
/*
 * InflGroups: the official consumer prices by group (architecture section 46.2): the HICP of Austria and Hungary for all items (CP00) and the 13 divisions
 * of COICOP 2018 (ECOICOP version 2, CP01 to CP13), monthly on 2025 = 100, and the divisions' weights in per mille, one set per year.
 *
 * The figures come from Eurostat through the monthly inflation job of his repository (src/inflation/groups-job.js), which writes data/inflation-groups.json;
 * the page never loads anything from another site (33.3). This module reads and checks that file (the page and the job use the same checks), writes it
 * (the job), and gives the rate of change of a division over twelve months. It has no baseline of its own: until the job has run, there is nothing.
 *
 * File: { version: 1, base: "2025=100", generated, source, AT: { series: { "00": { start, values }, "01": ..., "13": ... }, weights: { "2026": { "01": n, ... } } },
 *         HU: { ... } }  (a country may be missing).
 *
 * Checks (a file that fails one is refused whole for that country, never partly used): the all-items series and at least 10 of the 13 divisions, every month
 * there and a positive number, each division ending in the all-items month; at most 1,200 months; weights between 0 and 1,000 per mille, adding up to 990 to
 * 1,010 when all 13 divisions of a year are there; fits(): the all-items series agrees with the tracker's own all-items figures over the months they share
 * (median within 0.3 %, none beyond 1 %, at least 6 months), so a file on another base or definition is never used.
 *
 * Pure functions, no DOM, no clock. Runs in Node (tests, the job) and in the page.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./inflation.js"));
  else root.InflGroups = factory(root.Inflation);
})(typeof self !== "undefined" ? self : this, function (Inflation) {
  "use strict";

  const VERSION = "inflgroups-0.1.0";
  const DIVS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"];
  const CODES = ["00"].concat(DIVS);
  const COUNTRIES = ["AT", "HU"];
  const NAMES = { AT: "Austria", HU: "Hungary" };
  const MIN_DIVS = 10;
  const MAX_MONTHS = 1200;
  const MAX_YEARS = 80;
  const MEDIAN_LIMIT = 0.003;
  const MAX_LIMIT = 0.01;
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };

  /** One country of a file, checked: { ok, country: { series, weights } } or { ok: false, reason }. */
  function checkCountry(c, x) {
    const name = NAMES[c];
    if (!isObj(x) || !isObj(x.series)) return { ok: false, reason: name + ": no series." };
    const series = {};
    for (const k of Object.keys(x.series)) if (CODES.indexOf(k) < 0) return { ok: false, reason: name + ": an unknown group code " + JSON.stringify(String(k).slice(0, 12)) + "." };
    const all = Inflation.prepare(x.series["00"]);
    if (!all) return { ok: false, reason: name + ": the all-items series is missing or has a gap or an unusable value." };
    if (all.values.length > MAX_MONTHS) return { ok: false, reason: name + ": more than " + MAX_MONTHS + " months." };
    series["00"] = { start: all.first, values: all.values.slice() };
    const lastAll = all.i0 + all.values.length - 1;
    let n = 0;
    for (const d of DIVS) {
      if (!has(x.series, d)) continue;
      const p = Inflation.prepare(x.series[d]);
      if (!p) return { ok: false, reason: name + ": the series of group " + d + " has a gap or an unusable value." };
      if (p.values.length > MAX_MONTHS) return { ok: false, reason: name + ": group " + d + " has more than " + MAX_MONTHS + " months." };
      if (p.i0 + p.values.length - 1 !== lastAll) return { ok: false, reason: name + ": group " + d + " ends in " + p.last + ", the all-items series in " + all.last + "." };
      series[d] = { start: p.first, values: p.values.slice() };
      n++;
    }
    if (n < MIN_DIVS) return { ok: false, reason: name + ": only " + n + " of the 13 groups (at least " + MIN_DIVS + " are needed)." };
    const weights = {};
    if (x.weights !== undefined) {
      if (!isObj(x.weights)) return { ok: false, reason: name + ": the weights are damaged." };
      const years = Object.keys(x.weights);
      if (years.length > MAX_YEARS) return { ok: false, reason: name + ": weights of more than " + MAX_YEARS + " years." };
      for (const y of years.sort()) {
        const w = x.weights[y];
        if (!/^(19|20)\d\d$/.test(y) || !isObj(w)) return { ok: false, reason: name + ": the weights of " + String(y).slice(0, 8) + " are damaged." };
        const row = {};
        let sum = 0;
        let k = 0;
        for (const d of Object.keys(w)) {
          const v = Number(w[d]);
          if (DIVS.indexOf(d) < 0 || typeof w[d] !== "number" || !(v >= 0) || v > 1000) return { ok: false, reason: name + ": a weight of " + y + " is damaged." };
          row[d] = v;
          sum += v;
          k++;
        }
        if (k === DIVS.length && (sum < 990 || sum > 1010)) return { ok: false, reason: name + ": the weights of " + y + " add up to " + sum.toFixed(1) + " per mille, not about 1,000." };
        if (k) weights[y] = row;
      }
    }
    return { ok: true, country: { series, weights } };
  }

  /** The file as text -> { ok, data } or { ok: false, reason }. */
  function parseFile(text) {
    let j;
    try {
      j = JSON.parse(String(text));
    } catch (e) {
      return { ok: false, reason: "The file of the price groups is not readable (it is not JSON)." };
    }
    if (!isObj(j)) return { ok: false, reason: "The file of the price groups is empty." };
    if (j.base !== Inflation.BASE) return { ok: false, reason: "The file of the price groups is on another base (" + String(j.base).slice(0, 20) + ", the page expects " + Inflation.BASE + ")." };
    const data = { version: 1, base: j.base, generated: typeof j.generated === "string" ? j.generated.slice(0, 10) : "", source: typeof j.source === "string" ? j.source.slice(0, 300) : "" };
    for (const c of COUNTRIES) {
      if (j[c] === undefined) continue;
      const r = checkCountry(c, j[c]);
      if (!r.ok) return { ok: false, reason: "The file of the price groups was not used: " + r.reason };
      data[c] = r.country;
    }
    if (!data.AT && !data.HU) return { ok: false, reason: "The file of the price groups has neither Austria nor Hungary." };
    return { ok: true, data };
  }

  /**
   * Whether each country's all-items series fits the tracker's own all-items figures (allItems: { AT: { start, values }, HU }, e.g. Inflation.merge of
   * the baseline and the inflation file). Returns { AT: true|false, HU, notes: [text] }; a country that does not fit is not used.
   */
  function fits(data, allItems) {
    const out = { AT: false, HU: false, notes: [] };
    for (const c of COUNTRIES) {
      if (!data || !data[c]) continue;
      const f = Inflation.prepare(data[c].series["00"]);
      const b = allItems && allItems[c] ? Inflation.prepare(allItems[c]) : null;
      if (!f || !b) {
        out.notes.push(NAMES[c] + ": nothing to compare the price groups with.");
        continue;
      }
      const lo = Math.max(b.i0, f.i0);
      const hi = Math.min(b.i0 + b.values.length - 1, f.i0 + f.values.length - 1);
      const diffs = [];
      for (let i = lo; i <= hi; i++) diffs.push(Math.abs(f.values[i - f.i0] / b.values[i - b.i0] - 1));
      const worst = diffs.length ? Math.max.apply(null, diffs) : 0;
      if (diffs.length < 6) out.notes.push(NAMES[c] + ": the price groups share fewer than 6 months with the all-items figures.");
      else if (median(diffs) > MEDIAN_LIMIT) out.notes.push(NAMES[c] + ": the all-items series of the price groups differs from the tracker's by " + (median(diffs) * 100).toFixed(2) + " % on average.");
      else if (worst > MAX_LIMIT) out.notes.push(NAMES[c] + ": one month of the price groups' all-items series differs by " + (worst * 100).toFixed(2) + " %.");
      else out[c] = true;
    }
    return out;
  }

  /** A country of a file made ready to look up: { first, last (month indexes of the all-items series), idx: { code: prepared }, weights } */
  function ready(country) {
    if (!country) return null;
    const idx = {};
    for (const k of Object.keys(country.series)) idx[k] = Inflation.prepare(country.series[k]);
    const a = idx["00"];
    return { first: a.i0, last: a.i0 + a.values.length - 1, idx, weights: country.weights || {} };
  }
  /** The index of a group in month i (month index), or null. */
  function at(p, i) {
    if (!p) return null;
    const k = i - p.i0;
    return k >= 0 && k < p.values.length ? p.values[k] : null;
  }
  /** The rate of change over twelve months of a prepared series at month i: I(i) / I(i - 12) - 1, or null. */
  function yoy(p, i) {
    const a = at(p, i);
    const b = at(p, i - 12);
    return a === null || b === null ? null : a / b - 1;
  }

  /**
   * The divisions weighted by their year's weights against the all-items change (the job's check, 46.2): for each month i of `months` with weights,
   * { month, mix, all, diff } in percentage points.
   */
  function consistency(country, months) {
    const r = ready(country);
    const out = [];
    for (const i of months) {
      const w = r.weights[Inflation.monthText(i).slice(0, 4)];
      const all = yoy(r.idx["00"], i);
      if (!w || all === null) continue;
      let sw = 0;
      let s = 0;
      for (const d of DIVS) {
        const y = yoy(r.idx[d], i);
        if (y === null || !has(w, d)) continue;
        sw += w[d];
        s += w[d] * y;
      }
      if (!(sw > 0)) continue;
      out.push({ month: Inflation.monthText(i), mix: (100 * s) / sw, all: 100 * all, diff: (100 * s) / sw - 100 * all });
    }
    return out;
  }

  /** The text of the file (the job): twelve values to a line, so that a new month is a small change in the repository. */
  function serialize(data) {
    const rows = (a) => {
      const out = [];
      for (let k = 0; k < a.length; k += 12) out.push("          " + a.slice(k, k + 12).join(", "));
      return out.join(",\n");
    };
    const country = (c) => {
      const x = data[c];
      const ser = CODES.filter((k) => has(x.series, k)).map((k) => '      "' + k + '": {\n        "start": "' + x.series[k].start + '",\n        "values": [\n' + rows(x.series[k].values) + "\n        ]\n      }");
      const ws = Object.keys(x.weights || {}).sort().map((y) => '      "' + y + '": ' + JSON.stringify(x.weights[y]));
      return '  "' + c + '": {\n    "series": {\n' + ser.join(",\n") + "\n    },\n    \"weights\": {\n" + ws.join(",\n") + "\n    }\n  }";
    };
    const parts = COUNTRIES.filter((c) => data[c]).map(country);
    return "{\n" + '  "version": 1,\n  "base": "' + Inflation.BASE + '",\n  "generated": "' + data.generated + '",\n  "source": ' + JSON.stringify(data.source) + ",\n" + parts.join(",\n") + "\n}\n";
  }

  /**
   * Invented figures for the demo (nothing here is a published figure): both countries from 2012 to the month before `last`, every group with a price
   * path of its own, weights that add up to 1,000.
   */
  function demo(last) {
    const end = Inflation.parseMonth(last || "2026-10");
    const start = Inflation.parseMonth("2012-01");
    const out = { version: 1, base: Inflation.BASE, generated: "demo", source: "invented demo figures" };
    const W = { AT: [118, 33, 62, 148, 66, 52, 140, 32, 112, 12, 128, 38, 59], HU: [205, 72, 41, 112, 55, 52, 158, 41, 80, 9, 66, 20, 89] };
    // a yearly rate per group: a base, a swing and a phase, so that groups differ and years differ
    const base = { AT: [2.4, 2.8, 1.0, 3.2, 1.8, 1.4, 2.0, -0.6, 2.2, 2.0, 3.6, 2.4, 2.1], HU: [4.6, 5.2, 1.4, 4.0, 2.6, 3.4, 3.4, 0.8, 3.0, 3.2, 5.6, 2.6, 3.0] };
    for (const c of COUNTRIES) {
      const series = {};
      const lv = DIVS.map(() => 100);
      const vals = DIVS.map(() => []);
      const all = [];
      for (let i = start; i <= end; i++) {
        const y = Math.floor(i / 12);
        let s = 0;
        for (let g = 0; g < DIVS.length; g++) {
          const boom = y >= 2022 && y <= 2023 ? (g === 3 ? 9 : g === 0 ? 5 : 3) : 0; // invented: a price shock in two years
          const rate = base[c][g] + 1.2 * Math.sin((y + g) * 1.3) + boom;
          lv[g] *= Math.pow(1 + rate / 100, 1 / 12);
          vals[g].push(lv[g]);
          s += W[c][g] * lv[g];
        }
        all.push(s / 1000);
      }
      // on 2025 = 100: each series divided by its mean of 2025 (when the demo reaches it)
      const k25 = Inflation.parseMonth("2025-01") - start;
      const norm = (a) => {
        const m = a.slice(k25, k25 + 12);
        const mean = m.length ? m.reduce((x, y) => x + y, 0) / m.length : a[a.length - 1];
        return a.map((v) => Math.round((v / mean) * 10000) / 100);
      };
      series["00"] = { start: Inflation.monthText(start), values: norm(all) };
      DIVS.forEach((d, g) => (series[d] = { start: Inflation.monthText(start), values: norm(vals[g]) }));
      const weights = {};
      for (let y = 2012; y <= Math.floor(end / 12); y++) {
        const row = {};
        DIVS.forEach((d, g) => (row[d] = W[c][g]));
        weights[String(y)] = row;
      }
      out[c] = { series, weights };
    }
    return out;
  }

  return { VERSION, DIVS, CODES, COUNTRIES, MIN_DIVS, parseFile, fits, ready, at, yoy, consistency, serialize, demo };
});

  return module.exports;
})();

// ---- the job's second part, the prices by group (src/inflation/groups-job.js) ---------------------------------------------------
const InflGroupsJob = (function () {
  const module = { exports: {} };
const require = (p) => { if (p === "../perf/inflation.js") return Inflation; if (p === "../perf/infl-groups.js") return InflGroups; if (p === "./job.js") return InflationJob; throw new Error("unexpected require " + p); };
/*
 * InflGroupsJob: the second part of the monthly inflation job (architecture 46.2). It downloads the HICP of Austria and Hungary by the 13 divisions of
 * COICOP 2018 (ECOICOP version 2) with all items, and the divisions' weights, from Eurostat, checks them and keeps data/inflation-groups.json up to date.
 * The tracker uses them only for his own inflation rate on the Spending area's Inflation tab. Nothing here touches the tax.
 *
 * Where the figures come from:
 *   1. a small request to prc_hicp_minr (unit I25, 2025 = 100) for one month, to find the name of the classification dimension (coicop18 in 2026) and
 *      that the codes CP00 (or TOTAL) and CP01 to CP13 are there;
 *   2. prc_hicp_minr for both countries and those codes since January 2000;
 *   3. prc_hicp_iw (the weights, per mille, one set a year) for both countries and the 13 codes.
 *
 * A country is saved only when every check passes (InflGroups.parseFile on the text to be saved; InflGroups.fits against the tracker's own all-items figures;
 * the divisions weighted by their year's weights within 1 percentage point of the all-items rate of change in each of the last 12 months, a warning above
 * 0.3; the newest month no older than the one already saved and at most three months before today; no month already saved moved by more than 1 %).
 * A country that fails keeps what the file had and the job reports an error; the other country is still saved. Nothing is guessed, filled in or rescaled.
 *
 * The network, the clock and the pauses are passed in, so the tests run it without any of them.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../perf/inflation.js"), require("../perf/infl-groups.js"), require("./job.js"));
  else root.InflGroupsJob = factory(root.Inflation, root.InflGroups, root.InflationJob);
})(typeof self !== "undefined" ? self : this, function (Inflation, InflGroups, Job) {
  "use strict";

  const VERSION = "inflgroupsjob-0.1.0";
  const SERIES = "prc_hicp_minr";
  const WEIGHTS = "prc_hicp_iw";
  const UNIT = "I25";
  const SINCE = "2000-01";
  const SINCE_YEAR = "2000";
  const COUNTRIES = InflGroups.COUNTRIES;
  const NAMES = { AT: "Austria", HU: "Hungary" };
  const DIVS = InflGroups.DIVS;
  const ALL_CODES = ["CP00", "TOTAL"];
  const MAX_LAG_MONTHS = 3;
  const REVISE_LIMIT = 0.01;
  const MIX_REFUSE = 1.0; // percentage points
  const MIX_WARN = 0.3;
  const mi = Inflation.parseMonth;
  const mt = Inflation.monthText;
  const url = (ds, q) => Job.EUROSTAT + ds + "?format=JSON&lang=EN" + q;

  /** The classification dimension and the codes of a first answer: { ok, dim, all, error }. */
  function discover(body) {
    const o = Job.openStat(body);
    if (!o.ok) return o;
    const j = o.j;
    const dim = j.id.find((d) => /^coicop/i.test(d));
    if (!dim) return { ok: false, error: "The data set has no classification dimension (coicop), its layout may have changed." };
    const codes = Job.categories(j.dimension[dim]).map((c) => c.code);
    const all = ALL_CODES.find((c) => codes.indexOf(c) >= 0);
    if (!all) return { ok: false, error: "No all-items code (" + ALL_CODES.join(" or ") + ") among the codes of " + dim + "." };
    const missing = DIVS.filter((d) => codes.indexOf("CP" + d) < 0);
    if (missing.length > DIVS.length - InflGroups.MIN_DIVS) return { ok: false, error: "The classification " + dim + " lacks the groups " + missing.map((d) => "CP" + d).join(", ") + "." };
    return { ok: true, dim, all, divs: DIVS.filter((d) => codes.indexOf("CP" + d) >= 0) };
  }

  /**
   * Every series of an answer: { ok, got: { geo: { code: [[time, value]] } } } for the codes of `dim` asked for; the other dimensions must have one value
   * (unit: `unit` when given). Values that are null or missing are left out (the caller looks at the gaps).
   */
  function extractAll(body, dim, unit) {
    const o = Job.openStat(body);
    if (!o.ok) return o;
    const j = o.j;
    const ids = j.id;
    const stride = {};
    let s = 1;
    for (let k = ids.length - 1; k >= 0; k--) {
      stride[ids[k]] = s;
      s *= j.size[k];
    }
    if (!j.dimension.geo || !j.dimension.time || !j.dimension[dim]) return { ok: false, error: "The answer has no geo, time or " + dim + " dimension, its layout may have changed." };
    let base = 0;
    for (const d of ids) {
      if (d === "geo" || d === "time" || d === dim) continue;
      const cats = Job.categories(j.dimension[d]);
      if (d === "unit" && unit) {
        const p = Job.posOf(j.dimension[d], unit);
        if (p < 0) return { ok: false, error: "The answer has no unit " + unit + "." };
        base += p * stride[d];
      } else if (cats.length !== 1) return { ok: false, error: "The answer has " + cats.length + " values for " + d + " where one was expected." };
    }
    const at = (i) => (Array.isArray(j.value) ? j.value[i] : j.value && typeof j.value === "object" ? j.value[String(i)] : undefined);
    const times = Job.categories(j.dimension.time).map((c) => c.code);
    const got = {};
    for (const g of Job.categories(j.dimension.geo).map((c) => c.code)) {
      const gp = Job.posOf(j.dimension.geo, g);
      got[g] = {};
      for (const c of Job.categories(j.dimension[dim]).map((x) => x.code)) {
        const cp = Job.posOf(j.dimension[dim], c);
        const pts = [];
        for (const t of times) {
          const v = at(base + gp * stride.geo + cp * stride[dim] + Job.posOf(j.dimension.time, t) * stride.time);
          if (v !== null && v !== undefined) pts.push([t, v]);
        }
        got[g][c] = pts;
      }
    }
    return { ok: true, got };
  }

  /** Monthly points -> { start, values } with every month between the first and the last, or { error }. */
  function monthly(points, what) {
    const pts = points.map(([t, v]) => [mi(t), v]).sort((a, b) => a[0] - b[0]);
    if (!pts.length) return { error: what + " has no figures." };
    for (let k = 0; k < pts.length; k++) {
      if (pts[k][0] === null) return { error: what + ": a time that is not a month." };
      if (k > 0 && pts[k][0] !== pts[k - 1][0] + 1) return { error: what + ": a month is missing after " + mt(pts[k - 1][0]) + "." };
      const x = Number(pts[k][1]);
      if (!(x > 0) || !Number.isFinite(x)) return { error: what + ": " + mt(pts[k][0]) + " has no usable value." };
    }
    return { start: mt(pts[0][0]), values: pts.map((p) => Number(p[1])), last: pts[pts.length - 1][0] };
  }

  /** A country's file part from the answers: { ok, country: { series, weights }, warnings } or { ok: false, error }. */
  function build(c, sGot, wGot, d) {
    const name = NAMES[c];
    const warnings = [];
    if (!sGot || !sGot[d.all]) return { ok: false, error: name + ": the answer has no all-items series." };
    const raw = { "00": monthly(sGot[d.all], name + " all items") };
    if (raw["00"].error) return { ok: false, error: raw["00"].error };
    for (const g of d.divs) {
      const m = monthly(sGot["CP" + g] || [], name + " group " + g);
      if (m.error) warnings.push(m.error + " That group is left out.");
      else raw[g] = m;
    }
    // every series ends in the same month: the newest month all of them have
    let end = raw["00"].last;
    for (const k of Object.keys(raw)) end = Math.min(end, raw[k].last);
    const series = {};
    for (const k of Object.keys(raw)) {
      const r = raw[k];
      const n = end - mi(r.start) + 1;
      if (n < 13) continue;
      series[k] = { start: r.start, values: r.values.slice(0, n) };
    }
    const weights = {};
    if (wGot) {
      for (const g of d.divs) {
        for (const [t, v] of wGot["CP" + g] || []) {
          if (!/^\d{4}$/.test(String(t)) || String(t) < SINCE_YEAR) continue;
          const x = Number(v);
          if (!(x >= 0) || !Number.isFinite(x)) continue;
          if (!weights[t]) weights[t] = {};
          weights[t][g] = x;
        }
      }
    } else warnings.push(name + ": no weights; the country's mix is not shown.");
    return { ok: true, country: { series, weights }, warnings };
  }

  /** Whether a new country part may replace the old one: { ok, error, added, revised }. */
  function compare(c, old, neu, today) {
    const name = NAMES[c];
    const n = InflGroups.ready(neu);
    const t = Inflation.dayOf(today);
    if (t !== null && n.last < Inflation.monthIdx(t) - MAX_LAG_MONTHS) return { ok: false, error: name + ": the newest month of the price groups is " + mt(n.last) + ", more than " + MAX_LAG_MONTHS + " months before " + today + "." };
    if (!old) return { ok: true, added: n.last - n.first + 1, revised: 0 };
    const o = InflGroups.ready(old);
    if (n.last < o.last) return { ok: false, error: name + ": the newest month of the price groups (" + mt(n.last) + ") is older than the one already saved (" + mt(o.last) + ")." };
    let revised = 0;
    for (const k of Object.keys(old.series)) {
      const a = o.idx[k];
      const b = n.idx[k];
      if (!a || !b) continue;
      for (let i = Math.max(a.i0, b.i0); i <= Math.min(a.i0 + a.values.length - 1, b.i0 + b.values.length - 1); i++) {
        const x = Math.abs(b.values[i - b.i0] / a.values[i - a.i0] - 1);
        if (x > REVISE_LIMIT) return { ok: false, error: name + ": group " + k + " in " + mt(i) + " differs by " + (x * 100).toFixed(2) + " % from the figure already saved (the limit is 1 %)." };
        if (x > 0.0002) revised++;
      }
    }
    return { ok: true, added: n.last - o.last, revised };
  }

  /**
   * o: { fetch, previousText (the groups file already saved, or ""), allItems ({ AT, HU }: the tracker's all-items series, baseline and file), now, sleep,
   * log, tries, backoffMs, timeoutMs }. Returns { ok, error, changed, text, summary: { AT, HU }, lines, warnings }.
   */
  async function run(o) {
    const lines = [];
    const warnings = [];
    const say = (s) => {
      lines.push(s);
      if (o.log) o.log(s);
    };
    const summary = { AT: null, HU: null };
    const today = String(o.now || "").slice(0, 10);
    const t = Inflation.dayOf(today);
    const fail = (e) => {
      lines.push(e);
      return { ok: false, error: e, changed: false, text: "", summary, lines, warnings };
    };
    if (t === null) return fail("The clock gave no usable date, so the age of the figures cannot be checked.");
    let prev = null;
    if (typeof o.previousText === "string" && o.previousText.trim() !== "") {
      const p = InflGroups.parseFile(o.previousText);
      if (p.ok) prev = p.data;
      else warnings.push("The groups file already saved could not be read (" + p.reason + "). It is made again.");
    }
    say("Downloading the consumer prices of Austria and Hungary by group (Eurostat " + SERIES + " and " + WEIGHTS + ").");
    const probe = await Job.get(o, url(SERIES, "&unit=" + UNIT + "&geo=AT&time=" + mt(Inflation.monthIdx(t) - 2)), "application/json");
    if (!probe.ok) return fail("Price groups: " + probe.error);
    const d = discover(probe.body);
    if (!d.ok) return fail("Price groups: " + d.error);
    const codes = [d.all].concat(d.divs.map((g) => "CP" + g));
    const filter = (list) => list.map((c) => "&" + d.dim + "=" + encodeURIComponent(c)).join("") + COUNTRIES.map((c) => "&geo=" + c).join("");
    const sRes = await Job.get(o, url(SERIES, "&unit=" + UNIT + filter(codes) + "&sinceTimePeriod=" + SINCE), "application/json");
    if (!sRes.ok) return fail("Price groups: " + sRes.error);
    const sx = extractAll(sRes.body, d.dim, UNIT);
    if (!sx.ok) return fail("Price groups: " + sx.error);
    let wx = null;
    const wRes = await Job.get(o, url(WEIGHTS, filter(d.divs.map((g) => "CP" + g)) + "&sinceTimePeriod=" + SINCE_YEAR), "application/json");
    if (wRes.ok) {
      const w = extractAll(wRes.body, d.dim, null);
      if (w.ok) wx = w;
      else warnings.push("The weights could not be read: " + w.error);
    } else warnings.push("The weights could not be downloaded: " + wRes.error);
    const out = { version: 1, base: Inflation.BASE, generated: today, source: "Eurostat HICP by ECOICOP version 2 (COICOP 2018) division, 2025 = 100 (" + SERIES + ", " + d.dim + " " + codes.join(" ") + "); weights per mille (" + WEIGHTS + ")" };
    const errors = [];
    for (const c of COUNTRIES) {
      const old = prev && prev[c] ? prev[c] : null;
      const keep = () => {
        if (old) out[c] = old;
      };
      const b = build(c, sx.got[c], wx ? wx.got[c] : null, d);
      if (!b.ok) {
        errors.push(b.error);
        keep();
        continue;
      }
      for (const w of b.warnings) warnings.push(w);
      // the file's own reader on this country alone
      const probeText = InflGroups.serialize({ version: 1, generated: today, source: "", [c]: b.country });
      const back = InflGroups.parseFile(probeText);
      if (!back.ok) {
        errors.push(back.reason);
        keep();
        continue;
      }
      const country = back.data[c];
      const fit = InflGroups.fits({ [c]: country }, o.allItems || {});
      if (!fit[c]) {
        errors.push(fit.notes.join(" ") || NAMES[c] + ": the all-items series does not fit the tracker's.");
        keep();
        continue;
      }
      const r = InflGroups.ready(country);
      const mix = InflGroups.consistency(country, Array.from({ length: 12 }, (_, k) => r.last - 11 + k));
      const bad = mix.filter((x) => Math.abs(x.diff) > MIX_REFUSE);
      if (bad.length) {
        errors.push(NAMES[c] + ": the groups weighted by their weights differ from the all-items rate by " + bad[0].diff.toFixed(2) + " points in " + bad[0].month + " (the limit is " + MIX_REFUSE + "): a group code or a weight may have changed.");
        keep();
        continue;
      }
      const soft = mix.filter((x) => Math.abs(x.diff) > MIX_WARN);
      if (soft.length) warnings.push(NAMES[c] + ": the groups weighted by their weights differ from the all-items rate by up to " + Math.max(...soft.map((x) => Math.abs(x.diff))).toFixed(2) + " points (the HICP is chain-linked every December).");
      const cmp = compare(c, old, country, today);
      if (!cmp.ok) {
        errors.push(cmp.error);
        keep();
        continue;
      }
      out[c] = country;
      summary[c] = { last: mt(r.last), groups: Object.keys(country.series).length - 1, years: Object.keys(country.weights).length, added: cmp.added, revised: cmp.revised };
      say(NAMES[c] + ": " + summary[c].groups + " groups to " + summary[c].last + ", weights of " + summary[c].years + " years (" + cmp.added + " new month(s), " + cmp.revised + " revised figure(s)).");
    }
    for (const e of errors) lines.push(e);
    if (!out.AT && !out.HU) return { ok: false, error: errors.join(" ") || "Nothing could be read.", changed: false, text: "", summary, lines, warnings };
    const body = InflGroups.serialize(out);
    const back = InflGroups.parseFile(body);
    if (!back.ok) return fail("The new groups file did not read back (" + back.reason + "), so it was not saved.");
    const same = typeof o.previousText === "string" && o.previousText.replace(/\r\n|\r/g, "\n").replace(/"generated": "[^"]*"/, "") === body.replace(/"generated": "[^"]*"/, "");
    say(same ? "Price groups: nothing changed." : "Price groups: the file has changed.");
    return { ok: errors.length === 0, error: errors.join(" "), changed: !same, text: same ? "" : body, summary, lines, warnings };
  }

  return { VERSION, SERIES, WEIGHTS, UNIT, SINCE, discover, extractAll, monthly, build, compare, run };
});

  return module.exports;
})();

// ---- the part that touches files, the network and the clock ------------------------------------------------------------------

async function main(d) {
  const log = d.log;
  const outPath = d.argv[0] || "data/inflation.json";
  if (typeof d.fetch !== "function") {
    log("This needs Node 18 or newer (it has to be able to download).");
    return 1;
  }
  let previousText = "";
  try {
    previousText = d.fs.readFileSync(outPath, "utf8");
  } catch (e) {
    // there is no inflation file yet
  }
  const r = await InflationJob.run({ fetch: d.fetch, previousText, now: d.now(), sleep: d.sleep, log });
  for (const w of r.warnings) log("::warning::" + w);
  if (r.changed && r.text) {
    d.fs.mkdirSync(d.path.dirname(outPath), { recursive: true });
    d.fs.writeFileSync(outPath, r.text);
    log("Saved " + outPath + ".");
  }
  if (!r.ok) log("::error::" + r.error);

  // the second part (architecture 46.2): the prices by group, checked against the all-items figures the tracker now has
  const groupsPath = d.argv[1] || "data/inflation-groups.json";
  let groupsText = "";
  try {
    groupsText = d.fs.readFileSync(groupsPath, "utf8");
  } catch (e) {
    // there is no groups file yet
  }
  const nowText = r.text || previousText;
  const parsed = nowText ? Inflation.parseFile(nowText) : { ok: false };
  const allItems = Inflation.merge(InflationData, parsed.ok ? parsed.data : null);
  let g;
  try {
    g = await InflGroupsJob.run({ fetch: d.fetch, previousText: groupsText, allItems, now: d.now(), sleep: d.sleep, log });
  } catch (e) {
    g = { ok: false, error: "Price groups: " + (e && e.message ? e.message : String(e)), changed: false, text: "", warnings: [] };
  }
  for (const w of g.warnings) log("::warning::" + w);
  if (g.changed && g.text) {
    d.fs.mkdirSync(d.path.dirname(groupsPath), { recursive: true });
    d.fs.writeFileSync(groupsPath, g.text);
    log("Saved " + groupsPath + ".");
  }
  if (!g.ok) log("::error::" + g.error);
  return r.ok && g.ok ? 0 : 1;
}

if (require.main === module) {
  main({
    fs: require("fs"),
    path: require("path"),
    fetch: typeof fetch === "function" ? fetch : null,
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (s) => console.log(s),
    argv: process.argv.slice(2),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e && e.message ? e.message : e);
      process.exitCode = 1;
    }
  );
} else {
  module.exports = { Inflation, InflationData, InflationJob, InflGroups, InflGroupsJob, main };
}
