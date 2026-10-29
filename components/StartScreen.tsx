import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import useThemeManager from "@/hooks/useThemeManager";

// The native splash draws the round logo 200 dp wide in the middle of the screen, on the app's
// surface colour. This screen takes over at exactly that size and lets the logo settle, so the
// hand-over is invisible. It stays until what it covers is drawn, then the logo docks into the map.
const SPLASH_WIDTH = 200;
const LOGO = 120;
const SLOW_AFTER_MS = 2500;
const TRACK = 120;

// Once per app window: a later screen (index → map) starts at rest instead of landing again.
let landed = false;

// A new app window lands again. On Android the location service keeps the JS running after the
// app is swiped away, so "once per process" would mean the animation never shows a second time.
export function resetLanding() {
  landed = false;
}

type Props = {
  // What the screen waits for is drawn underneath.
  ready: boolean;
  // How the logo goes: into its place on the map, or simply away.
  leave?: "dock" | "fade";
  // First start only.
  tagline?: string;
  onHidden?: () => void;
};

export default function StartScreen({ ready, leave = "dock", tagline, onHidden }: Props) {
  const { colors } = useThemeManager();
  const land = useRef(new Animated.Value(landed ? 1 : 0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const word = useRef(new Animated.Value(landed ? 1 : 0)).current;
  const out = useRef(new Animated.Value(0)).current;
  const thumb = useRef(new Animated.Value(0)).current;
  const [slow, setSlow] = useState(false);
  const hidden = useRef(onHidden);
  hidden.current = onHidden;

  // The splash goes the moment this screen is on, with the logo where the splash left it.
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  useEffect(() => {
    if (landed) return;
    landed = true;
    const show = Animated.parallel([
      Animated.timing(land, { toValue: 1, duration: 700, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }),
      Animated.sequence([
        Animated.delay(350),
        Animated.timing(ring, { toValue: 1, duration: 1200, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.delay(500),
        Animated.timing(word, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
    ]);
    show.start();
    return () => show.stop();
  }, [land, ring, word]);

  // A bar appears only when the wait gets long, and slides until the wait is over.
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  useEffect(() => {
    if (!slow) return;
    const slide = Animated.loop(
      Animated.timing(thumb, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
    );
    slide.start();
    return () => slide.stop();
  }, [slow, thumb]);

  useEffect(() => {
    if (!ready) return;
    const go = Animated.timing(out, {
      toValue: 1,
      duration: leave === "dock" ? 500 : 450,
      easing: Easing.inOut(Easing.cubic),
      useNativeDriver: true,
    });
    go.start(({ finished }) => finished && hidden.current?.());
    return () => go.stop();
  }, [ready, leave, out]);

  const gone = out.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const landScale = land.interpolate({ inputRange: [0, 1], outputRange: [SPLASH_WIDTH / LOGO, 1] });
  const dockScale = out.interpolate({ inputRange: [0, 1], outputRange: [1, leave === "dock" ? 0.42 : 1] });
  const dockY = out.interpolate({ inputRange: [0, 1], outputRange: [0, leave === "dock" ? -34 : 0] });

  return (
    <Animated.View pointerEvents={ready ? "none" : "auto"} style={[styles.fill, { backgroundColor: colors.surface, opacity: gone }]}>
      <View style={styles.stage}>
        <Animated.View
          style={[
            styles.ring,
            {
              borderColor: colors.secondary,
              opacity: ring.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 0.6, 0] }),
              transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
            },
          ]}
        />
        <Animated.Image
          source={require("@/assets/images/logo.png")}
          style={[styles.logo, { transform: [{ translateY: dockY }, { scale: Animated.multiply(landScale, dockScale) }] }]}
        />
      </View>
      <Animated.View
        style={[
          styles.below,
          { opacity: Animated.multiply(word, gone), transform: [{ translateY: word.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] },
        ]}
      >
        <Animated.Text style={[styles.word, { color: colors.primary }]}>NeoPin</Animated.Text>
        {tagline ? <Animated.Text style={[styles.tagline, { color: colors.muted }]}>{tagline}</Animated.Text> : null}
        {slow ? (
          <View style={[styles.track, { backgroundColor: colors.subtle }]}>
            <Animated.View
              style={[
                styles.thumb,
                {
                  backgroundColor: colors.secondary,
                  transform: [{ translateX: thumb.interpolate({ inputRange: [0, 1], outputRange: [-TRACK / 2, TRACK] }) }],
                },
              ]}
            />
          </View>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", zIndex: 10 },
  // The logo sits in the exact middle, like on the splash; everything else hangs below it.
  stage: { width: LOGO, height: LOGO, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: LOGO, height: LOGO, borderRadius: LOGO / 2, borderWidth: 2 },
  logo: { width: LOGO, height: LOGO },
  below: { position: "absolute", top: "50%", marginTop: LOGO / 2 + 18, alignItems: "center" },
  word: { fontSize: 24, fontWeight: "800", letterSpacing: 0.5 },
  tagline: { fontSize: 15, marginTop: 6 },
  track: { width: TRACK, height: 3, borderRadius: 2, marginTop: 22, overflow: "hidden" },
  thumb: { width: TRACK / 2, height: 3, borderRadius: 2 },
});
