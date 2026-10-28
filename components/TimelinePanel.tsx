import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useThemeManager from "@/hooks/useThemeManager";
import Avatar from "@/components/Avatar";
import PlacePicker from "@/components/PlacePicker";
import {
  fetchTimeline,
  fetchTimelineDays,
  fetchUserDevices,
  fetchUsers,
  setTripMode,
  type AccountSummary,
  type Timeline,
  type Trip,
  type TripModeChoice,
} from "@/lib/api";
import type { StoredCredentials } from "@/lib/credentials";
import { DEVICE_ICONS, freshness, typeOf, type Device } from "@/lib/devices";
import { getReportingPreset, onSettingsChange } from "@/lib/settings";
import { SNAP_SPRING, clampDrag, restAfterDrag, type Snaps } from "@/lib/sheetSnap";
import {
  MODE_CHOICES,
  MODE_ICONS,
  MODE_LABELS,
  PLACE_ICONS,
  dayKey,
  dayLabel,
  formatClock,
  formatCoords,
  formatDistance,
  formatDuration,
  routeChange,
  routeSegments,
  shiftDay,
  stillPending,
  shortDayLabel,
  transitRow,
  tripColor,
  tripIcon,
  tripTitle,
  visitKind,
  visitNumbers,
  visitTitle,
  type RouteSegment,
} from "@/lib/timeline";

// Place names the server is still looking up, and paths it is still smoothing, are asked for
// again, a few times at most.
const PENDING_RETRY_MS = 4000;
const PENDING_RETRIES = 5;

type Props = {
  creds: StoredCredentials;
  devices: Device[];
  avatarFor: (url?: string | null) => string | null;
  // Sends a message to the map page.
  post: (payload: object) => void;
  // The height the panel rests at, and the rests the finger can move it to.
  height: number;
  snaps: Snaps;
  onHeightChange: (height: number) => void;
  // A stop or a line the user tapped on the map.
  mapTap: { index: number; n: number } | null;
  onClose: () => void;
};

export default function TimelinePanel({ creds, devices, avatarFor, post, height, snaps, onHeightChange, mapTap, onClose }: Props) {
  const { colors: c } = useThemeManager();
  const insets = useSafeAreaInsets();

  const admin = creds.user.isAdmin === true;
  const [users, setUsers] = useState<AccountSummary[]>([]);
  // Admins can look at another account, undefined is their own.
  const [accountId, setAccountId] = useState<number | undefined>(undefined);
  const [otherDevices, setOtherDevices] = useState<Device[]>([]);
  const viewingOther = accountId !== undefined && accountId !== creds.user.id;
  const queryUser = viewingOther ? accountId : undefined;

  const choices = useMemo(() => {
    if (viewingOther) return otherDevices;
    // The map shows everyone's devices, the timeline starts with the own ones.
    const own = devices.filter((d) => d.userId === undefined || d.userId === creds.user.id);
    const list = own.length ? own : [{ deviceId: creds.deviceId } as Device];
    return [...list].sort(
      (a, b) =>
        Number(b.deviceId === creds.deviceId) - Number(a.deviceId === creds.deviceId) ||
        a.deviceId.localeCompare(b.deviceId, undefined, { sensitivity: "base" })
    );
  }, [devices, creds.deviceId, viewingOther, otherDevices]);

  const today = dayKey(new Date());
  const [deviceId, setDeviceId] = useState(creds.deviceId);
  const [day, setDay] = useState(today);
  const [days, setDays] = useState<string[]>([]);
  const [daysOpen, setDaysOpen] = useState(false);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [reloads, setReloads] = useState(0);
  // The visit whose place is being picked.
  const [picking, setPicking] = useState<number | null>(null);
  // The trip whose mode is being corrected, and the choice on its way to the server.
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [modeSaving, setModeSaving] = useState<TripModeChoice | null>(null);
  const [modeError, setModeError] = useState("");
  // Lines are only matched with enough fixes on the way, which the battery preset does not send.
  const [preset, setPreset] = useState(getReportingPreset());
  const run = useRef(0);
  const pendingTries = useRef(0);
  // Only the newest place refresh may land, an older one would undo a saved place.
  const refreshRun = useRef(0);
  const [refreshFailures, setRefreshFailures] = useState(0);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const rows = useRef<Record<number, number>>({});
  // The panel's height lives on the UI thread: the finger moves it and a spring settles it at a
  // rest, without a render per frame. React and the map only hear the rest it settles at.
  const shown = useSharedValue(height);
  const dragFrom = useSharedValue(height);
  // The rest the spring is heading for, so the height prop coming back from it does not restart it.
  const target = useRef(height);
  const panelStyle = useAnimatedStyle(() => ({ height: shown.value }));
  const bottomPadding = height + 16;
  const bottomRef = useRef(bottomPadding);
  bottomRef.current = bottomPadding;
  const hasRoute = useRef(false);
  // What the map shows now, to tell whether a refresh only smoothed the lines.
  const shownRoute = useRef<RouteSegment[]>([]);
  const callbacks = useRef({ onClose, onHeightChange });
  callbacks.current = { onClose, onHeightChange };
  const settle = useCallback((rest: number) => {
    target.current = rest;
    callbacks.current.onHeightChange(rest);
  }, []);
  // A new height from outside (the window changed, the panel opened): glide there too.
  useEffect(() => {
    if (height === target.current) return;
    target.current = height;
    shown.value = withSpring(height, SNAP_SPRING);
  }, [height, shown]);
  const { peek, low, mid, high } = snaps;
  const dragGesture = useMemo(() => {
    const rests = { peek, low, mid, high };
    return Gesture.Pan()
      // A tap on the buttons in the header stays a tap.
      .activeOffsetY([-6, 6])
      // Grabbing the panel while it still settles takes it from where it is.
      .onBegin(() => {
        dragFrom.value = shown.value;
      })
      .onUpdate((e) => {
        shown.value = clampDrag(dragFrom.value - e.translationY, rests);
      })
      // Dragging down ends at the header strip, never closed: the map gets the room, the day stays on it.
      // The spring carries on with the finger's speed, the panel height grows upwards.
      .onEnd((e) => {
        const rest = restAfterDrag(dragFrom.value - e.translationY, e.velocityY, rests);
        shown.value = withSpring(rest, { ...SNAP_SPRING, velocity: -e.velocityY });
        scheduleOnRN(settle, rest);
      });
  }, [peek, low, mid, high, shown, dragFrom, settle]);

  useEffect(() => {
    if (hasRoute.current) post({ type: "routeBottom", bottom: bottomPadding });
  }, [bottomPadding, post]);

  useEffect(() => {
    if (!admin) return;
    fetchUsers(creds)
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [creds, admin]);

  useEffect(() => onSettingsChange((s) => setPreset(s.reporting)), []);

  const pickAccount = (user: AccountSummary) => {
    setDaysOpen(false);
    if (user.id === creds.user.id) {
      setAccountId(undefined);
      setOtherDevices([]);
      setDeviceId(creds.deviceId);
      return;
    }
    setAccountId(user.id);
    setOtherDevices([]);
    setTimeline(null);
    fetchUserDevices(creds, user.id)
      .then((list) => {
        setOtherDevices(
          list.map((d) => ({ deviceId: d.deviceId, position: d.position, lastPing: d.lastPing, status: d.status, avatarUrl: user.avatarUrl, deviceType: d.deviceType }))
        );
        setDeviceId(list[0]?.deviceId ?? "");
      })
      .catch((e: any) => setError(e?.message || "The devices could not be loaded."));
  };

  useEffect(() => {
    if (!deviceId) return;
    let live = true;
    fetchTimelineDays(creds, deviceId, queryUser)
      .then((list) => live && setDays(list))
      .catch(() => live && setDays([]));
    return () => {
      live = false;
    };
  }, [creds, deviceId, queryUser, reloads]);

  useEffect(() => {
    const current = ++run.current;
    if (!deviceId) {
      setTimeline(null);
      setLoading(false);
      post({ type: "routeClear" });
      return;
    }
    setLoading(true);
    setError("");
    setSelected(null);
    setPicking(null);
    setCorrecting(null);
    setModeError("");
    pendingTries.current = 0;
    fetchTimeline(creds, deviceId, day, queryUser)
      .then((result) => {
        if (current !== run.current) return;
        setTimeline(result);
        const segments = routeSegments(result.segments);
        shownRoute.current = segments;
        hasRoute.current = segments.length > 0;
        if (segments.length) post({ type: "route", segments, bottom: bottomRef.current });
        else post({ type: "routeClear" });
      })
      .catch((e: any) => {
        if (current !== run.current) return;
        setTimeline(null);
        setError(e?.message || "The timeline could not be loaded.");
        shownRoute.current = [];
        hasRoute.current = false;
        post({ type: "routeClear" });
      })
      .finally(() => current === run.current && setLoading(false));
  }, [creds, deviceId, queryUser, day, reloads, post]);

  useEffect(() => () => post({ type: "routeClear" }), [post]);

  // Same day again for new place names or smoother paths. The map keeps its view: smoothed lines
  // are swapped in place, and only a day that changed in more than its lines is drawn anew.
  const refreshPlaces = useCallback(() => {
    const current = run.current;
    const mine = ++refreshRun.current;
    const fresh = () => current === run.current && mine === refreshRun.current;
    fetchTimeline(creds, deviceId, day, queryUser)
      .then((result) => {
        if (!fresh()) return;
        setTimeline(result);
        const segments = routeSegments(result.segments);
        const change = routeChange(shownRoute.current, segments);
        shownRoute.current = segments;
        hasRoute.current = segments.length > 0;
        if (change === "paths") post({ type: "routePaths", segments });
        else if (change === "full") {
          setSelected(null);
          if (segments.length) post({ type: "route", segments, bottom: bottomRef.current });
          else post({ type: "routeClear" });
        }
      })
      // A failed try still counts, the next one is scheduled all the same.
      .catch(() => fresh() && setRefreshFailures((n) => n + 1));
  }, [creds, deviceId, day, queryUser, post]);

  useEffect(() => {
    if (!stillPending(timeline) || pendingTries.current >= PENDING_RETRIES) return;
    const timer = setTimeout(() => {
      pendingTries.current += 1;
      refreshPlaces();
    }, PENDING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [timeline, refreshFailures, refreshPlaces]);

  const select = useCallback(
    (index: number | null) => {
      setSelected(index);
      post({ type: "routeFocus", index });
    },
    [post]
  );

  // "This was: Transit": the server keeps the correction, the day is fetched again so the row and the map follow.
  const correct = (trip: Trip, mode: TripModeChoice) => {
    setModeSaving(mode);
    setModeError("");
    setTripMode(creds, deviceId, trip.start, mode)
      .then(() => {
        setCorrecting(null);
        setReloads((n) => n + 1);
      })
      .catch((e: any) => setModeError(e?.message || "Could not save, try again."))
      .finally(() => setModeSaving(null));
  };

  useEffect(() => {
    if (!mapTap || !timeline) return;
    setSelected(mapTap.index);
    post({ type: "routeFocus", index: mapTap.index });
    const y = rows.current[mapTap.index];
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapTap]);

  const segments = timeline?.segments ?? [];
  const numbers = useMemo(() => visitNumbers(segments), [segments]);
  const summary = timeline?.summary;

  const chip = (active: boolean) => ({ backgroundColor: active ? c.secondary : c.subtle });
  const chipText = (active: boolean) => ({ color: active ? c.onSecondary : c.primary });

  return (
    <Animated.View style={[styles.panel, panelStyle, { backgroundColor: c.raised, paddingBottom: insets.bottom + 8 }]}>
      <GestureDetector gesture={dragGesture}>
        <View collapsable={false} accessibilityHint="Drag up or down to resize">
          <View style={[styles.grabber, { backgroundColor: c.muted }]} />

          <View style={styles.header}>
            <Text style={[styles.title, { color: c.primary }]}>Timeline</Text>
            <View style={styles.headerActions}>
              <Pressable
                style={[styles.iconButton, { backgroundColor: c.subtle }]}
                onPress={() => setReloads((n) => n + 1)}
                accessibilityLabel="Reload the timeline"
              >
                <MaterialIcons name="refresh" size={20} color={c.primary} />
              </Pressable>
              <Pressable
                style={[styles.iconButton, { backgroundColor: c.subtle }]}
                onPress={onClose}
                accessibilityLabel="Close the timeline"
              >
                <MaterialIcons name="close" size={20} color={c.primary} />
              </Pressable>
            </View>
          </View>
        </View>
      </GestureDetector>

      {preset === "battery" && deviceId === creds.deviceId && (
        <Text style={[styles.hint, { color: c.muted }]}>Bus and train lines need Balanced or Precise position updates.</Text>
      )}

      {admin && users.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
          {users.map((user) => {
            const active = user.id === (accountId ?? creds.user.id);
            return (
              <Pressable
                key={user.id}
                onPress={() => pickAccount(user)}
                style={[styles.deviceChip, chip(active)]}
                accessibilityLabel={`Show the account ${user.displayName}`}
                accessibilityState={{ selected: active }}
              >
                <MaterialIcons name="person" size={18} color={active ? c.onSecondary : c.muted} />
                <Text style={[styles.chipLabel, chipText(active)]} numberOfLines={1}>
                  {user.id === creds.user.id ? "Me" : user.displayName}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {choices.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
          {choices.map((device) => {
            const active = device.deviceId === deviceId;
            return (
              <Pressable
                key={device.deviceId}
                onPress={() => setDeviceId(device.deviceId)}
                style={[styles.deviceChip, chip(active)]}
                accessibilityLabel={`Show ${device.deviceId}`}
                accessibilityState={{ selected: active }}
              >
                <Avatar
                  name={device.deviceId}
                  uri={avatarFor(device.avatarUrl)}
                  state={device.status ? freshness(device) : "offline"}
                  size={18}
                  gapColor={active ? c.secondary : c.subtle}
                />
                <MaterialIcons name={DEVICE_ICONS[typeOf(device)]} size={14} color={chipText(active).color} />
                <Text style={[styles.chipLabel, chipText(active)]} numberOfLines={1}>
                  {device.deviceId}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.dayRow}>
        <Pressable
          style={[styles.iconButton, { backgroundColor: c.subtle }]}
          onPress={() => setDay(shiftDay(day, -1))}
          accessibilityLabel="Previous day"
        >
          <MaterialIcons name="chevron-left" size={22} color={c.primary} />
        </Pressable>
        <Pressable
          style={[styles.dayLabel, { backgroundColor: c.subtle }]}
          onPress={() => setDaysOpen((open) => !open)}
          accessibilityLabel="Pick a day"
        >
          <MaterialIcons name="event" size={18} color={c.muted} />
          <Text style={[styles.dayText, { color: c.primary }]} numberOfLines={1}>
            {dayLabel(day)}
          </Text>
          <MaterialIcons name={daysOpen ? "expand-less" : "expand-more"} size={20} color={c.muted} />
        </Pressable>
        <Pressable
          style={[styles.iconButton, { backgroundColor: c.subtle, opacity: day >= today ? 0.35 : 1 }]}
          onPress={() => setDay(shiftDay(day, 1))}
          disabled={day >= today}
          accessibilityLabel="Next day"
        >
          <MaterialIcons name="chevron-right" size={22} color={c.primary} />
        </Pressable>
      </View>

      {daysOpen && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
          {days.length === 0 && <Text style={[styles.note, { color: c.muted }]}>No recorded days yet.</Text>}
          {days.map((key) => {
            const active = key === day;
            return (
              <Pressable
                key={key}
                onPress={() => {
                  setDay(key);
                  setDaysOpen(false);
                }}
                style={[styles.dayChip, chip(active)]}
              >
                <Text style={[styles.chipLabel, chipText(active)]}>{shortDayLabel(key)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {summary && segments.length > 0 && (
        <View style={[styles.summary, { backgroundColor: c.subtle }]}>
          <Stat value={formatDistance(summary.distanceM)} label="Distance" />
          <Stat value={formatDuration(summary.movingMs)} label="Moving" />
          <Stat value={String(summary.visits)} label={summary.visits === 1 ? "Stop" : "Stops"} />
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.secondary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <MaterialIcons name="error-outline" size={28} color={c.secondary} />
          <Text style={[styles.note, { color: c.primary, textAlign: "center" }]}>{error}</Text>
          <Pressable onPress={() => setReloads((n) => n + 1)} hitSlop={8}>
            <Text style={[styles.link, { color: c.secondary }]}>Try again</Text>
          </Pressable>
        </View>
      ) : segments.length === 0 ? (
        <View style={styles.center}>
          <MaterialIcons name="timeline" size={34} color={c.muted} />
          <Text style={[styles.emptyTitle, { color: c.primary }]}>Nothing recorded</Text>
          <Text style={[styles.note, { color: c.muted, textAlign: "center" }]}>
            {choices.length === 0 ? "This account has no devices." : `This device has no location data for ${dayLabel(day).toLowerCase()}.`}
          </Text>
        </View>
      ) : (
        <ScrollView ref={scroll} style={styles.list} showsVerticalScrollIndicator={false}>
          {segments.map((segment, index) => {
            const active = selected === index;
            const first = index === 0;
            const last = index === segments.length - 1;
            const time = `${formatClock(segment.start)} – ${formatClock(segment.end)}`;
            const kind = segment.type === "visit" ? visitKind(segment) : null;
            const ride = segment.type === "trip" ? transitRow(segment) : null;
            return (
              <React.Fragment key={`${segment.type}-${segment.start}`}>
                <Pressable
                  onLayout={(event) => {
                    rows.current[index] = event.nativeEvent.layout.y;
                  }}
                  onPress={() => {
                    select(active ? null : index);
                    // A trip opens its "This was:" chooser along with the focus on the map.
                    if (segment.type === "trip") setCorrecting(active ? null : index);
                  }}
                  style={styles.row}
                  accessibilityLabel={
                    segment.type === "visit"
                      ? `${visitTitle(segment, numbers.get(index))}, ${time}, ${formatDuration(segment.durationMs)}`
                      : `${tripTitle(segment)}, ${formatDistance(segment.distanceM)}, ${time}`
                  }
                >
                  <View style={styles.rail}>
                    <View style={[styles.line, { backgroundColor: c.subtle, top: first ? 22 : 0, bottom: last ? "70%" : 0 }]} />
                    {segment.type === "visit" ? (
                      <View style={[styles.stopDot, { backgroundColor: active ? c.primary : c.secondary }]}>
                        <Text style={[styles.stopNumber, { color: active ? c.raised : c.onSecondary }]}>{numbers.get(index)}</Text>
                      </View>
                    ) : (
                      <View style={[styles.modeDot, { backgroundColor: c.raised, borderColor: tripColor(segment) }]}>
                        <MaterialIcons name={segment.gap ? "more-horiz" : tripIcon(segment)} size={14} color={tripColor(segment)} />
                      </View>
                    )}
                  </View>
                  {segment.type === "visit" ? (
                    <View style={[styles.card, { backgroundColor: active ? c.subtle : "transparent" }]}>
                      <View style={styles.cardText}>
                        <Text style={[styles.cardTitle, { color: c.primary }]} numberOfLines={1}>
                          {visitTitle(segment, numbers.get(index))}
                        </Text>
                        <Text style={[styles.cardMeta, { color: c.muted }]}>
                          {time} · {formatDuration(segment.durationMs)}
                        </Text>
                        {kind && segment.place ? (
                          <View style={styles.kindRow}>
                            <MaterialIcons name={PLACE_ICONS[segment.place.kind] ?? "place"} size={13} color={c.muted} />
                            <Text style={[styles.cardMeta, styles.kindText, { color: c.muted }]}>{kind}</Text>
                          </View>
                        ) : (
                          <Text style={[styles.cardMeta, { color: c.muted }]}>{formatCoords(segment.lat, segment.lon)}</Text>
                        )}
                      </View>
                      {/* Servers from before place names have no place field and nothing to save to. */}
                      {segment.place !== undefined && (
                        <Pressable
                          style={[styles.editButton, { backgroundColor: picking === index ? c.primary : c.subtle }]}
                          onPress={() => setPicking(picking === index ? null : index)}
                          hitSlop={6}
                          accessibilityLabel="Change the place"
                        >
                          <MaterialIcons name="edit" size={16} color={picking === index ? c.raised : c.muted} />
                        </Pressable>
                      )}
                    </View>
                  ) : ride ? (
                    <View style={[styles.tripRow, { backgroundColor: active ? c.subtle : "transparent" }]}>
                      <View style={styles.rideLine}>
                        {!!ride.badge && (
                          <View
                            style={[
                              styles.badge,
                              // Lines without colours of their own get a quiet badge on the panel's surface.
                              { backgroundColor: ride.color ?? c.raised, borderColor: ride.color ?? c.subtle },
                            ]}
                          >
                            <Text style={[styles.badgeText, { color: ride.textColor ?? c.primary }]} numberOfLines={1}>
                              {ride.badge}
                            </Text>
                          </View>
                        )}
                        <Text style={[styles.tripTitle, styles.rideTitle, { color: c.primary }]} numberOfLines={1}>
                          {ride.label} · {ride.stops}
                        </Text>
                      </View>
                      <Text style={[styles.cardMeta, { color: c.muted }]}>
                        {formatDuration(segment.durationMs)} · {time}
                      </Text>
                    </View>
                  ) : (
                    <View style={[styles.tripRow, { backgroundColor: active ? c.subtle : "transparent" }]}>
                      <Text style={[styles.tripTitle, { color: c.primary }]}>
                        {tripTitle(segment)} · {formatDistance(segment.distanceM)}
                      </Text>
                      <Text style={[styles.cardMeta, { color: c.muted }]}>
                        {formatDuration(segment.durationMs)} · {time}
                      </Text>
                    </View>
                  )}
                </Pressable>
                {/* The correction is stored for the caller's own account, so only own devices get it. */}
                {correcting === index && segment.type === "trip" && !viewingOther && (
                  <View style={[styles.chooser, { backgroundColor: c.subtle }]}>
                    <Text style={[styles.chooserLabel, { color: c.muted }]}>This was:</Text>
                    <View style={styles.chooserChips}>
                      {MODE_CHOICES.map((choice) => {
                        const current = choice !== "auto" && choice === segment.mode;
                        const label = choice === "auto" ? "Automatic" : MODE_LABELS[choice];
                        return (
                          <Pressable
                            key={choice}
                            style={[styles.modeChip, { backgroundColor: current ? c.primary : c.raised }]}
                            disabled={modeSaving !== null}
                            onPress={() => correct(segment, choice)}
                            accessibilityLabel={`This was ${label.toLowerCase()}`}
                            accessibilityState={{ selected: current }}
                          >
                            {modeSaving === choice ? (
                              <ActivityIndicator size="small" color={current ? c.raised : c.primary} />
                            ) : (
                              <MaterialIcons
                                name={choice === "auto" ? "autorenew" : MODE_ICONS[choice]}
                                size={16}
                                color={current ? c.raised : c.muted}
                              />
                            )}
                            <Text style={[styles.modeChipText, { color: current ? c.raised : c.primary }]}>{label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                    {!!modeError && <Text style={[styles.note, { color: c.secondary }]}>{modeError}</Text>}
                  </View>
                )}
                {picking === index && segment.type === "visit" && (
                  <PlacePicker
                    creds={creds}
                    visit={segment}
                    userId={queryUser}
                    onSaved={() => {
                      setPicking(null);
                      pendingTries.current = 0;
                      refreshPlaces();
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </ScrollView>
      )}
    </Animated.View>
  );

}

function Stat({ value, label }: { value: string; label: string }) {
  const { colors: c } = useThemeManager();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: c.primary }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: c.muted }]}>{label}</Text>
    </View>
  );
}

const shadow = {
  elevation: 12,
  shadowColor: "#000",
  shadowOpacity: 0.22,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: -4 },
};

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 10,
    ...shadow,
  },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, opacity: 0.35, marginBottom: 10 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  title: { fontSize: 24, fontWeight: "800", letterSpacing: -0.3 },
  headerActions: { flexDirection: "row", gap: 8 },
  iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  chipScroll: { flexGrow: 0, marginBottom: 10 },
  chips: { gap: 8, alignItems: "center" },
  deviceChip: { flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingLeft: 8, paddingRight: 14, borderRadius: 18, maxWidth: 200 },
  dayChip: { height: 34, paddingHorizontal: 14, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  chipLabel: { fontSize: 13.5, fontWeight: "600" },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  dayLabel: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 36, borderRadius: 18 },
  dayText: { fontSize: 15, fontWeight: "700" },
  summary: { flexDirection: "row", borderRadius: 16, paddingVertical: 10, marginBottom: 6 },
  stat: { flex: 1, alignItems: "center" },
  statValue: { fontSize: 17, fontWeight: "800" },
  statLabel: { fontSize: 12, marginTop: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 16, fontWeight: "700" },
  note: { fontSize: 13 },
  link: { fontSize: 14, fontWeight: "600" },
  list: { flex: 1 },
  row: { flexDirection: "row", alignItems: "stretch", minHeight: 52 },
  rail: { width: 40, alignItems: "center", justifyContent: "center" },
  line: { position: "absolute", width: 3, borderRadius: 2 },
  stopDot: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  stopNumber: { fontSize: 12.5, fontWeight: "800" },
  modeDot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  card: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
  cardText: { flex: 1 },
  kindRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  kindText: { marginTop: 0 },
  editButton: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  cardMeta: { fontSize: 12.5, marginTop: 2 },
  tripRow: { flex: 1, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  tripTitle: { fontSize: 14, fontWeight: "600" },
  rideLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rideTitle: { flex: 1 },
  badge: { minWidth: 30, height: 22, paddingHorizontal: 7, borderRadius: 7, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 12.5, fontWeight: "800" },
  hint: { fontSize: 12.5, marginTop: -4, marginBottom: 10 },
  chooser: { marginLeft: 40, marginBottom: 8, padding: 10, borderRadius: 16, gap: 8 },
  chooserLabel: { fontSize: 12.5, fontWeight: "600" },
  chooserChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  modeChip: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17 },
  modeChipText: { fontSize: 13, fontWeight: "600" },
});
