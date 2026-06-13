import WebKit

// MARK: - Fire-and-forget handler

final class BridgeMessageHandler: NSObject, WKScriptMessageHandler {
    weak var vc: ViewController?
    init(vc: ViewController) { self.vc = vc; super.init() }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body   = message.body as? [String: Any],
              let method = body["method"] as? String,
              let args   = body["args"]   as? [Any] else { return }
        DispatchQueue.main.async { [weak self] in
            self?.vc?.handleMessage(method, args)
        }
    }
}

// MARK: - Reply handler (returns Promise to JS)

@available(iOS 14, *)
final class BridgeSyncHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var vc: ViewController?
    init(vc: ViewController) { self.vc = vc; super.init() }

    func userContentController(_ ucc: WKUserContentController,
                                didReceive message: WKScriptMessage,
                                replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body   = message.body as? [String: Any],
              let method = body["method"] as? String,
              let args   = body["args"]   as? [Any] else {
            replyHandler("[]", nil); return
        }
        DispatchQueue.main.async { [weak self] in
            self?.vc?.handleSyncMessage(method, args, reply: replyHandler)
        }
    }
}
