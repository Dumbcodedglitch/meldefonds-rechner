#!/usr/bin/env node
"use strict";
/*
 * fetch-ecb.js
 *
 * Downloads the European Central Bank's history of euro reference rates (eurofxref-hist.zip), keeps the twelve currencies the
 * Austria Tax Tracker offers and the days from 2010, and saves them in data/ecb-rates.csv. It is made by the tracker and runs as a
 * scheduled job of this repository (see .github/workflows/fetch-ecb.yml). It needs Node 22 (the workflow sets it up; Node 20.12 or
 * newer also works) and no packages.
 *
 * The file is saved only when every check passes: a complete ZIP file, the ECB's layout, every rate a number, every day once and in
 * order, a recent newest day, no earlier day lost. Otherwise the file that is already there stays as it is and the job fails, so that
 * GitHub tells you. The rates are the ECB's own text, never rounded or computed. A rate that the ECB has revised is saved and named in
 * a warning. The tracker reads this file and compares it with the rates you have stored before it uses it.
 *
 * Usage: node scripts/fetch-ecb.js [data/ecb-rates.csv]
 */

// ---- exact decimals (src/lib/decimal.js) ---------------------------------------------------------------------------------------
const Dec = (function () {
  const module = { exports: {} };
/*
 * Exact decimals for money, quantities and exchange rates.
 *
 * A decimal is { u, s }: an integer `u` (BigInt) and a number of decimals `s`, meaning u / 10^s.
 * Nothing here ever goes through floating point. Rounding is always "half away from zero"
 * (kaufm\u00e4nnische Rundung) and always to a stated number of decimals.
 *
 * Pure functions only. The same file runs in Node (tests) and, copied into a page, in the browser.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Dec = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const P10 = (n) => 10n ** BigInt(n);
  const mk = (u, s) => ({ u, s });
  const ZERO = mk(0n, 0);

  /** Strict decimal text: optional sign, digits, optional dot and digits. No thousands commas, no exponent. */
  function parse(raw) {
    const t = String(raw === undefined || raw === null ? "" : raw).trim();
    const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(t);
    if (!m) return null;
    const frac = m[3] || "";
    let u = BigInt(m[2] + frac);
    if (m[1] === "-") u = -u;
    return mk(u, frac.length);
  }

  /** Round half away from zero to `dp` decimals. */
  function round(a, dp) {
    if (a.s <= dp) return mk(a.u * P10(dp - a.s), dp);
    const div = P10(a.s - dp);
    let q = a.u / div;
    const r = a.u % div;
    const twice = (r < 0n ? -r : r) * 2n;
    if (twice >= div) q += a.u < 0n ? -1n : 1n;
    return mk(q, dp);
  }

  /** Plain decimal text (never an exponent). With `dp`, rounds first. */
  function str(a, dp) {
    const x = dp === undefined ? a : round(a, dp);
    const neg = x.u < 0n;
    let digits = (neg ? -x.u : x.u).toString();
    if (x.s > 0) {
      digits = digits.padStart(x.s + 1, "0");
      digits = digits.slice(0, -x.s) + "." + digits.slice(-x.s);
    }
    return (neg ? "-" : "") + digits;
  }

  const align = (a, s) => (a.s === s ? a.u : a.u * P10(s - a.s));
  const add = (a, b) => {
    const s = Math.max(a.s, b.s);
    return mk(align(a, s) + align(b, s), s);
  };
  const neg = (a) => mk(-a.u, a.s);
  const sub = (a, b) => add(a, neg(b));
  const mul = (a, b) => mk(a.u * b.u, a.s + b.s);
  const abs = (a) => mk(a.u < 0n ? -a.u : a.u, a.s);
  const isZero = (a) => a.u === 0n;
  const isNeg = (a) => a.u < 0n;
  const cmp = (a, b) => {
    const s = Math.max(a.s, b.s);
    const x = align(a, s);
    const y = align(b, s);
    return x < y ? -1 : x > y ? 1 : 0;
  };

  /** a / b to `dp` decimals, half away from zero. Null if b is zero. */
  function divRound(a, b, dp) {
    if (b.u === 0n) return null;
    const num = a.u * P10(b.s) * P10(dp);
    const den = b.u * P10(a.s);
    let q = num / den;
    const r = num % den;
    const twice = (r < 0n ? -r : r) * 2n;
    const aden = den < 0n ? -den : den;
    if (twice >= aden) q += num < 0n !== den < 0n ? -1n : 1n;
    return mk(q, dp);
  }

  /** a \u00d7 b to `dp` decimals, half away from zero. */
  const mulRound = (a, b, dp) => round(mul(a, b), dp);

  /** Number of decimals actually needed (trailing zeros do not count). */
  function scaleNeeded(a) {
    let u = a.u < 0n ? -a.u : a.u;
    let s = a.s;
    while (s > 0 && u % 10n === 0n) {
      u /= 10n;
      s--;
    }
    return s;
  }

  /** Same value with trailing zeros removed (100.500 becomes 100.5, 100.000 becomes 100). */
  function normalize(a) {
    const need = scaleNeeded(a);
    return need === a.s ? a : mk(a.u / P10(a.s - need), need);
  }

  /** Smaller and larger of two decimals. */
  const min = (a, b) => (cmp(a, b) <= 0 ? a : b);
  const max = (a, b) => (cmp(a, b) >= 0 ? a : b);

  return { P10, mk, ZERO, parse, str, round, add, sub, neg, mul, abs, isZero, isNeg, cmp, divRound, mulRound, scaleNeeded, normalize, min, max };
});

  return module.exports;
})();

// ---- the ECB rate reader, the same one the tracker uses (src/fx/ecb.js) -------------------------------------------------------
const EcbFx = (function () {
  const module = { exports: {} };
const require = (p) => { if (p === "../lib/decimal.js") return Dec; throw new Error("unexpected require " + p); };
/*
 * ECB reference-rate file: reader, checks and lookup.
 *
 * Pure functions only: no browser APIs, no network, no storage. The same file runs in
 * Node (tests) and, copied into a page, in the browser.
 *
 * Why this exists: for income in foreign currency and for gains realised without an actual
 * conversion, the Austrian income tax guidelines (EStR 2000 Rz 6201c) name the "EZB-Referenzkurs"
 * as the conversion rate. The ECB publishes one rate per business day, as units of foreign
 * currency per 1 EUR.
 *
 * Rates and amounts are exact decimals (BigInt digits + number of decimals). Nothing goes
 * through floating point. Nothing is guessed: a file that cannot be read in full is refused
 * with the reason, and every conversion says which day's rate it used.
 *
 * The workspace this was built in cannot reach the ECB, so the reader is tested on files
 * shaped like the ECB's three formats (SDMX CSV, the wide eurofxref-hist.csv, and the Data
 * Portal download). A real file is checked by the owner in the browser; the report printed
 * here is built so that a mismatch with the real format shows up as a clear finding.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../lib/decimal.js"));
  else root.EcbFx = factory(root.Dec);
})(typeof self !== "undefined" ? self : this, function (Dec) {
  "use strict";

  const VERSION = 1;

  /* ------------------------------------------------------------------ *
   * 1. Exact decimals (shared module, src/lib/decimal.js)
   * ------------------------------------------------------------------ */
  const P10 = Dec.P10;
  const decParse = Dec.parse;
  const dStr = Dec.str;
  const dRound = Dec.round;
  const dDivRound = Dec.divRound;
  const dMulRound = Dec.mulRound;
  const dCmp = Dec.cmp;

  /* ------------------------------------------------------------------ *
   * 2. Dates (ISO yyyy-mm-dd, whole days only)
   * ------------------------------------------------------------------ */
  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

  /** Whole days since 1970-01-01, or null if the text is not a real calendar date. */
  function dayNumber(iso) {
    const m = ISO.exec(String(iso).trim());
    if (!m) return null;
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return ms / 86400000;
  }

  /** The date text (yyyy-mm-dd) of a day number. */
  const isoOfDay = (dn) => new Date(dn * 86400000).toISOString().slice(0, 10);

  /** Easter Sunday of a year as a day number (the anonymous Gregorian algorithm of Meeus, Jones and Butcher). */
  function easterDay(y) {
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, month - 1, day) / 86400000;
  }

  /**
   * Does the ECB publish its reference rates on this day? Not on the TARGET closing days: Saturday, Sunday, 1 January,
   * Good Friday, Easter Monday, 1 May, 25 and 26 December (ECB, "Euro foreign exchange reference rates"; checked by the
   * review of 19 Nov 2026, architecture 32). dn is a day number (dayNumber).
   */
  function publishesOn(dn) {
    const wd = (((dn + 4) % 7) + 7) % 7; // 1970-01-01 (day 0) was a Thursday; 0 = Sunday
    if (wd === 0 || wd === 6) return false;
    const t = new Date(dn * 86400000);
    const mo = t.getUTCMonth() + 1;
    const d = t.getUTCDate();
    if ((mo === 1 && d === 1) || (mo === 5 && d === 1) || (mo === 12 && (d === 25 || d === 26))) return false;
    const easter = easterDay(t.getUTCFullYear());
    return dn !== easter - 2 && dn !== easter + 1;
  }

  /* ------------------------------------------------------------------ *
   * 3. CSV reading (RFC 4180 style: quotes, doubled quotes, CRLF/LF/CR)
   * ------------------------------------------------------------------ */
  function pickDelimiter(s) {
    let inQ = false;
    const count = { ",": 0, ";": 0, "\t": 0 };
    let lines = 0;
    for (let i = 0; i < s.length && lines < 5; i++) {
      const c = s[i];
      if (c === '"') inQ = !inQ;
      else if (!inQ) {
        if (c === "\n" || c === "\r") {
          if (count[","] + count[";"] + count["\t"] > 0) lines++;
        } else if (c in count) count[c]++;
      }
    }
    let best = ",";
    for (const d of [";", "\t"]) if (count[d] > count[best]) best = d;
    return best;
  }

  function readCsv(s, delim) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQ = false;
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') {
            cell += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        cell += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (c === delim) {
        row.push(cell);
        cell = "";
        i++;
        continue;
      }
      if (c === "\r" || c === "\n") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        i++;
        continue;
      }
      cell += c;
      i++;
    }
    if (inQ) return { error: "A quoted cell is never closed, so the file looks cut off." };
    if (cell !== "" || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return { rows: rows.filter((r) => r.some((x) => x.trim() !== "")) };
  }

  const norm = (h) =>
    String(h === undefined || h === null ? "" : h)
      .replace(/^\ufeff/, "")
      .trim()
      .toUpperCase()
      .replace(/[\s_]+/g, "_");

  /* ------------------------------------------------------------------ *
   * 4. Reading an ECB rate file
   * ------------------------------------------------------------------ */
  const MISSING = new Set(["", "N/A", "NA", "NAN", "-", "."]);
  const MAX_LIST = 5;
  const lvl = (level, id, text) => ({ level, id, text });

  /**
   * Read a downloaded ECB file for one currency (default USD).
   * options: currency, needFrom (ISO date the file must cover), needTo (ISO date, usually today),
   *          spotDates (ISO dates to print the rate for).
   * Returns { ok, fatal, format, currency, dates, rates, findings, ledger, reportText }.
   */
  function readEcbFile(text, options) {
    const o = options || {};
    const ccy = String(o.currency || "USD").toUpperCase();
    const findings = [];
    const fail = (msg, extra) => {
      const res = Object.assign({ ok: false, fatal: msg, currency: ccy, findings, ledger: null }, extra || {});
      res.reportText = buildReport(res, o);
      return res;
    };

    let s = String(text === undefined || text === null ? "" : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    if (s.trim() === "") return fail("The file is empty.");
    if (/^\s*</.test(s)) return fail("This looks like a web page or XML file, not a CSV file. Save the CSV file itself.");

    const parsed = readCsv(s, pickDelimiter(s));
    if (parsed.error) return fail(parsed.error);
    const rows = parsed.rows;
    if (!rows.length) return fail("The file has no rows.");

    // --- find the header row and decide the format
    let format = null;
    let headerAt = -1;
    let cols = {};
    const seenHeaders = [];
    for (let i = 0; i < Math.min(rows.length, 25) && !format; i++) {
      const names = rows[i].map(norm);
      if (i === 0) seenHeaders.push(...rows[i].map((x) => x.trim()).filter(Boolean).slice(0, 12));
      const idx = (n) => names.indexOf(n);
      if (idx("TIME_PERIOD") >= 0 && idx("OBS_VALUE") >= 0) {
        format = "sdmx";
        headerAt = i;
        cols = {
          date: idx("TIME_PERIOD"),
          value: idx("OBS_VALUE"),
          currency: idx("CURRENCY"),
          denom: idx("CURRENCY_DENOM"),
          type: idx("EXR_TYPE"),
          suffix: idx("EXR_SUFFIX"),
          freq: idx("FREQ"),
          key: idx("KEY"),
        };
      } else if (idx("DATE") >= 0 && idx(ccy) >= 0) {
        format = "wide";
        headerAt = i;
        cols = { date: idx("DATE"), value: idx(ccy) };
      } else {
        const keyName = "EXR.D." + ccy + ".EUR.SP00.A";
        const valueCol = names.findIndex((n) => n.indexOf(keyName) >= 0);
        const dateCol = idx("DATE") >= 0 ? idx("DATE") : idx("TIME_PERIOD");
        if (valueCol >= 0 && dateCol >= 0) {
          format = "portal";
          headerAt = i;
          cols = { date: dateCol, value: valueCol };
        }
      }
    }
    if (!format) {
      return fail(
        "I do not recognise this file's layout for " + ccy + ". Expected the ECB's CSV with TIME_PERIOD and OBS_VALUE columns, " +
          "the wide history file with a Date column and a " + ccy + " column, or the Data Portal download with a column named after EXR.D." + ccy + ".EUR.SP00.A." +
          (seenHeaders.length ? " First row of your file: " + seenHeaders.join(" | ") : ""),
        { firstRow: seenHeaders }
      );
    }

    // --- every line has as many fields as the header (review of 19 Nov 2026, RD-004): a line with a comma too many or too few would
    // shift the columns, and a line cut inside a field has too few; such a file is refused, chosen by hand or fetched
    const width = (r) => (r.length > 1 && r[r.length - 1].trim() === "" ? r.length - 1 : r.length); // the ECB ends its lines with a comma
    const headerWidth = width(rows[headerAt]);
    for (let k = headerAt + 1; k < rows.length; k++) {
      const m = width(rows[k]);
      if (m !== headerWidth) {
        return fail("Line " + (k + 1) + " of the rate file has " + m + " fields but the header has " + headerWidth + " (a comma too many or too few, or the line is cut off). The columns would be shifted, so the file is not used. Load the file again from the ECB.");
      }
    }

    // --- collect observations
    const body = rows.slice(headerAt + 1);
    const obs = [];
    const bad = [];
    let missing = 0;
    let stray = 0;
    let otherSeries = 0;
    const otherNames = new Set();
    for (let k = 0; k < body.length; k++) {
      const r = body[k];
      const lineNo = headerAt + 2 + k;
      if (format === "sdmx") {
        const cell = (i) => (i >= 0 && i < r.length ? r[i].trim() : "");
        const isSeries =
          (cols.currency < 0 || cell(cols.currency).toUpperCase() === ccy) &&
          (cols.denom < 0 || cell(cols.denom).toUpperCase() === "EUR") &&
          (cols.type < 0 || cell(cols.type).toUpperCase() === "SP00") &&
          (cols.suffix < 0 || cell(cols.suffix).toUpperCase() === "A") &&
          (cols.freq < 0 || cell(cols.freq).toUpperCase() === "D");
        if (!isSeries) {
          otherSeries++;
          otherNames.add(cell(cols.key) || cell(cols.currency) || "?");
          continue;
        }
      }
      const rawDate = (r[cols.date] || "").trim();
      const rawVal = (r[cols.value] || "").trim();
      if (MISSING.has(rawVal.toUpperCase())) {
        if (dayNumber(rawDate) !== null) missing++;
        else stray++;
        continue;
      }
      const dn = dayNumber(rawDate);
      const dec = decParse(rawVal);
      if (dn === null) {
        bad.push("line " + lineNo + ": date '" + rawDate.slice(0, 20) + "' is not yyyy-mm-dd");
        continue;
      }
      if (!dec || dec.u <= 0n) {
        bad.push("line " + lineNo + ": rate '" + rawVal.slice(0, 20) + "' is not a positive number with a dot");
        continue;
      }
      obs.push({ date: rawDate, dn, dec, raw: rawVal });
    }

    findings.push(lvl("ok", "format", "Layout recognised: " + { sdmx: "ECB SDMX CSV (TIME_PERIOD, OBS_VALUE)", wide: "wide history file (Date, one column per currency)", portal: "ECB Data Portal download" }[format] + "."));
    if (otherSeries) {
      findings.push(lvl("note", "other-series", otherSeries + " rows of other series were ignored (" + [...otherNames].slice(0, 4).join(", ") + (otherNames.size > 4 ? ", ..." : "") + "). Only EXR.D." + ccy + ".EUR.SP00.A (daily reference rate) is used."));
    }
    if (bad.length) {
      findings.push(lvl("problem", "unreadable", bad.length + " rows cannot be read, for example: " + bad.slice(0, MAX_LIST).join("; ") + "."));
      return fail("Some rows cannot be read, so the file is refused: " + bad.length + " problem row(s).", { format });
    }
    if (!obs.length) {
      findings.push(lvl("problem", "no-rates", "No usable " + ccy + " rate was found in the file."));
      return fail("No usable " + ccy + " rate was found.", { format });
    }
    if (missing) findings.push(lvl("note", "missing", missing + " dates had no rate (N/A or empty) and were skipped, as the ECB marks days without a rate."));
    if (stray) findings.push(lvl("note", "stray", stray + " rows with neither a date nor a rate were ignored (blank or footer lines)."));

    // --- order, duplicates
    obs.sort((a, b) => a.dn - b.dn);
    const clean = [];
    let dupSame = 0;
    for (const x of obs) {
      const prev = clean[clean.length - 1];
      if (prev && prev.dn === x.dn) {
        if (dCmp(prev.dec, x.dec) === 0) {
          dupSame++;
          continue;
        }
        findings.push(lvl("problem", "conflict", "The date " + x.date + " appears twice with different rates (" + prev.raw + " and " + x.raw + ")."));
        return fail("A date has two different rates, so the file is refused.", { format });
      }
      clean.push(x);
    }
    if (dupSame) findings.push(lvl("note", "duplicates", dupSame + " repeated rows with identical rates were merged."));

    // --- checks on the series
    const first = clean[0].date;
    const last = clean[clean.length - 1].date;
    findings.push(lvl("ok", "range", clean.length + " daily " + ccy + " rates from " + first + " to " + last + "."));

    const decimals = new Map();
    for (const x of clean) decimals.set(x.dec.s, (decimals.get(x.dec.s) || 0) + 1);
    const maxDp = Math.max(...decimals.keys());
    if (maxDp > 4) {
      const n = [...decimals.entries()].filter(([dp]) => dp > 4).reduce((t, [, c]) => t + c, 0);
      findings.push(lvl("warn", "decimals", n + " rates have more than 4 decimals. The ECB publishes 4 for the " + ccy + " rate, so this file may have been changed or computed."));
    } else {
      findings.push(lvl("ok", "decimals", "Every rate has at most 4 decimals, as the ECB publishes."));
    }

    const gaps = [];
    const jumps = [];
    for (let i = 1; i < clean.length; i++) {
      const days = clean[i].dn - clean[i - 1].dn;
      if (days > 7) gaps.push(clean[i - 1].date + " to " + clean[i].date + " (" + days + " days)");
      const a = clean[i - 1].dec;
      const b = clean[i].dec;
      // relative move above 8 % in one step
      const diff = b.u * P10(a.s) - a.u * P10(b.s);
      const base = a.u * P10(b.s);
      const absDiff = diff < 0n ? -diff : diff;
      if (absDiff * 100n > base * 8n) jumps.push(clean[i].date + " (" + clean[i - 1].raw + " to " + clean[i].raw + ")");
    }
    if (gaps.length) findings.push(lvl("warn", "gaps", gaps.length + " stretches longer than 7 days without a rate (normal holiday gaps are at most 5), for example: " + gaps.slice(0, MAX_LIST).join("; ") + ". Part of the file may be missing."));
    else findings.push(lvl("ok", "gaps", "No stretch longer than 7 days without a rate."));
    if (jumps.length) findings.push(lvl("warn", "jumps", jumps.length + " one-step moves of more than 8 %, for example: " + jumps.slice(0, MAX_LIST).join("; ") + ". Check these against the ECB site."));
    else findings.push(lvl("ok", "jumps", "No one-step move above 8 %."));

    if (ccy === "USD") {
      const lo = decParse("0.8");
      const hi = decParse("1.7");
      const out = clean.filter((x) => dCmp(x.dec, lo) < 0 || dCmp(x.dec, hi) > 0);
      if (out.length) findings.push(lvl("problem", "range-usd", out.length + " USD rates are outside 0.8 to 1.7 (first: " + out[0].date + " = " + out[0].raw + "). The USD rate has not been there since 1999. This is probably the wrong currency or direction."));
    }

    if (o.needFrom) {
      const nf = dayNumber(o.needFrom);
      if (nf !== null && clean[0].dn > nf) findings.push(lvl("problem", "starts-late", "The file starts on " + first + " but you need rates from " + o.needFrom + ". Download the full history."));
    }
    if (o.needTo) {
      const nt = dayNumber(o.needTo);
      if (nt !== null && clean[clean.length - 1].dn < nt - 7) findings.push(lvl("warn", "out-of-date", "The last rate is " + last + ", more than a week before " + o.needTo + ". Download again before calculating recent transactions."));
    }

    const hasProblem = findings.some((f) => f.level === "problem");
    const dates = clean.map((x) => x.date);
    const rates = clean.map((x) => x.raw);
    const ledger = hasProblem ? null : makeLedger(ccy, dates, clean.map((x) => x.dec));

    if (ledger && Array.isArray(o.spotDates) && o.spotDates.length) {
      const lines = [];
      for (const d of o.spotDates) {
        const r = ledger.rateOn(d);
        lines.push(r.ok ? d + ": " + r.rate + (r.exact ? "" : " (latest rate before it, from " + r.rateDate + ")") : d + ": " + r.reason);
      }
      findings.push(lvl("note", "spot", "Rates for the dates you asked about: " + lines.join("; ") + ". Compare them with the ECB website."));
    }

    const res = { ok: !hasProblem, fatal: hasProblem ? "The file has problems, see the findings." : null, format, currency: ccy, dates, rates, findings, ledger, count: clean.length, first, last };
    res.reportText = buildReport(res, o);
    return res;
  }

  /* ------------------------------------------------------------------ *
   * 5. The ledger: lookup and conversion
   * ------------------------------------------------------------------ */

  /**
   * dates: ascending ISO dates; decs: matching exact decimals (units of currency per 1 EUR).
   * rateOn(date): the rate published that day, or else the latest one before it (at most
   * maxLagDays earlier, default 7). The result always says which day's rate it is.
   */
  function makeLedger(currency, dates, decs) {
    const dns = dates.map(dayNumber);
    const n = dates.length;

    function rateOn(date, opts) {
      const maxLag = opts && opts.maxLagDays !== undefined ? opts.maxLagDays : 7;
      const dn = dayNumber(date);
      if (dn === null) return { ok: false, reason: "'" + String(date).slice(0, 20) + "' is not a date (yyyy-mm-dd)." };
      if (n === 0 || dn < dns[0]) return { ok: false, reason: "no " + currency + " rate on or before " + date + " (the file starts " + (n ? dates[0] : "never") + ")." };
      // last index with dns[i] <= dn
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (dns[mid] <= dn) lo = mid;
        else hi = mid - 1;
      }
      const lag = dn - dns[lo];
      // The earlier rate stands in only for days the ECB published none (weekends, TARGET holidays). A day it did publish that
      // the file lacks (after the file's last day, or a gap inside it) is never filled with an older rate (review of 19 Nov 2026,
      // RD-003 and RD-005). allowStale: a what-if valued "today" may use the latest rate on purpose (it says which day).
      if (lag <= maxLag && !(opts && opts.allowStale)) {
        for (let d = dns[lo] + 1; d <= dn; d++) {
          if (!publishesOn(d)) continue;
          // a day from today on: the ECB publishes the rate of a day on that day, around 16:00 Central European time
          const notYet = !!(opts && typeof opts.today === "string" && isoOfDay(d) >= opts.today);
          return {
            ok: false,
            missing: isoOfDay(d),
            notYet,
            reason: notYet
              ? "the " + currency + " rate of " + isoOfDay(d) + " is not in the file yet: the ECB publishes it on that day, around 16:00 Central European time (needed for " + date + "). The row waits for it; the automatic update or a newer rate file brings it."
              : dn > dns[n - 1]
                ? "the " + currency + " rate file ends on " + dates[n - 1] + ", but the ECB published a rate on " + isoOfDay(d) + " (needed for " + date + "). Load a newer rate file (step 4 of the Data tab)."
                : "the " + currency + " rate file has no rate for " + isoOfDay(d) + ", a day the ECB published one (needed for " + date + "). A day is missing inside the file: load the complete file from the ECB.",
          };
        }
      }
      if (lag > maxLag) return { ok: false, reason: "the latest " + currency + " rate on or before " + date + " is from " + dates[lo] + ", " + lag + " days earlier than allowed (" + maxLag + "). The file ends " + dates[n - 1] + "." };
      return { ok: true, rate: dStr(decs[lo]), rateDate: dates[lo], lagDays: lag, exact: lag === 0, _dec: decs[lo] };
    }

    /** Foreign amount to EUR: amount \u00f7 rate, rounded half away from zero to dp (default 2). */
    function toEur(amount, date, opts) {
      const a = decParse(amount);
      if (!a) return { ok: false, reason: "amount '" + String(amount).slice(0, 30) + "' is not a number with a dot." };
      const r = rateOn(date, opts);
      if (!r.ok) return r;
      const dp = opts && opts.dp !== undefined ? opts.dp : 2;
      const eur = dDivRound(a, r._dec, dp);
      return { ok: true, eur: dStr(eur), rate: r.rate, rateDate: r.rateDate, lagDays: r.lagDays, exact: r.exact };
    }

    /** EUR amount to foreign currency: amount \u00d7 rate, rounded half away from zero to dp (default 2). */
    function fromEur(amount, date, opts) {
      const a = decParse(amount);
      if (!a) return { ok: false, reason: "amount '" + String(amount).slice(0, 30) + "' is not a number with a dot." };
      const r = rateOn(date, opts);
      if (!r.ok) return r;
      const dp = opts && opts.dp !== undefined ? opts.dp : 2;
      return { ok: true, amount: dStr(dMulRound(a, r._dec, dp)), rate: r.rate, rateDate: r.rateDate, lagDays: r.lagDays, exact: r.exact };
    }

    const strip = (r) => (r.ok ? { ok: true, rate: r.rate, rateDate: r.rateDate, lagDays: r.lagDays, exact: r.exact } : r);
    return {
      currency,
      count: n,
      first: n ? dates[0] : null,
      last: n ? dates[n - 1] : null,
      rateOn: (d, o) => strip(rateOn(d, o)),
      toEur,
      fromEur,
    };
  }

  /* ------------------------------------------------------------------ *
   * 6. Report (no personal data: rates are public)
   * ------------------------------------------------------------------ */
  function buildReport(res, o) {
    const out = [];
    out.push("ECB RATE FILE CHECK. This text contains public exchange rates only.");
    out.push("Reader version " + VERSION + " \u00b7 currency " + res.currency + (o && o.today ? " \u00b7 " + o.today : ""));
    out.push("");
    if (res.fatal && !res.findings.length) out.push("REFUSED: " + res.fatal);
    else {
      out.push("CHECKS");
      const tag = { ok: "[OK]", note: "[NOTE]", warn: "[LOOK]", problem: "[PROBLEM]" };
      for (const f of res.findings) out.push(tag[f.level] + " " + f.text);
      if (res.fatal) out.push("", "REFUSED: " + res.fatal);
    }
    if (res.ok) out.push("", "RESULT: the file can be used. Every conversion will state the date of the rate it used.");
    return out.join("\n");
  }

  return {
    VERSION,
    readEcbFile,
    makeLedger,
    publishesOn: (iso) => {
      const dn = dayNumber(iso);
      return dn === null ? null : publishesOn(dn);
    },
    decParse,
    dStr,
    dRound,
    dDivRound,
    dMulRound,
    dCmp,
    dayNumber,
  };
});

  return module.exports;
})();

// ---- the ZIP reader, the same one the tracker uses (src/app/zip.js) -----------------------------------------------------------
const Zip = (function () {
  const module = { exports: {} };
/*
 * Zip: reads the files inside a ZIP archive, and turns the bytes of a text file into text.
 *
 * Why this exists: the ECB publishes its full history of euro exchange rates as a ZIP file with one CSV inside
 * (eurofxref-hist.zip). Opening it for the owner saves him unzipping on a phone. Only what is needed is built:
 * "stored" and "deflate" entries, no encryption, no ZIP64, no multi-part archives. Anything else is refused with a reason.
 *
 * Rules of this module:
 *  - Every entry is checked against the CRC-32 and the size written in the archive. A damaged archive is refused.
 *  - A limit on the unpacked size stops a small file that unpacks to something huge.
 *  - Nothing is guessed: a wrong or cut-short archive gives { ok: false, error } and never partial text.
 *  - No clock, no network, no storage. Deflate is done by the browser's DecompressionStream (also in Node 18+).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Zip = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "zip-0.1.0";
  const DEFAULT_LIMIT = 60 * 1000 * 1000;

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Bytes to text. A byte-order mark decides UTF-8, UTF-16 little or big endian; without one, UTF-8. */
  function decodeText(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
    return new TextDecoder("utf-8").decode(b);
  }

  /** True when the bytes start like a ZIP archive ("PK"). */
  function looksLikeZip(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7) && (b[3] === 4 || b[3] === 6 || b[3] === 8);
  }

  /** The entries of an archive: { ok, entries: [{ name, method, flags, crc, csize, usize, offset }] } or { ok: false, error }. */
  function list(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 22) return { ok: false, error: "This is not a ZIP file (it is too short)." };
    let e = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) {
        e = i;
        break;
      }
    }
    if (e < 0) return { ok: false, error: "This is not a complete ZIP file (its end is missing). It may have been cut short when it was downloaded." };
    const disk = u16(b, e + 4);
    const total = u16(b, e + 10);
    const cdSize = u32(b, e + 12);
    const cdOff = u32(b, e + 16);
    if (disk !== 0 || u16(b, e + 6) !== 0) return { ok: false, error: "ZIP files in several parts are not supported." };
    if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return { ok: false, error: "ZIP64 archives are not supported." };
    if (cdOff + cdSize > e) return { ok: false, error: "The ZIP file is damaged (its list of files points outside the file)." };
    const entries = [];
    let p = cdOff;
    for (let n = 0; n < total; n++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) return { ok: false, error: "The ZIP file is damaged (its list of files cannot be read)." };
      const flags = u16(b, p + 8);
      const method = u16(b, p + 10);
      const crc = u32(b, p + 16);
      const csize = u32(b, p + 20);
      const usize = u32(b, p + 24);
      const nameLen = u16(b, p + 28);
      const extraLen = u16(b, p + 30);
      const commentLen = u16(b, p + 32);
      const offset = u32(b, p + 42);
      if (p + 46 + nameLen > b.length) return { ok: false, error: "The ZIP file is damaged (a file name runs past the end)." };
      const nameBytes = b.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x800 ? new TextDecoder("utf-8").decode(nameBytes) : Array.from(nameBytes, (c) => String.fromCharCode(c)).join("");
      entries.push({ name, method, flags, crc, csize, usize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { ok: true, entries };
  }

  async function inflateRaw(data, limit) {
    if (typeof DecompressionStream !== "function") throw new Error("This browser cannot open ZIP files. Unzip the file first and choose the file inside it.");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch (err) {
          /* already stopped */
        }
        throw new Error("The file inside unpacks to more than " + Math.round(limit / 1000000) + " million bytes, so it is not opened.");
      }
      chunks.push(r.value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  /** The bytes of one entry, checked against the size and the CRC-32 in the archive. */
  async function extract(input, entry, opts) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    const limit = (opts && opts.limit) || DEFAULT_LIMIT;
    if (entry.flags & 1) return { ok: false, error: "The file inside is encrypted (password protected), which is not supported." };
    if (entry.usize > limit) return { ok: false, error: "The file inside is larger than " + Math.round(limit / 1000000) + " million bytes, so it is not opened." };
    const o = entry.offset;
    if (o + 30 > b.length || u32(b, o) !== 0x04034b50) return { ok: false, error: "The ZIP file is damaged (a file header cannot be found)." };
    const start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
    if (start + entry.csize > b.length) return { ok: false, error: "The ZIP file is damaged or cut short (a file runs past the end)." };
    const raw = b.subarray(start, start + entry.csize);
    let bytes;
    try {
      if (entry.method === 0) bytes = raw;
      else if (entry.method === 8) bytes = await inflateRaw(raw, limit);
      else return { ok: false, error: "The file inside uses a compression method (" + entry.method + ") that is not supported." };
    } catch (err) {
      return { ok: false, error: err && err.message ? String(err.message) : "The file inside could not be unpacked." };
    }
    if (bytes.length !== entry.usize) return { ok: false, error: "The file inside has a different size than the ZIP file says. The ZIP file is damaged." };
    if (crc32(bytes) !== entry.crc) return { ok: false, error: "The check code of the file inside does not match. The ZIP file is damaged." };
    return { ok: true, bytes };
  }

  const isDir = (n) => /\/$/.test(n) || /^__MACOSX\//.test(n) || /(^|\/)\.DS_Store$/.test(n);

  /**
   * The text of the first CSV file in the archive (or the first file, if there is no CSV).
   * Returns { ok, name, text } or { ok: false, error }.
   */
  async function firstText(input, opts) {
    const l = list(input);
    if (!l.ok) return l;
    const files = l.entries.filter((e) => !isDir(e.name));
    if (!files.length) return { ok: false, error: "The ZIP file has no files in it." };
    const csv = files.filter((e) => /\.csv$/i.test(e.name));
    const entry = (csv.length ? csv : files)[0];
    const x = await extract(input, entry, opts);
    if (!x.ok) return x;
    return { ok: true, name: entry.name, text: decodeText(x.bytes), others: files.length - 1 };
  }

  return { VERSION, crc32, decodeText, looksLikeZip, list, extract, firstText };
});

  return module.exports;
})();

// ---- the job (src/ecb/job.js) --------------------------------------------------------------------------------------------------
const EcbJob = (function () {
  const module = { exports: {} };
const require = (p) => { if (p === "../fx/ecb.js") return EcbFx; if (p === "../app/zip.js") return Zip; throw new Error("unexpected require " + p); };
/*
 * EcbJob: the job that downloads the ECB's history of euro reference rates and keeps the rate file of the owner's own GitHub
 * repository (data/ecb-rates.csv) up to date.
 *
 * It runs as a scheduled job of the owner's repository, not in the tracker page: the ECB's site sends no permission for other web
 * sites to read it from a browser. The tracker only reads the file this job writes (next to the page, on the same site, or from the
 * repository itself).
 *
 * What it saves: the ECB's own "wide" format (a Date column, one column per currency, newest day first), reduced to the twelve
 * currencies the tracker offers and to the days from 1 Jan 2010 (the tracker refuses purchases before Oct 2011, so older rates are
 * never read). About 400 kB. The rates are the ECB's own text, never rounded or recomputed.
 *
 * Rules of this module:
 *  - The network, the clock and the pauses are passed in, so the tests run it without any of them.
 *  - The file is saved only if every check passes (see check below). Any failure leaves the file that is already there untouched and
 *    makes the job fail, so that GitHub tells the owner. Nothing is guessed, filled in or repaired.
 *  - A rate that the ECB has revised since the last run is saved, and said in a warning: the tracker then waits for its owner's click
 *    before it uses the file (it only takes a file by itself when no stored rate changes).
 *  - The file that is saved is read back with the same reader the tracker uses (src/fx/ecb.js) for every currency.
 *  - Nothing in this file contains real data.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../fx/ecb.js"), require("../app/zip.js"));
  else root.EcbJob = factory(root.EcbFx, root.Zip);
})(typeof self !== "undefined" ? self : this, function (Ecb, Zip) {
  "use strict";

  const VERSION = "ecbjob-0.1.0";
  const SOURCE_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip";
  /** The currencies of the tracker (the same list as the account currencies of the Data tab), without the euro. Alphabetical. */
  const CURRENCIES = ["AUD", "CAD", "CHF", "CZK", "DKK", "GBP", "HUF", "JPY", "NOK", "PLN", "SEK", "USD"];
  const START_DATE = "2010-01-01"; // the first day that is kept
  const FIRST_DAY_LATEST = "2010-01-08"; // the oldest kept day must be on or before this (the first ECB day of 2010 is 4 Jan)
  const MAX_AGE_DAYS = 10; // the newest day may be this many days before today (holidays make gaps of up to 5 days)
  const MAX_GAP_DAYS = 10; // two days in a row may be this many calendar days apart
  const MIN_DAYS = 3000; // 1 Jan 2010 to 2026 has more than 4,200 ECB days
  const MAX_DECIMALS = 6; // the ECB publishes at most 4
  const MAX_LIST = 5;
  const TRIES = 3;
  const BACKOFF_MS = [2000, 6000];
  const TIMEOUT_MS = 60000;
  const LIMIT_BYTES = 20 * 1000 * 1000;
  const USER_AGENT = "Mozilla/5.0 (compatible; AustriaTaxTracker-EcbJob/0.1)";
  const RATE = new RegExp("^\\d+(\\.\\d{1," + MAX_DECIMALS + "})?$");

  const dn = (iso) => Ecb.dayNumber(iso);
  const list = (a) => a.slice(0, MAX_LIST).join("; ") + (a.length > MAX_LIST ? "; and " + (a.length - MAX_LIST) + " more" : "");

  // ---------------------------------------------------------------- reading the ECB's wide file

  /**
   * Reads the ECB's wide CSV (or the file this job made). Returns { ok: true, rows, dropped } or { ok: false, error }.
   * rows: the kept days, as in the file (newest first): { date, dn, cells } with cells[i] the text of CURRENCIES[i]: a positive number
   * with a dot (at most MAX_DECIMALS decimals) or N/A. dropped: how many days before START_DATE were left out.
   */
  function parseWide(text) {
    let s = String(text === undefined || text === null ? "" : text);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    if (/^\s*</.test(s)) return { ok: false, error: "This is a web page or XML, not the ECB's CSV file." };
    if (s.indexOf('"') >= 0) return { ok: false, error: "The file has quotation marks, which the ECB's rate file does not have. Its format may have changed." };
    const lines = s.split(/\r\n|\n|\r/);
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) return { ok: false, error: "The file is empty." };
    const head = lines[i].split(",").map((x) => x.trim());
    if (head[head.length - 1] === "") head.pop(); // the ECB ends every line with a comma
    if (head[0] !== "Date") return { ok: false, error: "The first column is not called Date (it is " + JSON.stringify(String(head[0]).slice(0, 20)) + "). The format of the file may have changed." };
    const col = {};
    for (let k = 1; k < head.length; k++) {
      if (head[k] === "") return { ok: false, error: "The header has an empty column name, which the ECB's file does not." };
      if (col[head[k]] !== undefined) return { ok: false, error: "The header names " + head[k] + " twice." };
      col[head[k]] = k;
    }
    const missing = CURRENCIES.filter((c) => col[c] === undefined);
    if (missing.length) return { ok: false, error: "The file has no column for " + missing.join(", ") + ". The format of the file may have changed." };

    const rows = [];
    const bad = [];
    let dropped = 0;
    let prev = null;
    for (let k = i + 1; k < lines.length; k++) {
      const line = lines[k];
      if (line.trim() === "") continue;
      const f = line.split(",");
      if (f[f.length - 1].trim() === "") f.pop();
      const date = f[0].trim();
      const d = dn(date);
      if (d === null) {
        bad.push("line " + (k + 1) + ": " + JSON.stringify(date.slice(0, 20)) + " is not a date like 2026-11-17");
        continue;
      }
      if (prev !== null && d >= prev) {
        bad.push("line " + (k + 1) + ": " + date + " is not older than the line before it (the days must run from the newest to the oldest, each day once)");
        continue;
      }
      prev = d;
      if (f.length !== head.length) {
        bad.push("line " + (k + 1) + " (" + date + "): it has " + f.length + " fields but the header has " + head.length + " (a comma too many or too few)");
        continue;
      }
      if (date < START_DATE) {
        dropped++;
        continue;
      }
      const cells = [];
      let rowOk = true;
      for (const c of CURRENCIES) {
        const v = (f[col[c]] === undefined ? "" : f[col[c]]).trim();
        if (v === "N/A" || (RATE.test(v) && Ecb.decParse(v).u > 0n)) cells.push(v);
        else {
          bad.push("line " + (k + 1) + " (" + date + "): the " + c + " rate " + JSON.stringify(v.slice(0, 20)) + " is not a positive number with a dot, or N/A");
          rowOk = false;
          break;
        }
      }
      if (rowOk) rows.push({ date, dn: d, cells });
    }
    if (bad.length) return { ok: false, error: bad.length + " line(s) cannot be read, for example: " + list(bad) + "." };
    if (!rows.length) return { ok: false, error: "The file has no day from " + START_DATE + " on." };
    return { ok: true, rows, dropped };
  }

  /** The text that is saved: Date and the twelve currencies, newest day first, the ECB's own rate texts, lines end with \n. */
  function serialize(rows) {
    const out = ["Date," + CURRENCIES.join(",")];
    for (const r of rows) out.push(r.date + "," + r.cells.join(","));
    return out.join("\n") + "\n";
  }

  // ---------------------------------------------------------------- the checks

  /** The problems of a series of days (as parseWide returns them) seen on the day `today`; an empty list means it is fine. */
  function checkSeries(rows, today) {
    const problems = [];
    const t = dn(today);
    const newest = rows[0];
    const oldest = rows[rows.length - 1];
    if (rows.length < MIN_DAYS) problems.push("The file has only " + rows.length + " days from " + START_DATE + " on; at least " + MIN_DAYS + " are expected. It may be cut short.");
    if (oldest.date > FIRST_DAY_LATEST) problems.push("The oldest day is " + oldest.date + ", but the file should reach back to the first days of 2010.");
    if (t !== null) {
      const age = t - newest.dn;
      if (age > MAX_AGE_DAYS) problems.push("The newest day is " + newest.date + ", " + age + " days before " + today + ". The ECB's file is not being updated, or the job read an old copy.");
      if (age < -1) problems.push("The newest day is " + newest.date + ", which is after " + today + ". That cannot be a real rate.");
    }
    const gaps = [];
    for (let k = 1; k < rows.length; k++) if (rows[k - 1].dn - rows[k].dn > MAX_GAP_DAYS) gaps.push(rows[k].date + " to " + rows[k - 1].date);
    if (gaps.length) problems.push(gaps.length + " stretch(es) of more than " + MAX_GAP_DAYS + " days without a rate (normal holiday gaps are at most 5), for example: " + list(gaps) + ". Part of the file may be missing.");
    CURRENCIES.forEach((c, ci) => {
      let n = 0;
      let latest = null;
      for (const r of rows) {
        if (r.cells[ci] !== "N/A") {
          n++;
          if (latest === null) latest = r;
        }
      }
      if (n < MIN_DAYS) problems.push("The " + c + " column has only " + n + " rates; at least " + MIN_DAYS + " are expected.");
      else if (newest.dn - latest.dn > MAX_AGE_DAYS) problems.push("The newest " + c + " rate is from " + latest.date + ", " + (newest.dn - latest.dn) + " days before the newest day of the file.");
    });
    return problems;
  }

  /**
   * The new days against the file that is already saved.
   * Returns { problems, added, revised } : problems stop the job; revised (date, currency, old and new rate) is only reported.
   */
  function compare(prev, next) {
    const problems = [];
    const revised = [];
    if (next[0].dn < prev[0].dn) problems.push("The newest day of the ECB's file (" + next[0].date + ") is older than the newest day already saved (" + prev[0].date + "). Nothing was changed.");
    const byDate = new Map(next.map((r) => [r.date, r]));
    const vanished = [];
    let added = 0;
    const firstNext = next[next.length - 1].dn;
    for (const r of prev) {
      if (r.dn < firstNext) continue;
      const n = byDate.get(r.date);
      if (!n) {
        vanished.push(r.date);
        continue;
      }
      CURRENCIES.forEach((c, ci) => {
        const a = r.cells[ci];
        const b = n.cells[ci];
        const same = a === b || (a !== "N/A" && b !== "N/A" && Ecb.dCmp(Ecb.decParse(a), Ecb.decParse(b)) === 0);
        if (!same) revised.push({ date: r.date, currency: c, old: a, new: b });
      });
    }
    if (vanished.length) problems.push(vanished.length + " day(s) of the file already saved are not in the ECB's file any more, for example " + list(vanished) + ". Nothing was changed.");
    const have = new Set(prev.map((r) => r.date));
    for (const r of next) if (!have.has(r.date)) added++;
    return { problems, added, revised };
  }

  // ---------------------------------------------------------------- the download

  /** The bytes of the ZIP file, or { ok: false, error }. A network error or a server error is tried again; any other answer is final. */
  async function download(o) {
    const tries = o.tries || TRIES;
    const backoff = o.backoffMs || BACKOFF_MS;
    const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const url = o.url || SOURCE_URL;
    let last = "The download did not work.";
    for (let k = 0; k < tries; k++) {
      if (k > 0) await sleep(backoff[Math.min(k - 1, backoff.length - 1)]);
      let res;
      let buf;
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), o.timeoutMs || TIMEOUT_MS) : null;
      try {
        res = await o.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/zip, */*" }, signal: ctl ? ctl.signal : undefined, redirect: "follow" });
        if (res.status === 200) buf = await res.arrayBuffer();
      } catch (e) {
        last = "The download failed: " + (e && e.message ? e.message : String(e)) + ".";
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.status === 200) {
        const bytes = new Uint8Array(buf);
        if (bytes.length > LIMIT_BYTES) return { ok: false, error: "The answer is larger than " + LIMIT_BYTES / 1000000 + " million bytes, which the ECB's file is not." };
        return { ok: true, bytes };
      }
      last = "The ECB answered with HTTP " + res.status + " for " + url + ".";
      if (res.status !== 429 && res.status < 500) return { ok: false, error: last };
    }
    return { ok: false, error: last + " It was tried " + tries + " times." };
  }

  // ---------------------------------------------------------------- the job

  /**
   * o: { fetch, previousText, now (ISO timestamp), sleep, log, tries, backoffMs, timeoutMs, url }.
   * Returns { ok, error, changed, text, summary: { days, first, last, added, revised }, lines, warnings }.
   * ok is false when nothing may be saved; then text is "" and changed is false.
   */
  async function run(o) {
    const lines = [];
    const warnings = [];
    const say = (s) => {
      lines.push(s);
      if (o.log) o.log(s);
    };
    const summary = { days: 0, first: null, last: null, added: 0, revised: 0 };
    const stop = (error) => {
      lines.push(error); // the caller prints the error itself (as a GitHub annotation), so it is not logged twice
      return { ok: false, error, changed: false, text: "", summary, lines, warnings };
    };
    const now = String(o.now || "").replace(/\.\d+Z$/, "Z");
    const today = now.slice(0, 10);
    if (dn(today) === null) return stop("The clock gave no usable date (" + JSON.stringify(now.slice(0, 30)) + "), so the age of the file cannot be checked.");

    say("Downloading the ECB's history of reference rates.");
    const dl = await download(o);
    if (!dl.ok) return stop(dl.error);
    if (!Zip.looksLikeZip(dl.bytes)) return stop("The ECB's address did not return a ZIP file (" + dl.bytes.length + " bytes). It may have returned a web page.");
    const z = await Zip.firstText(dl.bytes, { limit: LIMIT_BYTES * 3 });
    if (!z.ok) return stop("The ECB's ZIP file could not be opened: " + z.error);
    if (!/\.csv$/i.test(z.name)) return stop("The ZIP file holds no CSV file (its first file is " + JSON.stringify(z.name.slice(0, 40)) + ").");

    const parsed = parseWide(z.text);
    if (!parsed.ok) return stop("The ECB's file cannot be used: " + parsed.error);
    const rows = parsed.rows;
    const series = checkSeries(rows, today);
    if (series.length) return stop("The ECB's file did not pass the checks, so nothing was saved: " + series.join(" "));

    let prev = null;
    if (typeof o.previousText === "string" && o.previousText.trim() !== "") {
      const p = parseWide(o.previousText);
      if (p.ok) prev = p.rows;
      else warnings.push("The file already saved could not be read (" + p.error + "). It is made again from scratch.");
    }
    let added = rows.length;
    let revised = [];
    if (prev) {
      const c = compare(prev, rows);
      if (c.problems.length) return stop(c.problems.join(" "));
      added = c.added;
      revised = c.revised;
      if (revised.length) {
        warnings.push(revised.length + " rate(s) of days already saved were revised by the ECB, for example " + list(revised.slice(0, MAX_LIST).map((x) => x.date + " " + x.currency + " " + x.old + " to " + x.new)) + ". The new rates are saved; the tracker asks you before it uses them.");
      }
    }

    // The file that is saved must read back as the same days, and the tracker's own reader must accept every currency in it.
    const text = serialize(rows);
    const back = parseWide(text);
    if (!back.ok || back.rows.length !== rows.length || back.rows.some((r, k) => r.date !== rows[k].date || r.cells.join(",") !== rows[k].cells.join(","))) {
      return stop("The new file did not read back as the same days, so it was not saved" + (back.ok ? "." : ": " + back.error));
    }
    for (const c of CURRENCIES) {
      const r = Ecb.readEcbFile(text, { currency: c, needFrom: rows[rows.length - 1].date, needTo: today });
      const numeric = rows.filter((x) => x.cells[CURRENCIES.indexOf(c)] !== "N/A").length;
      if (!r.ok || r.count !== numeric) return stop("The tracker's own reader does not accept the " + c + " rates of the new file (" + (r.ok ? r.count + " of " + numeric + " days read" : r.fatal) + "), so it was not saved.");
    }

    summary.days = rows.length;
    summary.first = rows[rows.length - 1].date;
    summary.last = rows[0].date;
    summary.added = added;
    summary.revised = revised.length;
    const same = prev !== null && typeof o.previousText === "string" && o.previousText.replace(/\r\n|\r/g, "\n") === text;
    say("Read " + rows.length + " days, " + summary.first + " to " + summary.last + ", for " + CURRENCIES.length + " currencies (" + parsed.dropped + " older days left out).");
    say(same ? "Nothing changed." : prev ? "The file has changed: " + added + " new day(s), " + revised.length + " revised rate(s)." : "There is no usable saved file yet: it is made now.");
    return { ok: true, error: "", changed: !same, text, summary, lines, warnings };
  }

  return { VERSION, SOURCE_URL, CURRENCIES, START_DATE, MAX_AGE_DAYS, USER_AGENT, parseWide, serialize, checkSeries, compare, download, run };
});

  return module.exports;
})();

// ---- the part that touches files, the network and the clock ------------------------------------------------------------------

async function main(d) {
  const log = d.log;
  const outPath = d.argv[0] || "data/ecb-rates.csv";
  if (typeof d.fetch !== "function" || typeof DecompressionStream !== "function") {
    log("This needs Node 22, or Node 20.12 or newer (it has to be able to download and to open a ZIP file).");
    return 1;
  }
  let previousText = "";
  try {
    previousText = d.fs.readFileSync(outPath, "utf8");
  } catch (e) {
    // there is no rate file yet
  }
  const r = await EcbJob.run({ fetch: d.fetch, previousText, now: d.now(), sleep: d.sleep, log });
  for (const w of r.warnings) log("::warning::" + w);
  if (!r.ok) {
    log("::error::" + r.error);
    return 1;
  }
  if (r.changed) {
    d.fs.mkdirSync(d.path.dirname(outPath), { recursive: true });
    d.fs.writeFileSync(outPath, r.text);
    log("Saved " + outPath + ".");
  }
  return 0;
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
  module.exports = { EcbJob, EcbFx, Zip, main };
}
