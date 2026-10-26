import React, { useEffect, useRef } from "react";
import { Animated, Easing, Image, StyleSheet, View } from "react-native";

const RINGS = 3;
const PERIOD = 2400;

type Props = {
  size?: number;
  // How far a ring spreads, as a multiple of the logo size.
  reach?: number;
};

// The NeoPin logo sending out rings, like a device reporting its position.
export default function PulseLogo({ size = 96, reach = 2.4 }: Props) {
  const rings = useRef(Array.from({ length: RINGS }, () => new Animated.Value(0))).current;

  useEffect(() => {
    const loops = rings.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((PERIOD / RINGS) * index),
          Animated.timing(value, { toValue: 1, duration: PERIOD, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
          Animated.delay((PERIOD / RINGS) * (RINGS - 1 - index)),
        ])
      )
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [rings]);

  const box = size * reach;
  return (
    <View style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }}>
      {rings.map((value, index) => (
        <Animated.View
          key={index}
          style={[
            styles.ring,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              opacity: value.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0, 0.55, 0] }),
              transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, reach] }) }],
            },
          ]}
        />
      ))}
      <Image source={require("@/assets/images/logo.png")} style={{ width: size, height: size }} />
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: "absolute", borderWidth: 2, borderColor: "#d3171e" },
});
