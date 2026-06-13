import WebKit
import Photos
import AVFoundation

// MARK: - Shared local-file server (range-request aware)

enum LocalFileServer {

    static func serve(task: WKURLSchemeTask, fileURL: URL, originalRequest: URLRequest) {
        guard let fileHandle = try? FileHandle(forReadingFrom: fileURL) else {
            task.didFailWithError(URLError(.cannotOpenFile)); return
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
            let parts    = rangeStr.split(separator: "-", maxSplits: 1)
            startByte    = Int(parts[0]) ?? 0
            endByte      = parts.count > 1 && !parts[1].isEmpty ? (Int(parts[1]) ?? (fileSize - 1)) : (fileSize - 1)
            endByte      = min(endByte, fileSize - 1)
            let length   = endByte - startByte + 1
            status       = 206
            headers["Content-Range"]  = "bytes \(startByte)-\(endByte)/\(fileSize)"
            headers["Content-Length"] = "\(length)"
        }

        guard let url = task.request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
              ) else { task.didFailWithError(URLError(.badServerResponse)); return }

        task.didReceive(response)

        // Stream in 1 MB chunks to avoid large heap allocations
        fileHandle.seek(toFileOffset: UInt64(startByte))
        let chunkSize = 1 * 1024 * 1024
        var remaining = endByte - startByte + 1

        while remaining > 0 {
            let toRead = min(chunkSize, remaining)
            let chunk  = fileHandle.readData(ofLength: toRead)
            if chunk.isEmpty { break }
            task.didReceive(chunk)
            remaining -= chunk.count
        }

        try? fileHandle.close()
        task.didFinish()
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
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL)); return
        }
        let path = url.path   // percent-decoded
        guard !path.isEmpty, Self.isAllowed(path),
              FileManager.default.fileExists(atPath: path) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        LocalFileServer.serve(task: urlSchemeTask,
                              fileURL: URL(fileURLWithPath: path),
                              originalRequest: urlSchemeTask.request)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

// MARK: - WKURLSchemeHandler for ph:// (Photos library assets)

final class PHSchemeHandler: NSObject, WKURLSchemeHandler {

    // Cache: localIdentifier → exported temp file URL
    private static let exportCache = NSCache<NSString, NSURL>()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
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
        // Cancellation is best-effort; we just let the export finish (result cached)
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
                .appendingPathComponent("enkrit_\(localId.hashValue).mp4")

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
            .appendingPathComponent("enkrit_\(localId.hashValue).\(ext.isEmpty ? "m4a" : ext)")

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
        LocalFileServer.serve(task: task, fileURL: fileURL, originalRequest: originalRequest)
    }

    // MARK: - Helpers

    private func fail(_ task: WKURLSchemeTask, _ error: Error) {
        task.didFailWithError(error)
    }
}
