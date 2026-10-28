// The widget extension, built into the Xcode project by @bacons/apple-targets at prebuild.
// For now it carries the Live Activity of a find. Name and bundle id match the widgets branch,
// so its home screen widgets can join this extension.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  name: "NeoPinWidgets",
  displayName: "NeoPin",
  bundleIdentifier: "de.vensin.neopin.widgets",
  // The app's own minimum, so the Live Activity shows wherever the app runs.
  deploymentTarget: "16.4",
  colors: {
    $accent: "#d3171e",
  },
};
