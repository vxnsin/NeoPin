// The home screen widgets, built into the Xcode project by @bacons/apple-targets at prebuild.
// The app group is the store the app writes its snapshot into, see lib/widgets.ts.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  name: "NeoPinWidgets",
  displayName: "NeoPin",
  bundleIdentifier: "de.vensin.neopin.widgets",
  deploymentTarget: "17.0",
  colors: {
    $accent: "#d3171e",
  },
  entitlements: {
    "com.apple.security.application-groups": ["group.de.vensin.neopin"],
  },
};
