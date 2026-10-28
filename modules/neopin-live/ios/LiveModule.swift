import ActivityKit
import ExpoModulesCore

// What lib/live.ts hands over, see LiveContent in ../index.ts.
struct LiveContentRecord: Record {
  @Field var title: String = ""
  @Field var text: String = ""
  @Field var short: String = ""
  @Field var arrowDeg: Double? = nil
}

// The search as a Live Activity on the lock screen and in the Dynamic Island. Same calls as the
// Android notification in LiveModule.kt, so the find screen drives both alike.
public class LiveModule: Module {
  // Posted by StopFindIntent in targets/widgets/_shared/FindActivity.swift.
  private let stopNotification = Notification.Name("de.vensin.neopin.live.stop")
  private var stopObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("NeoPinLive")
    Events("onAction")

    OnCreate {
      self.stopObserver = NotificationCenter.default.addObserver(
        forName: self.stopNotification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onAction", ["action": "stop"])
      }
      // A find does not outlive the app. An activity left over from a run that was killed would
      // otherwise stay on the lock screen for hours.
      Task { await LiveModule.endAll() }
    }

    OnDestroy {
      if let observer = self.stopObserver {
        NotificationCenter.default.removeObserver(observer)
      }
    }

    // Starts the activity, or updates the one that runs. Resolves "shown", "denied" when Live
    // Activities are off for the app (or on a device without them), "failed" otherwise.
    AsyncFunction("show") { (content: LiveContentRecord) async -> String in
      let state = NeoPinFindAttributes.ContentState(
        title: content.title, text: content.text, short: content.short, arrowDeg: content.arrowDeg
      )
      if let activity = Activity<NeoPinFindAttributes>.activities.first {
        await activity.update(ActivityContent(state: state, staleDate: nil))
        return "shown"
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return "denied" }
      do {
        _ = try Activity.request(
          attributes: NeoPinFindAttributes(),
          content: ActivityContent(state: state, staleDate: nil),
          pushType: nil
        )
        return "shown"
      } catch {
        return "failed"
      }
    }

    AsyncFunction("hide") { () async in
      await LiveModule.endAll()
    }
  }

  private static func endAll() async {
    for activity in Activity<NeoPinFindAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }
}
