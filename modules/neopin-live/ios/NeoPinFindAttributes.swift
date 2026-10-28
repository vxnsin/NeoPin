import ActivityKit
import Foundation

// The same struct as targets/widgets/_shared/FindActivity.swift: ActivityKit matches the type by
// its name, and this module cannot see the app target's copy. Keep both in step.
struct NeoPinFindAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var title: String
    var text: String
    var short: String
    var arrowDeg: Double?
  }
}
