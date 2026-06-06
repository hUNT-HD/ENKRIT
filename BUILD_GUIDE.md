# ═══════════════════════════════════════════
#  ENKRIT — Complete Build Guide
#  Mac · Windows · Linux · Android · iPhone
# ═══════════════════════════════════════════

## PROJECT STRUCTURE

ENKRIT/
├── src/
│   ├── index.html      ← Main UI (all platforms share this)
│   ├── style.css       ← Premium dark/light theme
│   └── app.js          ← All player logic
├── electron/
│   ├── main.js         ← Desktop app entry (Mac/Win/Linux)
│   └── preload.js      ← Secure IPC bridge
├── android-setup/
│   └── ANDROID_IOS_SETUP.md
├── assets/             ← Put your icon.png / icon.icns / icon.ico here
└── package.json

---

## STEP 1 — Install Node.js
Download from: https://nodejs.org  (version 18 or higher)

---

## STEP 2 — Install dependencies

Open Terminal (Mac/Linux) or Command Prompt (Windows):

  cd ENKRIT
  npm install

---

## STEP 3 — TEST (run without building)

  npm start

This opens ENKRIT as a native desktop window. Test all features.

---

## STEP 4A — BUILD FOR MAC (.dmg installer)

  npm run build:mac

Output: dist/ENKRIT-1.0.0.dmg
→ Double-click to install on any Mac (Intel + Apple Silicon both supported)

---

## STEP 4B — BUILD FOR WINDOWS (.exe installer)

On Windows, run:
  npm run build:win

Output: dist/ENKRIT Setup 1.0.0.exe
→ Standard Windows installer with Next/Next/Finish

---

## STEP 4C — BUILD FOR LINUX (.AppImage)

  npm run build:linux

Output: dist/ENKRIT-1.0.0.AppImage
→ chmod +x ENKRIT.AppImage && ./ENKRIT.AppImage

---

## STEP 4D — BUILD FOR ANDROID / iPHONE

See: android-setup/ANDROID_IOS_SETUP.md

Short version:
  npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
  npx cap init ENKRIT com.enkrit.app --web-dir src
  npx cap add android
  npx cap sync android
  npx cap open android   ← opens Android Studio → Build APK

---

## FEATURES INCLUDED

✅ Blue & Black premium dark theme (+ light mode toggle)
✅ ALL video formats: MP4, MKV, AVI, MOV, WEBM, FLV, WMV, M4V, OGV, TS, 3GP, etc.
✅ Volume boost UP TO 300% (Web Audio API GainNode)
✅ Default screen settings (brightness/contrast/saturation sliders)
✅ 8 filter presets: Normal, Vivid, Cinematic, Cool, Warm, Noir, Vintage, Auto Enhance
✅ Fully offline — no internet needed for playback
✅ Auto subtitle generation when online (Web Speech API)
✅ Manual subtitle: Load .SRT / .VTT files
✅ Subtitle ON/OFF toggle
✅ Controls: Play/Pause, Volume, Seek bar, Time display
✅ ±5 second skip (forward & backward)
✅ Previous / Next video buttons
✅ Playlist sidebar
✅ Playback speed: 0.1× to 5× (slider + presets)
✅ Picture-in-Picture popup mode
✅ Fullscreen
✅ Drag & drop video files
✅ Dark mode default, light mode toggle
✅ Keyboard shortcuts (Space, Arrow keys, F, M, P, [], N, B)

---

## KEYBOARD SHORTCUTS

  Space       → Play / Pause
  ← →         → Seek ±5 seconds
  ↑ ↓         → Volume ±10%
  [ ]         → Speed down / up (±0.25×)
  F           → Fullscreen
  M           → Mute
  P           → Picture in Picture
  N           → Next video
  B           → Previous video

---

## ADDING YOUR APP ICON

Place these files in the assets/ folder:
  icon.png   (1024×1024, for Linux + Android)
  icon.icns  (Mac — use iconutil or https://cloudconvert.com/png-to-icns)
  icon.ico   (Windows — use https://icoconvert.com)

---

## TROUBLESHOOTING

"App can't be opened" on Mac:
  System Settings → Privacy & Security → "Open Anyway"

Windows Defender warning:
  Click "More info" → "Run anyway" (unsigned app)

Video won't play:
  Electron uses Chromium — if a codec is missing (e.g. H.265),
  install electron with --enable-proprietary-codecs or use a pre-built
  Electron with all codecs from: https://github.com/castlabs/electron-releases
