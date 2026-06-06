# ENKRIT — Android / iOS Setup (Capacitor)

## Prerequisites
- Node.js 18+
- Android Studio (for Android)
- Xcode + CocoaPods (for iPhone, Mac only)

---

## Step 1 — Install Capacitor in project root

```bash
cd ENKRIT
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init ENKRIT com.enkrit.app --web-dir src
```

---

## Step 2 — capacitor.config.json (auto-created, but verify)

```json
{
  "appId": "com.enkrit.app",
  "appName": "ENKRIT",
  "webDir": "src",
  "server": {
    "androidScheme": "https"
  },
  "plugins": {
    "SplashScreen": {
      "launchShowDuration": 2000,
      "backgroundColor": "#080812"
    }
  }
}
```

---

## Step 3 — Add Android platform

```bash
npx cap add android
npx cap sync android
npx cap open android
```

Then in Android Studio → Build → Generate Signed Bundle/APK

---

## Step 4 — Add iOS platform (Mac only)

```bash
npx cap add ios
npx cap sync ios
npx cap open ios
```

Then in Xcode → Product → Archive → Distribute

---

## Step 5 — Chromebook

Chromebooks support Android apps via Google Play.
Build the APK (Step 3) and sideload via:
Settings → Developer → Enable ADB → adb install ENKRIT.apk

Or publish to Google Play.

---

## Notes on local video file access

For Android/iOS add this plugin for local file picking:
```bash
npm install @capacitor/filesystem @capacitor/file-picker
npx cap sync
```

Then in app.js, replace the HTML file input with Capacitor FilePicker when running natively (detect via `window.Capacitor`).
