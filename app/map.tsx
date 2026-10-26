import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
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
import useThemeManager from "@/hooks/useThemeManager";
import { useAvatars } from "@/hooks/useAvatars";
import { useWebSocketContext } from "@/context/WebSocket";
import Avatar from "@/components/Avatar";
import PulseLogo from "@/components/PulseLogo";
import { logout as signOut } from "@/lib/logout";
import { timeAgo } from "@/lib/time";
import { pickAvatar, removeAvatar, uploadAvatar } from "@/lib/avatar";
import { STATE_COLORS, freshness, type Device } from "@/lib/devices";
import { buildMapHtml } from "@/lib/mapHtml";
import { readCredentials, type StoredCredentials } from "@/lib/socket";
import {
  REPORTING_PRESETS,
  getReportingPreset,
  setReportingPreset,
  type ReportingPreset,
} from "@/lib/settings";

const STATE_ORDER = { online: 0, stale: 1, offline: 2 };

type Sheet = "devices" | "settings" | null;

export default function MapScreen() {
  const theme = useThemeManager();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { emit, addMessageListener, isConnected } = useWebSocketContext();

  const webviewRef = useRef<WebView>(null);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [minLoadingTimeFinished, setMinLoadingTimeFinished] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [creds, setCreds] = useState<StoredCredentials | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [preset, setPreset] = useState<ReportingPreset>(getReportingPreset());
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [, setTick] = useState(0);
  const requestedOnce = useRef(false);
  const avatarFor = useAvatars(devices, creds);
  // Built once, later theme changes go in as messages so the map does not reload.
  const mapHtml = useMemo(() => buildMapHtml(theme.isDark, insets.bottom), []); // eslint-disable-line react-hooks/exhaustive-deps

  const post = useCallback((payload: object) => {
    webviewRef.current?.postMessage(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    readCredentials().then(setCreds);
    const timer = setTimeout(() => setMinLoadingTimeFinished(true), 1200);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const ticker = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(ticker);
  }, []);

  useEffect(
    () =>
      addMessageListener((data) => {
        if (data.type === "dataResponse" && Array.isArray(data.devices)) setDevices(data.devices);
      }),
    [addMessageListener]
  );

  // The map gets each device with its picture as a data URI, it cannot send the login headers itself.
  const mapDevices = devices.map((device) => ({ ...device, avatar: avatarFor(device.avatarUrl) }));
  const mapDevicesKey = JSON.stringify(mapDevices);
  useEffect(() => {
    if (webViewLoaded) post({ type: "devices", devices: JSON.parse(mapDevicesKey) });
  }, [webViewLoaded, mapDevicesKey, post]);

  useEffect(() => {
    if (webViewLoaded) post({ type: "theme", dark: theme.isDark });
  }, [webViewLoaded, theme.isDark, post]);

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
  }, [webViewLoaded, isConnected, emit]);

  const showLoader = !webViewLoaded || !minLoadingTimeFinished;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: showLoader ? 1 : 0, duration: 500, useNativeDriver: true }).start();
  }, [showLoader, fadeAnim]);

  const refresh = () => emit({ type: "pingDevices" });

  const focusDevice = (device: Device) => {
    if (!device.position) return;
    post({ type: "focus", deviceId: device.deviceId });
    setSheet(null);
  };

  const changePreset = async (next: ReportingPreset) => {
    setPreset(next);
    await setReportingPreset(next);
  };

  const changePhoto = async () => {
    if (!creds || photoBusy) return;
    setPhotoError("");
    setPhotoBusy(true);
    try {
      const jpeg = await pickAvatar();
      // The server sends the new avatarUrl to everyone, this screen included.
      if (jpeg) await uploadAvatar(creds, jpeg);
    } catch (error: any) {
      setPhotoError(error?.message || "The photo could not be saved.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const deletePhoto = async () => {
    if (!creds || photoBusy) return;
    setPhotoError("");
    setPhotoBusy(true);
    try {
      await removeAvatar(creds);
    } catch (error: any) {
      setPhotoError(error?.message || "The photo could not be removed.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const logout = async () => {
    setSheet(null);
    await signOut();
    router.replace("/login");
  };

  const me = devices.find((d) => d.deviceId === creds?.deviceId);
  const sorted = [...devices].sort(
    (a, b) =>
      Number(b.deviceId === creds?.deviceId) - Number(a.deviceId === creds?.deviceId) ||
      STATE_ORDER[freshness(a)] - STATE_ORDER[freshness(b)] ||
      a.deviceId.localeCompare(b.deviceId, undefined, { sensitivity: "base" })
  );
  const online = devices.filter((d) => d.status === "online").length;
  const summary = !isConnected
    ? "Reconnecting…"
    : devices.length === 0
      ? "Connected · no devices yet"
      : `${online} of ${devices.length} connected`;

  const deviceRow = (device: Device) => {
    const state = freshness(device);
    const isMe = device.deviceId === creds?.deviceId;
    return (
      <Pressable
        key={device.deviceId}
        style={({ pressed }) => [styles.deviceRow, pressed && { backgroundColor: c.subtle }]}
        onPress={() => focusDevice(device)}
        accessibilityLabel={`${device.deviceId}, ${state}`}
      >
        <Avatar name={device.deviceId} uri={avatarFor(device.avatarUrl)} state={state} gapColor={c.raised} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.deviceName, { color: c.primary }]} numberOfLines={1}>
            {device.deviceId}
            {isMe ? <Text style={{ color: c.muted, fontWeight: "500" }}>  · You</Text> : null}
          </Text>
          <View style={styles.metaRow}>
            <View style={[styles.metaDot, { backgroundColor: STATE_COLORS[state] }]} />
            <Text style={[styles.deviceMeta, { color: c.muted }]}>
              {state === "offline" ? "Offline · " : ""}
              {device.lastPing ? timeAgo(device.lastPing) : "no position yet"}
            </Text>
          </View>
        </View>
        {device.position && <MaterialIcons name="near-me" size={20} color={c.muted} />}
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: c.surface }]}>
      <Animated.View style={[styles.loader, { backgroundColor: c.surface, opacity: fadeAnim }]} pointerEvents={showLoader ? "auto" : "none"}>
        <PulseLogo size={72} />
      </Animated.View>

      <WebView
        ref={webviewRef}
        source={{ html: mapHtml }}
        style={[styles.webview, { backgroundColor: c.surface }, showLoader && { opacity: 0 }]}
        onLoad={() => setWebViewLoaded(true)}
        originWhitelist={["*"]}
        geolocationEnabled
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === "error") console.warn("Map:", data.message);
          } catch {
            // ignore
          }
        }}
      />

      {/* The device bar, like the one at the bottom of Apple's Find My. */}
      <Pressable
        style={[styles.bar, { bottom: insets.bottom + 12, backgroundColor: c.raised }]}
        onPress={() => setSheet("devices")}
        accessibilityLabel={`Devices, ${summary}`}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.barTitle, { color: c.primary }]}>Devices</Text>
          <View style={styles.metaRow}>
            <View style={[styles.metaDot, { backgroundColor: isConnected ? STATE_COLORS.online : STATE_COLORS.stale }]} />
            <Text style={[styles.deviceMeta, { color: c.muted }]}>{summary}</Text>
          </View>
        </View>
        <View style={styles.stack}>
          {sorted.slice(0, 4).map((device, index) => (
            <View key={device.deviceId} style={{ marginLeft: index === 0 ? 0 : -10 }}>
              <Avatar name={device.deviceId} uri={avatarFor(device.avatarUrl)} state={freshness(device)} size={26} gapColor={c.raised} />
            </View>
          ))}
        </View>
        <Pressable
          style={[styles.gear, { backgroundColor: c.subtle }]}
          onPress={() => setSheet("settings")}
          hitSlop={6}
          accessibilityLabel="Settings"
        >
          <MaterialIcons name="settings" size={20} color={c.primary} />
        </Pressable>
      </Pressable>

      <Modal visible={sheet !== null} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSheet(null)} />
        <View style={[styles.sheet, { backgroundColor: c.raised, paddingBottom: insets.bottom + 16 }]}>
          <View style={[styles.grabber, { backgroundColor: c.muted }]} />

          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: c.primary }]}>{sheet === "settings" ? "Settings" : "Devices"}</Text>
            <View style={styles.headerActions}>
              {sheet === "devices" && (
                <Pressable
                  style={[styles.headerButton, { backgroundColor: c.subtle }]}
                  onPress={refresh}
                  accessibilityLabel="Ask every device for a fresh position"
                >
                  <MaterialIcons name="refresh" size={20} color={c.primary} />
                </Pressable>
              )}
              <Pressable
                style={[styles.headerButton, { backgroundColor: c.subtle }]}
                onPress={() => setSheet(sheet === "settings" ? "devices" : "settings")}
                accessibilityLabel={sheet === "settings" ? "Back to devices" : "Settings"}
              >
                <MaterialIcons name={sheet === "settings" ? "people-outline" : "settings"} size={20} color={c.primary} />
              </Pressable>
            </View>
          </View>

          {sheet === "devices" && (
            <>
              <Text style={[styles.sheetMeta, { color: c.muted }]}>{summary}</Text>
              <ScrollView style={styles.deviceList}>
                {sorted.length === 0 && (
                  <Text style={[styles.empty, { color: c.muted }]}>No devices yet.</Text>
                )}
                {sorted.map(deviceRow)}
              </ScrollView>
            </>
          )}

          {sheet === "settings" && creds && (
            <>
              <View style={[styles.profile, { backgroundColor: c.subtle }]}>
                <Pressable onPress={changePhoto} accessibilityLabel="Change your profile photo" disabled={photoBusy}>
                  <Avatar
                    name={creds.deviceId}
                    uri={avatarFor(me?.avatarUrl)}
                    state={me ? freshness(me) : "offline"}
                    size={52}
                    gapColor={c.subtle}
                  />
                  <View style={[styles.cameraBadge, { backgroundColor: c.secondary, borderColor: c.subtle }]}>
                    {photoBusy ? (
                      <ActivityIndicator size="small" color={c.onSecondary} />
                    ) : (
                      <MaterialIcons name="photo-camera" size={13} color={c.onSecondary} />
                    )}
                  </View>
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.deviceName, { color: c.primary }]} numberOfLines={1}>
                    {creds.deviceId}
                  </Text>
                  <View style={styles.profileActions}>
                    <Pressable onPress={changePhoto} disabled={photoBusy} hitSlop={8}>
                      <Text style={[styles.link, { color: c.secondary }]}>{me?.avatarUrl ? "Change photo" : "Add a photo"}</Text>
                    </Pressable>
                    {me?.avatarUrl ? (
                      <Pressable onPress={deletePhoto} disabled={photoBusy} hitSlop={8}>
                        <Text style={[styles.link, { color: c.muted }]}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {photoError ? <Text style={[styles.error, { color: c.secondary }]}>{photoError}</Text> : null}
                </View>
              </View>

              <Text style={[styles.sectionTitle, { color: c.muted }]}>Position updates</Text>
              <View style={styles.presetRow}>
                {(Object.keys(REPORTING_PRESETS) as ReportingPreset[]).map((key) => {
                  const active = key === preset;
                  return (
                    <Pressable
                      key={key}
                      onPress={() => changePreset(key)}
                      style={[styles.presetChip, { backgroundColor: active ? c.secondary : c.subtle }]}
                    >
                      <Text style={[styles.presetLabel, { color: active ? c.onSecondary : c.primary }]}>
                        {REPORTING_PRESETS[key].label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.presetHint, { color: c.muted }]}>{REPORTING_PRESETS[preset].description}</Text>

              <Pressable style={[styles.logout, { backgroundColor: c.subtle }]} onPress={logout}>
                <MaterialIcons name="logout" size={20} color={c.secondary} />
                <Text style={[styles.logoutText, { color: c.secondary }]}>Disconnect and log out</Text>
              </Pressable>
            </>
          )}
        </View>
      </Modal>
    </View>
  );
}

const shadow = {
  elevation: 6,
  shadowColor: "#000",
  shadowOpacity: 0.22,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 6 },
};

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
  webview: { flex: 1 },
  bar: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 68,
    paddingLeft: 18,
    paddingRight: 10,
    paddingVertical: 10,
    borderRadius: 22,
    ...shadow,
  },
  barTitle: { fontSize: 17, fontWeight: "700" },
  stack: { flexDirection: "row", alignItems: "center" },
  gear: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  metaDot: { width: 7, height: 7, borderRadius: 4 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 10,
    maxHeight: "85%",
  },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, opacity: 0.35, marginBottom: 12 },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sheetTitle: { fontSize: 24, fontWeight: "800", letterSpacing: -0.3 },
  sheetMeta: { fontSize: 13, marginTop: 2, marginBottom: 8 },
  headerActions: { flexDirection: "row", gap: 8 },
  headerButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  deviceList: { maxHeight: 420 },
  empty: { paddingVertical: 14 },
  deviceRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9, borderRadius: 14, paddingHorizontal: 6 },
  deviceName: { fontSize: 15.5, fontWeight: "600" },
  deviceMeta: { fontSize: 12.5 },
  profile: { flexDirection: "row", alignItems: "center", gap: 14, padding: 14, borderRadius: 18, marginTop: 14 },
  cameraBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  profileActions: { flexDirection: "row", gap: 16, marginTop: 4 },
  link: { fontSize: 13.5, fontWeight: "600" },
  error: { fontSize: 12, marginTop: 4 },
  sectionTitle: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8 },
  presetRow: { flexDirection: "row", gap: 8 },
  presetChip: { flex: 1, borderRadius: 12, paddingVertical: 11, alignItems: "center" },
  presetLabel: { fontSize: 13, fontWeight: "600" },
  presetHint: { fontSize: 12, marginTop: 8 },
  logout: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 22,
    height: 50,
    borderRadius: 14,
  },
  logoutText: { fontSize: 15, fontWeight: "600" },
});
