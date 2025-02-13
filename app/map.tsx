import React, { useState, useEffect, useRef } from "react";
import {
  View,
  ActivityIndicator,
  StyleSheet,
  Text,
  Animated,
} from "react-native";
import { WebView } from "react-native-webview";
import useThemeManager from "@/hooks/useThemeManager";
import * as Location from "expo-location";
import { useWebSocketContext } from "@/context/WebSocket";

export default function MapComponent() {
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [minLoadingTimeFinished, setMinLoadingTimeFinished] = useState(false);
  const colors = useThemeManager();
  const webviewRef = useRef<WebView>(null);
  const loaded = useRef(false);
  const { emit, addMessageListener, isConnected } = useWebSocketContext();

  useEffect(() => {
    const timer = setTimeout(() => setMinLoadingTimeFinished(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const removeListener = addMessageListener(
      (data: {
        type: string;
        devices?: any;
        latitude?: number;
        longitude?: number;
      }) => {
        if (data.type === "dataResponse" && data.devices) {
          webviewRef.current?.postMessage(
            JSON.stringify({
              type: "dataResponse",
              devices: data.devices,
            })
          );
        }
      }
    );
    return () => {
      removeListener();
    };
  }, [addMessageListener]);

  useEffect(() => {
    if (!webViewLoaded) return;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;

      const currentLocation = await Location.getCurrentPositionAsync({});
      webviewRef.current?.postMessage(
        JSON.stringify({
          type: "updateLocation",
          latitude: currentLocation.coords.latitude,
          longitude: currentLocation.coords.longitude,
        })
      );

      Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 5000,
          distanceInterval: 5,
        },
        (newLocation) => {
          webviewRef.current?.postMessage(
            JSON.stringify({
              type: "updateLocation",
              latitude: newLocation.coords.latitude,
              longitude: newLocation.coords.longitude,
            })
          );
        }
      );
    })();
  }, [webViewLoaded]);

  useEffect(() => {
    if (webViewLoaded && isConnected && !loaded.current) {
      setTimeout(() => {
        emit({ type: "pingDevices" });
      }, 1000);
      loaded.current = true;
    }
  }, [webViewLoaded, isConnected, emit]);

  const showLoader = !webViewLoaded || !minLoadingTimeFinished;

  const fadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: showLoader ? 1 : 0,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [showLoader, fadeAnim]);

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.loaderContainer,
          { backgroundColor: colors.colors.surface, opacity: fadeAnim },
        ]}
      >
        <ActivityIndicator size="large" color={colors.colors.primary} />
        <Text style={[styles.text, { color: colors.colors.primary }]}>
          Loading Map...
        </Text>
      </Animated.View>

      <WebView
        ref={webviewRef}
        source={{ html: mapHTML }}
        style={[styles.webview, showLoader && { opacity: 0 }]}
        onLoad={() => setWebViewLoaded(true)}
        geolocationEnabled={true}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === "error") {
              console.error("WebView Error:", data.message || data.error);
            }
          } catch (e) {
            console.error("Error parsing WebView message:", e);
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loaderContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
    position: "absolute",
    width: "100%",
    height: "100%",
    zIndex: 10,
  },
  webview: { flex: 1 },
  text: { marginTop: 10, fontSize: 16, fontWeight: "bold" },
});

const mapHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; }
    html, body, #map { height: 100%; width: 100%;}
    .leaflet-container {
      background: #FFFFFF !important;
    }
    .leaflet-control-attribution, .leaflet-control-zoom { display: none !important; }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map', {
      center: [51.505, -0.09],
      zoom: 10,
      minZoom: 2,
      maxZoom: 19,
      attributionControl: false,
      zoomControl: false,
    });
    
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      noWrap: true,
      detectRetina: true,
      maxZoom: 19
    }).addTo(map);
    
    window.userMarker = null;
    window.updateMarkerFromNative = function(lat, lng) {
      var latlng = [lat, lng];
      if (!window.userMarker) {
        window.userMarker = L.marker(latlng, {
          icon: new L.Icon.Default(),
          title: 'Your Location',
          zIndexOffset: 1000
        }).addTo(map);
        map.setView(latlng, 12);
      } else {
        window.userMarker.setLatLng(latlng);
      }
    };

    window.deviceMarkers = {};
    
    window.updateDeviceMarkers = function(devices) {
      const updatedDeviceIds = new Set(devices.map(device => device.deviceId));
      
      devices.forEach(function(device) {
        if (!device.position) return;
        
        var lat = device.position.latitude;
        var lng = device.position.longitude;
        var status = device.status || "online";
        var lastPing = device.lastPing || "N/A";
        
        var popupContent = "<b>Device:</b> " + device.deviceId + "<br>" +
                           "<b>Status:</b> " + status + "<br>" +
                           "<b>Last Ping:</b> " + lastPing;
        
        if (window.deviceMarkers[device.deviceId]) {
          window.deviceMarkers[device.deviceId].setLatLng([lat, lng]);
          window.deviceMarkers[device.deviceId].bindPopup(popupContent);
        } else {
          var marker = L.marker([lat, lng]).addTo(map);
          marker.bindPopup(popupContent);
          window.deviceMarkers[device.deviceId] = marker;
        }
      });
      
      Object.keys(window.deviceMarkers).forEach(function(deviceId) {
        if (!updatedDeviceIds.has(deviceId)) {
          map.removeLayer(window.deviceMarkers[deviceId]);
          delete window.deviceMarkers[deviceId];
        }
      });
    };

    window.addEventListener('message', function(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'updateLocation') {
          window.updateMarkerFromNative(data.latitude, data.longitude);
        } else if (data.type === 'dataResponse' && data.devices) {
          window.updateDeviceMarkers(data.devices);
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    });

    setTimeout(function(){
      var dummyDevices = [
        { 
          deviceId: "Dummy1", 
          position: { latitude: 51.51, longitude: -0.1 }, 
          lastPing: "2 minutes ago", 
          status: "online" 
        },
        { 
          deviceId: "Dummy2", 
          position: { latitude: 51.50, longitude: -0.08 }, 
          lastPing: "5 minutes ago", 
          status: "offline" 
        }
      ];
      window.updateDeviceMarkers(dummyDevices);
    }, 6000);

        let clickCount = 0;
        const maxClicks = 2;
        const clickResetTime = 1000;

        map.on("click", function (e) {
          clickCount++;

          if (clickCount >= maxClicks) {
            map.setView(e.latlng, map.getZoom() + 1, { animate: true });
            clickCount = 0; 
          }

          setTimeout(() => {
            clickCount = 0;
          }, clickResetTime);
        });


  </script>
</body>
</html>
`;
