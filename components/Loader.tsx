import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, StyleSheet, LayoutRectangle } from 'react-native';
import useThemeManager from '@/hooks/useThemeManager';

interface LoaderProps {
  text?: string;
  duration?: number;
  loop?: boolean;
  instant?: boolean;
  visible?: boolean;
  onComplete?: () => void; // optionaler Callback, wenn die Animation fertig ist
}

const Loader: React.FC<LoaderProps> = ({
  text = 'Loading',
  duration = 10000,
  loop = false,
  instant = false,
  visible = true,
  onComplete,
}) => {
  const theme = useThemeManager();
  const animation = useRef(new Animated.Value(0)).current;
  const [containerLayout, setContainerLayout] = useState<LayoutRectangle | null>(null);

  useEffect(() => {
    if (!visible) {
      animation.setValue(0);
      return;
    }
    
    let anim: Animated.CompositeAnimation | null = null;
    
    if (instant) {
      anim = Animated.timing(animation, {
        toValue: 1,
        duration: 2500,
        useNativeDriver: false,
      });
      anim.start(({ finished }) => {
        if (finished && onComplete) {
          onComplete();
        }
      });
    } else if (loop) {
      anim = Animated.loop(
        Animated.timing(animation, {
          toValue: 1,
          duration: duration,
          useNativeDriver: false,
        })
      );
      anim.start();
    } else {
      anim = Animated.timing(animation, {
        toValue: 1,
        duration,
        useNativeDriver: false,
      });
      anim.start(({ finished }) => {
        if (finished && onComplete) {
          onComplete();
        }
      });
    }

    return () => {
      if (anim) anim.stop();
    };
  }, [visible, duration, loop, instant, onComplete]);

  if (!visible) return null;

  const widthInterpolation = animation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={styles.container}>
      <View 
        style={styles.textContainer}
        onLayout={(e) => setContainerLayout(e.nativeEvent.layout)}
      >
        <Text style={[styles.text, { color: theme.colors.onSurface, opacity: 0.3 }]}>
          {text}
        </Text>
        <View style={[StyleSheet.absoluteFill, { overflow: 'hidden', width: containerLayout?.width }]}>
          <Animated.View style={{ width: widthInterpolation }}>
            <Text style={[styles.text, styles.filledText, { color: theme.colors.primary }]}>
              {text}
            </Text>
          </Animated.View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    position: 'relative',
  },
  text: {
    fontSize: 40,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    fontFamily: 'System',
  },
  filledText: {},
});

export default Loader;
