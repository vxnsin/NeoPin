import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, BackHandler, Easing, Linking, Pressable, StyleSheet, Text, View, useWindowDimensions, type HostInstance } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useThemeManager from "@/hooks/useThemeManager";
import type { TourStep, TourTarget } from "@/lib/tour";

// Where a control sits in its window, and how round its corners are.
export type TourRect = { x: number; y: number; width: number; height: number; radius: number };

type Props = {
  steps: TourStep[];
  index: number;
  // The next step. One on another sheet comes after this overlay has faded out; the screen then
  // opens that sheet and a fresh overlay over it, in the same window as its controls.
  onIndex: (next: number) => void;
  // Done or skipped, after the overlay has faded out.
  onFinish: () => void;
  // The control in window coordinates, null when it is not on the screen.
  measure: (target: TourTarget) => Promise<TourRect | null>;
  // Lets a sheet slide in before what is on it gets measured.
  delay?: number;
  // The dashboard's address, linked from the admin step.
  dashboard?: string;
};

const PAD = 6;
const CARD_GAP = 16;

type Hole = { x: number; y: number; w: number; h: number; r: number };

// Everything dims except the control a step is about, and a card next to it says what it does.
// The dim is one view with a huge border around the hole, so the hole keeps round corners without
// an SVG, and it glides from one control to the next.
export default function TourOverlay({ steps, index, onIndex, onFinish, measure, delay = 0, dashboard }: Props) {
  const { colors: c, isDark } = useThemeManager();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [shown, setShown] = useState(index);
  const [spot, setSpot] = useState<TourRect | null>(null);

  const rootRef = useRef<HostInstance>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const card = useRef(new Animated.Value(0)).current;
  // JS driven: width, height and corners cannot run on the native driver.
  const hole = useRef({
    x: new Animated.Value(width / 2),
    y: new Animated.Value(height / 2),
    w: new Animated.Value(0),
    h: new Animated.Value(0),
    r: new Animated.Value(0),
  }).current;
  const busy = useRef(true);
  const done = useRef(false);
  const first = useRef(true);

  // Big enough to reach every corner from any spot on the screen.
  const border = width + height;

  // The control relative to this overlay, which covers its window.
  const locate = useCallback(
    async (target: TourTarget | null): Promise<TourRect | null> => {
      if (!target) return null;
      const rect = await measure(target).catch(() => null);
      if (!rect) return null;
      const root = await new Promise<{ x: number; y: number }>((resolve) => {
        // A view that never answers (gone meanwhile, or no native side in tests) counts as the
        // window's corner, which is where the overlay starts anyway.
        const timer = setTimeout(() => resolve({ x: 0, y: 0 }), 250);
        if (typeof rootRef.current?.measureInWindow !== "function") return resolve({ x: 0, y: 0 });
        rootRef.current.measureInWindow((x, y) => {
          clearTimeout(timer);
          resolve({ x, y });
        });
      });
      return { ...rect, x: rect.x - root.x, y: rect.y - root.y };
    },
    [measure]
  );

  const show = useCallback(
    async (next: number) => {
      const rect = await locate(steps[next].target);
      if (done.current) return;
      const target: Hole = rect
        ? { x: rect.x - PAD, y: rect.y - PAD, w: rect.width + PAD * 2, h: rect.height + PAD * 2, r: rect.radius + PAD }
        : // Nothing to point at: the hole closes to a point and the card sits in the middle.
          { x: width / 2, y: height * 0.45, w: 0, h: 0, r: 0 };
      setShown(next);
      setSpot(rect ? { x: target.x, y: target.y, width: target.w, height: target.h, radius: target.r } : null);
      const entering = first.current;
      first.current = false;
      const glide = (value: Animated.Value, toValue: number) =>
        Animated.timing(value, { toValue, duration: 340, easing: Easing.out(Easing.cubic), useNativeDriver: false });
      if (entering) {
        hole.x.setValue(target.x);
        hole.y.setValue(target.y);
        hole.w.setValue(target.w);
        hole.h.setValue(target.h);
        hole.r.setValue(target.r);
      }
      Animated.parallel([
        ...(entering
          ? [Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: true })]
          : [glide(hole.x, target.x), glide(hole.y, target.y), glide(hole.w, target.w), glide(hole.h, target.h), glide(hole.r, target.r)]),
        Animated.timing(card, { toValue: 1, duration: 240, delay: entering ? 120 : 140, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start(() => {
        busy.current = false;
      });
    },
    [steps, locate, width, height, hole, fade, card]
  );

  // The first step of this overlay after the delay, later ones as the index moves on.
  useEffect(() => {
    const timer = setTimeout(() => show(index), first.current ? delay : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const leave = useCallback(
    (then: () => void) => {
      busy.current = true;
      Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => then());
    },
    [fade]
  );

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    leave(onFinish);
  }, [leave, onFinish]);

  const next = useCallback(() => {
    if (busy.current || done.current) return;
    const following = shown + 1;
    if (following >= steps.length) return finish();
    if (steps[following].sheet !== steps[shown].sheet) {
      done.current = true;
      return leave(() => onIndex(following));
    }
    busy.current = true;
    Animated.timing(card, { toValue: 0, duration: 140, useNativeDriver: true }).start(() => onIndex(following));
  }, [shown, steps, finish, leave, card, onIndex]);

  // Android's back leaves the tour, like Skip.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      finish();
      return true;
    });
    return () => subscription.remove();
  }, [finish]);

  const step = steps[shown];
  const last = shown === steps.length - 1;
  const cardWidth = Math.min(width - 32, 420);
  const cardLeft = (width - cardWidth) / 2;
  // The card sits above a control in the lower half and below one in the upper half.
  const above = !spot || spot.y + spot.height / 2 > height / 2;
  const place = spot
    ? above
      ? { bottom: height - spot.y + CARD_GAP }
      : { top: spot.y + spot.height + CARD_GAP }
    : { bottom: Math.max(insets.bottom + 110, height * 0.3) };
  const caretLeft = spot ? Math.max(22, Math.min(cardWidth - 36, spot.x + spot.width / 2 - cardLeft - 7)) : null;
  const dim = isDark ? "rgba(0,0,0,0.66)" : "rgba(9,10,13,0.52)";

  return (
    <Animated.View
      ref={rootRef}
      style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}
      // Taps around the card go nowhere: the screen stays still while the tour talks about it.
      onStartShouldSetResponder={() => true}
      accessibilityViewIsModal
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: Animated.subtract(hole.x, border),
          top: Animated.subtract(hole.y, border),
          width: Animated.add(hole.w, border * 2),
          height: Animated.add(hole.h, border * 2),
          borderWidth: border,
          borderRadius: Animated.add(hole.r, border),
          borderColor: dim,
        }}
      />
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: hole.x,
          top: hole.y,
          width: hole.w,
          height: hole.h,
          borderRadius: hole.r,
          borderWidth: spot ? 2 : 0,
          borderColor: c.secondary,
        }}
      />

      <Animated.View
        style={[
          styles.card,
          place,
          {
            left: cardLeft,
            width: cardWidth,
            backgroundColor: c.raised,
            opacity: card,
            transform: [{ translateY: card.interpolate({ inputRange: [0, 1], outputRange: [above ? 10 : -10, 0] }) }],
          },
        ]}
      >
        {caretLeft !== null && (
          <View style={[styles.caret, above ? styles.caretDown : styles.caretUp, { left: caretLeft, backgroundColor: c.raised }]} />
        )}
        <View style={styles.head}>
          <View style={[styles.icon, { backgroundColor: c.subtle }]}>
            <MaterialIcons name={step.icon} size={20} color={c.secondary} />
          </View>
          <Text style={[styles.count, { color: c.muted }]}>
            {shown + 1} of {steps.length}
          </Text>
        </View>
        <Text style={[styles.title, { color: c.primary }]} accessibilityRole="header">
          {step.title}
        </Text>
        <Text style={[styles.text, { color: c.muted }]} accessibilityLiveRegion="polite">
          {step.text}
        </Text>
        {step.key === "dashboard" && dashboard ? (
          <Pressable
            style={({ pressed }) => [styles.link, { backgroundColor: c.subtle, opacity: pressed ? 0.7 : 1 }]}
            onPress={() => Linking.openURL(dashboard).catch(() => {})}
            accessibilityRole="link"
            accessibilityLabel="Open the dashboard"
          >
            <Text style={[styles.linkText, { color: c.primary }]} numberOfLines={1}>
              {dashboard.replace(/^https?:\/\//i, "")}
            </Text>
            <MaterialIcons name="open-in-new" size={16} color={c.muted} />
          </Pressable>
        ) : null}

        <View style={styles.footer}>
          {last ? (
            <View style={styles.skip} />
          ) : (
            <Pressable onPress={finish} hitSlop={8} style={styles.skip} accessibilityRole="button" accessibilityLabel="Skip the tour">
              <Text style={[styles.skipText, { color: c.muted }]}>Skip</Text>
            </Pressable>
          )}
          <View style={styles.progress} importantForAccessibility="no-hide-descendants">
            <View style={[styles.track, { backgroundColor: c.subtle }]}>
              <View style={[styles.fill, { backgroundColor: c.secondary, width: `${((shown + 1) / steps.length) * 100}%` }]} />
            </View>
          </View>
          <Pressable
            onPress={next}
            style={({ pressed }) => [styles.next, { backgroundColor: c.secondary, opacity: pressed ? 0.8 : 1 }]}
            accessibilityRole="button"
          >
            <Text style={[styles.nextText, { color: c.onSecondary }]}>{last ? "Done" : "Next"}</Text>
          </Pressable>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { zIndex: 20, elevation: 20, overflow: "hidden" },
  card: {
    position: "absolute",
    borderRadius: 22,
    padding: 18,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  caret: { position: "absolute", width: 14, height: 14, borderRadius: 3, transform: [{ rotate: "45deg" }] },
  caretDown: { bottom: -6 },
  caretUp: { top: -6 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  icon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  count: { fontSize: 12.5, fontWeight: "600" },
  title: { fontSize: 19, fontWeight: "800", letterSpacing: -0.3 },
  text: { fontSize: 14.5, lineHeight: 20, marginTop: 6 },
  link: { flexDirection: "row", alignItems: "center", gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 12, marginTop: 12 },
  linkText: { flex: 1, fontSize: 14, fontWeight: "600" },
  footer: { flexDirection: "row", alignItems: "center", marginTop: 18 },
  skip: { minWidth: 64, height: 40, justifyContent: "center" },
  skipText: { fontSize: 15, fontWeight: "600" },
  // Fourteen steps are too many for dots; a thin bar says how far along it is.
  progress: { flex: 1, paddingHorizontal: 14 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  next: { minWidth: 88, height: 42, paddingHorizontal: 18, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  nextText: { fontSize: 15, fontWeight: "700" },
});
