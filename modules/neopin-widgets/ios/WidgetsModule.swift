import ExpoModulesCore
import WidgetKit

// The app hands over its snapshot, the widget extension reads it from the shared app group
// and gets redrawn.
public class WidgetsModule: Module {
  private let suite = "group.de.vensin.neopin"
  private let key = "snapshot"

  public func definition() -> ModuleDefinition {
    Name("NeoPinWidgets")

    AsyncFunction("update") { (json: String) in
      let defaults = UserDefaults(suiteName: self.suite)
      if json.isEmpty {
        defaults?.removeObject(forKey: self.key)
      } else {
        defaults?.set(json, forKey: self.key)
      }
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
