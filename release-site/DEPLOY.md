# ENKRIT — dummy release page (deploy notes)

This is a **separate, standalone** test page. It does NOT touch your real site in `netlify-deploy/`.

## What's here
- `index.html` — download page (logo + version 1.2.1 + 5 download buttons)
- `logo.png` — app logo
- `_headers` — Netlify headers so APK/ZIP/DMG download correctly
- `downloads/` — the actual installers (Mac DMG ×2, Windows ZIP ×2, Android APK)

## Test locally (right now)
Double-click `index.html` → opens in your browser → click any Download button. The real file downloads. No deploy needed.

## Deploy as a NEW Netlify site (your real site stays untouched)
Easiest, no command line:
1. Go to https://app.netlify.com/drop
2. Drag the whole **`release-site`** folder onto the page.
3. Netlify creates a brand-new site with its own URL. Done.

## ⚠️ Size warning
The `downloads/` folder is ~1.1 GB (the desktop installers are 200–330 MB each).
Netlify's free tier gives 100 GB bandwidth/month — fine for testing, but for a real
public release it's better to host the big desktop files on **GitHub Releases** and
point the buttons there, keeping only the small APK on Netlify. The page is a dummy/test
build, so this is just a heads-up.
