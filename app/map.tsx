import React, { useState } from "react";
import { View, ActivityIndicator, StyleSheet, Text } from "react-native";
import { WebView } from "react-native-webview";
import useThemeManager from "@/hooks/useThemeManager";

export default function MapComponent() {
  const [loading, setLoading] = useState(true);
  const colors = useThemeManager();

  const handleLoad = () => {
    setLoading(false);
  };

  return (
    <View style={styles.container}>
      {loading && (
      <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
        <ActivityIndicator size="large" color={colors.colors.primary} />
        <Text style={[styles.text, { color: colors.colors.primary }]}>Loading Map...</Text>
      </View>
      )}
      <WebView
        source={{ html: mapHTML }}
        style={styles.webview}
        onLoad={handleLoad}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1,
  },
  webview: {
    flex: 1,
  },
  text: {
    marginTop: 10,
    fontSize: 16,
    fontWeight: "bold",
  },
});

const mapHTML = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      * { margin: 0; padding: 0; }
      html, body, #map { height: 100%; width: 100%; }
            .leaflet-control-attribution { display: none !important; }
    </style>
    <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
    <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
  </head>
  <body>
    <div id="map"></div>
    <script>
      // Initialisiere die Karte mit gewünschten Optionen
      var map = L.map('map', {
        center: [51.1657, 10.4515],
        zoom: 6,
        minZoom: 3,  
        maxZoom: 18,
        maxBounds: [
          [40, -10],
          [60, 30]
        ],
        attributionControl: false,
        zoomControl: false
      });
      
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        noWrap: true
      }).addTo(map);
    </script>
  </body>
  </html>
`;
