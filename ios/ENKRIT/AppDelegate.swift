import UIKit

// Classic (non-scene) lifecycle: this is a single-window app, so the
// UIScene machinery adds nothing. The Info.plist deliberately has NO
// UIApplicationSceneManifest and this delegate implements no scene
// methods, so UIKit uses the app-delegate window directly.
@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        NSLog("ENKRIT: didFinishLaunching")
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.backgroundColor = .black
        window.rootViewController = ViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
