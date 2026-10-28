import SwiftUI
import WidgetKit

// People: everybody from the app, nearest first. Three in the medium size, seven in the large.
struct GroupEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
}

struct GroupProvider: TimelineProvider {
  func placeholder(in context: Context) -> GroupEntry {
    GroupEntry(date: Date(), snapshot: Snapshot.sample)
  }

  func getSnapshot(in context: Context, completion: @escaping (GroupEntry) -> Void) {
    completion(GroupEntry(date: Date(), snapshot: context.isPreview ? Snapshot.sample : Store.load()))
  }

  // The app redraws the widgets whenever it has news. Without news the times still have to
  // move, so the line gets redrawn every quarter of an hour.
  func getTimeline(in context: Context, completion: @escaping (Timeline<GroupEntry>) -> Void) {
    let entry = GroupEntry(date: Date(), snapshot: Store.load())
    completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
  }
}

struct GroupWidgetView: View {
  let entry: GroupEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    if let snapshot = entry.snapshot {
      VStack(alignment: .leading, spacing: 4) {
        SectionLabel(text: "People")
        if snapshot.people.isEmpty {
          Text("Nobody yet. Invite people in the app.")
            .font(.system(size: 13))
            .foregroundStyle(Style.muted)
            .padding(.top, 6)
        } else {
          ForEach(snapshot.people.prefix(family == .systemLarge ? 7 : 3)) { person in
            Link(destination: personLink(person)) {
              PersonRow(person: person, now: entry.date)
            }
          }
        }
        Spacer(minLength: 0)
      }
      .widgetURL(link("from=widget"))
    } else {
      NoticeView(text: "Open NeoPin to sign in")
    }
  }
}

struct GroupWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "NeoPinGroup", provider: GroupProvider()) { entry in
      GroupWidgetView(entry: entry)
        .modifier(WidgetBackground(family: .systemMedium))
    }
    .configurationDisplayName("People")
    .description("Everybody you share with, nearest first.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}
