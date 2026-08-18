import UIKit
import Capacitor
import Intents

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Ask for Siri authorisation so "Hey Siri, ask Jarvis to…" can work.
        // Declining is fine — every other entry point still functions.
        INPreferences.requestSiriAuthorization { _ in }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {}

    func applicationDidEnterBackground(_ application: UIApplication) {}

    func applicationWillEnterForeground(_ application: UIApplication) {}

    func applicationDidBecomeActive(_ application: UIApplication) {}

    func applicationWillTerminate(_ application: UIApplication) {}

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        // Hands jarvis:// URLs to Capacitor, which forwards them to the web
        // layer as an `appUrlOpen` event.
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        // Siri Shortcuts and Handoff arrive here. A shortcut carries its spoken
        // phrase in the activity, which becomes the request text.
        if userActivity.activityType == "ai.jarvis.assistant.ask" {
            let spoken = userActivity.userInfo?["message"] as? String
                ?? userActivity.title
                ?? ""
            JarvisBridge.dispatch(event: "jarvis:shared-text", payload: spoken)
            return true
        }

        return ApplicationDelegateProxy.shared.application(
            application,
            continue: userActivity,
            restorationHandler: restorationHandler
        )
    }
}

/// Sends an event into the web layer, mirroring what MainActivity does on Android.
enum JarvisBridge {
    static func dispatch(event: String, payload: String) {
        guard
            let controller = UIApplication.shared.windows.first?.rootViewController
                as? CAPBridgeViewController,
            let webView = controller.webView
        else { return }

        let escaped = payload
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")

        let script = "window.dispatchEvent(new CustomEvent('\(event)', { detail: '\(escaped)' }));"
        DispatchQueue.main.async {
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}
