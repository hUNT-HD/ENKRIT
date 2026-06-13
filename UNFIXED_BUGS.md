# ENKRIT — Unfixed Bugs List

Here is a list of functional and logical bugs currently present in the codebase:

1. **GIF Encoder Timing Issue (`makeGifDesktop` in `app.js`)**
   For very short video clips (`durS < 1.0s`), the GIF frame count is artificially clamped to a minimum of 10 frames. However, the encoder hardcodes the GIF frame delay based on the initial `fps` calculation instead of the adjusted frame count. This mismatch causes short GIFs to play back in slow motion.

2. **Subtitle State Leak (`clearPlaylist` in `app.js`)**
   When the user clears the playlist, `S.srtCues` is emptied and the subtitle UI is cleared, but `setSubMode("off")` is never called. This leaves the internal state `S.subtitleMode` stuck in its previous mode (e.g., `"file"`). When the next video is loaded, the subtitle menu UI will be out of sync and may attempt to look for subtitle cues.

3. **Repeat All Broken at Playlist End (`advanceAfterEnded` in `app.js`)**
   The playback auto-advance logic strictly verifies `hasNext` (which is `false` on the last video of the playlist) before attempting to call `playNextTrack()`. As a result, when the final video finishes, the app immediately exits to the library, entirely ignoring `S.repeatMode === "all"` and breaking the playlist loop functionality.

4. **Temporary Transcoding File Leak (`prepare-playable` in `electron/main.js`)**
   When the desktop application encounters an incompatible video format, it transcodes a copy via FFmpeg and saves it to `os.tmpdir()`. However, there is no cleanup mechanism implemented to delete these temporary `.mp4` files once the user closes the video or exits the app, leading to a permanent disk space leak over time.

5. **Drag-and-Drop Duplicate Playback Bug (`openFiles` in `app.js`)**
   While the file picker dialogs (`openDesktopMediaItems`) correctly track the index of an already-existing file to play it, the drag-and-drop handler (`openFiles`) does not. If a user drag-and-drops a media file that already exists in the playlist, it is correctly skipped to avoid duplication, but the `loadVideo` function mistakenly falls back to playing the very last video in the playlist rather than the one the user just dropped.
