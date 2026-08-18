import UIKit
import Social
import UniformTypeIdentifiers

/**
 Share extension: puts Jarvis in the iOS share sheet.

 The extension process cannot talk to the app's web view directly, so it writes
 the shared text into the shared App Group container and then opens the app via
 its URL scheme. `MobileLayout` picks the text up from the resulting
 `jarvis:shared-text` event.

 Requires an App Group (`group.ai.jarvis.assistant`) enabled on both the app
 target and this extension target.
 */
class ShareViewController: UIViewController {

    private let appGroup = "group.ai.jarvis.assistant"
    private let pendingKey = "jarvis.pendingSharedText"

    override func viewDidLoad() {
        super.viewDidLoad()
        handleSharedItem()
    }

    private func handleSharedItem() {
        guard
            let item = extensionContext?.inputItems.first as? NSExtensionItem,
            let provider = item.attachments?.first
        else {
            finish(with: nil)
            return
        }

        let textType = UTType.plainText.identifier
        let urlType = UTType.url.identifier

        if provider.hasItemConformingToTypeIdentifier(textType) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { [weak self] value, _ in
                self?.finish(with: value as? String)
            }
        } else if provider.hasItemConformingToTypeIdentifier(urlType) {
            provider.loadItem(forTypeIdentifier: urlType, options: nil) { [weak self] value, _ in
                self?.finish(with: (value as? URL)?.absoluteString)
            }
        } else {
            finish(with: nil)
        }
    }

    private func finish(with text: String?) {
        if let text, !text.isEmpty {
            // Stash it where the app can read it, then hand off via the scheme.
            UserDefaults(suiteName: appGroup)?.set(text, forKey: pendingKey)

            var components = URLComponents()
            components.scheme = "jarvis"
            components.host = "chat"
            components.queryItems = [URLQueryItem(name: "message", value: text)]

            if let url = components.url {
                openHostApp(url)
            }
        }

        DispatchQueue.main.async { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        }
    }

    /// Extensions have no `UIApplication.shared`, so walk the responder chain
    /// to find something that can open a URL.
    private func openHostApp(_ url: URL) {
        var responder: UIResponder? = self
        let selector = sel_registerName("openURL:")

        while let current = responder {
            if current.responds(to: selector), current !== self {
                current.perform(selector, with: url)
                return
            }
            responder = current.next
        }
    }
}
