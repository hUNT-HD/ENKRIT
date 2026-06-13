# ENKRIT — Incomplete / Half-Built Features

Audited: 2026-06-13. These are features that *look* like they exist (UI is present, or a setting is declared) but are not actually wired end-to-end, so they do nothing or only partly work. Verified by checking both sides — the declaration AND the usage — to avoid false positives. Synced copies under `android/.../assets/www/` and `ios/ENKRIT/www/` are ignored; only source files were audited.

> **STATUS: ALL IMPLEMENTED (2026-06-13).** Every item below has been completed in `src/app.js`, `src/index.html`, `android/MainActivity.java`, and `ios/ViewController.swift`. JS passes `node --check`; native files are brace-balanced; `src/` was re-synced to `ios/ENKRIT/www/`. Two manual follow-ups remain (you must do these in the native projects — they can't be done from the web/source files):
>
> 1. **iOS background play** needs `UIBackgroundModes = [audio]` added to the iOS app's `Info.plist`, or background audio won't actually keep playing when the screen locks. The AVAudioSession code is done.
> 2. **Android reliable background play** currently keeps ExoPlayer alive when backgrounded (minimal approach). For production-grade reliability (surviving memory pressure, lock-screen controls) add a `media3 MediaSessionService` foreground service + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permission. Optional follow-up.
> 3. **Share** is wired to the GIF export (which returns a real URI). Screenshot and audio-extract only return a filename, not a shareable content URI — to add Share for those, surface the saved URI from the native `onShotSaved`/`onAudioExtracted` callbacks, then one `showSharePrompt(...)` call extends it.
> 4. **Behavior note (Android):** with background-play OFF (default), audio now pauses when the app is backgrounded. Previously it incidentally kept playing — this change is intended so the new setting is meaningful.

## Fully dead (does nothing at all)

**1. Blacklist** — `src/index.html:608`, `src/app.js:4` (`blacklist: []`). The settings row has no `id`, no click handler, and no editor panel; the `blacklist` array is never read during folder filtering. Clicking it does nothing, and even a manually-set value would never hide any folder. (This is the one you noticed.)

**2. Preferred audio language** — `src/app.js:9` (`preferredAudioLang: ""`). Declared in settings, never read anywhere. No UI to set it and it's never applied when selecting an audio track.

**3. Preferred subtitle language** — `src/app.js:9` (`preferredSubLang: ""`). Same as above — declared, never read, no UI, never applied to subtitle selection.

**4. Show floating play button** — toggle `sShowFloatingBtn` (`src/index.html:597`), key `showFloatingBtn` (`src/app.js:10`). The toggle saves the setting, but `showFloatingBtn` is never read in `applySettings()` or anywhere else, so no floating button is ever created. The toggle is purely cosmetic.

**5. Remember background play** — toggle `sRememberBgPlay` (`src/index.html:636`), key `rememberBgPlay` (`src/app.js:5`). The only consumer is `window.AndroidBridge?.setBackgroundPlay?.(...)` at `src/app.js:2689`, but there is no `setBackgroundPlay` method in `MainActivity.java` or the iOS polyfill. The optional-chained call silently no-ops, so background play is never actually enabled or disabled on any platform.

**6. `"backbutton"` handler + `exitApp`** — `src/app.js:2854-2859`. Listens for a Cordova/Capacitor-style `"backbutton"` DOM event that nothing ever dispatches, and calls `AndroidBridge.exitApp()` which has no Android implementation. Dead code — Android back is actually handled natively (`onBackPressed → ENKRITHandleBack → moveTaskToBack`).

**7. `onNativeStopped` callback** — `src/app.js:141-143`. Registered to call `backToLibrary()`, but no Android/iOS code ever invokes `window.ENKRITAndroid.onNativeStopped`. Harmless but dead; native stop is surfaced through other callbacks.

**8. `shareUri` (Android)** — `MainActivity.java:2162`. A native share method is fully implemented but never called from JS, and there is no Share button anywhere in the UI. So GIF/screenshot/audio-extract outputs can't actually be shared — the plumbing exists but is unreachable.

## Partially working (misleading behaviour)

**9. Show subtitles by default** — toggle `sShowSubtitles` (`src/index.html:676`), key `showSubtitles` (`src/app.js:9`), in `applySettings()` at `src/app.js:2662`. Its only effect is showing/hiding the subtitle *button* (`subWrap.style.display`). It never sets `S.subtitleMode` / calls the sub-enable path, so it does NOT actually turn subtitles on by default despite the description "Show subtitles by default."

## Suggested priority to finish

1. **Blacklist** (#1) — most visible; needs an id + click handler, an add/remove folder panel, persistence, and a filter step after the library scan (around `src/app.js:1971`).
2. **Remember background play** (#5) — add the native `setBackgroundPlay` implementation (Android foreground service / ExoPlayer keep-playing; iOS audio session), or hide the toggle.
3. **Show subtitles by default** (#9) — make it actually set the default subtitle mode, not just show the button.
4. **Preferred audio/sub language** (#2, #3) — add language pickers and apply them in the track-selection logic, or remove the dead settings.
5. **Show floating play button** (#4) — implement the button or remove the toggle.
6. **Share** (#8) — add a Share button that calls the existing `shareUri` for exported GIFs/screenshots/audio.
7. **Dead code cleanup** (#6, #7) — remove the `"backbutton"`/`exitApp` handler and the unused `onNativeStopped` callback.

## Verified NOT broken (don't re-investigate)
- All "More"-sheet buttons (A-B repeat, audio track, boost, dialogue, bookmark, screenshot, extract audio, GIF, eco, lock) have working handlers.
- The other chevron settings rows (Folder View, Resume playback, Orientation, Seek time) are fully wired via `openSettingsDialog`.
- All filter labels, `s*` toggles, and decorative/CSS-class-driven elements are functional.
- Every other `AndroidBridge.*` / `electronAPI.*` / `libraryAPI.*` call has a matching native/IPC implementation, and every native→JS callback that actually fires is registered.
