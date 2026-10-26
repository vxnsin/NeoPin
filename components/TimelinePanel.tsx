import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useThemeManager from "@/hooks/useThemeManager";
import Avatar from "@/components/Avatar";
import {
  fetchTimeline,
  fetchTimelineDays,
  fetchUserDevices,
  fetchUsers,
  type AccountSummary,
  type Timeline,
} from "@/lib/api";
import type { StoredCredentials } from "@/lib/credentials";
import { freshness, type Device } from "@/lib/devices";
import {
  MODE_COLORS,
  MODE_ICONS,
  MODE_LABELS,
  dayKey,
  dayLabel,
  formatClock,
  formatCoords,
  formatDistance,
  formatDuration,
  routeSegments,
  shiftDay,
  shortDayLabel,
  visitNumbers,
} from "@/lib/timeline";

type Props = {
  creds: StoredCredentials;
  devices: Device[];
  avatarFor: (url?: string | null) => string | null;
  // Sends a message to the map page.
  post: (payload: object) => void;
  height: number;
  // A stop or a line the user tapped on the map.
  mapTap: { index: number; n: number } | null;
  onClose: () => void;
};

export default function TimelinePanel({ creds, devices, avatarFor, post, height, mapTap, onClose }: Props) {
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
  const run = useRef(0);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const rows = useRef<Record<number, number>>({});
  const bottomPadding = height + 16;

  useEffect(() => {
    if (!admin) return;
    fetchUsers(creds)
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [creds, admin]);

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
          list.map((d) => ({ deviceId: d.deviceId, position: d.position, lastPing: d.lastPing, status: d.status, avatarUrl: user.avatarUrl }))
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
    fetchTimeline(creds, deviceId, day, queryUser)
      .then((result) => {
        if (current !== run.current) return;
        setTimeline(result);
        const segments = routeSegments(result.segments);
        if (segments.length) post({ type: "route", segments, bottom: bottomPadding });
        else post({ type: "routeClear" });
      })
      .catch((e: any) => {
        if (current !== run.current) return;
        setTimeline(null);
        setError(e?.message || "The timeline could not be loaded.");
        post({ type: "routeClear" });
      })
      .finally(() => current === run.current && setLoading(false));
  }, [creds, deviceId, queryUser, day, reloads, post, bottomPadding]);

  useEffect(() => () => post({ type: "routeClear" }), [post]);

  const select = useCallback(
    (index: number | null) => {
      setSelected(index);
      post({ type: "routeFocus", index });
    },
    [post]
  );

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
    <View style={[styles.panel, { height, backgroundColor: c.raised, paddingBottom: insets.bottom + 8 }]}>
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
            return (
              <Pressable
                key={`${segment.type}-${segment.start}`}
                onLayout={(event) => {
                  rows.current[index] = event.nativeEvent.layout.y;
                }}
                onPress={() => select(active ? null : index)}
                style={styles.row}
                accessibilityLabel={
                  segment.type === "visit"
                    ? `Stop ${numbers.get(index)}, ${time}, ${formatDuration(segment.durationMs)}`
                    : `${MODE_LABELS[segment.mode]}, ${formatDistance(segment.distanceM)}, ${time}`
                }
              >
                <View style={styles.rail}>
                  <View style={[styles.line, { backgroundColor: c.subtle, top: first ? 22 : 0, bottom: last ? "70%" : 0 }]} />
                  {segment.type === "visit" ? (
                    <View style={[styles.stopDot, { backgroundColor: active ? c.primary : c.secondary }]}>
                      <Text style={[styles.stopNumber, { color: active ? c.raised : c.onSecondary }]}>{numbers.get(index)}</Text>
                    </View>
                  ) : (
                    <View style={[styles.modeDot, { backgroundColor: c.raised, borderColor: MODE_COLORS[segment.mode] }]}>
                      <MaterialIcons name={MODE_ICONS[segment.mode]} size={14} color={MODE_COLORS[segment.mode]} />
                    </View>
                  )}
                </View>
                {segment.type === "visit" ? (
                  <View style={[styles.card, { backgroundColor: active ? c.subtle : "transparent" }]}>
                    <Text style={[styles.cardTitle, { color: c.primary }]}>{time}</Text>
                    <Text style={[styles.cardMeta, { color: c.muted }]}>
                      Stayed {formatDuration(segment.durationMs)} · {formatCoords(segment.lat, segment.lon)}
                    </Text>
                  </View>
                ) : (
                  <View style={[styles.tripRow, { backgroundColor: active ? c.subtle : "transparent" }]}>
                    <Text style={[styles.tripTitle, { color: c.primary }]}>
                      {MODE_LABELS[segment.mode]} · {formatDistance(segment.distanceM)}
                    </Text>
                    <Text style={[styles.cardMeta, { color: c.muted }]}>
                      {formatDuration(segment.durationMs)} · {time}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
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
  card: { flex: 1, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  cardMeta: { fontSize: 12.5, marginTop: 2 },
  tripRow: { flex: 1, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  tripTitle: { fontSize: 14, fontWeight: "600" },
});
