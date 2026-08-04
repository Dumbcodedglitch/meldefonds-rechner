# Meldefonds-Rechner — gehostete Version / Hosted Version

Dieses Repository hostet deinen Meldefonds-Rechner und Depot-Kostenbasis-Rechner über GitHub
Pages (echte https-Adresse → löst das CORS-Problem beim automatischen Kursabruf) und lässt eine
geplante GitHub Action regelmäßig neue OeKB-Daten für dich abholen.

*This repository hosts your Meldefonds-Rechner and Depot-Kostenbasis-Rechner via GitHub Pages
(a real https address → fixes the CORS issue for automatic exchange-rate lookups) and runs a
scheduled GitHub Action that fetches fresh OeKB data for you automatically.*

---

## Einmalige Einrichtung / One-time setup

### 1. Repository erstellen / Create the repository

1. Auf [github.com](https://github.com) einloggen (kostenloser Account reicht).
2. Oben rechts auf **+** → **New repository** klicken.
3. Einen Namen vergeben, z. B. `meldefonds-rechner` — **Public** oder **Private**, beides
   funktioniert (bei Private ist GitHub Pages evtl. nur mit einem kostenpflichtigen Plan möglich —
   im Zweifel **Public** wählen, die Daten liegen ohnehin nur in deinem eigenen Repo).
4. **Create repository** klicken. Noch keine Dateien hochladen — das kommt im nächsten Schritt.

*Log into github.com (free account is fine). Click "+" → "New repository" top-right. Give it a
name, e.g. `meldefonds-rechner`. Public or Private both work (Private may require a paid plan for
Pages — if unsure, choose Public; your data still only lives in your own repo). Click "Create
repository". Don't upload files yet.*

### 2. Dateien hochladen / Upload the files

1. Alle Dateien aus diesem Ordner (inkl. der Unterordner `.github` und `scripts` und `data`) in
   dein neues Repository hochladen. Am einfachsten: auf der Repo-Seite auf **Add file → Upload
   files** klicken, den ganzen entpackten Ordnerinhalt hineinziehen, dann **Commit changes**.
   *(Wichtig: die Ordnerstruktur muss erhalten bleiben — `.github/workflows/scrape-oekb.yml` muss
   genau an dieser Stelle landen, damit GitHub die Datei als Action erkennt.)*

*Upload every file from this folder (including the `.github`, `scripts`, and `data` subfolders)
into your new repository. Easiest way: on the repo page, click "Add file → Upload files", drag in
the whole unzipped folder contents, then "Commit changes". Important: the folder structure must
be preserved — `.github/workflows/scrape-oekb.yml` needs to land exactly there for GitHub to
recognize it as an Action.*

### 3. GitHub Pages aktivieren / Enable GitHub Pages

1. Im Repository auf **Settings** → **Pages** (linkes Menü).
2. Unter "Build and deployment" → **Source**: `Deploy from a branch` wählen.
3. **Branch**: `main` (oder `master`), Ordner `/ (root)` → **Save**.
4. Nach ein bis zwei Minuten ist der Rechner erreichbar unter:
   `https://DEIN-BENUTZERNAME.github.io/meldefonds-rechner/`

*In the repo, go to Settings → Pages. Under "Build and deployment" → Source, choose "Deploy from a
branch". Branch: main, folder: / (root) → Save. After a minute or two, the calculator is live at
the URL shown above.*

### 4. Deine ISINs eintragen / Enter your ISINs

1. Datei `data/isins.txt` im Repo öffnen (Stift-Symbol zum Bearbeiten anklicken).
2. Eine ISIN pro Zeile eintragen, Beispielzeilen löschen. Speichern (**Commit changes**).

*Open `data/isins.txt` in the repo (click the pencil icon to edit). Enter one ISIN per line,
delete the example lines, save (Commit changes).*

### 5. Ersten Testlauf starten / Run it once manually

1. Im Repository auf **Actions** klicken.
2. Links auf **Scrape OeKB Meldefonds data** klicken.
3. Rechts auf **Run workflow** → **Run workflow** klicken.
4. Nach ein paar Minuten ist der Lauf fertig — bei Erfolg wird `data/oekb-data.json` automatisch
   aktualisiert und ins Repo committet. Bei Fehlern siehst du das Protokoll direkt im Actions-Tab.

*Click "Actions" in the repo, then "Scrape OeKB Meldefonds data" on the left, then "Run workflow"
on the right. After a few minutes it finishes — on success, `data/oekb-data.json` is updated and
committed automatically. On failure, the log is right there in the Actions tab.*

Danach läuft es automatisch jeden Montag um 06:00 UTC (einstellbar in
`.github/workflows/scrape-oekb.yml`, Zeile mit `cron:`).

*After that, it runs automatically every Monday at 06:00 UTC (adjustable in the workflow file's
`cron:` line).*

---

## Laufende Nutzung / Ongoing use

- **Rechner öffnen**: `https://DEIN-BENUTZERNAME.github.io/meldefonds-rechner/` — jetzt sollte der
  automatische EZB-Kursabruf funktionieren (kein CORS-Fehler mehr, da echte https-Adresse statt
  einer lokalen Datei).
- **Neue OeKB-Daten holen**: passiert automatisch wöchentlich, oder manuell über Actions → Run
  workflow. Danach `data/oekb-data.json` herunterladen (Repo → Datei anklicken → Raw → speichern,
  oder direkt aus dem Actions-Lauf als "Artifact" herunterladen) und im Rechner unter "2
  Meldedaten → Daten vom Auto-Abruf-Script importieren" einlesen.
- **Depot-Kostenbasis-Rechner**: erreichbar unter
  `https://DEIN-BENUTZERNAME.github.io/meldefonds-rechner/depot-kostenbasis-rechner.html`

*Open the calculator at the URL above — automatic ECB rate fetching should now work (no more CORS
error, since it's a real https address instead of a local file). New OeKB data arrives weekly
automatically, or trigger it manually via Actions → Run workflow; then download
`data/oekb-data.json` (click the file in the repo → Raw → save, or grab it as an Action run's
"Artifact") and import it into the calculator via "2 Meldedaten → Import script data". The
Depot-Kostenbasis-Rechner is reachable at the second URL above.*

## Was, wenn OeKB die Seite ändert? / What if OeKB changes their page?

Die Action bricht dann nicht komplett ab, sondern trägt einzelne ISINs in `errors` innerhalb von
`data/oekb-data.json` ein, statt falsche Zahlen zu erzeugen. Schau im Actions-Protokoll nach roten
Fehlermeldungen — meld dich in dem Fall, dann passen wir die Erkennungslogik in
`scripts/scrape-oekb.js` an.

*The Action won't silently produce wrong numbers if OeKB changes their page structure — affected
ISINs get logged under `errors` in the output file instead. Check the Actions log for red error
messages if something looks off, and the detection logic in `scripts/scrape-oekb.js` can be
adjusted.*

## Sicherheit / Security note

Alles hier ist rein lesend (nur öffentliche OeKB-Fondsdaten werden abgerufen) und läuft in deinem
eigenen, privaten GitHub-Konto. Es werden keine Zugangsdaten oder persönliche Finanzdaten an
Dritte übertragen.

*Everything here is read-only (only public OeKB fund data is fetched) and runs in your own private
GitHub account. No credentials or personal financial data are sent anywhere.*
