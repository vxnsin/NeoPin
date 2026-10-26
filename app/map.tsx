import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { WebView as NativeWebView, type WebViewMessageEvent } from "react-native-webview";
import { MaterialIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import useThemeManager from "@/hooks/useThemeManager";
import { useAvatars } from "@/hooks/useAvatars";
import { useWebSocketContext } from "@/context/WebSocket";
import Avatar from "@/components/Avatar";
import PulseLogo from "@/components/PulseLogo";
import TimelinePanel from "@/components/TimelinePanel";
import PasswordForm from "@/components/PasswordForm";
import ProfileForm from "@/components/ProfileForm";
import { logout as signOut } from "@/lib/logout";
import { timeAgo } from "@/lib/time";
import { pickAvatar, removeAvatar, uploadAvatar } from "@/lib/avatar";
import {
  DEVICE_ICONS,
  STATE_COLORS,
  deviceKey,
  freshness,
  groupPeople,
  isOwnDevice,
  statusText,
  typeOf,
  type Device,
  type Person,
} from "@/lib/devices";
import { buildMapHtml } from "@/lib/mapHtml";
import { readCredentials, socket, type StoredCredentials } from "@/lib/socket";
import { saveCredentials, updateStoredUser } from "@/lib/credentials";
import { fetchMe, type User } from "@/lib/api";
import {
  REPORTING_PRESETS,
  getReportingPreset,
  setReportingPreset,
  type ReportingPreset,
} from "@/lib/settings";

type MapWebViewHandle = { postMessage: (message: string) => void };
type MapWebViewProps = {
  ref?: React.Ref<MapWebViewHandle>;
  source: { html: string };
  style: StyleProp<ViewStyle>;
  onLoad: () => void;
  originWhitelist: string[];
  geolocationEnabled: boolean;
  onMessage: (event: WebViewMessageEvent) => void;
};

// The package's own props type collapses to never with this TypeScript version.
const WebView = NativeWebView as unknown as React.ComponentType<MapWebViewProps>;

type Sheet = "devices" | "settings" | null;

export default function MapScreen() {
  const theme = useThemeManager();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { emit, addMessageListener, isConnected } = useWebSocketContext();

  const webviewRef = useRef<MapWebViewHandle>(null);
  const [webViewLoaded, setWebViewLoaded] = useState(false);
  const [minLoadingTimeFinished, setMinLoadingTimeFinished] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [creds, setCreds] = useState<StoredCredentials | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [mapTap, setMapTap] = useState<{ index: number; n: number } | null>(null);
  const [preset, setPreset] = useState<ReportingPreset>(getReportingPreset());
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [, setTick] = useState(0);
  const requestedOnce = useRef(false);
  const user = creds?.user ?? null;
  // The account picture is the one every device of it shows. It loads even before the own device is listed.
  const avatarSources = useMemo<Device[]>(
    () =>
      user?.avatarUrl
        ? [...devices, { deviceId: "", position: null, lastPing: null, status: "offline", avatarUrl: user.avatarUrl }]
        : devices,
    [devices, user?.avatarUrl]
  );
  const avatarFor = useAvatars(avatarSources, creds);
  // Built once, later theme changes go in as messages so the map does not reload.
  const mapHtml = useMemo(() => buildMapHtml(theme.isDark, insets.bottom), []); // eslint-disable-line react-hooks/exhaustive-deps

  const post = useCallback((payload: object) => {
    webviewRef.current?.postMessage(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    readCredentials().then((stored) => {
      setCreds(stored);
      // The picture or name may have changed on the dashboard.
      if (stored) {
        fetchMe(stored)
          .then((fresh) => {
            setCreds((current) => (current ? { ...current, user: fresh } : current));
            updateStoredUser(fresh).catch(() => {});
          })
          .catch(() => {});
      }
    });
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

  // The backdrop fades and the sheet slides on its own, so the dimming does not ride up with the sheet.
  const sheetProgress = useRef(new Animated.Value(0)).current;
  const sheetDrag = useRef(new Animated.Value(0)).current;
  const closeSheet = useRef(() => {
    Animated.parallel([
      Animated.timing(sheetProgress, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.timing(sheetDrag, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => setSheet(null));
  }).current;
  const closeSheetFromDrag = useRef(() => {
    Animated.parallel([
      Animated.timing(sheetProgress, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(sheetDrag, { toValue: 700, duration: 180, useNativeDriver: true }),
    ]).start(() => {
      setSheet(null);
      sheetDrag.setValue(0);
    });
  }).current;
  const sheetOpen = sheet !== null;
  useEffect(() => {
    if (!sheetOpen) return;
    sheetDrag.setValue(0);
    sheetProgress.setValue(0);
    Animated.timing(sheetProgress, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [sheetOpen, sheetProgress, sheetDrag]);

  // Dragging the top of the sheet down closes it.
  const sheetPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 4,
      onPanResponderMove: (_, g) => sheetDrag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > 80 || g.vy > 0.8) {
          closeSheetFromDrag();
        } else {
          Animated.spring(sheetDrag, { toValue: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => Animated.spring(sheetDrag, { toValue: 0, useNativeDriver: true }).start(),
    })
  ).current;

  // The map gets each device with its picture as a data URI, it cannot send the login headers itself.
  // This phone is the "you are here" dot already, so its own device gets no second pin.
  const mapDevices = devices
    .filter((device) => !isOwnDevice(device, user?.id, creds?.deviceId))
    .map((device) => ({ ...device, key: deviceKey(device), avatar: avatarFor(device.avatarUrl) }));
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

  const focusDevice = (device: Device, close = true) => {
    if (!device.position) return;
    post({ type: "focus", key: deviceKey(device) });
    if (close) closeSheet();
  };

  const changePreset = async (next: ReportingPreset) => {
    setPreset(next);
    await setReportingPreset(next);
  };

  const changeUser = (patch: Partial<User>) => {
    if (!creds) return;
    const next = { ...creds.user, ...patch };
    setCreds({ ...creds, user: next });
    updateStoredUser(next).catch(() => {});
  };

  // The old token is revoked. Switch the socket and the stored login to the fresh one.
  const passwordChanged = async (token: string) => {
    if (!creds) return;
    const renewed = { ...creds, token };
    setCreds(renewed);
    await saveCredentials(renewed).catch(() => {});
    socket.connect(renewed.serverIp, renewed.deviceId, token).catch(() => {});
    fetchMe(renewed)
      .then((fresh) => {
        setCreds((current) => (current ? { ...current, user: fresh } : current));
        updateStoredUser(fresh).catch(() => {});
      })
      .catch(() => {});
  };

  const changePhoto = async () => {
    if (!creds || photoBusy) return;
    setPhotoError("");
    setPhotoBusy(true);
    try {
      const jpeg = await pickAvatar();
      // The server sends the new avatarUrl to everyone, this screen included.
      if (jpeg) {
        const avatarUrl = await uploadAvatar(creds, jpeg);
        changeUser({ avatarUrl });
      }
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
      changeUser({ avatarUrl: null });
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

  const isMine = (d: Device) => isOwnDevice(d, user?.id, creds?.deviceId);
  const me = devices.find(isMine);
  const profileAvatar = user?.avatarUrl ?? null;
  const panelHeight = Math.round(windowHeight * 0.55);
  const people = groupPeople(devices, user?.id);
  const online = devices.filter((d) => d.status === "online").length;
  const summary = !isConnected
    ? "Reconnecting…"
    : devices.length === 0
      ? "Connected · nobody yet"
      : `${people.length} ${people.length === 1 ? "person" : "people"} · ${online} of ${devices.length} ${devices.length === 1 ? "device" : "devices"} online`;

  // One row per person. Tapping focuses their primary device and opens the list of their devices.
  const togglePerson = (person: Person) => {
    if (expanded === person.key) {
      setExpanded(null);
      return;
    }
    setExpanded(person.key);
    focusDevice(person.primary, false);
  };

  const linkedDevice = (device: Device) => {
    const state = freshness(device);
    return (
      <Pressable
        key={deviceKey(device)}
        style={({ pressed }) => [styles.linkedRow, pressed && { backgroundColor: c.subtle }]}
        onPress={() => focusDevice(device)}
        accessibilityLabel={`${device.deviceId}, ${statusText(device, timeAgo)}`}
      >
        <MaterialIcons name={DEVICE_ICONS[typeOf(device)]} size={20} color={c.muted} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.linkedName, { color: c.primary }]} numberOfLines={1}>
            {device.deviceId}
            {isMine(device) ? <Text style={{ color: c.muted, fontWeight: "500" }}>  · You</Text> : null}
          </Text>
          <View style={styles.metaRow}>
            <View style={[styles.metaDot, { backgroundColor: STATE_COLORS[state] }]} />
            <Text style={[styles.deviceMeta, { color: c.muted }]}>{statusText(device, timeAgo)}</Text>
          </View>
        </View>
        {device.position && <MaterialIcons name="near-me" size={18} color={c.muted} />}
      </Pressable>
    );
  };

  const personRow = (person: Person) => {
    const { primary } = person;
    const open = expanded === person.key;
    return (
      <View key={person.key}>
        <Pressable
          style={({ pressed }) => [styles.deviceRow, pressed && { backgroundColor: c.subtle }]}
          onPress={() => togglePerson(person)}
          accessibilityLabel={`${person.name}, ${primary.deviceId}, ${statusText(primary, timeAgo)}`}
          accessibilityState={{ expanded: open }}
        >
          <Avatar name={person.name} uri={avatarFor(primary.avatarUrl)} state={freshness(primary)} gapColor={c.raised} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.deviceName, { color: c.primary }]} numberOfLines={1}>
              {person.name}
              {person.isMe ? <Text style={{ color: c.muted, fontWeight: "500" }}>  · You</Text> : null}
            </Text>
            <View style={styles.metaRow}>
              <View style={[styles.metaDot, { backgroundColor: STATE_COLORS[freshness(primary)] }]} />
              <Text style={[styles.deviceMeta, { color: c.muted }]} numberOfLines={1}>
                {primary.deviceId} · {statusText(primary, timeAgo)}
                {person.extra > 0 ? ` · +${person.extra} ${person.extra === 1 ? "device" : "devices"}` : ""}
              </Text>
            </View>
          </View>
          <MaterialIcons name={open ? "expand-less" : "expand-more"} size={22} color={c.muted} />
        </Pressable>
        {open && <View style={styles.linked}>{person.devices.map(linkedDevice)}</View>}
      </View>
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
            else if (data.type === "segment" && typeof data.index === "number") setMapTap({ index: data.index, n: Date.now() });
          } catch {
            // ignore
          }
        }}
      />

      {/* The device bar, like the one at the bottom of Apple's Find My. */}
      {!timelineOpen && (
      <Pressable
        style={[styles.bar, { bottom: insets.bottom + 12, backgroundColor: c.raised }]}
        onPress={() => setSheet("devices")}
        accessibilityLabel={`People, ${summary}`}
      >
        <View style={{ flex: 1 }}>
          <Text style={[styles.barTitle, { color: c.primary }]}>People</Text>
          <View style={styles.metaRow}>
            <View style={[styles.metaDot, { backgroundColor: isConnected ? STATE_COLORS.online : STATE_COLORS.stale }]} />
            <Text style={[styles.deviceMeta, { color: c.muted }]}>{summary}</Text>
          </View>
        </View>
        <View style={styles.stack}>
          {people.slice(0, 4).map((person, index) => (
            <View key={person.key} style={{ marginLeft: index === 0 ? 0 : -10 }}>
              <Avatar name={person.name} uri={avatarFor(person.primary.avatarUrl)} state={freshness(person.primary)} size={26} gapColor={c.raised} />
            </View>
          ))}
        </View>
        <Pressable
          style={[styles.gear, { backgroundColor: c.subtle }]}
          onPress={() => setTimelineOpen(true)}
          hitSlop={6}
          accessibilityLabel="Timeline"
        >
          <MaterialIcons name="timeline" size={20} color={c.primary} />
        </Pressable>
        <Pressable
          style={[styles.gear, { backgroundColor: c.subtle }]}
          onPress={() => setSheet("settings")}
          hitSlop={6}
          accessibilityLabel="Settings"
        >
          <MaterialIcons name="settings" size={20} color={c.primary} />
        </Pressable>
      </Pressable>
      )}

      {timelineOpen && creds && (
        <TimelinePanel
          creds={creds}
          devices={devices}
          avatarFor={avatarFor}
          post={post}
          height={panelHeight}
          mapTap={mapTap}
          onClose={() => setTimelineOpen(false)}
        />
      )}

      <Modal visible={sheet !== null} transparent animationType="none" onRequestClose={closeSheet}>
        <KeyboardAvoidingView style={styles.sheetHost} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Animated.View style={[styles.backdrop, { opacity: sheetProgress }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          style={[styles.sheet, { backgroundColor: c.raised, paddingBottom: insets.bottom + 16, transform: [{ translateY: Animated.add(sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [windowHeight, 0] }), sheetDrag) }] }]}
        >
          <View {...sheetPan.panHandlers} style={styles.grabArea}>
            <View style={[styles.grabber, { backgroundColor: c.muted }]} />
          </View>

          <View style={styles.sheetHeader} {...sheetPan.panHandlers}>
            <Text style={[styles.sheetTitle, { color: c.primary }]}>{sheet === "settings" ? "Settings" : "People"}</Text>
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
                accessibilityLabel={sheet === "settings" ? "Back to people" : "Settings"}
              >
                <MaterialIcons name={sheet === "settings" ? "people-outline" : "settings"} size={20} color={c.primary} />
              </Pressable>
            </View>
          </View>

          {sheet === "devices" && (
            <>
              <Text style={[styles.sheetMeta, { color: c.muted }]}>{summary}</Text>
              <ScrollView style={styles.deviceList}>
                {people.length === 0 && (
                  <Text style={[styles.empty, { color: c.muted }]}>Nobody here yet.</Text>
                )}
                {people.map(personRow)}
              </ScrollView>
            </>
          )}

          {sheet === "settings" && creds && (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {creds.user.mustChangePassword ? (
                <View style={[styles.notice, { backgroundColor: c.subtle }]}>
                  <MaterialIcons name="info-outline" size={18} color={c.secondary} />
                  <Text style={[styles.noticeText, { color: c.primary }]}>
                    This account still uses its generated password. Please change it below.
                  </Text>
                </View>
              ) : null}
              <View style={[styles.profile, { backgroundColor: c.subtle }]}>
                <Pressable onPress={changePhoto} accessibilityLabel="Change your profile photo" disabled={photoBusy}>
                  <Avatar
                    name={creds.user.displayName}
                    uri={avatarFor(profileAvatar)}
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
                    {creds.user.displayName}
                  </Text>
                  <Text style={[styles.deviceMeta, { color: c.muted }]} numberOfLines={1}>
                    @{creds.user.username} · {creds.deviceId}
                  </Text>
                  <View style={styles.profileActions}>
                    <Pressable onPress={changePhoto} disabled={photoBusy} hitSlop={8}>
                      <Text style={[styles.link, { color: c.secondary }]}>{profileAvatar ? "Change photo" : "Add a photo"}</Text>
                    </Pressable>
                    {profileAvatar ? (
                      <Pressable onPress={deletePhoto} disabled={photoBusy} hitSlop={8}>
                        <Text style={[styles.link, { color: c.muted }]}>Remove</Text>
                      </Pressable>
                    ) : null}
                    <Pressable onPress={() => setEditingProfile((open) => !open)} hitSlop={8}>
                      <Text style={[styles.link, { color: c.muted }]}>Edit profile</Text>
                    </Pressable>
                  </View>
                  {photoError ? <Text style={[styles.error, { color: c.secondary }]}>{photoError}</Text> : null}
                </View>
              </View>

              {editingProfile ? (
                <ProfileForm auth={creds} user={creds.user} onSaved={(saved) => changeUser(saved)} onClose={() => setEditingProfile(false)} />
              ) : null}

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

              <PasswordForm auth={creds} onChanged={passwordChanged} />

              <Pressable style={[styles.logout, { backgroundColor: c.subtle }]} onPress={logout}>
                <MaterialIcons name="logout" size={20} color={c.secondary} />
                <Text style={[styles.logoutText, { color: c.secondary }]}>Log out</Text>
              </Pressable>
            </ScrollView>
          )}
        </Animated.View>
        </KeyboardAvoidingView>
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
  sheetHost: { flex: 1, justifyContent: "flex-end" },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.4)" },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, marginTop: 14 },
  noticeText: { flex: 1, fontSize: 13.5 },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 10,
    maxHeight: "85%",
  },
  grabArea: { paddingTop: 4, paddingBottom: 16, marginTop: -4 },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, opacity: 0.35 },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sheetTitle: { fontSize: 24, fontWeight: "800", letterSpacing: -0.3 },
  sheetMeta: { fontSize: 13, marginTop: 2, marginBottom: 8 },
  headerActions: { flexDirection: "row", gap: 8 },
  headerButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  deviceList: { maxHeight: 420 },
  empty: { paddingVertical: 14 },
  linked: { marginLeft: 22, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: "rgba(128,128,128,0.25)", marginBottom: 6 },
  linkedRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, paddingHorizontal: 6, borderRadius: 12 },
  linkedName: { fontSize: 14.5, fontWeight: "600" },
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
