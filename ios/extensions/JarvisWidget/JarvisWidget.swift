import WidgetKit
import SwiftUI

/**
 Home screen widget in small, medium and large sizes.

 Widgets cannot run the web view, so this is native SwiftUI. Tapping any of it
 deep-links into the app, and the larger sizes expose specific prompts so a
 common request is one tap rather than one tap plus dictation.
 */

struct JarvisEntry: TimelineEntry {
    let date: Date
}

struct JarvisProvider: TimelineProvider {
    func placeholder(in context: Context) -> JarvisEntry {
        JarvisEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (JarvisEntry) -> Void) {
        completion(JarvisEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<JarvisEntry>) -> Void) {
        // The widget is a launcher, not a data display — it never needs to
        // refresh on its own.
        completion(Timeline(entries: [JarvisEntry(date: Date())], policy: .never))
    }
}

/// The arc-reactor orb, drawn natively so it matches the app.
struct OrbView: View {
    var size: CGFloat

    private let cyan = Color(red: 0.16, green: 0.83, blue: 1.0)

    var body: some View {
        ZStack {
            Circle()
                .stroke(cyan.opacity(0.35), lineWidth: 2)

            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(colors: [
                            cyan.opacity(0.95),
                            cyan.opacity(0.35),
                            cyan.opacity(0.05),
                        ]),
                        center: .init(x: 0.38, y: 0.32),
                        startRadius: 1,
                        endRadius: size * 0.55
                    )
                )
                .padding(size * 0.14)

            Image(systemName: "mic.fill")
                .font(.system(size: size * 0.3, weight: .semibold))
                .foregroundColor(Color(red: 0.02, green: 0.03, blue: 0.05))
        }
        .frame(width: size, height: size)
    }
}

struct JarvisWidgetEntryView: View {
    @Environment(\.widgetFamily) var family
    var entry: JarvisProvider.Entry

    private let background = Color(red: 0.02, green: 0.03, blue: 0.05)

    var body: some View {
        switch family {
        case .systemSmall:
            ZStack {
                background
                OrbView(size: 76)
            }
            .widgetURL(URL(string: "jarvis://chat"))

        case .systemMedium:
            ZStack {
                background
                HStack(spacing: 16) {
                    OrbView(size: 64)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("JARVIS")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.white)
                        Text("Tap to ask anything")
                            .font(.system(size: 12))
                            .foregroundColor(.white.opacity(0.6))
                    }
                    Spacer()
                }
                .padding(.horizontal, 18)
            }
            .widgetURL(URL(string: "jarvis://chat"))

        default:
            ZStack {
                background
                VStack(spacing: 14) {
                    OrbView(size: 72)
                    Text("JARVIS")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white)

                    VStack(spacing: 8) {
                        QuickLink(label: "What's the weather?", prompt: "What is the weather today?")
                        QuickLink(label: "Set a timer", prompt: "Set a timer for 5 minutes")
                        QuickLink(label: "Search the web", prompt: "Search the web for ")
                    }
                    .padding(.horizontal, 18)
                }
                .padding(.vertical, 16)
            }
        }
    }
}

/// One tappable prompt, deep-linking with its text pre-filled.
struct QuickLink: View {
    var label: String
    var prompt: String

    private var url: URL? {
        var components = URLComponents()
        components.scheme = "jarvis"
        components.host = "chat"
        components.queryItems = [URLQueryItem(name: "message", value: prompt)]
        return components.url
    }

    var body: some View {
        Link(destination: url ?? URL(string: "jarvis://chat")!) {
            HStack {
                Text(label)
                    .font(.system(size: 12))
                    .foregroundColor(.white.opacity(0.85))
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.white.opacity(0.07))
            .cornerRadius(8)
        }
    }
}

@main
struct JarvisWidget: Widget {
    let kind = "JarvisWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: JarvisProvider()) { entry in
            JarvisWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Jarvis")
        .description("Ask Jarvis from your home screen.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
