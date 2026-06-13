import UIKit
import LocalAuthentication
import WebKit
import Photos
import PhotosUI
import AVFoundation
import UniformTypeIdentifiers

// MARK: - ViewController

class ViewController: UIViewController {

    var webView: WKWebView!
    var isImmersive = false
    var currentOrientationMask: UIInterfaceOrientationMask = .portrait
    private var isSubtitlePicker = false

    override var prefersStatusBarHidden: Bool { isImmersive }
    override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .fade }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { currentOrientationMask }
    override var shouldAutorotate: Bool { true }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupAudioSession()
        setupWebView()
        loadApp()
    }

    // MARK: - Audio Session

    func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback,
                mode: .moviePlayback,
                options: [.mixWithOthers, .allowAirPlay]
            )
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("ENKRIT: Audio session error: \(error)")
        }
    }

    // MARK: - WebView Setup

    func setupWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true

        // Custom scheme handler for ph:// (Photos library assets)
        config.setURLSchemeHandler(PHSchemeHandler(), forURLScheme: "ph")
        // Custom scheme handler for enkrit-media:// (picked local files outside the bundle)
        config.setURLSchemeHandler(MediaSchemeHandler(), forURLScheme: "enkrit-media")

        let cc = config.userContentController

        // Fire-and-forget bridge
        cc.add(BridgeMessageHandler(vc: self), name: "enkrit")

        // Sync bridge (returns a Promise in JS)
        if #available(iOS 14, *) {
            cc.addScriptMessageHandler(BridgeSyncHandler(vc: self), contentWorld: .page, name: "enkritSync")
        }

        // Polyfill: injected BEFORE any page scripts
        cc.addUserScript(WKUserScript(
            source: buildPolyfill(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        // libraryAPI async override: injected AFTER page scripts (overrides the Android stub)
        cc.addUserScript(WKUserScript(
            source: """
            window.libraryAPI = {
              scanLibrary: async function() {
                try {
                  var json = await window.webkit.messageHandlers.enkritSync.postMessage({method:'scanLibrary',args:[]});
                  return JSON.parse(json || '[]');
                } catch(e) { return []; }
              }
            };
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        if #available(iOS 15, *) {
            // Default is systemBackground (white in light mode) — shows as
            // white bands behind the status bar / home indicator.
            webView.underPageBackgroundColor = .black
        }
        webView.navigationDelegate = self

        view.addSubview(webView)
    }

    func loadApp() {
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "www") else {
            showError("Could not find app bundle (www/index.html missing)")
            return
        }
        // Use bundle URL as read-access root so fonts/subdir are reachable
        let readAccess = Bundle.main.bundleURL
        print("ENKRIT: Loading \(url)")
        print("ENKRIT: Read access: \(readAccess)")
        webView.loadFileURL(url, allowingReadAccessTo: readAccess)
    }

    // MARK: - Bridge Polyfill (injected at document start)

    func buildPolyfill() -> String {
        return """
        (function() {
          'use strict';

          // All fire-and-forget calls go through this
          function POST(method, args) {
            try { window.webkit.messageHandlers.enkrit.postMessage({method: method, args: args || []}); } catch(e) {}
          }

          window.AndroidBridge = {
            // Playback — handled by HTML <video> on iOS (no native player)
            playNativeMedia:   null,   // deliberately null so hasNativePlayer() returns false
            nativeSetPlaying:  function(p)        { POST('nativeSetPlaying',  [p]); },
            nativeSeekTo:      function(ms)       { POST('nativeSeekTo',      [ms]); },
            nativeSetVolume:   function(v)        { POST('nativeSetVolume',   [v]); },
            nativeSetSpeed:    function(s)        { POST('nativeSetSpeed',    [s]); },
            setSpeed:          function(s)        { POST('nativeSetSpeed',    [s]); },
            stopNativeMedia:   function()         { POST('stopNativeMedia',   []); },

            // Media picker
            pickMedia:         function()         { POST('pickMedia',         []); },
            pickSubtitleFile:  function()         { POST('pickSubtitleFile',  []); },

            // Video transform (CSS-based on iOS — native side is no-op)
            setVideoTransform: function(z, x, y) { POST('setVideoTransform', [z, x, y]); },
            setVideoZoom:      function(z)        { POST('setVideoTransform', [z, 0, 0]); },
            setVideoFilter:    function(b,c,s,g,h,sep,inv,bl) { POST('setVideoFilter',[b,c,s,g,h,sep,inv,bl]); },

            // System
            setOrientationMode:  function(m) { POST('setOrientationMode',  [m]); },
            setImmersive:        function(v) { POST('setImmersive',        [v]); },
            setScreenBrightness: function(v) { POST('setScreenBrightness', [v]); },

            // Permissions
            hasMediaPermission:    function() { return true; },
            requestMediaPermission: function() { POST('requestMediaPermission', []); },

            // Private vault: biometric (FaceID/TouchID) + secure flag (no-op on iOS)
            requestBiometric:  function(t) { POST('requestBiometric', [t || '']); },
            setSecureMode:     function(on) { POST('setSecureMode', [on]); },

            // Thumbnails + delete
            requestVideoThumb: function(p, i) { POST('requestVideoThumb', [p, i]); },
            deleteMedia:       function(p)    { POST('deleteMedia',       [p]); },

            // Exit (minimize on iOS)
            exitApp: function() { POST('exitApp', []); },

            // scanLibrary stub — overridden by the atDocumentEnd script
            scanLibrary: function() { return '[]'; },
          };

          // Electron API stub (mostly unused on iOS).
          // toFileUrl: WKWebView blocks file:// reads outside the app bundle,
          // so absolute paths are mapped to the enkrit-media:// scheme handler.
          window.electronAPI = window.electronAPI || {
            getPathForFile: function() { return ''; },
            toFileUrl: function(p) {
              if (!p) return '';
              if (p.indexOf('://') !== -1) return p;  // ph://, blob:, enkrit-media://, …
              if (p.charAt(0) !== '/') return p;
              return 'enkrit-media://local' + p.split('/').map(encodeURIComponent).join('/');
            },
            runWhisper: async function() { return { error: 'AI subtitles not available on iOS' }; },
            readFile: async function() { return null; },
            preparePlayable: async function() { return { error: 'Codec conversion not available on iOS' }; },
          };

          // Mark the iOS host ASAP so safe-area CSS applies from first paint
          document.addEventListener('DOMContentLoaded', function() {
            if (document.body) document.body.classList.add('ios-ready');
          });

          // Forward JS errors to native console
          window.addEventListener('error', function(e) {
            POST('jsError', [e.message + ' @ ' + e.filename + ':' + e.lineno]);
          });
          window.addEventListener('unhandledrejection', function(e) {
            POST('jsError', ['Unhandled promise rejection: ' + (e.reason && e.reason.message || e.reason)]);
          });
        })();
        """
    }

    // MARK: - Bridge Dispatch (fire-and-forget)

    func handleMessage(_ method: String, _ args: [Any]) {
        switch method {
        case "pickMedia":
            pickMedia()
        case "pickSubtitleFile":
            pickSubtitleFile()
        case "requestMediaPermission":
            requestMediaPermission()
        case "requestBiometric":
            authenticateBiometric(reason: args.first as? String ?? "Unlock Private folder")
        case "setSecureMode":
            // iOS can't block screenshots for normal apps; app-switcher blur is
            // handled separately via the privacy overlay. No-op here.
            break
        case "requestVideoThumb":
            let path = args.first as? String ?? ""
            let idx  = (args.count > 1 ? args[1] : 0) as? Int ?? 0
            requestVideoThumb(path: path, idx: idx)
        case "deleteMedia":
            deleteMedia(path: args.first as? String ?? "")
        case "jsError":
            print("ENKRIT JS ERROR: \(args.first as? String ?? "unknown")")
        case "exitApp":
            UIControl().sendAction(#selector(URLSessionTask.suspend), to: UIApplication.shared, for: nil)
        case "setOrientationMode":
            setOrientationMode(args.first as? String ?? "portrait")
        case "setImmersive":
            let on = args.first as? Bool ?? false
            isImmersive = on
            DispatchQueue.main.async { self.setNeedsStatusBarAppearanceUpdate() }
        case "setScreenBrightness":
            if let v = args.first as? CGFloat { UIScreen.main.brightness = v / 100.0 }
            else if let v = args.first as? Int { UIScreen.main.brightness = CGFloat(v) / 100.0 }
        case "setVideoFilter":
            // On iOS, CSS filters are applied by app.js itself since S.nativePlayback is false.
            break
        case "setVideoTransform", "setVideoZoom":
            // CSS transform applied by app.js.
            break
        case "nativeSetPlaying", "nativeSeekTo", "nativeSetVolume", "nativeSetSpeed", "stopNativeMedia":
            // No native player on iOS; HTML <video> handles these via app.js directly.
            break
        default:
            print("ENKRIT: unhandled bridge message: \(method)")
        }
    }

    // MARK: - Sync Bridge Dispatch (returns a Promise to JS)

    func handleSyncMessage(_ method: String, _ args: [Any], reply: @escaping (Any?, String?) -> Void) {
        switch method {
        case "scanLibrary":
            scanLibrary(reply: reply)
        default:
            reply("[]", nil)
        }
    }

    // MARK: - Orientation

    func setOrientationMode(_ mode: String) {
        switch mode {
        case "landscape": currentOrientationMask = .landscape
        case "auto":      currentOrientationMask = .allButUpsideDown
        default:          currentOrientationMask = .portrait
        }
        if #available(iOS 16, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
        } else {
            UIDevice.current.setValue(UIInterfaceOrientation.portrait.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    // MARK: - Library Scan

    func scanLibrary(reply: @escaping (Any?, String?) -> Void) {
        let status: PHAuthorizationStatus
        if #available(iOS 14, *) {
            status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        } else {
            status = PHPhotoLibrary.authorizationStatus()
        }

        switch status {
        case .authorized, .limited:
            performScan(reply: reply)
        case .notDetermined:
            let handler: (PHAuthorizationStatus) -> Void = { [weak self] s in
                DispatchQueue.main.async {
                    if s == .authorized || s == .limited {
                        self?.performScan(reply: reply)
                    } else {
                        reply("[]", nil)
                    }
                }
            }
            if #available(iOS 14, *) {
                PHPhotoLibrary.requestAuthorization(for: .readWrite, handler: handler)
            } else {
                PHPhotoLibrary.requestAuthorization(handler)
            }
        default:
            reply("[]", nil)
        }
    }

    func performScan(reply: @escaping (Any?, String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var items: [[String: Any]] = []

            // Videos
            let vOpts = PHFetchOptions()
            vOpts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let videos = PHAsset.fetchAssets(with: .video, options: vOpts)
            videos.enumerateObjects { asset, _, _ in
                let id   = asset.localIdentifier
                let name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "video.mp4"
                items.append([
                    "path": "ph://\(id)",
                    "url":  "ph://\(id)",
                    "name": name,
                    "durationMs": Int(asset.duration * 1000),
                    "size": 0,
                    "folder": "Photos",
                    "type": "video",
                ])
            }

            // Audio
            let aOpts = PHFetchOptions()
            aOpts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            let audios = PHAsset.fetchAssets(with: .audio, options: aOpts)
            audios.enumerateObjects { asset, _, _ in
                let id   = asset.localIdentifier
                let name = PHAssetResource.assetResources(for: asset).first?.originalFilename ?? "audio.m4a"
                items.append([
                    "path": "ph://\(id)",
                    "url":  "ph://\(id)",
                    "name": name,
                    "durationMs": Int(asset.duration * 1000),
                    "size": 0,
                    "folder": "Music",
                    "type": "audio",
                ])
            }

            DispatchQueue.main.async {
                if let data = try? JSONSerialization.data(withJSONObject: items),
                   let json = String(data: data, encoding: .utf8) {
                    reply(json, nil)
                } else {
                    reply("[]", nil)
                }
                // NOTE: do NOT call onPermissionReady here — app.js reacts to it
                // by starting another scan, which would loop forever.
                _ = self
            }
        }
    }

    // MARK: - Permission

    func requestMediaPermission() {
        let handler: (PHAuthorizationStatus) -> Void = { [weak self] status in
            DispatchQueue.main.async {
                if status == .authorized || status == .limited {
                    self?.callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onPermissionReady) window.ENKRITAndroid.onPermissionReady()")
                }
            }
        }
        if #available(iOS 14, *) {
            PHPhotoLibrary.requestAuthorization(for: .readWrite, handler: handler)
        } else {
            PHPhotoLibrary.requestAuthorization(handler)
        }
    }

    // MARK: - Thumbnails

    func requestVideoThumb(path: String, idx: Int) {
        guard path.hasPrefix("ph://") else {
            // Local file (picked via Photos-copy or Files app)
            guard path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else { return }
            DispatchQueue.global(qos: .utility).async { [weak self] in
                let asset = AVURLAsset(url: URL(fileURLWithPath: path))
                let gen = AVAssetImageGenerator(asset: asset)
                gen.appliesPreferredTrackTransform = true
                gen.maximumSize = CGSize(width: 360, height: 240)
                let time = CMTime(seconds: min(3, asset.duration.seconds / 2), preferredTimescale: 600)
                guard let cg = try? gen.copyCGImage(at: time, actualTime: nil),
                      let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.65) else { return }
                let b64 = data.base64EncodedString()
                DispatchQueue.main.async {
                    self?.callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onVideoThumb) window.ENKRITAndroid.onVideoThumb(\(idx), '\(b64)')")
                }
            }
            return
        }
        let localId = String(path.dropFirst(5))
        let assets  = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        guard let asset = assets.firstObject else { return }

        let opts = PHImageRequestOptions()
        // .opportunistic + .current: freshly imported videos often have no
        // fast-format thumbnail resource (PHPhotosError 3303 with .fastFormat).
        opts.deliveryMode = .opportunistic
        opts.version      = .current
        opts.resizeMode   = .fast
        opts.isNetworkAccessAllowed = true

        PHImageManager.default().requestImage(
            for: asset,
            targetSize: CGSize(width: 180, height: 120),
            contentMode: .aspectFill,
            options: opts
        ) { [weak self] image, _ in
            guard let image = image,
                  let data  = image.jpegData(compressionQuality: 0.65) else { return }
            let b64 = data.base64EncodedString()
            DispatchQueue.main.async {
                self?.callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onVideoThumb) window.ENKRITAndroid.onVideoThumb(\(idx), '\(b64)')")
            }
        }
    }

    // MARK: - Delete Media

    func deleteMedia(path: String) {
        guard path.hasPrefix("ph://") else {
            let esc = path.jsEscaped
            callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onDeleteComplete) window.ENKRITAndroid.onDeleteComplete(false, '\(esc)')")
            return
        }
        let localId = String(path.dropFirst(5))
        let assets  = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(assets as NSFastEnumeration)
        }) { [weak self] success, _ in
            DispatchQueue.main.async {
                let esc = path.jsEscaped
                self?.callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onDeleteComplete) window.ENKRITAndroid.onDeleteComplete(\(success), '\(esc)')")
            }
        }
    }

    // MARK: - Pick Media

    func pickMedia() {
        // Android offers video/* + audio/* from one system picker.
        // iOS splits that across Photos (videos) and Files (videos + audio),
        // so offer both sources.
        let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Photo Library", style: .default) { [weak self] _ in
            self?.pickFromPhotos()
        })
        sheet.addAction(UIAlertAction(title: "Files", style: .default) { [weak self] _ in
            self?.pickFromFiles()
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        present(sheet, animated: true)
    }

    func pickFromPhotos() {
        if #available(iOS 14, *) {
            var cfg = PHPickerConfiguration(photoLibrary: .shared())
            cfg.filter = .any(of: [.videos])
            cfg.selectionLimit = 50
            let picker = PHPickerViewController(configuration: cfg)
            picker.delegate = self
            present(picker, animated: true)
        } else {
            let picker = UIImagePickerController()
            picker.mediaTypes = ["public.movie"]
            picker.sourceType = .photoLibrary
            picker.delegate   = self
            present(picker, animated: true)
        }
    }

    func pickFromFiles() {
        var types: [UTType] = [.movie, .video, .audio, .mpeg4Movie, .quickTimeMovie, .mp3, .mpeg4Audio, .wav]
        if let mkv  = UTType(filenameExtension: "mkv")  { types.append(mkv) }
        if let flac = UTType(filenameExtension: "flac") { types.append(flac) }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        isSubtitlePicker = false
        present(picker, animated: true)
    }

    // MARK: - Pick Subtitle File

    func pickSubtitleFile() {
        let types: [UTType]
        if #available(iOS 14, *) {
            types = [.text, UTType(filenameExtension: "srt") ?? .text, UTType(filenameExtension: "vtt") ?? .text]
        } else {
            types = [UTType.plainText]
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types)
        picker.delegate = self
        isSubtitlePicker = true
        present(picker, animated: true)
    }

    // MARK: - Safe Area → CSS

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        pushSafeAreaToJS()
    }

    func pushSafeAreaToJS() {
        guard webView != nil else { return }
        let i = view.safeAreaInsets
        callJS("document.documentElement.style.setProperty('--safe-top','\(Int(i.top))px');"
             + "document.documentElement.style.setProperty('--safe-bottom','\(Int(i.bottom))px');")
    }

    // MARK: - JS Helper

    func callJS(_ js: String) {
        webView.evaluateJavaScript(js) { _, err in
            if let err = err { print("ENKRIT JS error: \(err)") }
        }
    }

    // MARK: - Biometric (FaceID / TouchID)
    func authenticateBiometric(reason: String) {
        let ctx = LAContext()
        ctx.localizedFallbackTitle = "Use PIN"
        var err: NSError?
        // Allow device passcode fallback so it works even without enrolled biometrics.
        if ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) {
            ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] ok, _ in
                DispatchQueue.main.async {
                    self?.callJS("window.ENKRITAndroid&&window.ENKRITAndroid.onBiometric&&window.ENKRITAndroid.onBiometric(\(ok ? "true" : "false"));")
                }
            }
        } else {
            callJS("window.ENKRITAndroid&&window.ENKRITAndroid.onBiometric&&window.ENKRITAndroid.onBiometric(false);")
        }
    }

    // MARK: - Error

    func showError(_ msg: String) {
        let alert = UIAlertController(title: "ENKRIT", message: msg, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}

// MARK: - WKNavigationDelegate

extension ViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("ENKRIT: didFinish navigation — page loaded OK")
        // Small delay to let page scripts settle, then force UI visible
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.callJS("""
                (function() {
                  // Force splash away and app visible (in case window.load timer didn't fire)
                  var splash = document.getElementById('splash');
                  var app = document.getElementById('app');
                  if (splash) { splash.style.display = 'none'; }
                  if (app && (!app.style.display || app.style.display === 'none')) {
                    app.style.display = 'flex';
                    app.style.flexDirection = 'column';
                  }
                  // Signal iOS ready
                  if (document.body && !document.body.classList.contains('ios-ready')) {
                    document.body.classList.add('ios-ready');
                  }
                })();
            """)
            self?.pushSafeAreaToJS()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("ENKRIT: didFail navigation: \(error)")
        showError("Page failed to load: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("ENKRIT: didFailProvisionalNavigation: \(error)")
        showError("Could not load app: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Allow file:// and ph:// navigations; block external http/https
        if let url = navigationAction.request.url {
            if url.scheme == "file" || url.scheme == "ph" || url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            if url.scheme == "http" || url.scheme == "https" {
                // Embedded players (YouTube/Instagram/Vimeo iframes) navigate inside
                // their own subframes; only main-frame links leave the app.
                if let frame = navigationAction.targetFrame, !frame.isMainFrame {
                    decisionHandler(.allow)
                    return
                }
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }
}

// MARK: - PHPickerViewControllerDelegate (iOS 14+)

@available(iOS 14, *)
extension ViewController: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        dismiss(animated: true)
        guard !results.isEmpty else { return }

        var items: [[String: Any]] = []
        let group = DispatchGroup()

        for result in results {
            guard result.itemProvider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) else { continue }
            group.enter()
            result.itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, _ in
                defer { group.leave() }
                guard let url = url else { return }
                // Copy to temp so the URL remains valid after the picker closes
                let dest = FileManager.default.temporaryDirectory
                    .appendingPathComponent("enkrit_\(url.lastPathComponent)")
                try? FileManager.default.removeItem(at: dest)
                try? FileManager.default.copyItem(at: url, to: dest)
                items.append([
                    "url":  dest.absoluteString,
                    "path": dest.path,
                    "name": url.lastPathComponent,
                    "type": "video",
                ])
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self = self, !items.isEmpty else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: items),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onPickedMedia) window.ENKRITAndroid.onPickedMedia(\(json))")
        }
    }
}

// MARK: - UIImagePickerControllerDelegate (iOS < 14)

extension ViewController: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    func imagePickerController(_ picker: UIImagePickerController,
                                didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        dismiss(animated: true)
        guard let url = info[.mediaURL] as? URL else { return }
        let dest = FileManager.default.temporaryDirectory
            .appendingPathComponent("enkrit_\(url.lastPathComponent)")
        try? FileManager.default.removeItem(at: dest)
        try? FileManager.default.copyItem(at: url, to: dest)
        let item: [String: Any] = ["url": dest.absoluteString, "path": dest.path,
                                    "name": url.lastPathComponent, "type": "video"]
        guard let data = try? JSONSerialization.data(withJSONObject: [item]),
              let json = String(data: data, encoding: .utf8) else { return }
        callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onPickedMedia) window.ENKRITAndroid.onPickedMedia(\(json))")
    }
}

// MARK: - UIDocumentPickerDelegate

extension ViewController: UIDocumentPickerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController,
                        didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }

        if isSubtitlePicker {
            isSubtitlePicker = false
            // Subtitle file
            do {
                let data = try Data(contentsOf: url)
                let b64  = data.base64EncodedString()
                callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onSubtitleFileB64) window.ENKRITAndroid.onSubtitleFileB64('\(b64)')")
            } catch {
                callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onSubtitleFileB64) window.ENKRITAndroid.onSubtitleFileB64(null)")
            }
        } else {
            // Media files via Files app
            var items: [[String: Any]] = []
            for url in urls {
                // Keep the security scope open for the session and register the
                // path so MediaSchemeHandler is allowed to serve it.
                _ = url.startAccessingSecurityScopedResource()
                MediaSchemeHandler.allow(path: url.path)
                let audioExts: Set<String> = ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma"]
                let type = audioExts.contains(url.pathExtension.lowercased()) ? "audio" : "video"
                items.append([
                    "url": url.absoluteString, "path": url.path,
                    "name": url.lastPathComponent, "type": type,
                ])
            }
            guard !items.isEmpty,
                  let data = try? JSONSerialization.data(withJSONObject: items),
                  let json = String(data: data, encoding: .utf8) else { return }
            callJS("if(window.ENKRITAndroid && window.ENKRITAndroid.onPickedMedia) window.ENKRITAndroid.onPickedMedia(\(json))")
        }
    }
}

// MARK: - String helper

private extension String {
    var jsEscaped: String {
        replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
    }
}
