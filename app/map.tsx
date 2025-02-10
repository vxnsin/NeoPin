import React, { useState, useEffect, useRef } from "react";
import { View, ActivityIndicator, StyleSheet, Text } from "react-native";
import { WebView } from "react-native-webview";
import useThemeManager from "@/hooks/useThemeManager";
import * as Location from "expo-location";

export default function MapComponent() {
  const [loading, setLoading] = useState(true);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const colors = useThemeManager();
  const webviewRef = useRef<any>(null);

  useEffect(() => {
    if (!webViewLoaded) return;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      console.log("Location permission status:", status);
      
      if (status !== "granted") return;

      // Initial location
      const currentLocation = await Location.getCurrentPositionAsync({});
      webviewRef.current?.postMessage(
        JSON.stringify({
          type: "updateLocation",
          latitude: currentLocation.coords.latitude,
          longitude: currentLocation.coords.longitude
        })
      );

      // Watch for updates
      Location.watchPositionAsync(
        { 
          accuracy: Location.Accuracy.High, 
          timeInterval: 1000, 
          distanceInterval: 1 
        },
        (newLocation) => {
          webviewRef.current?.postMessage(
            JSON.stringify({
              type: "updateLocation",
              latitude: newLocation.coords.latitude,
              longitude: newLocation.coords.longitude
            })
          );
        }
      );
    })();
  }, [webViewLoaded]);

  const injectedJavaScript = `
    (function() {
      // Initialize Leaflet icon path
      var leafletScript = document.createElement('script');
      leafletScript.text = \`
        L.Icon.Default.imagePath = 'https://unpkg.com/leaflet/dist/images/';
        
        window.updateMarkerFromNative = function(lat, lng) {
          console.log('Updating marker to:', lat, lng);
          var latlng = [lat, lng];
          
          if (!window.userMarker) {
            window.userMarker = L.marker(latlng, {
              icon: new L.Icon.Default(),
              title: 'Your Location',
              zIndexOffset: 1000
            }).addTo(map);
            map.setView(latlng, 17);
          } else {
            window.userMarker.setLatLng(latlng);
          }
        };
      \`;
      document.head.appendChild(leafletScript);

      // Enhanced message handling
      window.ReactNativeWebView = {
        postMessage: function(data) {
          window.webkit.messageHandlers.ReactNativeWebView.postMessage(data);
        }
      };
      
      window.ReactNativeWebView.onMessage = function(event) {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'updateLocation') {
            if (typeof window.updateMarkerFromNative === 'function') {
              window.updateMarkerFromNative(data.latitude, data.longitude);
            } else {
              console.error('Marker function not available');
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'error',
                message: 'updateMarkerFromNative not defined'
              }));
            }
          }
        } catch (error) {
          console.error('Message handling error:', error);
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'error',
            error: error.message
          }));
        }
      };
    })();
    true;
  `;

  const handleLoad = () => {
    setLoading(false);
    setWebViewLoaded(true);
    console.log("WebView fully initialized");
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
        ref={webviewRef}
        source={{ html: mapHTML }}
        style={styles.webview}
        onLoad={handleLoad}
        injectedJavaScript={injectedJavaScript}
        geolocationEnabled={true}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'error') {
              console.error('WebView Error:', data.message || data.error);
            }
          } catch (e) {
            console.error('Error parsing WebView message:', e);
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
  text: { marginTop: 10, fontSize: 16, fontWeight: "bold" }
});

const mapHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; }
    html, body, #map { height: 100%; width: 100%; }
    .leaflet-control-attribution, .leaflet-control-zoom { display: none !important; }
    .leaflet-marker-icon { filter: hue-rotate(220deg) saturate(150%); }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
</head>
<body>
  <div id="map"></div>
  <script>
    // Map initialization
    var map = L.map('map', {
      center: [51.1657, 10.4515],
      zoom: 6,
      minZoom: 2,
      maxZoom: 19,
      attributionControl: false,
      zoomControl: false
    });

    // Tile layer with retina support
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      noWrap: true,
      detectRetina: true,
      maxZoom: 19,
      updateWhenIdle: true
    }).addTo(map);

    // Static reference marker
    var staticMarker = L.marker([35.737448286487595, 51.39876293182373], {
      title: 'Reference Point',
      zIndexOffset: 500
    }).addTo(map);
    
    staticMarker.bindPopup('<b>Reference Point</b><br />Static location').openPopup();
  </script>
</body>
</html>
`;