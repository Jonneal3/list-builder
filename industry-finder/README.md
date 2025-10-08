Industry Finder (MVP)

Free, open-source scraper to discover company name + website for an industry and city using Bing HTML SERP and YellowPages, persisting to SQLite and exporting CSV.

Quick start

```bash
cd industry-finder
npm install
node src/orchestrator.js --industry="flooring" --city="New York" --queries=5 --pages=1
```

Outputs CSV under `exports/`.

Notes
- Polite delays and rotating User-Agent headers.
- Respects basic rate-limiting heuristics; please respect robots.txt of target sites.

