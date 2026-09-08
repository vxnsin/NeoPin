import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { MaterialIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import useThemeManager from "@/hooks/useThemeManager";
import { useWebSocketContext } from "@/context/WebSocket";
import { STORAGE_KEY } from "@/lib/socket";
import { timeAgo } from "@/lib/time";
import {
  REPORTING_PRESETS,
  getReportingPreset,
  setReportingPreset,
  type ReportingPreset,
} from "@/lib/settings";
import { stopBackgroundLocation } from "@/tasks/LocationTask";
import { stopWebSocketService } from "@/services/WebSocketService";

type Device = {
  deviceId: string;
  position: { latitude: number; longitude: number } | null;
  lastPing: string | null;
  status: "online" | "offline";
};

const STALE_AFTER_MS = 10 * 60 * 1000;

function freshness(device: Device): "online" | "stale" | "offline" | "unknown" {
  if (device.status !== "online") return "offline";
  if (!device.lastPing) return "unknown";
  return Date.now() - new Date(device.lastPing).getTime() > STALE_AFTER_MS ? "stale" : "online";
}

const STATE_COLORS = {
  online: "#2ecc71",
  stale: "#f1c40f",
  offline: "#9aa0a6",
  unknown: "#3498db",
};

export default function MapScreen() {
  const theme = useThemeManager();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { emit, close, addMessageListener, isConnected } = useWebSocketContext();

  const webviewRef = useRef<WebView>(null);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [minLoadingTimeFinished, setMinLoadingTimeFinished] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [preset, setPreset] = useState<ReportingPreset>(getReportingPreset());
  const [, setTick] = useState(0);
  const requestedOnce = useRef(false);

  const post = useCallback((payload: object) => {
    webviewRef.current?.postMessage(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setMinLoadingTimeFinished(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const ticker = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(
    () =>
      addMessageListener((data) => {
        if (data.type === "dataResponse" && Array.isArray(data.devices)) {
          setDevices(data.devices);
          post({ type: "devices", devices: data.devices });
        }
      }),
    [addMessageListener, post]
  );

  useEffect(() => {
    if (!webViewLoaded) return;
    let subscription: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") return;
      const current = await Location.getCurrentPositionAsync({});
      post({ type: "self", latitude: current.coords.latitude, longitude: current.coords.longitude, center: true });
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
        (location) =>
          post({ type: "self", latitude: location.coords.latitude, longitude: location.coords.longitude })
      );
    })();
    return () => subscription?.remove();
  }, [webViewLoaded, post]);

  useEffect(() => {
    if (webViewLoaded && isConnected && !requestedOnce.current) {
      requestedOnce.current = true;
      emit({ type: "pingDevices" });
    }
    if (webViewLoaded && isConnected) post({ type: "devices", devices });
  }, [webViewLoaded, isConnected, emit, post, devices]);

  const showLoader = !webViewLoaded || !minLoadingTimeFinished;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: showLoader ? 1 : 0, duration: 500, useNativeDriver: true }).start();
  }, [showLoader, fadeAnim]);

  const refresh = () => emit({ type: "pingDevices" });

  const focusDevice = (device: Device) => {
    if (!device.position) return;
    post({ type: "focus", latitude: device.position.latitude, longitude: device.position.longitude });
    setMenuOpen(false);
  };

  const changePreset = async (next: ReportingPreset) => {
    setPreset(next);
    await setReportingPreset(next);
  };

  const logout = async () => {
    setMenuOpen(false);
    close();
    await Promise.all([stopWebSocketService(), stopBackgroundLocation().catch(() => {})]);
    await AsyncStorage.removeItem(STORAGE_KEY);
    router.replace("/login");
  };

  const statusColor = isConnected ? STATE_COLORS.online : STATE_COLORS.stale;
  const statusText = isConnected ? "Live" : "Reconnecting…";
  const c = theme.colors;

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.loader, { backgroundColor: c.surface, opacity: fadeAnim }]} pointerEvents={showLoader ? "auto" : "none"}>
        <ActivityIndicator size="large" color={c.primary} />
        <Text style={[styles.loaderText, { color: c.primary }]}>Loading Map...</Text>
      </Animated.View>

      <WebView
        ref={webviewRef}
        source={{ html: mapHTML }}
        style={[styles.webview, showLoader && { opacity: 0 }]}
        onLoad={() => setWebViewLoaded(true)}
        geolocationEnabled
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === "error") console.error("WebView Error:", data.message);
          } catch {
            // ignore
          }
        }}
      />

      <View style={[styles.statusPill, { top: insets.top + 12, backgroundColor: c.surface }]}>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        <Text style={[styles.statusText, { color: c.primary }]}>{statusText}</Text>
        <Text style={[styles.statusMeta, { color: c.primary }]}>
          {devices.filter((d) => d.status === "online").length}/{devices.length} online
        </Text>
      </View>

      <Pressable
        style={[styles.menuButton, { top: insets.top + 8, backgroundColor: c.secondary }]}
        onPress={() => setMenuOpen(true)}
        accessibilityLabel="Menu"
      >
        <MaterialIcons name="menu" size={28} color={c.onSecondary} />
      </Pressable>

      <Modal visible={menuOpen} transparent animationType="slide" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)} />
        <View style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: c.primary }]}>Devices</Text>
            <Pressable onPress={refresh} hitSlop={10}>
              <MaterialIcons name="refresh" size={24} color={c.primary} />
            </Pressable>
          </View>

          <ScrollView style={styles.deviceList}>
            {devices.length === 0 && (
              <Text style={[styles.empty, { color: c.primary }]}>No devices connected yet.</Text>
            )}
            {devices.map((device) => {
              const state = freshness(device);
              return (
                <Pressable
                  key={device.deviceId}
                  style={({ pressed }) => [styles.deviceRow, pressed && { backgroundColor: c.onSurface }]}
                  onPress={() => focusDevice(device)}
                >
                  <View style={[styles.dot, { backgroundColor: STATE_COLORS[state] }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.deviceName, { color: c.primary }]}>{device.deviceId}</Text>
                    <Text style={[styles.deviceMeta, { color: c.primary }]}>
                      {device.status} · {timeAgo(device.lastPing)}
                    </Text>
                  </View>
                  {device.position && <MaterialIcons name="my-location" size={20} color={c.primary} />}
                </Pressable>
              );
            })}
          </ScrollView>

          <Text style={[styles.sectionTitle, { color: c.primary }]}>Position updates</Text>
          <View style={styles.presetRow}>
            {(Object.keys(REPORTING_PRESETS) as ReportingPreset[]).map((key) => {
              const active = key === preset;
              return (
                <Pressable
                  key={key}
                  onPress={() => changePreset(key)}
                  style={[
                    styles.presetChip,
                    { borderColor: active ? c.secondary : c.onSurface, backgroundColor: active ? c.secondary : "transparent" },
                  ]}
                >
                  <Text style={[styles.presetLabel, { color: active ? c.onSecondary : c.primary }]}>
                    {REPORTING_PRESETS[key].label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.presetHint, { color: c.primary }]}>{REPORTING_PRESETS[preset].description}</Text>

          <Pressable style={[styles.logout, { borderColor: c.onSurface }]} onPress={logout}>
            <MaterialIcons name="logout" size={20} color={c.secondary} />
            <Text style={[styles.logoutText, { color: c.secondary }]}>Disconnect and log out</Text>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loader: {
    position: "absolute",
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  loaderText: { marginTop: 10, fontSize: 16, fontWeight: "bold" },
  webview: { flex: 1 },
  statusPill: {
    position: "absolute",
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 13, fontWeight: "600" },
  statusMeta: { fontSize: 12, opacity: 0.6 },
  menuButton: {
    position: "absolute",
    right: 12,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 16,
    maxHeight: "80%",
  },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  sheetTitle: { fontSize: 20, fontWeight: "700" },
  deviceList: { maxHeight: 260 },
  empty: { opacity: 0.6, paddingVertical: 12 },
  deviceRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderRadius: 12, paddingHorizontal: 8 },
  deviceName: { fontSize: 16, fontWeight: "600" },
  deviceMeta: { fontSize: 12, opacity: 0.6, textTransform: "capitalize" },
  sectionTitle: { fontSize: 14, fontWeight: "600", marginTop: 16, marginBottom: 8, opacity: 0.8 },
  presetRow: { flexDirection: "row", gap: 8 },
  presetChip: { flex: 1, borderWidth: 1, borderRadius: 999, paddingVertical: 10, alignItems: "center" },
  presetLabel: { fontSize: 13, fontWeight: "600" },
  presetHint: { fontSize: 12, opacity: 0.6, marginTop: 8 },
  logout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  logoutText: { fontSize: 15, fontWeight: "600" },
});

const mapHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; }
    html, body, #map { height: 100%; width: 100%; background: #000; }
    .leaflet-control-zoom { display: none !important; }
    .leaflet-control-attribution { font-size: 9px; background: rgba(255,255,255,0.75); }
    .pin { background: transparent; border: none; }
    .pin span { display: block; width: 18px; height: 18px; margin: 2px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 1px 6px rgba(0,0,0,0.5); }
    .pin.online span { background: ${STATE_COLORS.online}; }
    .pin.stale span { background: ${STATE_COLORS.stale}; }
    .pin.offline span { background: ${STATE_COLORS.offline}; }
    .pin.unknown span { background: ${STATE_COLORS.unknown}; }
    .pin.self span { background: #ffffff; border-color: #d3171e; }
    .leaflet-popup-content { font: 13px system-ui, sans-serif; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map', { center: [51.505, -0.09], zoom: 10, minZoom: 2, maxZoom: 19, zoomControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      noWrap: true, detectRetina: true, maxZoom: 19
    }).addTo(map);

    var STALE_MS = ${STALE_AFTER_MS};
    var selfMarker = null;
    var markers = {};

    function icon(state) {
      return L.divIcon({ className: 'pin ' + state, html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12] });
    }
    function ago(ts) {
      if (!ts) return 'never';
      var s = Math.max(0, Math.floor((Date.now() - new Date(ts)) / 1000));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + ' min ago';
      if (s < 86400) return Math.floor(s / 3600) + ' h ago';
      return Math.floor(s / 86400) + ' d ago';
    }
    function state(d) {
      if (d.status !== 'online') return 'offline';
      if (!d.lastPing) return 'unknown';
      return Date.now() - new Date(d.lastPing) > STALE_MS ? 'stale' : 'online';
    }

    function updateSelf(lat, lng, center) {
      if (!selfMarker) {
        selfMarker = L.marker([lat, lng], { icon: icon('self'), zIndexOffset: 1000 }).addTo(map).bindPopup('<b>You</b>');
        map.setView([lat, lng], 13);
      } else {
        selfMarker.setLatLng([lat, lng]);
        if (center) map.setView([lat, lng], Math.max(map.getZoom(), 13));
      }
    }

    function updateDevices(devices) {
      var seen = {};
      devices.forEach(function (d) {
        if (!d.position) return;
        seen[d.deviceId] = true;
        var latlng = [d.position.latitude, d.position.longitude];
        var st = state(d);
        var popup = '<b>' + d.deviceId + '</b><br>' + d.status + ' &middot; ' + ago(d.lastPing);
        if (markers[d.deviceId]) {
          markers[d.deviceId].setLatLng(latlng).setIcon(icon(st)).bindPopup(popup);
        } else {
          markers[d.deviceId] = L.marker(latlng, { icon: icon(st), title: d.deviceId }).addTo(map).bindPopup(popup);
        }
      });
      Object.keys(markers).forEach(function (id) {
        if (!seen[id]) { map.removeLayer(markers[id]); delete markers[id]; }
      });
    }

    function handle(raw) {
      try {
        var data = JSON.parse(raw);
        if (data.type === 'self') updateSelf(data.latitude, data.longitude, data.center);
        else if (data.type === 'devices') updateDevices(data.devices || []);
        else if (data.type === 'focus') map.flyTo([data.latitude, data.longitude], Math.max(map.getZoom(), 15));
      } catch (e) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', message: String(e) }));
      }
    }
    window.addEventListener('message', function (e) { handle(e.data); });
    document.addEventListener('message', function (e) { handle(e.data); });

    var clicks = 0;
    map.on('click', function (e) {
      clicks++;
      if (clicks >= 2) { map.setView(e.latlng, map.getZoom() + 1, { animate: true }); clicks = 0; }
      setTimeout(function () { clicks = 0; }, 1000);
    });
  </script>
</body>
</html>
`;
