import WebKit
import Photos
import AVFoundation

// MARK: - Active task tracker (avoids "task already stopped" crashes)
//
// WebKit may call stop(urlSchemeTask:) at any time (e.g. when a media
// element is torn down mid-stream). Any task.didReceive/didFinish/
// didFailWithError after that throws "This task has already been stopped"
// and crashes. Each scheme handler owns one of these and consults it
// before every callback.
final class ActiveTaskTracker {
    private var ids = Set<ObjectIdentifier>()
    private let lock = NSLock()

    func add(_ task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); ids.insert(id); lock.unlock()
    }

    func remove(_ task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); ids.remove(id); lock.unlock()
    }

    func isActive(_ task: WKURLSchemeTask) -> Bool {
        let id = ObjectIdentifier(task)
        lock.lock(); defer { lock.unlock() }
        return ids.contains(id)
    }
}

// MARK: - Shared local-file server (range-request aware)

enum LocalFileServer {

    // Dedicated queue so the blocking file-read loop never runs on the main
    // thread. Callbacks for a given task are serialized onto this queue.
    private static let queue = DispatchQueue(label: "com.enkrit.localfileserver", qos: .userInitiated)

    /// Streams `fileURL` to `task`, honoring Range requests. The work runs on a
    /// background queue. `isLive` is checked before every WKURLSchemeTask
    /// callback so a task that WebKit has already stopped is never touched.
    static func serve(task: WKURLSchemeTask,
                      fileURL: URL,
                      originalRequest: URLRequest,
                      isLive: @escaping (WKURLSchemeTask) -> Bool) {
        queue.async {
            serveSync(task: task, fileURL: fileURL, originalRequest: originalRequest, isLive: isLive)
        }
    }

    private static func serveSync(task: WKURLSchemeTask,
                                  fileURL: URL,
                                  originalRequest: URLRequest,
                                  isLive: @escaping (WKURLSchemeTask) -> Bool) {
        guard isLive(task) else { return }

        guard let fileHandle = try? FileHandle(forReadingFrom: fileURL) else {
            if isLive(task) { task.didFailWithError(URLError(.cannotOpenFile)) }
            return
        }

        let attrs    = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let fileSize = (attrs?[.size] as? Int) ?? 0
        let mime     = mimeType(for: fileURL)

        var startByte = 0
        var endByte   = max(0, fileSize - 1)
        var status    = 200
        var headers: [String: String] = [
            "Content-Type":   mime,
            "Accept-Ranges":  "bytes",
            "Content-Length": "\(fileSize)",
        ]

        if let rangeVal = originalRequest.value(forHTTPHeaderField: "Range"),
           rangeVal.hasPrefix("bytes=") {
            let rangeStr = String(rangeVal.dropFirst(6))

            if rangeStr.hasPrefix("-") {
                // Suffix form: bytes=-SUFFIX  →  last SUFFIX bytes.
                let suffix = Int(rangeStr.dropFirst()) ?? 0
                startByte  = max(0, fileSize - suffix)
                endByte    = max(0, fileSize - 1)
            } else {
                // bytes=START-END  or  bytes=START-  (open-ended).
                let parts = rangeStr.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
                startByte = Int(parts[0]) ?? 0
                endByte   = parts.count > 1 && !parts[1].isEmpty ? (Int(parts[1]) ?? (fileSize - 1)) : (fileSize - 1)
            }
            endByte   = min(endByte, max(0, fileSize - 1))

            // Reject unsatisfiable ranges with HTTP 416 instead of computing a
            // negative Content-Length.
            if startByte >= fileSize || startByte > endByte {
                try? fileHandle.close()
                guard isLive(task), let url = task.request.url else { return }
                let h416: [String: String] = [
                    "Content-Range":  "bytes */\(fileSize)",
                    "Content-Length": "0",
                ]
                if let resp = HTTPURLResponse(url: url, statusCode: 416,
                                              httpVersion: "HTTP/1.1", headerFields: h416) {
                    task.didReceive(resp)
                    if isLive(task) { task.didFinish() }
                } else {
                    task.didFailWithError(URLError(.badServerResponse))
                }
                return
            }

            let length = endByte - startByte + 1
            status     = 206
            headers["Content-Range"]  = "bytes \(startByte)-\(endByte)/\(fileSize)"
            headers["Content-Length"] = "\(length)"
        }

        guard isLive(task), let url = task.request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
              ) else {
            try? fileHandle.close()
            if isLive(task) { task.didFailWithError(URLError(.badServerResponse)) }
            return
        }

        task.didReceive(response)

        // Stream in 1 MB chunks to avoid large heap allocations
        fileHandle.seek(toFileOffset: UInt64(startByte))
        let chunkSize = 1 * 1024 * 1024
        var remaining = endByte - startByte + 1

        while remaining > 0 {
            // Bail immediately if WebKit stopped the task mid-stream.
            guard isLive(task) else { try? fileHandle.close(); return }
            let toRead = min(chunkSize, remaining)
            let chunk  = fileHandle.readData(ofLength: toRead)
            if chunk.isEmpty { break }
            guard isLive(task) else { try? fileHandle.close(); return }
            task.didReceive(chunk)
            remaining -= chunk.count
        }

        try? fileHandle.close()
        if isLive(task) { task.didFinish() }
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "mp4", "m4v": return "video/mp4"
        case "mov":         return "video/quicktime"
        case "webm":        return "video/webm"
        case "m4a":         return "audio/mp4"
        case "mp3":         return "audio/mpeg"
        case "aac":         return "audio/aac"
        case "wav":         return "audio/wav"
        case "flac":        return "audio/flac"
        case "ogg", "oga":  return "audio/ogg"
        default:            return "application/octet-stream"
        }
    }
}

// MARK: - WKURLSchemeHandler for enkrit-media:// (picked local files)
//
// WKWebView only grants file:// read access to the app bundle (set in
// loadFileURL). Files picked from Photos (copied to tmp) or the Files app
// live outside that sandbox, so they are served through this scheme instead.
// JS side: electronAPI.toFileUrl() maps absolute paths to
//   enkrit-media://local/<percent-encoded-path>
final class MediaSchemeHandler: NSObject, WKURLSchemeHandler {

    // Security-scoped files (Files app) must be explicitly registered.
    private static var allowedPaths = Set<String>()
    private static let lock = NSLock()

    // Tracks tasks WebKit has started but not yet stopped.
    private let active = ActiveTaskTracker()

    static func allow(path: String) {
        lock.lock(); allowedPaths.insert(path); lock.unlock()
    }

    private static func isAllowed(_ path: String) -> Bool {
        let tmp  = FileManager.default.temporaryDirectory.path
        let docs = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first ?? ""
        if path.hasPrefix(tmp) || (!docs.isEmpty && path.hasPrefix(docs)) { return true }
        lock.lock(); defer { lock.unlock() }
        return allowedPaths.contains(path)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        active.add(urlSchemeTask)
        guard let url = urlSchemeTask.request.url else {
            if active.isActive(urlSchemeTask) { urlSchemeTask.didFailWithError(URLError(.badURL)) }
            return
        }
        let path = url.path   // percent-decoded
        guard !path.isEmpty, Self.isAllowed(path),
              FileManager.default.fileExists(atPath: path) else {
            if active.isActive(urlSchemeTask) { urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)) }
            return
        }
        let tracker = active
        LocalFileServer.serve(task: urlSchemeTask,
                              fileURL: URL(fileURLWithPath: path),
                              originalRequest: urlSchemeTask.request,
                              isLive: { tracker.isActive($0) })
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        active.remove(urlSchemeTask)
    }
}

// MARK: - WKURLSchemeHandler for ph:// (Photos library assets)

final class PHSchemeHandler: NSObject, WKURLSchemeHandler {

    // Cache: localIdentifier → exported temp file URL
    private static let exportCache = NSCache<NSString, NSURL>()

    // Tracks tasks WebKit has started but not yet stopped.
    private let active = ActiveTaskTracker()

    /// Stable, filesystem-safe key derived from a PHAsset.localIdentifier.
    /// Avoids Swift's per-launch randomized String.hashValue so temp files
    /// persist across launches (cache hits) and never collide.
    private static func safeKey(for localId: String) -> String {
        let mapped = localId.unicodeScalars.map { scalar -> Character in
            let c = Character(scalar)
            return (c.isLetter || c.isNumber) ? c : "_"
        }
        return String(mapped)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        active.add(urlSchemeTask)
        guard let reqURL  = urlSchemeTask.request.url else {
            fail(urlSchemeTask, URLError(.badURL)); return
        }

        // ph://localIdentifier  →  localId = everything after "ph://"
        let localId = reqURL.absoluteString
            .replacingOccurrences(of: "ph://", with: "")

        // Check disk cache
        if let cached = Self.exportCache.object(forKey: localId as NSString) as URL? {
            serve(task: urlSchemeTask, fileURL: cached, originalRequest: urlSchemeTask.request)
            return
        }

        let result = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        guard let asset = result.firstObject else {
            fail(urlSchemeTask, URLError(.fileDoesNotExist)); return
        }

        if asset.mediaType == .video {
            exportVideo(asset: asset, localId: localId, task: urlSchemeTask)
        } else {
            exportAudio(asset: asset, localId: localId, task: urlSchemeTask)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Remove from the active set so any in-flight export callback that
        // resolves after this point won't touch the (now stopped) task.
        // The export itself is best-effort and still completes (result cached).
        active.remove(urlSchemeTask)
    }

    // MARK: - Video Export

    private func exportVideo(asset: PHAsset, localId: String, task: WKURLSchemeTask) {
        let opts = PHVideoRequestOptions()
        opts.deliveryMode = .highQualityFormat
        opts.isNetworkAccessAllowed = true

        PHImageManager.default().requestAVAsset(forVideo: asset, options: opts) { avAsset, _, info in
            // If it's already a local file-backed URL, use it directly
            if let urlAsset = avAsset as? AVURLAsset, urlAsset.url.isFileURL {
                Self.exportCache.setObject(urlAsset.url as NSURL, forKey: localId as NSString)
                DispatchQueue.main.async {
                    self.serve(task: task, fileURL: urlAsset.url, originalRequest: task.request)
                }
                return
            }

            // Otherwise export via passthrough (preserves quality, skips re-encode)
            guard let avAsset = avAsset else {
                DispatchQueue.main.async { self.fail(task, URLError(.cannotOpenFile)) }
                return
            }

            let destURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("enkrit_\(Self.safeKey(for: localId)).mp4")

            if FileManager.default.fileExists(atPath: destURL.path) {
                Self.exportCache.setObject(destURL as NSURL, forKey: localId as NSString)
                DispatchQueue.main.async {
                    self.serve(task: task, fileURL: destURL, originalRequest: task.request)
                }
                return
            }

            guard let session = AVAssetExportSession(asset: avAsset,
                                                     presetName: AVAssetExportPresetPassthrough) else {
                DispatchQueue.main.async { self.fail(task, URLError(.cannotOpenFile)) }
                return
            }
            session.outputURL      = destURL
            session.outputFileType = .mp4

            session.exportAsynchronously {
                DispatchQueue.main.async {
                    if session.status == .completed {
                        Self.exportCache.setObject(destURL as NSURL, forKey: localId as NSString)
                        self.serve(task: task, fileURL: destURL, originalRequest: task.request)
                    } else {
                        self.fail(task, session.error ?? URLError(.cannotOpenFile))
                    }
                }
            }
        }
    }

    // MARK: - Audio Export

    private func exportAudio(asset: PHAsset, localId: String, task: WKURLSchemeTask) {
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first else {
            fail(task, URLError(.fileDoesNotExist)); return
        }

        let ext  = (resource.originalFilename as NSString).pathExtension.lowercased()
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("enkrit_\(Self.safeKey(for: localId)).\(ext.isEmpty ? "m4a" : ext)")

        if FileManager.default.fileExists(atPath: dest.path) {
            Self.exportCache.setObject(dest as NSURL, forKey: localId as NSString)
            serve(task: task, fileURL: dest, originalRequest: task.request)
            return
        }

        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = true

        PHAssetResourceManager.default().writeData(for: resource, toFile: dest, options: opts) { error in
            DispatchQueue.main.async {
                if error == nil {
                    Self.exportCache.setObject(dest as NSURL, forKey: localId as NSString)
                    self.serve(task: task, fileURL: dest, originalRequest: task.request)
                } else {
                    self.fail(task, error ?? URLError(.cannotOpenFile))
                }
            }
        }
    }

    // MARK: - Serve file with range-request support (shared)

    private func serve(task: WKURLSchemeTask, fileURL: URL, originalRequest: URLRequest) {
        let tracker = active
        LocalFileServer.serve(task: task, fileURL: fileURL, originalRequest: originalRequest,
                              isLive: { tracker.isActive($0) })
    }

    // MARK: - Helpers

    private func fail(_ task: WKURLSchemeTask, _ error: Error) {
        guard active.isActive(task) else { return }
        task.didFailWithError(error)
    }
}
