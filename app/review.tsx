import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useThemeManager from "@/hooks/useThemeManager";
import LineBadge from "@/components/LineBadge";
import ReviewMap from "@/components/ReviewMap";
import { fetchReview, type Review, type ReviewPeriod } from "@/lib/api";
import { readCredentials, type StoredCredentials } from "@/lib/socket";
import { MODE_COLORS, MODE_ICONS, MODE_LABELS, PLACE_ICONS, PLACE_LABELS, TRANSIT_ICONS, TRANSIT_LABELS } from "@/lib/timeline";
import {
  PERIODS,
  badgeTextColor,
  canGoForward,
  changeText,
  compare,
  dayBars,
  distanceParts,
  formatKm,
  formatMinutes,
  modeShares,
  periodHeading,
  plural,
  readReview,
  shareText,
  shiftPeriod,
  switchPeriod,
  targetFromParams,
  type Change,
} from "@/lib/review";

type State =
  | { kind: "loading" }
  | { kind: "ready"; review: Review }
  | { kind: "error"; message: string }
  // The server is from before reviews (404).
  | { kind: "unsupported" };

// The weekly or monthly review of the own timeline: big numbers on top, then the days, the ways of
// getting around, lines, places and the period's line on a small map. Opened from the settings, the
// timeline and a review notification, which brings its period along.
export default function ReviewScreen() {
  const { colors: c } = useThemeManager();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ period?: string; date?: string }>();
  const start = targetFromParams(params);

  const [period, setPeriod] = useState<ReviewPeriod>(start.period);
  // The first day of the period shown.
  const [date, setDate] = useState(start.date);
  const [creds, setCreds] = useState<StoredCredentials | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloads, setReloads] = useState(0);
  const run = useRef(0);

  // A notification tapped while the review is open brings a new period.
  useEffect(() => {
    const next = targetFromParams(params);
    setPeriod(next.period);
    setDate(next.date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.period, params.date]);

  useEffect(() => {
    readCredentials()
      .then((stored) => {
        if (stored) setCreds(stored);
        else setState({ kind: "error", message: "You are logged out." });
      })
      .catch(() => setState({ kind: "error", message: "You are logged out." }));
  }, []);

  useEffect(() => {
    if (!creds) return;
    const current = ++run.current;
    setState({ kind: "loading" });
    fetchReview(creds, period, date)
      .then((raw) => {
        if (current !== run.current) return;
        setState(raw === null ? { kind: "unsupported" } : { kind: "ready", review: readReview(raw, period, date) });
      })
      .catch((e: any) => current === run.current && setState({ kind: "error", message: e?.message || "The review could not be loaded." }));
  }, [creds, period, date, reloads]);

  const heading = periodHeading(period, date);
  const forward = canGoForward(period, date);
  const back = () => (router.canGoBack() ? router.back() : router.replace("/map"));

  const choose = (next: ReviewPeriod) => {
    if (next === period) return;
    setDate(switchPeriod(period, next, date));
    setPeriod(next);
  };

  return (
    <View style={[styles.screen, { backgroundColor: c.surface }]}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable style={[styles.iconButton, { backgroundColor: c.subtle }]} onPress={back} accessibilityRole="button" accessibilityLabel="Back">
            <MaterialIcons name="arrow-back" size={20} color={c.primary} />
          </Pressable>
          <Text style={[styles.title, { color: c.primary }]}>Review</Text>
          <Pressable
            style={[styles.iconButton, { backgroundColor: c.subtle }]}
            onPress={() => setReloads((n) => n + 1)}
            accessibilityRole="button"
            accessibilityLabel="Reload the review"
          >
            <MaterialIcons name="refresh" size={20} color={c.primary} />
          </Pressable>
        </View>

        <View style={[styles.toggle, { backgroundColor: c.subtle }]} accessibilityRole="tablist">
          {PERIODS.map((p) => {
            const active = p === period;
            return (
              <Pressable
                key={p}
                style={[styles.toggleItem, active && { backgroundColor: c.secondary }]}
                onPress={() => choose(p)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.toggleText, { color: active ? c.onSecondary : c.primary }]}>{p === "week" ? "Week" : "Month"}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.periodRow}>
          <Pressable
            style={[styles.iconButton, { backgroundColor: c.subtle }]}
            onPress={() => setDate(shiftPeriod(period, date, -1))}
            accessibilityRole="button"
            accessibilityLabel={period === "week" ? "Previous week" : "Previous month"}
          >
            <MaterialIcons name="chevron-left" size={22} color={c.primary} />
          </Pressable>
          <View style={[styles.periodLabel, { backgroundColor: c.subtle }]} accessibilityLabel={`${heading.title}, ${heading.detail}`}>
            <Text style={[styles.periodTitle, { color: c.primary }]} numberOfLines={1}>
              {heading.title}
            </Text>
            <Text style={[styles.periodDetail, { color: c.muted }]} numberOfLines={1}>
              {heading.detail}
            </Text>
          </View>
          <Pressable
            style={[styles.iconButton, { backgroundColor: c.subtle, opacity: forward ? 1 : 0.35 }]}
            onPress={() => setDate(shiftPeriod(period, date, 1))}
            disabled={!forward}
            accessibilityRole="button"
            accessibilityLabel={period === "week" ? "Next week" : "Next month"}
          >
            <MaterialIcons name="chevron-right" size={22} color={c.primary} />
          </Pressable>
        </View>

        {state.kind === "loading" ? (
          <View style={styles.center}>
            <ActivityIndicator color={c.secondary} />
          </View>
        ) : state.kind === "unsupported" ? (
          <Message icon="update" title="Not on this server yet" text="Reviews need a newer NeoPin server." />
        ) : state.kind === "error" ? (
          <View style={styles.center}>
            <MaterialIcons name="error-outline" size={28} color={c.secondary} />
            <Text style={[styles.note, { color: c.primary, textAlign: "center" }]}>{state.message}</Text>
            {creds && (
              <Pressable onPress={() => setReloads((n) => n + 1)} hitSlop={8} accessibilityRole="button">
                <Text style={[styles.link, { color: c.secondary }]}>Try again</Text>
              </Pressable>
            )}
          </View>
        ) : state.review.empty ? (
          <Message
            icon="insights"
            title="Nothing recorded"
            text={`Your timeline has no trips in this ${period}. The review fills up as you move.`}
          />
        ) : (
          <ReviewBody review={state.review} />
        )}
      </ScrollView>
    </View>
  );
}

function Message({ icon, title, text }: { icon: React.ComponentProps<typeof MaterialIcons>["name"]; title: string; text: string }) {
  const { colors: c } = useThemeManager();
  return (
    <View style={styles.center}>
      <View style={[styles.badge, { backgroundColor: c.subtle }]}>
        <MaterialIcons name={icon} size={36} color={c.muted} />
      </View>
      <Text style={[styles.emptyTitle, { color: c.primary }]}>{title}</Text>
      <Text style={[styles.note, { color: c.muted, textAlign: "center" }]}>{text}</Text>
    </View>
  );
}

function ChangeLine({ change, period }: { change: Change | null; period: ReviewPeriod }) {
  const { colors: c } = useThemeManager();
  if (!change) return null;
  const icon = change.direction === "up" ? "trending-up" : change.direction === "down" ? "trending-down" : "trending-flat";
  return (
    <View style={styles.changeRow}>
      <MaterialIcons name={icon} size={16} color={c.muted} />
      <Text style={[styles.changeText, { color: c.muted }]}>{changeText(change, period)}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { colors: c } = useThemeManager();
  return (
    <>
      <Text style={[styles.sectionTitle, { color: c.muted }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: c.subtle }]}>{children}</View>
    </>
  );
}

function ReviewBody({ review }: { review: Review }) {
  const { colors: c } = useThemeManager();
  const distance = distanceParts(review.distanceKm);
  const bars = dayBars(review);
  const shares = modeShares(review.byMode);
  const week = review.period === "week";

  return (
    <>
      <View style={[styles.hero, { backgroundColor: c.subtle }]}>
        <Text style={[styles.heroLabel, { color: c.muted }]}>Distance</Text>
        <View style={styles.heroValueRow}>
          <Text style={[styles.heroValue, { color: c.primary }]}>{distance.value}</Text>
          <Text style={[styles.heroUnit, { color: c.primary }]}>{distance.unit}</Text>
        </View>
        <ChangeLine change={compare(review.distanceKm, review.previous?.distanceKm)} period={review.period} />
      </View>

      <View style={styles.tiles}>
        <View style={[styles.tile, { backgroundColor: c.subtle }]}>
          <Text style={[styles.heroLabel, { color: c.muted }]}>On the move</Text>
          <Text style={[styles.tileValue, { color: c.primary }]} numberOfLines={1} adjustsFontSizeToFit>
            {formatMinutes(review.movingMinutes)}
          </Text>
          <ChangeLine change={compare(review.movingMinutes, review.previous?.movingMinutes)} period={review.period} />
        </View>
        <View style={[styles.tile, { backgroundColor: c.subtle }]}>
          <Text style={[styles.heroLabel, { color: c.muted }]}>Trips</Text>
          <Text style={[styles.tileValue, { color: c.primary }]}>{review.trips}</Text>
          <Text style={[styles.changeText, { color: c.muted }]}>{plural(review.stops, "stop")}</Text>
        </View>
      </View>

      <Section title="Day by day">
        <View style={styles.chart} accessibilityLabel={`Distance per day, most ${formatKm(Math.max(0, ...bars.map((b) => b.km)))}`}>
          {bars.map((bar) => (
            <View key={bar.date} style={styles.barColumn}>
              <View style={[styles.barTrack, { backgroundColor: c.raised, borderRadius: week ? 8 : 3 }]}>
                <View
                  style={[
                    styles.barFill,
                    { height: `${Math.max(bar.km > 0 ? 4 : 0, bar.ratio * 100)}%`, backgroundColor: c.secondary, borderRadius: week ? 8 : 3 },
                  ]}
                />
              </View>
              <Text style={[styles.barLabel, { color: c.muted }]} numberOfLines={1}>
                {bar.label}
              </Text>
            </View>
          ))}
        </View>
        {week && (
          <View style={styles.barValues}>
            {bars.map((bar) => (
              <Text key={bar.date} style={[styles.barValue, { color: c.muted }]} numberOfLines={1}>
                {bar.km > 0 ? (bar.km < 10 ? bar.km.toFixed(1) : Math.round(bar.km)) : ""}
              </Text>
            ))}
          </View>
        )}
      </Section>

      {shares.length > 0 && (
        <Section title="How you got around">
          <View style={[styles.shareBar, { backgroundColor: c.raised }]}>
            {shares.map((s) => (
              <View key={s.mode} style={{ flex: s.share, backgroundColor: MODE_COLORS[s.mode] }} />
            ))}
          </View>
          {shares.map((s) => (
            <View key={s.mode} style={styles.row} accessibilityLabel={`${MODE_LABELS[s.mode]}, ${formatKm(s.km)}, ${formatMinutes(s.minutes)}, ${shareText(s.share)}`}>
              <View style={[styles.modeDot, { backgroundColor: c.raised, borderColor: MODE_COLORS[s.mode] }]}>
                <MaterialIcons name={MODE_ICONS[s.mode]} size={15} color={MODE_COLORS[s.mode]} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: c.primary }]}>{MODE_LABELS[s.mode]}</Text>
                <Text style={[styles.rowMeta, { color: c.muted }]}>
                  {formatKm(s.km)} · {formatMinutes(s.minutes)}
                </Text>
              </View>
              <Text style={[styles.rowValue, { color: c.primary }]}>{shareText(s.share)}</Text>
            </View>
          ))}
        </Section>
      )}

      {review.transit.length > 0 && (
        <Section title="Lines you rode">
          {review.transit.slice(0, 5).map((t) => (
            <View key={`${t.kind}-${t.line}`} style={styles.row} accessibilityLabel={`${TRANSIT_LABELS[t.kind]} ${t.line}, ${plural(t.rides, "ride")}`}>
              <View style={styles.lineBadge}>
                <LineBadge line={t.line} color={t.color} textColor={badgeTextColor(t.color)} />
              </View>
              <MaterialIcons name={TRANSIT_ICONS[t.kind]} size={16} color={c.muted} />
              <Text style={[styles.rowTitle, styles.flex, { color: c.primary }]}>{TRANSIT_LABELS[t.kind]}</Text>
              <Text style={[styles.rowMeta, { color: c.muted }]}>{plural(t.rides, "ride")}</Text>
            </View>
          ))}
        </Section>
      )}

      {review.topPlaces.length > 0 && (
        <Section title="Where you spent time">
          {review.topPlaces.map((p, i) => (
            <View key={`${p.name}-${i}`} style={styles.row} accessibilityLabel={`${p.name}, ${plural(p.visits, "visit")}, ${formatMinutes(p.minutes)}`}>
              <View style={[styles.placeIcon, { backgroundColor: c.raised }]}>
                <MaterialIcons name={PLACE_ICONS[p.kind] ?? "place"} size={18} color={c.secondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: c.primary }]} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={[styles.rowMeta, { color: c.muted }]} numberOfLines={1}>
                  {PLACE_LABELS[p.kind]} · {plural(p.visits, "visit")}
                </Text>
              </View>
              <Text style={[styles.rowValue, { color: c.primary }]}>{formatMinutes(p.minutes)}</Text>
            </View>
          ))}
          {review.newPlaces > 0 && (
            <View style={styles.newPlaces}>
              <MaterialIcons name="explore" size={16} color={c.muted} />
              <Text style={[styles.rowMeta, { color: c.muted, marginTop: 0 }]}>
                {review.newPlaces === 1 ? "1 place visited for the first time" : `${review.newPlaces} places visited for the first time`}
              </Text>
            </View>
          )}
        </Section>
      )}

      {review.path.length >= 2 && (
        <>
          <Text style={[styles.sectionTitle, { color: c.muted }]}>Your {week ? "week" : "month"} on the map</Text>
          <ReviewMap path={review.path} />
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 18, flexGrow: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14 },
  title: { flex: 1, fontSize: 24, fontWeight: "800", letterSpacing: -0.3 },
  iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  toggle: { flexDirection: "row", borderRadius: 14, padding: 4, marginBottom: 12 },
  toggleItem: { flex: 1, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  toggleText: { fontSize: 14, fontWeight: "700" },
  periodRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 },
  periodLabel: { flex: 1, minHeight: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, paddingVertical: 4 },
  periodTitle: { fontSize: 15, fontWeight: "700" },
  periodDetail: { fontSize: 12 },
  center: { alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 24, paddingVertical: 48 },
  badge: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { fontSize: 17, fontWeight: "700" },
  note: { fontSize: 13.5 },
  link: { fontSize: 14, fontWeight: "600" },
  hero: { borderRadius: 20, padding: 18 },
  heroLabel: { fontSize: 13, fontWeight: "600" },
  heroValueRow: { flexDirection: "row", alignItems: "baseline", gap: 6, marginTop: 2 },
  heroValue: { fontSize: 52, fontWeight: "800", letterSpacing: -1.5 },
  heroUnit: { fontSize: 22, fontWeight: "700" },
  changeRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  changeText: { fontSize: 12.5, flexShrink: 1 },
  tiles: { flexDirection: "row", gap: 10, marginTop: 10 },
  tile: { flex: 1, borderRadius: 18, padding: 14 },
  tileValue: { fontSize: 26, fontWeight: "800", letterSpacing: -0.5, marginTop: 2 },
  sectionTitle: { fontSize: 13, fontWeight: "600", marginTop: 22, marginBottom: 8 },
  card: { borderRadius: 18, padding: 14 },
  chart: { flexDirection: "row", alignItems: "flex-end", gap: 3, height: 130 },
  barColumn: { flex: 1, height: "100%", alignItems: "center" },
  barTrack: { flex: 1, width: "100%", justifyContent: "flex-end", overflow: "hidden" },
  barFill: { width: "100%" },
  barLabel: { fontSize: 11, marginTop: 5, height: 14 },
  barValues: { flexDirection: "row", gap: 3, marginTop: 2 },
  barValue: { flex: 1, fontSize: 10.5, textAlign: "center" },
  shareBar: { flexDirection: "row", height: 12, borderRadius: 6, overflow: "hidden", marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 },
  flex: { flex: 1 },
  modeDot: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  rowTitle: { fontSize: 14.5, fontWeight: "600" },
  rowMeta: { fontSize: 12.5, marginTop: 2 },
  rowValue: { fontSize: 14, fontWeight: "700" },
  lineBadge: { minWidth: 48, alignItems: "flex-start" },
  placeIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  newPlaces: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8 },
});
