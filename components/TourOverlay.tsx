import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, BackHandler, Easing, Linking, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import useThemeManager from "@/hooks/useThemeManager";
import type { TourStep, TourTarget } from "@/lib/tour";

// Where a target sits on the map screen, and how round its corners are.
export type TourRect = { x: number; y: number; width: number; height: number; radius: number };

type Props = {
  steps: TourStep[];
  measure: (target: TourTarget) => Promise<TourRect | null>;
  // Done or skipped, after the overlay has faded out.
  onFinish: () => void;
  // The dashboard's address, linked from the admin step.
  dashboard?: string;
};

const PAD = 6;
const CARD_GAP = 16;

// The first-login walk over the map: everything dims except the spot a step is about, with a card
// that points at it. The dim is one view with a huge border around the spot, so the hole keeps
// round corners without an SVG, and it glides from one spot to the next.
export default function TourOverlay({ steps, measure, onFinish, dashboard }: Props) {
  const { colors: c, isDark } = useThemeManager();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<TourRect | null>(null);

  const fade = useRef(new Animated.Value(0)).current;
  const card = useRef(new Animated.Value(0)).current;
  // The hole, JS driven: width, height and corners cannot run on the native driver.
  const hole = useRef({
    x: new Animated.Value(width / 2),
    y: new Animated.Value(height / 2),
    w: new Animated.Value(0),
    h: new Animated.Value(0),
    r: new Animated.Value(0),
  }).current;
  const busy = useRef(true);
  const finished = useRef(false);

  // Big enough to reach every corner from any spot on the screen.
  const border = width + height;

  const show = useCallback(
    async (next: number, first = false) => {
      const step = steps[next];
      const rect = step.target === "map" ? null : await measure(step.target).catch(() => null);
      const target = rect
        ? { x: rect.x - PAD, y: rect.y - PAD, w: rect.width + PAD * 2, h: rect.height + PAD * 2, r: rect.radius + PAD }
        : // Nothing to point at: the hole closes to a point in the middle of the map.
          { x: width / 2, y: height * 0.45, w: 0, h: 0, r: 0 };
      setIndex(next);
      setSpot(rect ? { x: target.x, y: target.y, width: target.w, height: target.h, radius: target.r } : null);
      const glide = (value: Animated.Value, toValue: number) =>
        Animated.timing(value, { toValue, duration: 340, easing: Easing.out(Easing.cubic), useNativeDriver: false });
      if (first) {
        hole.x.setValue(target.x);
        hole.y.setValue(target.y);
        hole.w.setValue(target.w);
        hole.h.setValue(target.h);
        hole.r.setValue(target.r);
      }
      Animated.parallel([
        ...(first
          ? [Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: true })]
          : [glide(hole.x, target.x), glide(hole.y, target.y), glide(hole.w, target.w), glide(hole.h, target.h), glide(hole.r, target.r)]),
        Animated.timing(card, { toValue: 1, duration: 240, delay: first ? 120 : 140, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start(() => {
        busy.current = false;
      });
    },
    [steps, measure, width, height, hole, fade, card]
  );

  useEffect(() => {
    show(0, true);
    // Only the first step starts on its own; later ones follow the buttons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    busy.current = true;
    Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => onFinish());
  }, [fade, onFinish]);

  const go = useCallback(
    (next: number) => {
      if (busy.current || finished.current) return;
      if (next >= steps.length) return finish();
      busy.current = true;
      Animated.timing(card, { toValue: 0, duration: 140, useNativeDriver: true }).start(() => show(next));
    },
    [steps.length, card, show, finish]
  );

  // Android's back goes one step back, and out of the tour from the first one.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (index > 0) go(index - 1);
      else finish();
      return true;
    });
    return () => subscription.remove();
  }, [index, go, finish]);

  const step = steps[index];
  const last = index === steps.length - 1;
  const cardWidth = Math.min(width - 32, 420);
  const cardLeft = (width - cardWidth) / 2;
  // The card sits above a spot in the lower half and below one in the upper half.
  const above = !spot || spot.y + spot.height / 2 > height / 2;
  const place = spot
    ? above
      ? { bottom: height - spot.y + CARD_GAP }
      : { top: spot.y + spot.height + CARD_GAP }
    : { bottom: insets.bottom + 110 };
  const caretLeft = spot ? Math.max(22, Math.min(cardWidth - 36, spot.x + spot.width / 2 - cardLeft - 7)) : null;
  const dim = isDark ? "rgba(0,0,0,0.66)" : "rgba(9,10,13,0.52)";

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.root, { opacity: fade }]}
      // Taps around the card go nowhere: the map stays still while the tour talks about it.
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
            {index + 1} of {steps.length}
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
          <View style={styles.dots} importantForAccessibility="no-hide-descendants">
            {steps.map((s, i) => (
              <View key={s.key} style={[styles.dot, { backgroundColor: i === index ? c.secondary : c.subtle, width: i === index ? 16 : 6 }]} />
            ))}
          </View>
          <Pressable
            onPress={() => go(index + 1)}
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
  dots: { flex: 1, flexDirection: "row", justifyContent: "center", gap: 5 },
  dot: { height: 6, borderRadius: 3 },
  next: { minWidth: 88, height: 42, paddingHorizontal: 18, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  nextText: { fontSize: 15, fontWeight: "700" },
});
