import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { checkAndPrompt, updateLabel } from "@/lib/updates";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import useThemeManager from "@/hooks/useThemeManager";
import { useAvatars } from "@/hooks/useAvatars";
import { useWebSocketContext } from "@/context/WebSocket";
import Avatar from "@/components/Avatar";
import PulseLogo from "@/components/PulseLogo";
import TimelinePanel from "@/components/TimelinePanel";
import PasswordForm from "@/components/PasswordForm";
import HideSection from "@/components/HideSection";
import FindSheet from "@/components/FindSheet";
import { FIND_MESSAGES, reduceFind, type FindFix, type FindState } from "@/lib/find";
import ProfileForm from "@/components/ProfileForm";
import GroupsPanel from "@/components/GroupsPanel";
import AvatarCropper from "@/components/AvatarCropper";
import BatteryBadge from "@/components/BatteryBadge";
import { logout as signOut } from "@/lib/logout";
import { timeAgo } from "@/lib/time";
import { pickPhoto, removeAvatar, renderAvatar, uploadAvatar, type Photo } from "@/lib/avatar";
import type { CropRect } from "@/lib/crop";
import {
  DEVICE_ICONS,
  STATE_COLORS,
  batteryOf,
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
import {
  fetchGroups,
  fetchInvites,
  fetchMe,
  fetchServerStatus,
  setPrimaryDeviceRequest,
  type Group,
  type Invite,
  type User,
} from "@/lib/api";
import {
  badgeText,
  filterByGroup,
  loadGroupFilter,
  pendingCount,
  resolveGroupFilter,
  saveGroupFilter,
  showGroupChips,
} from "@/lib/groups";
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

type Sheet = "devices" | "settings" | "groups" | "find" | null;

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
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  // "Server v1.4.0 · 21a136a", under the app version in the settings.
  const [serverLabel, setServerLabel] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [foundAvatars, setFoundAvatars] = useState<string[]>([]);
  const [groupFilter, setGroupFilter] = useState<number | null>(null);
  const [cropPhoto, setCropPhoto] = useState<Photo | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [mapTap, setMapTap] = useState<{ index: number; n: number } | null>(null);
  const [preset, setPreset] = useState<ReportingPreset>(getReportingPreset());
  // "Find me": the running search, my own fix and where my phone points while it runs.
  const [find, setFind] = useState<FindState | null>(null);
  const [myFix, setMyFix] = useState<FindFix | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  // A search cancelled before the server named its session is ended as soon as it does.
  const abortNextPending = useRef(false);
  const serverFinds = isConnected && socket.features.includes("find");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [, setTick] = useState(0);
  const requestedOnce = useRef(false);
  const user = creds?.user ?? null;
  // The account picture is the one every device of it shows. It loads even before the own device is listed.
  const avatarSources = useMemo<Device[]>(() => {
    const extra: Device[] = [];
    const add = (avatarUrl?: string | null) => {
      if (avatarUrl) extra.push({ deviceId: "", position: null, lastPing: null, status: "offline", avatarUrl });
    };
    add(user?.avatarUrl);
    // Group members show their picture in the groups sheet even without a device.
    groups.forEach((group) => group.members.forEach((member) => add(member.avatarUrl)));
    foundAvatars.forEach(add);
    return [...devices, ...extra];
  }, [devices, user?.avatarUrl, groups, foundAvatars]);
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
    if (sheet !== "settings" || !creds) return;
    fetchServerStatus(creds.serverIp)
      .then((status) => setServerLabel(["Server v" + status.version, status.commit?.slice(0, 7)].filter(Boolean).join(" · ")))
      .catch(() => setServerLabel(null));
  }, [sheet, creds]);

  useEffect(() => {
    const ticker = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(ticker);
  }, []);

  const credsRef = useRef(creds);
  credsRef.current = creds;

  // While a search runs, my position goes to the other side every second, with the compass
  // reading, so their arrow and mine have something to point with.
  const findActive = find?.phase === "active" ? find.session : null;
  useEffect(() => {
    if (!findActive) return;
    let cancelled = false;
    let position: Location.LocationSubscription | null = null;
    let compass: Location.LocationSubscription | null = null;
    let lastHeading: number | null = null;
    (async () => {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted" || cancelled) return;
      compass = await Location.watchHeadingAsync((h) => {
        const value = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
        if (value >= 0) {
          lastHeading = value % 360;
          setHeading(lastHeading);
        }
      }).catch(() => null);
      if (cancelled) {
        compass?.remove();
        return;
      }
      position = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (location) => {
          const raw = location.coords.accuracy;
          const accuracy = raw != null && raw >= 0 ? Math.min(raw, 100_000) : null;
          const fix: FindFix = { latitude: location.coords.latitude, longitude: location.coords.longitude, accuracy, heading: lastHeading, at: Date.now() };
          setMyFix(fix);
          emit({
            type: "findPosition",
            session: findActive,
            latitude: fix.latitude,
            longitude: fix.longitude,
            ...(accuracy !== null && { accuracy }),
            ...(lastHeading !== null && { heading: lastHeading }),
          });
        }
      );
      if (cancelled) position.remove();
    })().catch(() => {});
    return () => {
      cancelled = true;
      position?.remove();
      compass?.remove();
      // The next search starts without a stale fix or compass reading from this one.
      setMyFix(null);
      setHeading(null);
    };
  }, [findActive, emit]);

  // Swiping the sheet away is a no to a question, or a stop.
  useEffect(() => {
    if (sheet !== null || !find || find.phase === "ended") return;
    if (find.phase === "asked") emit({ type: "findAnswer", session: find.session, accept: false });
    else if (find.session) emit({ type: "findEnd", session: find.session });
    else abortNextPending.current = true;
    setFind(null);
    setMyFix(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  const startFind = (person: Person) => {
    if (person.userId === undefined) return;
    abortNextPending.current = false;
    setFind({
      phase: "pending",
      session: "",
      peer: { id: person.userId, username: person.primary.owner?.username ?? person.name, displayName: person.name, avatarUrl: person.primary.avatarUrl ?? null },
      expiresAt: Date.now() + 2 * 60_000,
    });
    emit({ type: "findRequest", userId: person.userId });
    setSheet("find");
  };

  const stopFind = () => {
    if (find && find.phase !== "ended") {
      if (find.session) emit({ type: "findEnd", session: find.session });
      else abortNextPending.current = true;
    }
    setFind(null);
    setMyFix(null);
    closeSheet();
  };

  const answerFind = (accept: boolean) => {
    if (find?.phase !== "asked") return;
    emit({ type: "findAnswer", session: find.session, accept });
    if (!accept) {
      setFind(null);
      closeSheet();
    }
  };

  // Groups and invitations decide who is visible. A group that vanished drops the filter back to All.
  const loadGroups = useCallback(async () => {
    const auth = credsRef.current;
    if (!auth) return;
    try {
      const [nextGroups, nextInvites] = await Promise.all([fetchGroups(auth), fetchInvites(auth)]);
      setGroups(nextGroups);
      setInvites(nextInvites);
      setGroupFilter((current) => {
        const next = resolveGroupFilter(current, nextGroups);
        if (next !== current) saveGroupFilter(next);
        return next;
      });
    } catch {
      // keep what is shown
    }
  }, []);

  useEffect(() => {
    loadGroupFilter().then(setGroupFilter);
  }, []);

  useEffect(() => {
    if (creds?.token) loadGroups();
  }, [creds?.serverIp, creds?.token, loadGroups]);

  useEffect(
    () =>
      addMessageListener((data) => {
        if (data.type === "dataResponse" && Array.isArray(data.devices)) setDevices(data.devices);
        else if (data.type === "groupsChanged") loadGroups();
        else if (FIND_MESSAGES.includes(data.type)) {
          if (data.type === "findPending" && abortNextPending.current) {
            abortNextPending.current = false;
            emit({ type: "findEnd", session: data.session });
            return;
          }
          setFind((current) => reduceFind(current, data));
          if (data.type === "findRequest" || data.type === "findStarted") setSheet("find");
        }
      }),
    [addMessageListener, loadGroups, emit]
  );

  const chooseGroup = (id: number | null) => {
    setGroupFilter(id);
    saveGroupFilter(id);
  };

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
  const visibleDevices = filterByGroup(devices, groupFilter, user?.id);
  const mapDevices = visibleDevices
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

  // Pick a photo, then cut the square in the crop view. The settings sheet closes meanwhile,
  // two modals do not stack reliably on iOS.
  const changePhoto = async () => {
    if (!creds || photoBusy) return;
    setPhotoError("");
    setPhotoBusy(true);
    try {
      const photo = await pickPhoto();
      if (photo) {
        setSheet(null);
        setCropPhoto(photo);
      }
    } catch (error: any) {
      setPhotoError(error?.message || "The photo could not be opened.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const saveCrop = async (rect: CropRect) => {
    const photo = cropPhoto;
    setCropPhoto(null);
    setSheet("settings");
    if (!creds || !photo) return;
    setPhotoBusy(true);
    try {
      const jpeg = await renderAvatar(photo, rect);
      // The server sends the new avatarUrl to everyone, this screen included.
      changeUser({ avatarUrl: await uploadAvatar(creds, jpeg) });
    } catch (error: any) {
      setPhotoError(error?.message || "The photo could not be saved.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const cancelCrop = () => {
    setCropPhoto(null);
    setSheet("settings");
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
  const pending = pendingCount(invites);
  const people = groupPeople(visibleDevices, user?.id);
  const online = visibleDevices.filter((d) => d.status === "online").length;
  const summary = !isConnected
    ? "Reconnecting…"
    : visibleDevices.length === 0
      ? "Connected · nobody yet"
      : `${people.length} ${people.length === 1 ? "person" : "people"} · ${online} of ${visibleDevices.length} ${visibleDevices.length === 1 ? "device" : "devices"} online`;

  // One row per person. Tapping focuses their primary device and opens the list of their devices.
  const togglePerson = (person: Person) => {
    if (expanded === person.key) {
      setExpanded(null);
      return;
    }
    setExpanded(person.key);
    focusDevice(person.primary, false);
  };

  // Your own device stands for you; a second tap on the filled star goes back to automatic.
  const pickPrimary = async (device: Device) => {
    if (!creds) return;
    try {
      // The new list arrives over the socket and redraws the rows.
      await setPrimaryDeviceRequest(creds, device.primary ? null : device.deviceId);
    } catch (error: any) {
      Alert.alert("Main device", error?.message || "The main device could not be changed.");
    }
  };

  const linkedDevice = (device: Device, pickable: boolean) => {
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
            <Text style={[styles.deviceMeta, styles.metaText, { color: c.muted }]} numberOfLines={1}>
              {statusText(device, timeAgo)}
            </Text>
            {batteryOf(device) ? <BatteryBadge battery={batteryOf(device)!} /> : null}
          </View>
        </View>
        {pickable ? (
          <Pressable
            onPress={() => pickPrimary(device)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityState={{ selected: Boolean(device.primary) }}
            accessibilityLabel={device.primary ? `${device.deviceId} is your main device` : `Make ${device.deviceId} your main device`}
          >
            <MaterialIcons
              name={device.primary ? "star" : "star-border"}
              size={20}
              color={device.primary ? STATE_COLORS.stale : c.muted}
            />
          </Pressable>
        ) : null}
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
            {/* The ring around the avatar already shows the status, so no dot here. */}
            <View style={styles.metaRow}>
              <Text style={[styles.deviceMeta, styles.metaText, { color: c.muted }]} numberOfLines={1}>
                {primary.deviceId} · {statusText(primary, timeAgo)}
                {person.extra > 0 ? ` · +${person.extra} ${person.extra === 1 ? "device" : "devices"}` : ""}
              </Text>
              {batteryOf(primary) ? <BatteryBadge battery={batteryOf(primary)!} /> : null}
            </View>
          </View>
          {serverFinds && !person.isMe && person.online && person.userId !== undefined && (
            <Pressable
              onPress={() => startFind(person)}
              hitSlop={8}
              style={[styles.findButton, { backgroundColor: c.subtle }]}
              accessibilityLabel={"Find " + person.name}
            >
              <MaterialIcons name="near-me" size={18} color={c.secondary} />
            </Pressable>
          )}
          <MaterialIcons name={open ? "expand-less" : "expand-more"} size={22} color={c.muted} />
        </Pressable>
        {open && (
          <View style={styles.linked}>
            {person.devices.map((device) => linkedDevice(device, person.isMe && person.devices.length > 1))}
          </View>
        )}
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
          accessibilityLabel={pending > 0 ? `Settings, ${pending} pending invitations` : "Settings"}
        >
          <MaterialIcons name="settings" size={20} color={c.primary} />
          {pending > 0 && <View style={[styles.dot, { backgroundColor: c.secondary, borderColor: c.raised }]} />}
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

      <AvatarCropper photo={cropPhoto} onCancel={cancelCrop} onSave={saveCrop} />

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
            <Text style={[styles.sheetTitle, { color: c.primary }]}>{sheet === "settings" ? "Settings" : sheet === "groups" ? "Groups" : sheet === "find" ? "Find me" : "People"}</Text>
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
              {sheet !== "find" && (
              <Pressable
                style={[styles.headerButton, { backgroundColor: c.subtle }]}
                onPress={() => setSheet(sheet === "devices" ? "settings" : sheet === "settings" ? "devices" : "settings")}
                accessibilityLabel={sheet === "devices" ? "Settings" : sheet === "settings" ? "Back to people" : "Back to settings"}
              >
                <MaterialIcons
                  name={sheet === "devices" ? "settings" : sheet === "settings" ? "people-outline" : "arrow-back"}
                  size={20}
                  color={c.primary}
                />
              </Pressable>
              )}
            </View>
          </View>

          {sheet === "find" && find && (
            <FindSheet
              state={find}
              mine={myFix}
              heading={heading}
              avatarFor={avatarFor}
              onAccept={() => answerFind(true)}
              onDecline={() => answerFind(false)}
              onStop={stopFind}
              onClose={() => {
                setFind(null);
                closeSheet();
              }}
            />
          )}

          {sheet === "devices" && (
            <>
              {showGroupChips(groups) && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
                  {[{ id: null as number | null, name: "All" }, ...groups].map((group) => {
                    const active = group.id === groupFilter;
                    return (
                      <Pressable
                        key={group.id ?? "all"}
                        onPress={() => chooseGroup(group.id)}
                        style={[styles.groupChip, { backgroundColor: active ? c.secondary : c.subtle }]}
                        accessibilityState={{ selected: active }}
                      >
                        <Text style={[styles.groupChipText, { color: active ? c.onSecondary : c.primary }]} numberOfLines={1}>
                          {group.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
              <Text style={[styles.sheetMeta, { color: c.muted }]}>{summary}</Text>
              <ScrollView style={styles.deviceList}>
                {people.length === 0 && (
                  <Text style={[styles.empty, { color: c.muted }]}>Nobody here yet.</Text>
                )}
                {people.map(personRow)}
              </ScrollView>
            </>
          )}

          {sheet === "groups" && creds && (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <GroupsPanel
                auth={creds}
                userId={creds.user.id}
                groups={groups}
                invites={invites}
                avatarFor={avatarFor}
                onChanged={loadGroups}
                onAvatarUrls={setFoundAvatars}
              />
            </ScrollView>
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

              <Pressable
                style={[styles.groupsEntry, { backgroundColor: c.subtle }]}
                onPress={() => setSheet("groups")}
                accessibilityLabel={pending > 0 ? `Groups, ${pending} pending invitations` : "Groups"}
              >
                <MaterialIcons name="group" size={20} color={c.primary} />
                <Text style={[styles.groupsEntryText, { color: c.primary }]}>Groups</Text>
                {pending > 0 && (
                  <View style={[styles.badge, { backgroundColor: c.secondary }]}>
                    <Text style={[styles.badgeText, { color: c.onSecondary }]}>{badgeText(pending)}</Text>
                  </View>
                )}
                <MaterialIcons name="chevron-right" size={22} color={c.muted} />
              </Pressable>

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

              <HideSection
                auth={creds}
                hiddenUntil={creds.user.hiddenUntil}
                onChange={(fresh) => {
                  setCreds((current) => (current ? { ...current, user: fresh } : current));
                  updateStoredUser(fresh).catch(() => {});
                }}
              />

              <PasswordForm auth={creds} onChanged={passwordChanged} />

              <Pressable style={[styles.logout, { backgroundColor: c.subtle }]} onPress={logout}>
                <MaterialIcons name="logout" size={20} color={c.secondary} />
                <Text style={[styles.logoutText, { color: c.secondary }]}>Log out</Text>
              </Pressable>
              <Pressable
                style={[styles.versionRow]}
                onPress={async () => {
                  setUpdateNote("Checking…");
                  const result = await checkAndPrompt(true);
                  setUpdateNote(
                    result === "current" ? "You have the latest version." : result === "failed" ? "Could not check for updates." : result === "unavailable" ? "Updates are off in this build." : "A new version is ready."
                  );
                }}
                accessibilityLabel="Check for updates"
              >
                <Text style={[styles.versionText, { color: c.muted }]}>
                  {updateNote ?? `Check for updates${updateLabel() ? ` · ${updateLabel()}` : ""}`}
                </Text>
                {serverLabel && <Text style={[styles.versionText, { color: c.muted, marginTop: 4 }]}>{serverLabel}</Text>}
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
  dot: { position: "absolute", top: 5, right: 5, width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  chipScroll: { flexGrow: 0, marginTop: 10 },
  chips: { gap: 8, alignItems: "center" },
  groupChip: { height: 34, maxWidth: 180, paddingHorizontal: 14, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  groupChipText: { fontSize: 13.5, fontWeight: "600" },
  groupsEntry: { flexDirection: "row", alignItems: "center", gap: 12, height: 52, paddingHorizontal: 16, borderRadius: 14, marginTop: 14 },
  groupsEntryText: { flex: 1, fontSize: 15, fontWeight: "600" },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 12, fontWeight: "800" },
  sheetTitle: { fontSize: 24, fontWeight: "800", letterSpacing: -0.3 },
  sheetMeta: { fontSize: 13, marginTop: 2, marginBottom: 8 },
  headerActions: { flexDirection: "row", gap: 8 },
  headerButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  deviceList: { maxHeight: 420 },
  empty: { paddingVertical: 14 },
  linked: { marginLeft: 22, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: "rgba(128,128,128,0.25)", marginBottom: 6 },
  linkedRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, paddingHorizontal: 6, borderRadius: 12 },
  linkedName: { fontSize: 14.5, fontWeight: "600" },
  deviceRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 7, borderRadius: 14, paddingHorizontal: 6 },
  deviceName: { fontSize: 15.5, fontWeight: "600" },
  findButton: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  deviceMeta: { fontSize: 12.5 },
  // The text gives way first, so a battery next to it stays on the line.
  metaText: { flexShrink: 1 },
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
  versionRow: { alignItems: "center", paddingVertical: 14 },
  versionText: { fontSize: 12 },
});
