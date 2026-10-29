import "dotenv/config";
import fs from "fs";

// Firebase config for push on Android: the path of an EAS file secret, or a file next to this one.
// Without it the app still builds, it just cannot receive push.
const googleServicesFile = [process.env.GOOGLE_SERVICES_JSON, "./google-services.json"].find(
  (path) => path && fs.existsSync(path)
);

export default {
  expo: {
    name: "NeoPin",
    slug: "neopin",
    version: "1.8.1",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "neopin",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      bundleIdentifier: "de.vensin.neopin",
      // Signs the app and the widget extension in targets/widgets. Xcode shows the team id under
      // Signing & Capabilities; EAS Build brings its own.
      appleTeamId: process.env.APPLE_TEAM_ID,
      supportsTablet: true,
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true,
        },
        // The search on the lock screen, see modules/neopin-live.
        NSSupportsLiveActivities: true,
        NSBluetoothAlwaysUsageDescription: "NeoPin uses Bluetooth to tell how close a person you are finding is.",
        NSLocationWhenInUseUsageDescription:
          "This app needs your location to display the map correctly.",
        NSLocationAlwaysUsageDescription:
          "NeoPin shares your location with your own server while the app is in the background.",
        NSLocationAlwaysAndWhenInUseUsageDescription:
          "NeoPin shares your location with your own server while the app is in the background.",
        UIBackgroundModes: ["location"],
      },
    },
    android: {
      package: "de.vensin.neopin",
      versionCode: 10,
      adaptiveIcon: {
        foregroundImage: "./assets/images/adaptive-icon.png",
        backgroundColor: "#d3171e",
      },
      permissions: [
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "FOREGROUND_SERVICE",
        "FOREGROUND_SERVICE_LOCATION",
        "POST_NOTIFICATIONS",
        "WAKE_LOCK",
        "BLUETOOTH_SCAN",
        "BLUETOOTH_ADVERTISE",
        "BLUETOOTH_CONNECT",
      ],
      softwareKeyboardLayoutMode: "pan",
      ...(googleServicesFile && { googleServicesFile }),
    },
    web: {
      bundler: "metro",
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      "@bacons/apple-targets",
      "expo-font",
      "expo-status-bar",
      [
        "expo-notifications",
        {
          icon: "./assets/images/notification-icon.png",
          color: "#d3171e",
          defaultChannel: "default",
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission: "NeoPin uses the photo you pick as your profile picture on your own server.",
          cameraPermission: false,
          microphonePermission: false,
        },
      ],
      [
        "expo-location",
        {
          isIosBackgroundLocationEnabled: true,
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true,
        },
      ],
      [
        "expo-splash-screen",
        {
          // The round logo reads on both backgrounds. The dark one is the app's dark surface, so the
          // splash follows the phone's setting and hands over to the loader without a jump.
          image: "./assets/images/logo.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: { backgroundColor: "#090a0d" },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {
        origin: false,
      },
      eas: {
        projectId: "1808f5ce-26ec-43c7-90fd-cfe81987c07b",
      },
    },
    owner: "vensin",
    runtimeVersion: "1.1.0",
    updates: {
      url: "https://u.expo.dev/1808f5ce-26ec-43c7-90fd-cfe81987c07b",
    },
  },
};
