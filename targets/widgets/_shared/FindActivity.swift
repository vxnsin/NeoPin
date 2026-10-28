import ActivityKit
import AppIntents
import Foundation

// Files in _shared are built into the app and into the widget extension.

// What a find shows on the lock screen and in the Dynamic Island. ActivityKit matches the type by
// its name: modules/neopin-live/ios/NeoPinFindAttributes.swift holds the same struct for the
// native module, keep both in step.
struct NeoPinFindAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var title: String
    var text: String
    // The few characters next to the island, "120 m".
    var short: String
    // Where to point, degrees clockwise from straight up. Nil shows no arrow.
    var arrowDeg: Double?
  }
}

// The name the native module listens on, see LiveModule.swift.
let neoPinLiveStopNotification = Notification.Name("de.vensin.neopin.live.stop")

// The Stop button on the Live Activity. A LiveActivityIntent runs in the app, which ends the find
// like the button on the sheet; the activity goes away with it.
@available(iOS 17.0, *)
struct StopFindIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Stop finding"

  func perform() async throws -> some IntentResult {
    NotificationCenter.default.post(name: neoPinLiveStopNotification, object: nil)
    // Should the app not be listening, the activity still goes.
    for activity in Activity<NeoPinFindAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    return .result()
  }
}
