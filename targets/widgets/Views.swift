import SwiftUI
import WidgetKit

// Initials in a coloured circle, with the green ring while online.
struct AvatarView: View {
  let person: WPerson
  var size: CGFloat = 30

  var body: some View {
    ZStack {
      Circle()
        .stroke(person.online ? Style.green : Style.grey, lineWidth: 2)
        .frame(width: size, height: size)
      Circle()
        .fill(Style.avatar(person.id))
        .frame(width: size - 6, height: size - 6)
      Text(person.initials)
        .font(.system(size: size * 0.36, weight: .bold))
        .foregroundStyle(.white)
    }
  }
}

struct PersonRow: View {
  let person: WPerson
  let now: Date

  var body: some View {
    HStack(spacing: 10) {
      AvatarView(person: person)
      VStack(alignment: .leading, spacing: 1) {
        Text(person.name)
          .font(.system(size: 14, weight: .bold))
          .foregroundStyle(.white)
          .lineLimit(1)
        Text(meta(person))
          .font(.system(size: 11))
          .foregroundStyle(Style.muted)
          .lineLimit(1)
      }
      Spacer(minLength: 4)
      VStack(alignment: .trailing, spacing: 1) {
        Text(metres(person.distanceM))
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(.white)
        Text(ago(person.lastPing, now: now))
          .font(.system(size: 10))
          .foregroundStyle(Style.muted)
      }
    }
  }
}

struct SectionLabel: View {
  let text: String

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 11, weight: .semibold))
      .tracking(0.5)
      .foregroundStyle(Style.muted)
  }
}

struct ButtonLook: View {
  let text: String
  var background: Color = Style.subtle
  var foreground: Color = .white

  var body: some View {
    Text(text)
      .font(.system(size: 12, weight: .bold))
      .foregroundStyle(foreground)
      .frame(maxWidth: .infinity)
      .frame(height: 30)
      .background(background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

// Shown before anybody signed in, or when a Person widget has nobody to show.
struct NoticeView: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 13))
      .foregroundStyle(Style.muted)
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .widgetURL(link("from=widget"))
  }
}

// The dark card on the home screen, nothing on the lock screen.
struct WidgetBackground: ViewModifier {
  let family: WidgetFamily

  func body(content: Content) -> some View {
    switch family {
    case .accessoryCircular, .accessoryRectangular, .accessoryInline:
      content.containerBackground(for: .widget) { Color.clear }
    default:
      content.containerBackground(Style.raised, for: .widget)
    }
  }
}
