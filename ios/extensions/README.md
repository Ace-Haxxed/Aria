# iOS extension targets

`ios/App` is a complete, buildable Capacitor project. The two extensions here
are **not** wired into it, because adding an Xcode target means rewriting
`project.pbxproj` — a generated file that does not survive being edited by
hand. Adding them takes about two minutes in Xcode.

Both are optional. The app builds, runs and ships to TestFlight without them.

## Share extension — "Share to Jarvis"

Puts Jarvis in the iOS share sheet for text and URLs.

1. `npm run ios:open`
2. **File → New → Target… → Share Extension**. Name it `ShareExtension`,
   uncheck "Include UI Tests".
3. Delete the generated `ShareViewController.swift` and `MainInterface.storyboard`.
4. Drag `ios/extensions/ShareExtension/ShareViewController.swift` in, with
   *only* the `ShareExtension` target ticked.
5. In the extension's `Info.plist`, set `NSExtensionPrincipalClass` to
   `$(PRODUCT_MODULE_NAME).ShareViewController` and remove
   `NSExtensionMainStoryboard`.
6. Select the **App** target → Signing & Capabilities → **+ App Groups** → add
   `group.ai.jarvis.assistant`. Repeat on the `ShareExtension` target. Both must
   have it, or the extension cannot hand text to the app.

## WidgetKit widget

Small, medium and large home screen widgets.

1. **File → New → Target… → Widget Extension**. Name it `JarvisWidget`,
   uncheck "Include Configuration Intent" and "Include Live Activity".
2. Delete the generated Swift file.
3. Drag `ios/extensions/JarvisWidget/JarvisWidget.swift` in, with only the
   `JarvisWidget` target ticked.
4. Set the deployment target to iOS 15.0 or later.

The widget deep-links through `jarvis://chat?message=…`, which the app already
handles — no extra wiring needed.

## Siri Shortcuts

Already wired up: `AppDelegate.swift` requests Siri authorisation and handles
the `ai.jarvis.assistant.ask` user activity, which `Info.plist` declares under
`NSUserActivityTypes`.

To give users a phrase to say, donate a shortcut from the app once they have
made a few requests, or let them add one in the Shortcuts app pointing at the
`jarvis://chat?message=…` URL.
