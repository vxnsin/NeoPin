import Foundation
import SwiftUI

// The snapshot the app wrote, see lib/widgets.ts for the fields.
struct WPerson: Codable, Identifiable, Hashable {
  let id: String
  let userId: Int?
  let name: String
  let initials: String
  let online: Bool
  let distanceM: Int?
  let lastPing: Double?
  let battery: Int?
  let groupIds: [Int]
}

struct WMe: Codable, Hashable {
  let name: String
  let hiddenUntil: Double?
  let battery: Int?
  let sharing: Bool
}

struct WGroup: Codable, Hashable {
  let id: Int
  let name: String
}

struct Snapshot: Codable, Hashable {
  let updatedAt: Double
  let me: WMe?
  let people: [WPerson]
  let groups: [WGroup]

  // What the widget gallery shows before anybody signed in.
  static let sample = Snapshot(
    updatedAt: Date().timeIntervalSince1970 * 1000,
    me: WMe(name: "You", hiddenUntil: nil, battery: 71, sharing: true),
    people: [
      WPerson(id: "user:2", userId: 2, name: "Anna", initials: "A", online: true, distanceM: 2100, lastPing: Date().timeIntervalSince1970 * 1000 - 600_000, battery: 40, groupIds: [1]),
      WPerson(id: "user:3", userId: 3, name: "Kaspar", initials: "K", online: true, distanceM: 850, lastPing: Date().timeIntervalSince1970 * 1000, battery: 88, groupIds: [1]),
      WPerson(id: "user:4", userId: 4, name: "Mia", initials: "M", online: false, distanceM: 6300, lastPing: Date().timeIntervalSince1970 * 1000 - 7_200_000, battery: nil, groupIds: [1]),
    ],
    groups: [WGroup(id: 1, name: "Everyone")]
  )
}

enum Store {
  static let suite = "group.de.vensin.neopin"
  static let key = "snapshot"

  static func load() -> Snapshot? {
    guard let raw = UserDefaults(suiteName: suite)?.string(forKey: key), let data = raw.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(Snapshot.self, from: data)
  }
}

enum Style {
  static let red = Color(red: 0xD3 / 255.0, green: 0x17 / 255.0, blue: 0x1E / 255.0)
  static let raised = Color(red: 0x16 / 255.0, green: 0x1A / 255.0, blue: 0x22 / 255.0)
  static let subtle = Color(red: 0x1E / 255.0, green: 0x23 / 255.0, blue: 0x2D / 255.0)
  static let muted = Color(red: 0x98 / 255.0, green: 0xA2 / 255.0, blue: 0xB3 / 255.0)
  static let green = Color(red: 0x22 / 255.0, green: 0xC5 / 255.0, blue: 0x5E / 255.0)
  static let grey = Color(red: 0x4B / 255.0, green: 0x55 / 255.0, blue: 0x63 / 255.0)

  // Avatar colours, one per person by their id.
  static let palette: [Color] = [
    red,
    Color(red: 0x1D / 255.0, green: 0x4E / 255.0, blue: 0xD8 / 255.0),
    Color(red: 0x6D / 255.0, green: 0x28 / 255.0, blue: 0xD9 / 255.0),
    Color(red: 0x0F / 255.0, green: 0x76 / 255.0, blue: 0x6E / 255.0),
    Color(red: 0xB4 / 255.0, green: 0x53 / 255.0, blue: 0x09 / 255.0),
    Color(red: 0xBE / 255.0, green: 0x18 / 255.0, blue: 0x5D / 255.0),
    Color(red: 0x4D / 255.0, green: 0x7C / 255.0, blue: 0x0F / 255.0),
    Color(red: 0x0E / 255.0, green: 0x74 / 255.0, blue: 0x90 / 255.0),
  ]

  static func avatar(_ id: String) -> Color {
    var h: UInt32 = 5381
    for byte in id.utf8 {
      h = h &* 33 &+ UInt32(byte)
    }
    return palette[Int(h % UInt32(palette.count))]
  }
}

func metres(_ m: Int?) -> String {
  guard let m = m else { return "–" }
  if m < 1000 { return "\(m) m" }
  if m < 10_000 { return String(format: "%.1f km", Double(m) / 1000.0) }
  return "\(m / 1000) km"
}

func ago(_ ms: Double?, now: Date = Date()) -> String {
  guard let ms = ms else { return "" }
  let s = Int(now.timeIntervalSince1970 - ms / 1000)
  if s < 60 { return "now" }
  if s < 3600 { return "\(s / 60) min" }
  if s < 86_400 { return "\(s / 3600) h" }
  return "\(s / 86_400) d"
}

func meta(_ p: WPerson) -> String {
  if !p.online { return "Offline" }
  if let battery = p.battery { return "Online · \(battery) %" }
  return "Online"
}

// Opens the app at the map with a query that says what to do, see lib/widgets.ts.
func link(_ query: String) -> URL {
  URL(string: "neopin://map?\(query)") ?? URL(string: "neopin://map")!
}

func personLink(_ p: WPerson) -> URL {
  link("person=\(p.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? p.id)")
}
