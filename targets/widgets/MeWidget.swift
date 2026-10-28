import SwiftUI
import WidgetKit

// Me: sharing or invisible. The small size only shows it, the medium one has the buttons,
// because a small widget has one tap target and that one opens the app.
struct MeEntry: TimelineEntry {
  let date: Date
  let me: WMe?
  let signedIn: Bool
}

struct MeProvider: TimelineProvider {
  func placeholder(in context: Context) -> MeEntry {
    MeEntry(date: Date(), me: Snapshot.sample.me, signedIn: true)
  }

  func getSnapshot(in context: Context, completion: @escaping (MeEntry) -> Void) {
    if context.isPreview {
      completion(MeEntry(date: Date(), me: Snapshot.sample.me, signedIn: true))
    } else {
      let snapshot = Store.load()
      completion(MeEntry(date: Date(), me: snapshot?.me, signedIn: snapshot != nil))
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<MeEntry>) -> Void) {
    let snapshot = Store.load()
    let entry = MeEntry(date: Date(), me: snapshot?.me, signedIn: snapshot != nil)
    // While invisible the minutes left count down, so the card is redrawn every minute.
    let hidden = (entry.me?.hiddenUntil ?? 0) > entry.date.timeIntervalSince1970 * 1000
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(hidden ? 60 : 15 * 60))))
  }
}

struct MeWidgetView: View {
  let entry: MeEntry
  @Environment(\.widgetFamily) private var family

  private var hiddenLeft: Int? {
    guard let until = entry.me?.hiddenUntil else { return nil }
    let left = Int((until / 1000 - entry.date.timeIntervalSince1970) / 60)
    return left > 0 ? left : nil
  }

  private func leftText(_ left: Int) -> String {
    if left > 60 * 24 * 365 { return "" }
    return left >= 60 ? "\(left / 60) h \(left % 60) min" : "\(left) min"
  }

  var body: some View {
    if let me = entry.me {
      let left = hiddenLeft
      HStack(spacing: 14) {
        VStack(alignment: .leading, spacing: 4) {
          SectionLabel(text: "Me")
          HStack(spacing: 6) {
            Circle()
              .fill(left != nil ? Style.grey : (me.sharing ? Style.green : Style.grey))
              .frame(width: 8, height: 8)
            Text(left != nil ? "Invisible" : (me.sharing ? "Sharing" : "Not connected"))
              .font(.system(size: 14, weight: .bold))
              .foregroundStyle(.white)
          }
          .padding(.top, 4)
          if let left = left {
            Text(leftText(left))
              .font(.system(size: 24, weight: .bold))
              .foregroundStyle(.white)
            Text(left > 60 * 24 * 365 ? "until you switch it off" : "left")
              .font(.system(size: 12))
              .foregroundStyle(Style.muted)
          } else if let battery = me.battery {
            Text("\(battery) %")
              .font(.system(size: 12))
              .foregroundStyle(Style.muted)
          }
          Spacer(minLength: 0)
          if family == .systemSmall {
            Text("Open the app to go invisible")
              .font(.system(size: 11))
              .foregroundStyle(Style.muted)
          }
        }
        if family != .systemSmall {
          VStack(spacing: 8) {
            Spacer(minLength: 0)
            if left != nil {
              Link(destination: link("hide=0")) {
                ButtonLook(text: "Show me again", background: Style.green.opacity(0.18), foreground: Style.green)
              }
            } else {
              Link(destination: link("hide=15")) { ButtonLook(text: "Invisible 15 min") }
              Link(destination: link("hide=60")) { ButtonLook(text: "Invisible 1 h") }
            }
            Spacer(minLength: 0)
          }
          .frame(width: 130)
        }
      }
      .widgetURL(link("from=widget"))
    } else {
      NoticeView(text: entry.signedIn ? "Open NeoPin once" : "Open NeoPin to sign in")
    }
  }
}

struct MeWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NeoPinMe", provider: MeProvider()) { entry in
      MeWidgetView(entry: entry)
        .modifier(WidgetBackground(family: .systemSmall))
    }
    .configurationDisplayName("Me")
    .description("Whether you are sharing, and buttons to go invisible for a while.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}
