import 'dotenv/config';

export default {
  expo: {
    name: "neopin",
    slug: "neopin",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "myapp",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      infoPlist: {
        NSAppTransportSecurity: {
          NSAllowsArbitraryLoads: true
        },
        NSLocationWhenInUseUsageDescription: "This app needs your location to display the map correctly.",
        NSLocationAlwaysUsageDescription: "This app needs your location to display the map correctly."
      }
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/images/adaptive-icon.png",
        backgroundColor: "#ffffff"
      },
      permissions: [
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION"
      ]
    },
    web: {
      bundler: "metro",
      output: "static",
      favicon: "./assets/images/favicon.png"
    },
    plugins: [
      "expo-router",
      [
        "expo-splash-screen",
        {
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff"
        }
      ]
    ],
    experiments: {
      typedRoutes: true
    },
    extra: {
      CESIUM_ION_TOKEN: process.env.CESIUM_ION_TOKEN, 
      router: {
        origin: false
      },
      eas: {
        projectId: "1808f5ce-26ec-43c7-90fd-cfe81987c07b"
      }
    },
    owner: "vensin",
    runtimeVersion: {
      policy: "appVersion"
    },
    updates: {
      url: "https://u.expo.dev/1808f5ce-26ec-43c7-90fd-cfe81987c07b"
    }
  }
};
