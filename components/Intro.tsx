import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import PulseLogo from "@/components/PulseLogo";

type Props = { onDone: () => void };

// Shown once, on the very first start: the logo lands, sends out its rings,
// the name rises in, then everything fades into the app.
export default function Intro({ onDone }: Props) {
  const logo = useRef(new Animated.Value(0)).current;
  const title = useRef(new Animated.Value(0)).current;
  const tagline = useRef(new Animated.Value(0)).current;
  const whole = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const show = Animated.sequence([
      Animated.spring(logo, { toValue: 1, friction: 5, tension: 60, useNativeDriver: true }),
      Animated.timing(title, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(tagline, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(1100),
      Animated.timing(whole, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]);
    show.start(({ finished }) => finished && onDone());
    return () => show.stop();
  }, [logo, title, tagline, whole, onDone]);

  const rise = (value: Animated.Value) => ({
    opacity: value,
    transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  });

  return (
    <Animated.View style={[styles.container, { opacity: whole }]}>
      <Animated.View
        style={{
          opacity: logo,
          transform: [{ scale: logo.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
        }}
      >
        <PulseLogo size={104} reach={2.6} />
      </Animated.View>
      <View style={styles.text}>
        <Animated.Text style={[styles.title, rise(title)]}>NeoPin</Animated.Text>
        <Animated.Text style={[styles.tagline, rise(tagline)]}>Your devices. Your server.</Animated.Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "#07090d", zIndex: 100 },
  text: { alignItems: "center", marginTop: -36 },
  title: { color: "#ffffff", fontSize: 34, fontWeight: "800", letterSpacing: -0.5 },
  tagline: { color: "#98a2b3", fontSize: 15, marginTop: 6 },
});
