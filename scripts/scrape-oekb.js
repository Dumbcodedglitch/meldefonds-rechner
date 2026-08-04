// scrape-oekb.js
//
// Automates my.oekb.at to collect Meldefonds tax-reporting data (Ausschüttungsgleiche
// Erträge, anzurechnende ausländische Quellensteuer, Anschaffungskosten-Korrektur) for a
// list of ISINs, across every reporting year found, using the "Privatanleger ohne Option"
// column (correct for foreign-broker holders).
//
// This is a direct Node/Playwright port of the DOM-extraction logic already verified in the
// oekb-autofill.user.js browser script — same selectors, same column choice, same Meldedatum
// handling — just run headlessly on a schedule instead of manually in a browser tab.
//
// Usage:
//   node scripts/scrape-oekb.js data/isins.txt data/oekb-data.json [fromYear]
//
// Output JSON shape matches what the Tampermonkey script produces, so it can be imported
// directly into the Meldefonds-Rechner via "Daten vom Auto-Abruf-Script importieren".

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = 'https://my.oekb.at/kapitalmarkt-services/kms-output/fonds-info/sd/af/f';

function parseGermanDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  return { iso: `${m[3]}-${m[2]}-${m[1]}`, year: parseInt(m[3], 10) };
}

function parseNum(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// ---- DOM-extraction functions, run inside the page via page.evaluate ----
// (kept as plain strings/functions so they execute in browser context, not Node context)

async function findHistoryPeriods(page) {
  return page.evaluate(() => {
    function parseGermanDateInPage(str) {
      if (!str) return null;
      const m = str.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (!m) return null;
      return { iso: `${m[3]}-${m[2]}-${m[1]}`, year: parseInt(m[3], 10) };
    }
    const tables = Array.from(document.querySelectorAll('table'));
    for (const t of tables) {
      const headers = Array.from(t.querySelectorAll('th')).map(th => (th.textContent || '').trim());
      const dateIdx = headers.indexOf('Meldedatum');
      const idIdx = headers.indexOf('Melde-ID');
      if (dateIdx === -1 || idIdx === -1) continue;
      const rows = Array.from(t.querySelectorAll('tbody tr'));
      const periods = rows.map(r => {
        const cells = Array.from(r.querySelectorAll('td')).map(td => (td.textContent || '').trim());
        const d = parseGermanDateInPage(cells[dateIdx]);
        const stmId = cells[idIdx];
        if (!d || !stmId) return null;
        return { stmId, meldedatum: d.iso, year: d.year };
      }).filter(Boolean);
      if (periods.length) return periods;
    }
    return null;
  });
}

async function extractTaxData(page) {
  return page.evaluate(() => {
    function findTableRowValue(labelStart) {
      const cells = Array.from(document.querySelectorAll('td.sticky, td.border, td'));
      for (const cell of cells) {
        const txt = (cell.textContent || '').trim();
        if (txt.startsWith(labelStart)) {
          const row = cell.closest('tr');
          if (!row) continue;
          const valueCells = Array.from(row.querySelectorAll('td.text-right'));
          if (valueCells.length === 0) continue;
          const last = valueCells[valueCells.length - 1]; // "Privatanleger ohne Option" column
          const val = (last.textContent || '').trim();
          if (val) return val;
        }
      }
      return null;
    }
    function findLabelValue(labelText) {
      const labels = Array.from(document.querySelectorAll('.label'));
      for (const lab of labels) {
        if ((lab.textContent || '').trim() === labelText.trim()) {
          const row = lab.closest('.row') || lab.parentElement;
          const valEl = row ? row.querySelector('.value') : null;
          if (valEl) {
            let text = '';
            valEl.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) text += n.textContent; });
            text = text.trim();
            if (text) return text;
          }
        }
      }
      return null;
    }
    return {
      ageStr: findTableRowValue('Ausschüttungsgleiche Erträge'),
      qStr: findTableRowValue('Anzurechnende ausländische'),
      kStr: findTableRowValue('Die Anschaffungskosten des Fondsanteils'),
      currency: findLabelValue('Währung, in der die Meldung vorgenommen wurde') || findLabelValue('Währung') || 'EUR',
      pageTitle: document.title || ''
    };
  });
}

async function waitForTaxData(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await extractTaxData(page);
    if (data.ageStr !== null) return data;
    await page.waitForTimeout(300);
  }
  return extractTaxData(page); // last attempt, may still be null -> caller records as error
}

async function scrapeIsin(browser, isin, fromYear) {
  const page = await browser.newPage();
  const results = [];
  try {
    await page.goto(`${BASE_URL}?isin=${encodeURIComponent(isin)}`, { waitUntil: 'networkidle', timeout: 30000 });
    const periods = await findHistoryPeriods(page);
    if (!periods || periods.length === 0) {
      results.push({ isin, status: 'FEHLER: Meldehistorie nicht gefunden', name: '' });
      await page.close();
      return results;
    }
    const relevant = periods.filter(p => p.year >= fromYear);
    for (const period of relevant) {
      await page.goto(`${BASE_URL}?isin=${encodeURIComponent(isin)}&stmId=${encodeURIComponent(period.stmId)}`, { waitUntil: 'networkidle', timeout: 30000 });
      const data = await waitForTaxData(page);
      results.push({
        isin,
        year: period.year,
        currency: data.currency,
        rateDate: period.meldedatum,
        agePerUnit: parseNum(data.ageStr),
        quellensteuerPerUnit: parseNum(data.qStr),
        korrekturPerUnit: parseNum(data.kStr),
        name: data.pageTitle,
        status: data.ageStr === null ? 'FEHLER: Daten nicht gefunden' : 'OK'
      });
      await page.waitForTimeout(500); // be polite between requests
    }
  } catch (err) {
    results.push({ isin, status: `FEHLER: ${err.message}`, name: '' });
  } finally {
    await page.close();
  }
  return results;
}

async function main() {
  const [, , isinsFile, outFile, fromYearArg] = process.argv;
  if (!isinsFile || !outFile) {
    console.error('Usage: node scrape-oekb.js <isins.txt> <output.json> [fromYear]');
    process.exit(1);
  }
  const fromYear = parseInt(fromYearArg, 10) || 2020;
  const isins = fs.readFileSync(isinsFile, 'utf8')
    .split('\n').map(s => s.trim().toUpperCase()).filter(Boolean).filter(s => !s.startsWith('#'));

  console.log(`Scraping ${isins.length} ISIN(s) from year ${fromYear} onward...`);
  const browser = await chromium.launch();
  const allResults = [];
  for (const isin of isins) {
    console.log(`  -> ${isin}`);
    const results = await scrapeIsin(browser, isin, fromYear);
    allResults.push(...results);
  }
  await browser.close();

  const isinNames = {};
  allResults.forEach(r => { if (r.name) isinNames[r.isin] = r.name; });

  const payload = {
    generatedAt: new Date().toISOString(),
    funds: Object.keys(isinNames).map(isin => ({ isin, name: isinNames[isin] })),
    entries: allResults.filter(r => r.status === 'OK').map(r => ({
      isin: r.isin, year: r.year, currency: r.currency, rateDate: r.rateDate,
      agePerUnit: r.agePerUnit, quellensteuerPerUnit: r.quellensteuerPerUnit, korrekturPerUnit: r.korrekturPerUnit
    })),
    errors: allResults.filter(r => r.status !== 'OK')
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`Done. ${payload.entries.length} entries OK, ${payload.errors.length} errors. Written to ${outFile}`);
  if (payload.errors.length) {
    console.log('Errors:', JSON.stringify(payload.errors, null, 2));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
