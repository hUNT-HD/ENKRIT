# ENKRIT — Bug List

Last audited: 2026-06-13
**Status: ALL FIXED (2026-06-13).** Every bug below has been patched in `src/app.js`, `electron/main.js`, `electron/preload.js`, `android/MainActivity.java`, `android/Gif89Encoder.java`, `ios/PHSchemeHandler.swift`, and `ios/ViewController.swift`. JS/Electron pass `node --check`; Java/Swift brace-balanced (full compile happens in Xcode/Gradle on your machine). `src/app.js` was re-synced to `ios/ENKRIT/www/app.js`; Android assets auto-sync at build. The one "GIF-LZW early change" item was verified already-correct and left unchanged.

Scope: `src/app.js`, `electron/`, `android/`, `ios/`. Findings are grouped by severity. Each item lists the location, what's wrong, and why it matters. Suspected items that turned out to be safe are noted at the end so they don't get re-investigated.

## Critical

**iOS — WKURLSchemeTask called after `stop()` crashes the app.** `ios/PHSchemeHandler.swift` (`MediaSchemeHandler.stop` is empty; `PHSchemeHandler.stop` is best-effort only, ~lines 48–64, 108–120, 159–161). When WebKit calls `stop(urlSchemeTask:)` — every time the user seeks, cancels, or the `<video>` element tears down — any later `task.didReceive`/`didFinish`/`didFailWithError` throws "This task has already been stopped" and crashes. The streaming loop and the async export completions have no live-task guard. Must track active tasks and check before every callback, and implement real cancellation in `stop:`.

## High

**iOS — `LocalFileServer.serve` blocks the main thread streaming whole files.** `ios/PHSchemeHandler.swift` ~lines 9–65, 108–120. `MediaSchemeHandler.start:` calls `serve` synchronously on the thread WebKit invoked (main thread), and `serve` does a blocking read loop over the entire file. Large videos freeze the UI on every `enkrit-media://` load. Move the read loop to a background queue.

**app.js — quick-speed picker calls a non-existent bridge method.** `src/app.js:3166`. It calls `window.AndroidBridge.setSpeed(sp)`, but the real bridge method is `nativeSetSpeed` (used at line 758). On native ExoPlayer playback the long-press speed picker silently fails to change actual playback speed — only the label updates.

**Electron — `read-file` IPC allows arbitrary file read.** `electron/main.js:118–121`. `fs.readFileSync(filePath, "utf-8")` runs on any renderer-supplied path with no confinement. Combined with `webSecurity:false`, a compromised renderer can read any user-readable file (e.g. `~/.ssh/id_rsa`). Constrain to the expected temp/SRT directories.

**Electron — temp files are never cleaned up.** `electron/main.js:66` (whisper `enkrit_sub_<ts>.srt`) and `:133` (`prepare-playable` `${base}_<ts>.mp4` in `os.tmpdir()/enkrit_playable`). Nothing deletes them on close, quit, or startup. Transcodes can be large, so temp fills over time.

**Electron — `webSecurity: false`.** `electron/main.js:48`. Disables same-origin protection. Documented as "required" for local media, but it's a real weakening: any rendered remote/subtitle/media content becomes an exfiltration vector. Worth scoping more tightly if possible.

## Medium

**app.js — quick-speed picker bypasses `setSpeed()` and desyncs state.** `src/app.js:3160–3173`. Sets `S.speed`/`video.playbackRate` by hand instead of calling `setSpeed(sp)`, so the speed readout, `.spbtn` active states, the slider value, and `enkrit_speed` persistence all drift out of sync. It also targets `.speed-item`/`.speed-label` selectors that differ from the ones `setSpeed` updates.

**app.js — deleting the current item re-writes it into the resume store.** `src/app.js:1342–1368` (`removeFromPlaylist`). When removing the currently playing item, `stopNativePlayback()` → `saveResumePosition(true)` runs while `currentItem()` still returns the not-yet-spliced item, re-creating a resume entry for the item just deleted. Deleted items can reappear in resume history.

**app.js — native play/pause is a silent no-op if `nativeSetPlaying` is missing.** `src/app.js:524–533` (`togglePlay`). On the native path, if the method is absent the function returns with no UI update and no fallback — tap-to-toggle becomes dead with no feedback.

**Electron — synchronous `execSync`/`execFileSync` freeze the UI.** `electron/main.js:70–73` (`python3 --version`) and `:169–182` (two ffprobe calls, up to 10s timeout each) run synchronously on the main thread inside async IPC handlers. A slow/missing interpreter or large file can freeze the UI for many seconds. Use async spawn.

**Electron — `Date.now()` temp filenames can collide.** `electron/main.js:66, 133`. Two calls in the same millisecond produce identical paths; with ffmpeg `-y` the second clobbers the first, and the first promise may resolve pointing at the second job's output. Use a counter or `crypto.randomUUID()`.

**Electron — no concurrency guard on ffmpeg transcodes.** `electron/main.js:123–164, 189–205`. Unlike whisper (which kills the prior process), `runFfmpeg` keeps no handle, so overlapping `prepare-playable` calls spawn unbounded concurrent transcodes (CPU/RAM exhaustion) with no way to cancel.

**Electron — menu callbacks dereference a possibly-destroyed `win`.** `electron/main.js:219–237`. All menu `click` handlers call `win.webContents.executeJavaScript(...)`; `win` is never reset to `null` on window close, so triggering a menu accelerator after the window is gone throws on a destroyed `webContents`.

**Android — `ParcelFileDescriptor` leaked in `extractAudioTrack`.** `MainActivity.java:1101–1124`. The `finally` block closes `mux` and `ex` but not the `pfd` opened at 1101–1102. File-descriptor leak on every audio extraction.

**Android — original bitmap leaked in `seekPreview` scaling path.** `MainActivity.java:1532–1542`. When `sc < 1f`, `bmp` is reassigned to the scaled bitmap and only the scaled one is recycled; the full-size frame from `getFrameAtTime` is never recycled. Leaks a bitmap on every scrub-preview frame.

**Android — GIF-LZW code-size "early change" ordering.** `Gif89Encoder.java:119–132`. The code-size bump happens as a new code is added rather than per GIF89a's early-change expectation; lenient decoders cope, but stricter viewers can mis-decode (shifted colors) once the table grows past 512/1024 codes.

**iOS — data race appending to `items` from PHPicker handlers.** `ViewController.swift:646–664`. `loadFileRepresentation` completions run on arbitrary background queues and each does `items.append(...)` on a shared `Array` concurrently. `DispatchGroup` coordinates completion, not mutation — selecting multiple videos can corrupt the array or crash. Serialize the appends with a lock or serial queue.

**iOS — suffix Range requests served wrong.** `PHSchemeHandler.swift:29–33`. For `Range: bytes=-500` (last 500 bytes), the split yields `["500"]`, so it serves bytes 500…end instead of the final 500.

**iOS — unclamped Range start yields negative Content-Length.** `PHSchemeHandler.swift:31–34`. `startByte` is never clamped to `fileSize`; a request like `bytes=999999999-` makes `length` negative and advertises a bogus `Content-Length`. Should return HTTP 416.

**iOS — `hashValue`-based temp filenames defeat the cache and can collide.** `PHSchemeHandler.swift:187, 228`. `enkrit_\(localId.hashValue).mp4` uses Swift's per-launch randomized `String.hashValue`, so the `fileExists` cache never hits across launches (re-export every launch, filling tmp), and a hash collision would serve the wrong asset. Use the sanitized localId or a stable hash.

## Low

**app.js — folder "now playing" highlight uses substring match.** `src/app.js` ~2660–2670. `item.path.includes(folder)` highlights a folder tile whenever the folder name appears anywhere in the path; a folder named "video" matches almost everything.

**app.js — resume dialog promise can leak.** `src/app.js` ~270–300 (`chooseStartPosition`). If `loadVideo` is called again while the dialog is open, the previous `await chooseStartPosition` never resolves (dangling async frame). No playback harm due to the generation guard, but it leaks.

**app.js — native-error auto-recovery can retry the same failing item indefinitely.** `src/app.js` ~155–170 (`onNativeError`). The 12s guard resets each attempt, so an item that fails just over 12s apart retries forever.

**app.js — desktop seek-preview can point at a revoked blob URL.** `src/app.js` ~4330–4350. `_spDesktopVid.src` is reset to `item.url`; if that blob was revoked by `releaseItemUrl` on a track change, the preview targets a dead blob.

**Electron — `onWhisperProgress` stacks listeners.** `preload.js:13–15`. `ipcRenderer.on(...)` is added on every call with no removal; repeated transcription sessions duplicate progress callbacks and slowly leak.

**Electron — `probeCodecs` failure silently forces a full transcode.** `electron/main.js:166–187, 134–135`. If ffprobe is missing/errors it returns `{}`, `canRemux` is false, and the code does an expensive full transcode where a cheap remux would have worked. No crash, silent perf regression.

**Electron — `scanDir` follows directory symlinks.** `electron/main.js:278–301`. No symlink guard; cycles within the depth-4 cap cause redundant rescans (bounded, but wasteful).

**Android — screen brightness override never restored.** `MainActivity.java:1942–1947`. A dimmed player leaves the whole app dimmed after exiting; `stopNativePlayer`/`onPause` never reset `BRIGHTNESS_OVERRIDE_NONE`.

**Android — user pinch-zoom reset on layout recompute.** `MainActivity.java:419` (`applyTextureFit`). Always calls `setTextureZoom(1f)`, so any user zoom is silently lost on video-size change or rotation.

**Android — orphaned zero-byte files in `doMoveToPrivate`.** `MainActivity.java:1409–1414`. On a per-item `continue` after the dst file is created, an empty file is left on disk and never deleted.

**Android — in-app browser has no host filtering.** `MainActivity.java:1347–1358`. The inner WebView enables JS with a bare `WebViewClient` (all navigation stays in-WebView). The bridge is not attached and file access defaults off, so exposure is limited, but arbitrary attacker URLs load with JS/DOM storage.

**iOS — orientation lock forces portrait on iOS 15.** `ViewController.swift:282–284`. The pre-iOS-16 branch always sets portrait via the private KVC `orientation` hack even when landscape/auto is requested (and the hack is an App Store rejection risk).

**iOS — `exitApp` private-selector hack.** `ViewController.swift:237`. `sendAction(#selector(URLSessionTask.suspend), ...)` likely no-ops and risks App Store rejection.

**iOS — unescaped newlines in JS interpolation.** `ViewController.swift:736–740` (`jsEscaped`) escapes `\` and `'` but not newlines; a path containing a newline injected via e.g. `onDeleteComplete('\(esc)')` breaks the JS statement.

**iOS — picked-file temp names collide on shared filenames.** `ViewController.swift:653–656`. Dest is `enkrit_\(url.lastPathComponent)`; two different videos named `IMG_0001.mov` overwrite each other (and race with the concurrency bug above).

## Verified NOT bugs (don't re-investigate)

- **GIF palette index math** (`Gif89Encoder.java` ~70, 83–89 and `app.js` `encodeGif89a` ~4706): max index 251 < 252 palette entries — in bounds.
- **Electron path/shell safety**: all `spawn`/`execFileSync` pass paths as array args with no `shell:true` — spaces and special chars are handled, no injection.
- **Electron** `nodeIntegration:false` + `contextIsolation:true` are set correctly (main.js:45–46).
- **app.js** `loadVideo` generation guard, shuffle 20-try cap, and strict-mode function reassignments are all correct; localStorage reads are wrapped in try/catch.
- **JS bridge signatures** (`playNativeMedia`, `setVideoFilter`, etc.) line up between `app.js`, Android `@JavascriptInterface` methods, and the iOS polyfill.
- `ios/Bridge.swift`, `AppDelegate.swift`, `SceneDelegate.swift`: clean.
