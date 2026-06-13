# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
# Desktop (Electron) — dev
npm install
npm start

# Desktop — production builds
npm run build:mac        # universal DMG (x64 + arm64)
npm run build:win        # ZIP only (unsigned); use build:win:signed for NSIS installer
npm run build:linux      # AppImage + deb

# Android — debug APK (runs syncWebAssets automatically via preBuild hook)
npm run android:build    # assembleDebug
npm run android:install  # assembleDebug + adb install

# Android — release APK (requires keystore.properties at android/)
cd android && ./gradlew assembleRelease

# iOS — sync web assets, then build/run from Xcode (Mac + Xcode 15+ required)
npm run ios:sync         # copies src/ → ios/ENKRIT/www/ (NOT automatic — run after every src/ change)
open ios/ENKRIT.xcodeproj
```

## Architecture

ENKRIT is a **single-page offline media player** with two host environments sharing one web UI.

```
src/
  index.html   — full app UI (library, player, settings, filters) in one HTML file
  app.js       — all player logic (~2000 lines, no bundler, plain ES2020 strict mode)
  style.css    — CSS custom-property theming (dark/light + 12 accent palettes)
  fonts/       — PlusJakartaSans (primary) + EnkritUI (legacy fallback)

electron/
  main.js      — BrowserWindow, IPC handlers, ffmpeg/ffprobe integration, Whisper AI subs
  preload.js   — contextBridge exposes window.electronAPI and window.libraryAPI to renderer

android/
  app/src/main/java/com/enkrit/app/MainActivity.java — Activity + WebView host + ExoPlayer
  app/src/main/assets/www/  — auto-synced from src/ by Gradle syncWebAssets task

ios/
  ENKRIT/ViewController.swift  — WKWebView host + AndroidBridge JS polyfill + pickers
  ENKRIT/Bridge.swift          — WKScriptMessageHandler(WithReply) plumbing
  ENKRIT/PHSchemeHandler.swift — ph:// (Photos assets) + enkrit-media:// (picked files) scheme handlers
  ENKRIT/www/                  — synced from src/ by ios/sync-web-assets.sh (manual, NOT automatic)
```

### Key state objects in app.js

- `S` — global runtime state: `playlist[]`, `currentIndex`, `playing`, `nativePlayback`, `nativePosition`, `decoderMode` (`hw`/`sw`), `filters{}`, gesture/pinch state, `ctrlPos` (draggable controls position)
- `AppSettings` — persisted to `localStorage["enkrit_settings"]`, loaded at startup
- `LibState` — library tab state: `mediaFiles[]`, `recentFiles[]`, `favorites` (Set), `activeTab`, `searchQuery`
- `resumeStore()` — reads/writes `localStorage["enkrit_resume"]` (keyed by file path)

### Android bridge

The Android build does **not** use Capacitor at runtime — `MainActivity.java` is a fully custom single-Activity host. The bridge works as follows:

1. `MainActivity` attaches an `AndroidBridge` Java object to the WebView via `addJavascriptInterface`.
2. `app.js` detects `window.AndroidBridge` and calls Java methods directly (`AndroidBridge.playNativeMedia(uri, startMs, speed, volume)`, `.scanLibrary()`, `.pickMedia()`, etc.).
3. Java calls back into JS via `webView.evaluateJavascript("window.ENKRITAndroid.onXxx(...)")`.
4. `window.ENKRITAndroid` is registered in `app.js` inside `setupAndroidBridge()`.

### iOS bridge

The iOS build reuses the Android bridge surface so `app.js` needs **no iOS-specific code**:

1. `ViewController.buildPolyfill()` injects a `window.AndroidBridge` polyfill at document start; each method posts to `webkit.messageHandlers.enkrit` (fire-and-forget) or `enkritSync` (Promise reply, used by `scanLibrary`).
2. `playNativeMedia` is deliberately `null` in the polyfill so `hasNativePlayer()` returns false — iOS plays everything through the HTML `<video>` element (no ExoPlayer equivalent; codec support = native iOS: MP4/MOV H.264/HEVC, MP3/AAC/WAV).
3. Swift calls back through the same `window.ENKRITAndroid.onXxx(...)` callbacks via `evaluateJavaScript`.
4. Photos-library assets are surfaced as `ph://<localIdentifier>` URLs served by `PHSchemeHandler` (passthrough-exports to tmp, then range-request streaming). Files picked from tmp/Files-app are absolute paths; the polyfill's `electronAPI.toFileUrl` maps them to `enkrit-media://local/<path>` served by `MediaSchemeHandler` (WKWebView blocks `file://` reads outside the bundle, which is the read-access root passed to `loadFileURL`).
5. Files-app picks call `startAccessingSecurityScopedResource()` and register the path via `MediaSchemeHandler.allow(path:)` — access lasts for the session only (no bookmark persistence yet, so Recent items from Files may not reopen after relaunch).

**Native vs. web playback on Android:** When `window.AndroidBridge.playNativeMedia` is present, `loadVideo()` routes to ExoPlayer (rendered on a `TextureView` behind the WebView). The HTML `<video>` element is used only on desktop/fallback. The `S.nativePlayback` flag governs which code path is active throughout `app.js`.

**Volume on Android native:** ExoPlayer volume is set to `volumePercent / 100` with a max of 5.0 (500%). The JS `SW_VOLUME_MAX = 500` constant applies to both SW decoder and native playback paths.

**Video filter on Android:** The JS filter panel calls `AndroidBridge.setVideoFilter(brightness, contrast, saturation, grayscale, hue, sepia, invert, blurTenths)` which applies a `ColorMatrix` + optional `RenderEffect` (API 31+) to the `TextureView`.

**URI permissions:** Android `content://` URIs from the media picker are persisted via `takePersistableUriPermission`. The app self-trims to 128 persisted grants to avoid silent failures.

### Dual audio decoder (desktop)

- **HW mode** (default): native `<video>` element, volume 0–100%.
- **SW mode**: Web Audio API `GainNode` chained to a `MediaElementSource`, volume 0–500%. Activated via the decoder toggle in the player controls.

## Android Deployment Notes

### Signing (release APK)
Create `android/keystore.properties` (not committed):
```
storeFile=path/to/keystore.jks
storePassword=...
keyAlias=...
keyPassword=...
```
`build.gradle` loads this file at build time. Without it, `assembleRelease` signs with a debug key.

### Web asset sync
The Gradle task `syncWebAssets` copies `src/{index.html,style.css,app.js,fonts/**}` into `android/app/src/main/assets/www/` and runs automatically before every build (`preBuild.dependsOn`). **Do not edit files under `assets/www/` directly** — they are overwritten on every build.

### SDK targets
- `compileSdk 36`, `minSdk 23`, `targetSdk 36`
- Java 17 (`compileOptions`)
- ExoPlayer: `androidx.media3:media3-exoplayer:1.4.1`

### WebView security
`allowFileAccessFromFileURLs` and `allowUniversalAccessFromFileURLs` are intentionally `false`. The `AndroidBridge` JS interface is attached only to the bundled `file:///android_asset/www/index.html` page; any navigation to `http://`, `https://`, or external `file://` paths is intercepted by `handleNavigation()` and opened in the system browser instead.

## Desktop Notes

The Mac build sets `identity: null` and `hardenedRuntime: false` — the DMG is unsigned. Users must allow it via System Settings → Privacy & Security → "Open Anyway".

ffmpeg/ffprobe are bundled for Windows (x64 + ia32) and resolved from `node_modules` on macOS/Linux. They are used only for Whisper AI subtitle generation; core video playback does not require them.

The Electron `webSecurity: false` setting in `main.js` is required for loading local `file://` media URIs in the renderer without CORS errors.
