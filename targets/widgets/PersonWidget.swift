import AppIntents
import SwiftUI
import WidgetKit

// One person, picked when the widget is added. On the home screen with the Find button, on the
// lock screen as the small circle or the rectangle.
struct PersonEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Person"
  static var defaultQuery = PersonQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)")
  }
}

struct PersonQuery: EntityQuery {
  private func all() -> [PersonEntity] {
    (Store.load()?.people ?? []).map { PersonEntity(id: $0.id, name: $0.name) }
  }

  func entities(for identifiers: [String]) async throws -> [PersonEntity] {
    all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [PersonEntity] {
    all()
  }

  func defaultResult() async -> PersonEntity? {
    all().first
  }
}

struct PersonIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Person"
  static var description = IntentDescription("Who the widget shows.")

  @Parameter(title: "Person")
  var person: PersonEntity?
}

struct PersonEntry: TimelineEntry {
  let date: Date
  let person: WPerson?
  let signedIn: Bool
}

struct PersonProvider: AppIntentTimelineProvider {
  private func entry(for configuration: PersonIntent, preview: Bool) -> PersonEntry {
    if preview {
      return PersonEntry(date: Date(), person: Snapshot.sample.people.first, signedIn: true)
    }
    let snapshot = Store.load()
    let wanted = configuration.person?.id
    let person = snapshot?.people.first { $0.id == wanted } ?? (wanted == nil ? snapshot?.people.first : nil)
    return PersonEntry(date: Date(), person: person, signedIn: snapshot != nil)
  }

  func placeholder(in context: Context) -> PersonEntry {
    PersonEntry(date: Date(), person: Snapshot.sample.people.first, signedIn: true)
  }

  func snapshot(for configuration: PersonIntent, in context: Context) async -> PersonEntry {
    entry(for: configuration, preview: context.isPreview)
  }

  func timeline(for configuration: PersonIntent, in context: Context) async -> Timeline<PersonEntry> {
    Timeline(entries: [entry(for: configuration, preview: false)], policy: .after(Date().addingTimeInterval(15 * 60)))
  }
}

struct PersonWidgetView: View {
  let entry: PersonEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    if let p = entry.person {
      switch family {
      case .accessoryCircular:
        ZStack {
          AccessoryWidgetBackground()
          VStack(spacing: 0) {
            Text(p.initials)
              .font(.system(size: 12, weight: .bold))
            Text(metres(p.distanceM))
              .font(.system(size: 11, weight: .semibold))
          }
        }
        .widgetURL(personLink(p))
      case .accessoryRectangular:
        HStack(spacing: 8) {
          ZStack {
            Circle().fill(.white.opacity(0.25)).frame(width: 28, height: 28)
            Text(p.initials).font(.system(size: 11, weight: .bold))
          }
          VStack(alignment: .leading, spacing: 1) {
            Text(p.name).font(.system(size: 13, weight: .bold)).lineLimit(1)
            Text("\(meta(p)) · \(metres(p.distanceM))").font(.system(size: 11)).lineLimit(1)
          }
          Spacer(minLength: 0)
        }
        .widgetURL(personLink(p))
      case .accessoryInline:
        Text("\(p.name) · \(metres(p.distanceM))")
          .widgetURL(personLink(p))
      default:
        VStack(alignment: .leading, spacing: 2) {
          AvatarView(person: p, size: 44)
          Text(p.name)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .padding(.top, 6)
          Text(meta(p) + (p.online || p.lastPing == nil ? "" : " · \(ago(p.lastPing, now: entry.date))"))
            .font(.system(size: 12))
            .foregroundStyle(Style.muted)
            .lineLimit(1)
          Spacer(minLength: 0)
          Text(metres(p.distanceM))
            .font(.system(size: 24, weight: .bold))
            .foregroundStyle(.white)
          if p.online, let userId = p.userId {
            Link(destination: link("find=\(userId)")) {
              ButtonLook(text: "Find", background: Style.red)
            }
            .padding(.top, 6)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(personLink(p))
      }
    } else {
      NoticeView(text: entry.signedIn ? "Pick a person: hold the widget, then Edit" : "Open NeoPin to sign in")
    }
  }
}

struct PersonWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "NeoPinPerson", intent: PersonIntent.self, provider: PersonProvider()) { entry in
      PersonWidgetFamilyView(entry: entry)
    }
    .configurationDisplayName("Person")
    .description("One person, how far away, and a button to find them.")
    .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

// The background depends on the family, which is only known inside a view.
struct PersonWidgetFamilyView: View {
  let entry: PersonEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    PersonWidgetView(entry: entry).modifier(WidgetBackground(family: family))
  }
}
