# Shayar Tex — Bill Book

A fast, offline-first bill book for Shayar Tex. Track paid and received bills,
manage parties, see cash flow at a glance, and print bill summaries or
per-party debit vouchers. Built as a plain HTML/CSS/JS PWA — no accounts, no
server; all data stays on your device (localStorage), with local snapshot and
JSON-file backup/restore.

**Live app:** https://harris658.github.io/shayar-bill-book/

## Install on your phone

### Android (Chrome)
1. Open the live app link above in Chrome.
2. Tap the **⋮** menu → **Add to Home screen** (or the **Install app** prompt).
3. Tap **Install**. The Bill Book opens full-screen from its own icon.

### iPhone / iPad (Safari)
1. Open the live app link above in Safari.
2. Tap the **Share** button (square with arrow).
3. Scroll down and tap **Add to Home Screen**, then **Add**.

Once installed it works offline; your bills live on the device. Use
**More → Backup** inside the app to download a backup file or restore one.

## Development

No build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

- `index.html` — app shell + PWA meta
- `css/app.css` — all styles (design tokens at the top)
- `js/app.js` — state, screens, calculator, print, backup
- `sw.js` — offline cache (network-first, cache fallback)
- `design-spec.dc.html` — original Claude Design spec this app was built from
