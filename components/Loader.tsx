// Loader.tsx
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, StyleSheet, LayoutRectangle } from 'react-native';
import useThemeManager from '@/hooks/useThemeManager';

interface LoaderProps {
  text?: string;
  duration?: number;
  loop?: boolean;
  instant?: boolean;
  visible?: boolean;
  onComplete?: () => void;
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

  console.log('Loader initialized with props:', { text, duration, loop, instant, visible });

  useEffect(() => {
    console.log('useEffect triggered with visible:', visible);
    if (!visible) {
      animation.setValue(0);
      console.log('Animation reset to 0');
      return;
    }
    
    let anim: Animated.CompositeAnimation | null = null;
    
    if (!instant && loop) {
      console.log('Starting loop animation');
      const runLoop = () => {
        Animated.timing(animation, {
          toValue: 1,
          duration: duration,
          useNativeDriver: false,
        }).start(({ finished }) => {
          if (finished && !instant) {
            animation.setValue(0);
            runLoop();
          }
        });
      };
      runLoop();
    } else if (instant) {
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
    } else {
      console.log('Starting one-time animation');
      anim = Animated.timing(animation, {
        toValue: 1,
        duration,
        useNativeDriver: false,
      });
      anim.start(({ finished }) => {
        console.log('One-time animation finished:', finished);
        if (finished && onComplete) {
          onComplete();
        }
      });
    }
    
    return () => {
      if (anim) {
        console.log('Stopping animation');
        anim.stop();
      }
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
        onLayout={(e) => {
          setContainerLayout(e.nativeEvent.layout);
          console.log('Container layout set:', e.nativeEvent.layout);
        }}
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

export default React.memo(Loader);
