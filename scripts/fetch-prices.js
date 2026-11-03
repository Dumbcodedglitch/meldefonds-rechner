#!/usr/bin/env node
"use strict";
/*
 * fetch-prices.js
 *
 * Fetches the daily closing prices of the securities listed in data/tickers.txt from Yahoo Finance and saves them in
 * data/prices.json. It is made by the Austria Tax Tracker and runs as a scheduled job of this repository (see
 * .github/workflows/fetch-prices.yml). It needs Node 18 or newer and no packages.
 *
 * The prices are only used for the performance graphs of the tracker. They are never used for the tax.
 * Yahoo has no official interface for this, and it may refuse requests or change without notice. When that happens the job
 * keeps the prices it already has and says so; the tracker also accepts a history file downloaded by hand from Yahoo.
 *
 * Usage: node scripts/fetch-prices.js [data/tickers.txt] [data/prices.json]
 */

// ---- the price reader (src/prices/prices.js) ----------------------------------------------------------------------------------
const Prices = (function () {
  const module = { exports: {} };
/*
 * Prices: daily closing prices of securities. Reads Yahoo Finance's chart answer (used by the small job that fetches the prices),
 * reads and writes the price file this tracker keeps (data/prices.json), reads a history file downloaded by hand from the Yahoo
 * website, and looks a price up for a day.
 *
 * Prices are used for one thing only: the performance figures (what a holding was worth on a day). They never enter the tax
 * calculation. The tax uses the prices of the trades, the OeKB reports and the ECB rates.
 *
 * Rules of this module:
 *  - Pure functions: no network, no storage, no clock (today is passed in where it matters).
 *  - A price is kept as the text of a decimal number (for example "104.3000"), never as a float, so a file read and written again
 *    is the same file.
 *  - What Yahoo gives is turned into what was quoted on that day: Yahoo reports old prices already adjusted for later splits, so the
 *    old prices are multiplied back by the splits that came after them. Prices quoted in pence (GBp) are kept in pounds (GBP).
 *  - Prices that look wrong are reported, never repaired. A day without a price is a day without a price.
 *  - Nothing in this file contains real data.
 *
 * The price file (format "prices-v1"), one close per line so that a daily update changes only a few lines:
 *   { "format": "prices-v1", "generatedAt": "...", "source": "...",
 *     "symbols": { "XXET.DE": { "currency": "EUR", "name": "", "status": "ok", "error": "", "fetchedAt": "...",
 *                               "splits": [ { "date": "2022-06-01", "num": 2, "den": 1 } ],
 *                               "closes": [ ["2019-07-23","71.91"], ... ] } } }
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Prices = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "prices-0.1.0";
  const FORMAT = "prices-v1";
  const MAX_SYMBOLS = 500;
  const MAX_ROWS = 40000;
  const MAX_SYMBOL_LENGTH = 20;
  const MIN_PRICE = 1e-6; // a close below this is not a price
  const MAX_PRICE = 1e12;
  const JUMP_LIMIT = 0.4; // a one-day move of more than 40 % is reported
  const REVISION_TOLERANCE = 0.001; // a stored close that changes by more than 0.1 % when it is fetched again is reported

  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  const finite = (x) => typeof x === "number" && Number.isFinite(x);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ---------------------------------------------------------------- days

  function isIso(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === "string" ? s : "");
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1) return false;
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  }

  /** Whole days since 1970-01-01 of a valid ISO day, else null. */
  function dayNumber(iso) {
    if (!isIso(iso)) return null;
    return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  }

  const formatters = new Map();
  /** The calendar day, in the exchange's own time zone, of a moment given in seconds since 1970. */
  function localDate(seconds, tz, gmtoffset) {
    if (typeof tz === "string" && tz !== "") {
      try {
        let f = formatters.get(tz);
        if (!f) {
          f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
          formatters.set(tz, f);
        }
        const s = f.format(new Date(seconds * 1000));
        if (isIso(s)) return s;
      } catch (e) {
        /* an unknown zone: fall back to the offset */
      }
    }
    const off = finite(gmtoffset) ? gmtoffset : 0;
    return new Date((seconds + off) * 1000).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- decimals as text

  const DEC = /^(\d+)(?:\.(\d+))?$/;

  /**
   * Yahoo sends prices that went through a 32-bit float, so 52.1 arrives as 52.099998474121094. The shortest text that reads back
   * as the same 32-bit float is the price that was meant: "52.1". Only for numbers above zero and below 1e15.
   */
  function cleanFloat32(x) {
    const f = Math.fround(x);
    for (let d = 0; d <= 10; d++) {
      const t = x.toFixed(d);
      if (Math.fround(Number(t)) === f) return t;
    }
    return x.toFixed(10);
  }

  /**
   * A price that was multiplied by a split factor: six significant digits, at least two decimals ("100.009998" -> "100.010").
   * The 32-bit noise of the old price, multiplied by the factor, is far below the sixth digit; a real quote of a security has no
   * more digits than that.
   */
  function roundPrice(x) {
    const e = Math.floor(Math.log10(x)) + 1; // digits before the decimal point (zero or negative below 1)
    return x.toFixed(Math.min(10, Math.max(2, 6 - e)));
  }

  /** Leading zeros removed, trailing zeros removed, but at least two decimals: "0012.595000" -> "12.595", "50.0000" -> "50.00". */
  function tidy(s) {
    const m = DEC.exec(s);
    if (!m) return s;
    let frac = (m[2] || "").replace(/0+$/, "");
    if (frac.length < 2) frac = frac.padEnd(2, "0");
    return m[1].replace(/^0+(?=\d)/, "") + "." + frac;
  }

  /** Divides a decimal text by 100 exactly (pence to pounds): "1259.5000" -> "12.595000". */
  function shift2(s) {
    const m = DEC.exec(s);
    if (!m) return s;
    const digits = m[1] + (m[2] || "");
    const dp = (m[2] || "").length + 2;
    const padded = digits.padStart(dp + 1, "0");
    const int = padded.slice(0, padded.length - dp).replace(/^0+(?=\d)/, "");
    return int + "." + padded.slice(padded.length - dp);
  }

  /** A price quoted in pence (and in similar minor units) is kept in the main unit. */
  function normCurrency(raw) {
    const c = String(raw === undefined || raw === null ? "" : raw).trim();
    if (c === "GBp" || c === "GBX" || c === "GBx") return { ccy: "GBP", minor: true };
    if (c === "ZAc" || c === "ZAC") return { ccy: "ZAR", minor: true };
    if (c === "ILA") return { ccy: "ILS", minor: true };
    if (/^[A-Za-z]{3}$/.test(c)) return { ccy: c.toUpperCase(), minor: false };
    return null;
  }

  // ---------------------------------------------------------------- symbols

  /** A Yahoo symbol: letters, digits and . - = ^ _ ("VWCE.DE", "BRK-B", "^GSPC", "EURUSD=X"). Returns { ok, symbol, error }. */
  function checkSymbol(raw) {
    const t = String(raw === undefined || raw === null ? "" : raw).trim().toUpperCase();
    if (t === "") return { ok: false, symbol: "", error: "Enter the Yahoo symbol." };
    if (t.length > MAX_SYMBOL_LENGTH) return { ok: false, symbol: "", error: "A Yahoo symbol has at most " + MAX_SYMBOL_LENGTH + " characters." };
    if (!/^[A-Z0-9^][A-Z0-9.\-=_^]*$/.test(t)) return { ok: false, symbol: "", error: "A Yahoo symbol has only letters, digits and . - = ^ _ (for example VWCE.DE)." };
    return { ok: true, symbol: t, error: "" };
  }

  // PortfolioSlicer-style endings and the ending Yahoo uses for the same market. Only a suggestion: the owner checks it.
  const MARKET_SUFFIX = { UK: "L", GB: "L", LN: "L", DE: "DE", FR: "PA", NL: "AS", IT: "MI", CH: "SW", AT: "VI", ES: "MC", SE: "ST", DK: "CO", NO: "OL", FI: "HE", PT: "LS", IE: "IR", BE: "BR" };

  /**
   * A guess for the Yahoo symbol of a ticker as the transaction file spells it. Returns the symbol (upper case) or "".
   * "VWCE.DE" stays "VWCE.DE"; "ABCD.UK" becomes "ABCD.L"; "ABC.US" becomes "ABC"; an ending that is not known stays as it is.
   */
  function suggestSymbol(ticker) {
    const t = String(ticker === undefined || ticker === null ? "" : ticker).trim().toUpperCase();
    if (t === "") return "";
    const m = /^([A-Z0-9^\-]+)\.([A-Z]{1,3})$/.exec(t);
    if (!m) return checkSymbol(t).ok ? t : "";
    if (m[2] === "US") return m[1];
    return Object.prototype.hasOwnProperty.call(MARKET_SUFFIX, m[2]) ? m[1] + "." + MARKET_SUFFIX[m[2]] : t;
  }

  // ---------------------------------------------------------------- Yahoo's chart answer

  /**
   * Turns the JSON answer of  https://query2.finance.yahoo.com/v8/finance/chart/<symbol>?interval=1d&events=div|split  into closes.
   * opts: { today: "YYYY-MM-DD" (UTC day of the request: the bar of that day is dropped, it may still be moving),
   *         expect: the symbol that was asked for (an answer for another symbol is refused) }
   * Returns { ok, error, symbol, currency, name, splits, closes, problems, stats }.
   *   closes   [[day, price text]] ascending, the price that was quoted on that day, in the main unit of the currency
   *   problems [{ level: "info"|"warn", code, text }]
   */
  function fromYahooChart(json, opts) {
    const o = opts || {};
    const out = { ok: false, error: "", symbol: "", currency: "", name: "", splits: [], closes: [], problems: [], stats: { bars: 0, nulls: 0, duplicates: 0, droppedToday: 0, jumps: 0 } };
    const note = (level, code, text) => out.problems.push({ level, code, text });
    const fail = (text) => {
      out.error = text;
      return out;
    };
    if (!isObj(json) || !isObj(json.chart)) return fail("This is not a Yahoo chart answer.");
    if (json.chart.error) {
      const e = json.chart.error;
      return fail("Yahoo says: " + (isObj(e) && (e.description || e.code) ? String(e.description || e.code).slice(0, 200) : "there is an error."));
    }
    const res = Array.isArray(json.chart.result) ? json.chart.result[0] : null;
    if (!isObj(res)) return fail("The answer holds no result.");
    const meta = isObj(res.meta) ? res.meta : {};
    const sym = checkSymbol(meta.symbol);
    if (!sym.ok) return fail("The answer does not name its symbol.");
    out.symbol = sym.symbol;
    if (typeof o.expect === "string" && o.expect.trim() !== "" && o.expect.trim().toUpperCase() !== sym.symbol) {
      return fail("Yahoo answered for " + sym.symbol + " although " + o.expect.trim().toUpperCase() + " was asked for.");
    }
    const cur = normCurrency(meta.currency);
    if (!cur) return fail("The answer has no usable currency (" + String(meta.currency).slice(0, 12) + ").");
    out.currency = cur.ccy;
    out.name = typeof meta.longName === "string" ? meta.longName.slice(0, 120) : typeof meta.shortName === "string" ? meta.shortName.slice(0, 120) : "";
    if (cur.minor) note("info", "PENCE", "Prices are quoted in " + String(meta.currency) + " (hundredths of " + cur.ccy + "); they are kept in " + cur.ccy + ".");
    const tz = typeof meta.exchangeTimezoneName === "string" ? meta.exchangeTimezoneName : "";
    const gmt = finite(meta.gmtoffset) ? meta.gmtoffset : 0;
    const stamps = res.timestamp;
    const quote = isObj(res.indicators) && Array.isArray(res.indicators.quote) ? res.indicators.quote[0] : null;
    if (stamps === undefined || stamps === null) {
      // Yahoo leaves the timestamps out when the asked period has no trading day.
      out.ok = true;
      note("info", "NO_BARS", "There is no trading day in the period that was asked for.");
      return out;
    }
    if (!Array.isArray(stamps) || !isObj(quote) || !Array.isArray(quote.close)) return fail("The answer has no daily closes.");
    if (stamps.length !== quote.close.length) return fail("The answer has " + stamps.length + " days but " + quote.close.length + " closes.");
    out.stats.bars = stamps.length;

    // splits: the first day that trades at the new ratio, and the ratio
    const splits = [];
    const ev = isObj(res.events) && isObj(res.events.splits) ? res.events.splits : {};
    for (const k of Object.keys(ev)) {
      const s = ev[k];
      if (!isObj(s) || !finite(s.date) || !finite(s.numerator) || !finite(s.denominator) || s.numerator <= 0 || s.denominator <= 0) {
        note("warn", "SPLIT_UNREADABLE", "A split entry could not be read and was ignored.");
        continue;
      }
      splits.push({ date: localDate(s.date, tz, gmt), num: s.numerator, den: s.denominator });
    }
    splits.sort((a, b) => cmp(a.date, b.date));
    out.splits = splits;

    // one close per day; a later moment of the same day wins
    const byDay = new Map();
    for (let i = 0; i < stamps.length; i++) {
      const t = stamps[i];
      const c = quote.close[i];
      if (!finite(t)) {
        out.stats.nulls++;
        continue;
      }
      if (c === null || c === undefined || !finite(c) || c < MIN_PRICE || c > MAX_PRICE) {
        out.stats.nulls++;
        continue;
      }
      const day = localDate(t, tz, gmt);
      if (typeof o.today === "string" && isIso(o.today) && day >= o.today) {
        out.stats.droppedToday++;
        continue;
      }
      const prev = byDay.get(day);
      if (prev) {
        out.stats.duplicates++;
        if (prev.t > t) continue;
      }
      byDay.set(day, { t, c });
    }
    const days = Array.from(byDay.keys()).sort();
    if (out.stats.nulls) note("info", "NULLS_SKIPPED", out.stats.nulls + " days without a price were skipped (holidays or halts).");
    if (out.stats.duplicates) note("warn", "DUPLICATE_DAY", out.stats.duplicates + " days had two prices; the later one was kept.");
    if (out.stats.droppedToday) note("info", "TODAY_DROPPED", "The price of today was left out, it may still change.");

    // undo the adjustment for later splits, newest day first
    let factor = 1;
    let si = splits.length - 1;
    const rows = [];
    const shown = []; // the closes as Yahoo shows them (adjusted for splits), for the check of big moves
    for (let i = days.length - 1; i >= 0; i--) {
      const day = days[i];
      while (si >= 0 && splits[si].date > day) {
        factor *= splits[si].num / splits[si].den;
        si--;
      }
      const clean = cleanFloat32(byDay.get(day).c);
      let text = factor === 1 ? clean : roundPrice(Number(clean) * factor);
      if (cur.minor) text = shift2(text);
      rows.push([day, tidy(text)]);
      shown.push(Number(clean));
    }
    rows.reverse();
    shown.reverse();
    out.closes = rows;
    if (splits.length) note("info", "SPLIT_UNADJUSTED", splits.length + " split(s) in the period: older prices are shown as they were quoted before the split.");

    // A move of more than 40 % in one day is probably a split that Yahoo does not know or a wrong price. The check looks at the
    // closes as Yahoo shows them, where a split that Yahoo knows leaves no step.
    const jumps = [];
    for (let i = 1; i < shown.length; i++) {
      if (shown[i - 1] > 0 && Math.abs(shown[i] / shown[i - 1] - 1) > JUMP_LIMIT) jumps.push(rows[i][0]);
    }
    out.stats.jumps = jumps.length;
    if (jumps.length) note("warn", "JUMP", jumps.length + " one-day moves of more than " + Math.round(JUMP_LIMIT * 100) + " %, for example on " + jumps.slice(0, 3).join(", ") + ". Check these days: a split or a wrong price would show like this.");
    out.ok = true;
    return out;
  }

  // ---------------------------------------------------------------- a history downloaded by hand

  const BOM = new RegExp("^" + String.fromCharCode(0xfeff));

  /** One line of a comma separated file into its values; a value in double quotes may hold commas, "" is a quote. */
  function splitCsvLine(line) {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  /**
   * Reads the CSV that the Yahoo website offers under "Historical data" (Date,Open,High,Low,Close,Adj Close,Volume).
   * Only Date and Close are used. opts: { currency } the currency the prices are quoted in, as Yahoo shows it ("EUR", "USD", "GBp").
   * Prices in pence are kept in pounds. Returns { ok, error, currency, closes, problems }.
   * Yahoo has already adjusted these closes for splits that came later, and this file does not say whether there were any: a
   * security that had a split needs the price file made by the job instead (the check of your own trade prices against these
   * closes shows the difference).
   */
  function fromYahooCsv(text, opts) {
    const o = opts || {};
    const out = { ok: false, error: "", currency: "", closes: [], problems: [] };
    let cur = null;
    if (o.currency !== undefined && o.currency !== null && String(o.currency).trim() !== "") {
      cur = normCurrency(o.currency);
      if (!cur) {
        out.error = "The currency " + JSON.stringify(String(o.currency).slice(0, 12)) + " is not usable. Use the three letters Yahoo shows (EUR, USD, GBP) or GBp for pence.";
        return out;
      }
      out.currency = cur.ccy;
      if (cur.minor) out.problems.push({ level: "info", code: "PENCE", text: "Prices are quoted in " + String(o.currency).trim() + " (hundredths of " + cur.ccy + "); they are kept in " + cur.ccy + "." });
    }
    const lines = String(text === undefined || text === null ? "" : text).replace(BOM, "").split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
    if (lines.length < 2) {
      out.error = "The file has no rows.";
      return out;
    }
    const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const di = head.indexOf("date");
    const ci = head.indexOf("close");
    if (di < 0 || ci < 0) {
      out.error = "The first line must name the columns Date and Close (the Yahoo download has Date,Open,High,Low,Close,Adj Close,Volume).";
      return out;
    }
    const byDay = new Map();
    let skipped = 0;
    for (let i = 1; i < lines.length; i++) {
      const c = splitCsvLine(lines[i]);
      if (c.length !== head.length) {
        out.error = "Line " + (i + 1) + " has " + c.length + " values but the first line names " + head.length + " columns.";
        return out;
      }
      const day = c[di];
      const v = c[ci];
      if (!isIso(day)) {
        out.error = "Line " + (i + 1) + " has a date that is not yyyy-mm-dd.";
        return out;
      }
      if (v === undefined || v === "" || v.toLowerCase() === "null" || v.toLowerCase() === "nan") {
        skipped++;
        continue;
      }
      if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) {
        out.error = "Line " + (i + 1) + " has a close that is not a positive number with a dot.";
        return out;
      }
      byDay.set(day, cur && cur.minor ? tidy(shift2(v)) : tidy(v));
    }
    out.closes = Array.from(byDay.entries()).sort((a, b) => cmp(a[0], b[0]));
    if (skipped) out.problems.push({ level: "info", code: "NULLS_SKIPPED", text: skipped + " days without a close were skipped." });
    if (!out.closes.length) {
      out.error = "The file has no usable close.";
      return out;
    }
    out.ok = true;
    return out;
  }

  // ---------------------------------------------------------------- merging a new fetch into stored closes

  /**
   * Adds the closes of a new fetch to the stored ones. A day that is in both takes the new close. Returns
   * { closes, added, replaced, revised: [days whose stored close changed by more than 0.1 %] }.
   */
  function mergeCloses(oldCloses, newCloses) {
    const m = new Map();
    for (const r of oldCloses || []) m.set(r[0], r[1]);
    let added = 0;
    let replaced = 0;
    const revised = [];
    for (const r of newCloses || []) {
      if (!m.has(r[0])) added++;
      else if (m.get(r[0]) !== r[1]) {
        replaced++;
        const a = Number(m.get(r[0]));
        if (a > 0 && Math.abs(Number(r[1]) / a - 1) > REVISION_TOLERANCE) revised.push(r[0]);
      }
      m.set(r[0], r[1]);
    }
    return { closes: Array.from(m.entries()).sort((a, b) => cmp(a[0], b[0])), added, replaced, revised };
  }

  // ---------------------------------------------------------------- the price file

  function emptyStore() {
    return { format: FORMAT, generatedAt: "", source: "", symbols: {} };
  }

  /**
   * Checks one entry of the file; returns { ok, entry, error }. Prices must be ascending days with positive decimal texts.
   * The currency may be left empty only for a symbol whose fetch failed and that has no closes (nothing is known about it).
   */
  function checkEntry(symbol, e) {
    if (!isObj(e)) return { ok: false, error: "is not an object" };
    if (!Array.isArray(e.closes)) return { ok: false, error: "has no list of closes" };
    const unknownOk = e.status === "error" && e.closes.length === 0 && (e.currency === "" || e.currency === undefined || e.currency === null);
    const cur = unknownOk ? { ccy: "", minor: false } : normCurrency(e.currency);
    if (!cur || cur.minor) return { ok: false, error: "has no usable currency (use the main unit, for example GBP)" };
    if (e.closes.length > MAX_ROWS) return { ok: false, error: "has more than " + MAX_ROWS + " closes" };
    let last = "";
    const closes = [];
    for (let i = 0; i < e.closes.length; i++) {
      const r = e.closes[i];
      if (!Array.isArray(r) || r.length < 2 || !isIso(r[0]) || typeof r[1] !== "string" || !DEC.test(r[1]) || !(Number(r[1]) > 0)) return { ok: false, error: "has an unreadable close at position " + (i + 1) };
      if (r[0] <= last) return { ok: false, error: "has days that are not in ascending order at " + r[0] };
      last = r[0];
      closes.push([r[0], r[1]]);
    }
    const splits = [];
    for (const s of Array.isArray(e.splits) ? e.splits : []) {
      if (isObj(s) && isIso(s.date) && finite(s.num) && finite(s.den) && s.num > 0 && s.den > 0) splits.push({ date: s.date, num: s.num, den: s.den });
    }
    return {
      ok: true,
      entry: {
        currency: cur.ccy,
        name: typeof e.name === "string" ? e.name.slice(0, 120) : "",
        status: e.status === "error" ? "error" : "ok",
        error: typeof e.error === "string" ? e.error.slice(0, 300) : "",
        fetchedAt: typeof e.fetchedAt === "string" ? e.fetchedAt.slice(0, 40) : "",
        splits,
        closes,
      },
    };
  }

  /**
   * Reads the text of a price file. Returns { ok, error, store, problems }. A symbol that cannot be read is left out with a reason;
   * the rest is kept. A file that is not a price file at all is refused.
   */
  function parseStore(text) {
    let j;
    try {
      j = JSON.parse(String(text === undefined || text === null ? "" : text));
    } catch (e) {
      return { ok: false, error: "The file is not valid JSON.", store: emptyStore(), problems: [] };
    }
    return normalizeStore(j);
  }

  /** The same for a store that is already an object (what the page keeps in the browser). Nothing in the input is changed. */
  function normalizeStore(j) {
    const out = { ok: false, error: "", store: emptyStore(), problems: [] };
    if (!isObj(j) || j.format !== FORMAT) {
      out.error = "This is not a price file (it does not say format \"" + FORMAT + "\").";
      return out;
    }
    if (!isObj(j.symbols)) {
      out.error = "The price file has no symbols.";
      return out;
    }
    const names = Object.keys(j.symbols);
    if (names.length > MAX_SYMBOLS) {
      out.error = "The price file has more than " + MAX_SYMBOLS + " symbols.";
      return out;
    }
    out.store.generatedAt = typeof j.generatedAt === "string" ? j.generatedAt.slice(0, 40) : "";
    out.store.source = typeof j.source === "string" ? j.source.slice(0, 120) : "";
    for (const name of names.sort()) {
      const sym = checkSymbol(name);
      if (!sym.ok || sym.symbol !== name) {
        out.problems.push("The symbol " + JSON.stringify(String(name).slice(0, 30)) + " is not a valid Yahoo symbol and was left out.");
        continue;
      }
      const c = checkEntry(name, j.symbols[name]);
      if (!c.ok) {
        out.problems.push(name + " " + c.error + " and was left out.");
        continue;
      }
      out.store.symbols[name] = c.entry;
    }
    out.ok = true;
    return out;
  }

  /** The text of a price file: the header lines, then every symbol, one close per line. Stable: the same store gives the same text. */
  function serializeStore(store) {
    const s = store || emptyStore();
    const q = (x) => JSON.stringify(x);
    const names = Object.keys(s.symbols || {}).sort();
    const parts = [];
    for (const n of names) {
      const e = s.symbols[n];
      const rows = e.closes.map((r) => "    [" + q(r[0]) + "," + q(r[1]) + "]").join(",\n");
      parts.push(
        "  " + q(n) + ": {\n" +
          "   \"currency\": " + q(e.currency) + ",\n" +
          "   \"name\": " + q(e.name || "") + ",\n" +
          "   \"status\": " + q(e.status === "error" ? "error" : "ok") + ",\n" +
          "   \"error\": " + q(e.error || "") + ",\n" +
          "   \"fetchedAt\": " + q(e.fetchedAt || "") + ",\n" +
          "   \"splits\": " + q(e.splits || []) + ",\n" +
          "   \"closes\": [" + (rows ? "\n" + rows + "\n   " : "") + "]\n" +
          "  }"
      );
    }
    return "{\n \"format\": " + q(FORMAT) + ",\n \"generatedAt\": " + q(s.generatedAt || "") + ",\n \"source\": " + q(s.source || "") + ",\n \"symbols\": {" + (parts.length ? "\n" + parts.join(",\n") + "\n " : "") + "}\n}\n";
  }

  /** What one symbol holds: { rows, first, last }. */
  function describe(entry) {
    const c = entry && Array.isArray(entry.closes) ? entry.closes : [];
    return { rows: c.length, first: c.length ? c[0][0] : "", last: c.length ? c[c.length - 1][0] : "" };
  }

  // ---------------------------------------------------------------- looking a price up

  /**
   * A series for fast lookups from the closes of one symbol.
   * at(day, maxLagDays): the last close on or before the day, { ok, day, close (number), lag } or { ok: false, reason }.
   */
  function makeSeries(closes) {
    const list = Array.isArray(closes) ? closes : [];
    const n = list.length;
    const dns = list.map((r) => dayNumber(r[0]));
    const px = list.map((r) => Number(r[1]));
    function at(day, maxLagDays) {
      const dn = dayNumber(day);
      if (dn === null) return { ok: false, reason: "not a day" };
      if (!n || dn < dns[0]) return { ok: false, reason: "no price on or before " + day };
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (dns[mid] <= dn) lo = mid;
        else hi = mid - 1;
      }
      const lag = dn - dns[lo];
      const max = maxLagDays === undefined ? 10 : maxLagDays;
      if (lag > max) return { ok: false, reason: "the last price before " + day + " is from " + list[lo][0] + ", " + lag + " days earlier", lastDay: list[lo][0], lag };
      return { ok: true, day: list[lo][0], close: px[lo], lag };
    }
    return { count: n, first: n ? list[0][0] : "", last: n ? list[n - 1][0] : "", at };
  }

  return { VERSION, FORMAT, MAX_SYMBOLS, MAX_ROWS, isIso, dayNumber, localDate, cleanFloat32, roundPrice, tidy, shift2, normCurrency, checkSymbol, suggestSymbol, fromYahooChart, fromYahooCsv, mergeCloses, emptyStore, checkEntry, parseStore, normalizeStore, serializeStore, describe, makeSeries };
});

  return module.exports;
})();

// ---- the job (src/prices/job.js) -----------------------------------------------------------------------------------------------
const PriceJob = (function () {
  const module = { exports: {} };
const require = (p) => { if (p === "./prices.js") return Prices; throw new Error("unexpected require " + p); };
/*
 * PriceJob: the job that fetches the daily closing prices from Yahoo Finance and keeps the price file (data/prices.json) up to date.
 *
 * It runs as a scheduled job of the owner's own GitHub repository, not in the tracker page: Yahoo does not let other web sites read
 * its prices from a browser. The tracker only reads the price file this job writes (next to the page, on the same site).
 *
 * Rules of this module:
 *  - The network, the clock and the pause between requests are passed in, so the tests run it without any of them.
 *  - Yahoo's interface is not an official one and may refuse a request or change. Every failure is kept per symbol, with a plain
 *    sentence; the prices that were fetched earlier are kept. The job fails (so GitHub tells the owner) only when not one symbol
 *    could be fetched.
 *  - Closes are only added or replaced, never deleted. A close that changes by more than 0.1 % is reported.
 *  - A file that does not read back as a valid price file is never written.
 *  - Nothing in this file contains real data.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./prices.js"));
  else root.PriceJob = factory(root.Prices);
})(typeof self !== "undefined" ? self : this, function (Prices) {
  "use strict";

  const VERSION = "pricejob-0.1.0";
  const START_DATE = "2015-01-01"; // the first day fetched, unless the list of symbols says otherwise (a line  @start 2012-01-01)
  const HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const SOURCE = "Yahoo Finance";
  const PAUSE_MS = 1500;
  const BACKOFF_MS = [2000, 6000, 15000];

  // ---------------------------------------------------------------- the list of symbols

  /**
   * Reads data/tickers.txt: one Yahoo symbol per line; # starts a comment; a line  @start 2012-01-01  sets the first day fetched.
   * Returns { symbols, start, problems }. A line that is not a symbol is skipped and reported.
   */
  function parseTickers(text) {
    const out = { symbols: [], start: START_DATE, problems: [] };
    const seen = new Set();
    String(text === undefined || text === null ? "" : text)
      .split(/\r\n|\n|\r/)
      .forEach((raw, i) => {
        const line = raw.replace(/#.*$/, "").trim();
        if (line === "") return;
        if (line.charAt(0) === "@") {
          const m = /^@start\s+(\d{4}-\d{2}-\d{2})$/i.exec(line);
          if (m && Prices.isIso(m[1])) out.start = m[1];
          else out.problems.push("Line " + (i + 1) + ": " + JSON.stringify(line.slice(0, 40)) + " is not understood. Write  @start 2015-01-01  to set the first day.");
          return;
        }
        const c = Prices.checkSymbol(line);
        if (!c.ok) {
          out.problems.push("Line " + (i + 1) + ": " + JSON.stringify(line.slice(0, 30)) + " is not a Yahoo symbol and is skipped.");
          return;
        }
        if (seen.has(c.symbol)) return;
        seen.add(c.symbol);
        out.symbols.push(c.symbol);
      });
    if (out.symbols.length > Prices.MAX_SYMBOLS) {
      out.problems.push("More than " + Prices.MAX_SYMBOLS + " symbols are listed; only the first " + Prices.MAX_SYMBOLS + " are fetched.");
      out.symbols = out.symbols.slice(0, Prices.MAX_SYMBOLS);
    }
    return out;
  }

  // ---------------------------------------------------------------- one symbol

  /** The address of Yahoo's chart answer for daily bars from a day (ISO) to a moment (seconds since 1970). */
  function chartUrl(symbol, startIso, toSeconds, host) {
    const from = Math.floor(Date.UTC(+startIso.slice(0, 4), +startIso.slice(5, 7) - 1, +startIso.slice(8, 10)) / 1000);
    return "https://" + (host || HOSTS[0]) + "/v8/finance/chart/" + encodeURIComponent(symbol) + "?period1=" + from + "&period2=" + toSeconds + "&interval=1d&events=div%7Csplit&includePrePost=false";
  }

  /**
   * Fetches one symbol, with a few tries (a refused or failed request is tried again after a pause, on the other Yahoo host).
   * o: { fetch, start (ISO), to (seconds), today (ISO), sleep, tries, backoffMs, timeoutMs }
   * Returns { ok, result (see Prices.fromYahooChart), error, attempts }.
   */
  async function fetchSymbol(symbol, o) {
    const tries = o.tries || 4;
    const backoff = o.backoffMs || BACKOFF_MS;
    const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let last = "no answer";
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (attempt > 1) await sleep(backoff[Math.min(attempt - 2, backoff.length - 1)]);
      const url = chartUrl(symbol, o.start, o.to, HOSTS[(attempt - 1) % HOSTS.length]);
      let status = 0;
      let body = "";
      try {
        const init = { headers: { "User-Agent": USER_AGENT, Accept: "application/json,text/plain,*/*" } };
        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(o.timeoutMs || 20000);
        const res = await o.fetch(url, init);
        status = res.status;
        body = await res.text();
      } catch (e) {
        last = "network error (" + String(e && e.message ? e.message : e).slice(0, 80) + ")";
        continue;
      }
      if (status === 429 || status >= 500) {
        last = "Yahoo answered " + status + (status === 429 ? " (too many requests)" : "");
        continue;
      }
      let json;
      try {
        json = JSON.parse(body);
      } catch (e) {
        last = "Yahoo's answer (" + status + ") was not price data";
        if (status >= 400) return { ok: false, result: null, error: last, attempts: attempt };
        continue;
      }
      const r = Prices.fromYahooChart(json, { today: o.today, expect: symbol });
      if (r.ok) return { ok: true, result: r, error: "", attempts: attempt };
      if (/too many requests|rate limit/i.test(r.error)) {
        last = r.error;
        continue;
      }
      return { ok: false, result: null, error: r.error, attempts: attempt };
    }
    return { ok: false, result: null, error: last + " after " + tries + " tries", attempts: tries };
  }

  // ---------------------------------------------------------------- the price file

  const withoutTimes = (store) => {
    const j = JSON.parse(JSON.stringify(store));
    j.generatedAt = "";
    for (const k of Object.keys(j.symbols)) j.symbols[k].fetchedAt = "";
    return Prices.serializeStore(j);
  };

  /** True when two price files hold the same prices, splits and failures (the times they were made are ignored). */
  function sameData(a, b) {
    return withoutTimes(a) === withoutTimes(b);
  }

  const unionSplits = (a, b) => {
    const m = new Map();
    for (const s of (a || []).concat(b || [])) m.set(s.date + "|" + s.num + "|" + s.den, s);
    return Array.from(m.values()).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  };

  /**
   * One run of the job.
   * o: { tickersText, previousText (the price file as it is now, or ""), fetch, now (ISO timestamp), sleep, pauseMs, tries, log }
   * Returns { ok, changed, text, summary, lines, warnings }. text is the new price file; it is only to be written when changed.
   */
  async function run(o) {
    const lines = [];
    const warnings = [];
    const say = (s) => {
      lines.push(s);
      if (o.log) o.log(s);
    };
    const warn = (s) => {
      warnings.push(s);
      say("Warning: " + s);
    };
    const summary = { symbols: 0, fetched: 0, failed: 0, added: 0, replaced: 0, revised: 0 };
    const now = String(o.now || "").replace(/\.\d+Z$/, "Z");
    const tickers = parseTickers(o.tickersText);
    for (const p of tickers.problems) warn(p);
    if (!tickers.symbols.length) {
      say("No symbols are listed in the tickers file, so there is nothing to fetch.");
      return { ok: true, changed: false, text: "", summary, lines, warnings };
    }
    let prev = null;
    if (typeof o.previousText === "string" && o.previousText.trim() !== "") {
      const p = Prices.parseStore(o.previousText);
      if (p.ok) {
        prev = p.store;
        for (const m of p.problems) warn("In the existing price file: " + m);
      } else warn("The existing price file could not be read (" + p.error + "). It is made again from scratch.");
    }
    const prevSymbols = prev ? prev.symbols : {};
    const store = Prices.emptyStore();
    store.source = SOURCE;
    store.generatedAt = now;
    const today = now.slice(0, 10);
    const to = Math.floor(Date.parse(now) / 1000) + 86400;
    const pause = o.pauseMs === undefined ? PAUSE_MS : o.pauseMs;
    const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    summary.symbols = tickers.symbols.length;
    say("Fetching " + tickers.symbols.length + " symbols from " + tickers.start + ".");

    for (let i = 0; i < tickers.symbols.length; i++) {
      const symbol = tickers.symbols[i];
      if (i > 0 && pause > 0) await sleep(pause);
      const old = prevSymbols[symbol] || null;
      const r = await fetchSymbol(symbol, { fetch: o.fetch, start: tickers.start, to, today, sleep, tries: o.tries, backoffMs: o.backoffMs, timeoutMs: o.timeoutMs });
      const keepOld = (reason) => {
        summary.failed++;
        store.symbols[symbol] = old ? Object.assign({}, old, { status: "error", error: reason }) : { currency: "", name: "", status: "error", error: reason, fetchedAt: "", splits: [], closes: [] };
        warn(symbol + ": " + reason + (old && old.closes.length ? " The prices fetched earlier are kept." : ""));
      };
      if (!r.ok) {
        keepOld(r.error);
        continue;
      }
      const f = r.result;
      if (old && old.closes.length && f.closes.length && old.currency !== f.currency) {
        keepOld("The currency is " + f.currency + " now but the prices kept so far are in " + old.currency + ", so this looks like another security. Nothing was changed.");
        continue;
      }
      const m = Prices.mergeCloses(old ? old.closes : [], f.closes);
      store.symbols[symbol] = { currency: f.currency, name: f.name || (old ? old.name : ""), status: "ok", error: "", fetchedAt: now, splits: unionSplits(old ? old.splits : [], f.splits), closes: m.closes };
      summary.fetched++;
      summary.added += m.added;
      summary.replaced += m.replaced;
      summary.revised += m.revised.length;
      say("OK " + symbol + ": " + m.closes.length + " closes, " + m.added + " new" + (m.replaced ? ", " + m.replaced + " replaced" : "") + (r.attempts > 1 ? " (after " + r.attempts + " tries)" : "") + ".");
      if (m.revised.length) warn(symbol + ": " + m.revised.length + " earlier closes changed by more than 0.1 %, for example on " + m.revised.slice(0, 3).join(", ") + ". The new values were taken.");
      if (!f.closes.length) warn(symbol + ": Yahoo sent no trading day for the period.");
      for (const p of f.problems) if (p.code === "JUMP") warn(symbol + ": " + p.text);
    }

    const text = Prices.serializeStore(store);
    // never write a file that does not read back as the same prices
    const back = Prices.parseStore(text);
    if (!back.ok || back.problems.length || Object.keys(back.store.symbols).length !== Object.keys(store.symbols).length) {
      throw new Error("The new price file did not read back correctly, so it was not written: " + (back.ok ? back.problems.join(" ") : back.error));
    }
    const changed = !prev || !sameData(prev, back.store);
    const ok = summary.fetched > 0;
    if (!ok) say("Not one symbol could be fetched.");
    else say(changed ? "The price file has changed: " + summary.added + " new closes, " + summary.replaced + " replaced, " + summary.failed + " failed." : "Nothing changed.");
    return { ok, changed: ok && changed, text, summary, lines, warnings };
  }

  return { VERSION, START_DATE, HOSTS, USER_AGENT, PAUSE_MS, parseTickers, chartUrl, fetchSymbol, sameData, run };
});

  return module.exports;
})();

// ---- the part that touches files, the network and the clock ------------------------------------------------------------------

async function main(d) {
  const log = d.log;
  const tickersPath = d.argv[0] || "data/tickers.txt";
  const outPath = d.argv[1] || "data/prices.json";
  if (typeof d.fetch !== "function") {
    log("This needs Node 18 or newer (it has to be able to download).");
    return 1;
  }
  let tickersText;
  try {
    tickersText = d.fs.readFileSync(tickersPath, "utf8");
  } catch (e) {
    log("The list of symbols (" + tickersPath + ") could not be read: " + (e && e.message ? e.message : e));
    return 1;
  }
  let previousText = "";
  try {
    previousText = d.fs.readFileSync(outPath, "utf8");
  } catch (e) {
    // there is no price file yet
  }
  const r = await PriceJob.run({ tickersText, previousText, fetch: d.fetch, now: d.now(), sleep: d.sleep, log });
  for (const w of r.warnings) log("::warning::" + w);
  if (r.changed) {
    d.fs.mkdirSync(d.path.dirname(outPath), { recursive: true });
    d.fs.writeFileSync(outPath, r.text);
    log("Saved " + outPath + ".");
  }
  return r.ok ? 0 : 1;
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
  module.exports = { Prices, PriceJob, main };
}
