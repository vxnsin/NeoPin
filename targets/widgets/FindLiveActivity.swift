import ActivityKit
import SwiftUI
import WidgetKit

private let accent = Color(red: 211 / 255, green: 23 / 255, blue: 30 / 255)

// The search on the lock screen and in the Dynamic Island: the arrow towards the person, the
// metres and the hint the find sheet shows. The app updates it, see modules/neopin-live.
struct FindLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: NeoPinFindAttributes.self) { context in
      LockScreenView(state: context.state)
        .activitySystemActionForegroundColor(accent)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          ArrowBadge(deg: context.state.arrowDeg, size: 44)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.short)
            .font(.title2.weight(.semibold))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.state.title)
            .font(.headline)
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack {
            Text(context.state.text)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .lineLimit(2)
            Spacer(minLength: 8)
            StopButton()
          }
        }
      } compactLeading: {
        Arrow(deg: context.state.arrowDeg)
          .foregroundStyle(accent)
      } compactTrailing: {
        Text(context.state.short)
          .monospacedDigit()
          .lineLimit(1)
      } minimal: {
        Arrow(deg: context.state.arrowDeg)
          .foregroundStyle(accent)
      }
      .keylineTint(accent)
    }
  }
}

private struct LockScreenView: View {
  let state: NeoPinFindAttributes.ContentState

  var body: some View {
    HStack(spacing: 14) {
      ArrowBadge(deg: state.arrowDeg, size: 48)
      VStack(alignment: .leading, spacing: 2) {
        Text(state.title)
          .font(.headline)
          .lineLimit(1)
        Text(state.text)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
      Spacer(minLength: 8)
      StopButton()
    }
    .padding(16)
  }
}

// Points along the bearing when the compass knows where the phone faces, else a pin.
private struct Arrow: View {
  let deg: Double?

  var body: some View {
    if let deg {
      Image(systemName: "location.north.fill")
        .rotationEffect(.degrees(deg))
    } else {
      Image(systemName: "mappin.and.ellipse")
    }
  }
}

private struct ArrowBadge: View {
  let deg: Double?
  let size: CGFloat

  var body: some View {
    ZStack {
      Circle().fill(accent)
      Arrow(deg: deg)
        .font(.system(size: size * 0.45, weight: .bold))
        .foregroundStyle(.white)
    }
    .frame(width: size, height: size)
  }
}

// Ends the find from the lock screen. Buttons in a Live Activity need iOS 17; before that a tap
// opens the app, where the sheet has its own Stop.
private struct StopButton: View {
  var body: some View {
    if #available(iOS 17.0, *) {
      Button(intent: StopFindIntent()) {
        Text("Stop")
          .font(.subheadline.weight(.semibold))
      }
      .buttonStyle(.bordered)
      .tint(accent)
    }
  }
}
