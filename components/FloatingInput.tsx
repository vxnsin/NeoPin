import React, { useState, useRef } from 'react';
import { KeyboardType } from 'react-native';
import { View, TextInput, StyleSheet, Animated } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';

interface FloatingInputProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  secure: boolean;
  icon: string;
  animatedValue: Animated.Value;
  colors: any;
  customPlaceholder?: string;
  keyboardType?: KeyboardType;
  error?: boolean;
  errorMessage?: string;
}

const animateLabel = (animatedValue: Animated.Value, toValue: number) => {
  Animated.timing(animatedValue, {
    toValue,
    duration: 150,
    useNativeDriver: false,
  }).start();
};

const FloatingInput: React.FC<FloatingInputProps> = ({
  label,
  value,
  onChangeText,
  secure,
  icon,
  animatedValue,
  colors,
  customPlaceholder,
  keyboardType,
  error,
  errorMessage,
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const placeholderTimeout = useRef<NodeJS.Timeout | null>(null);

  const handleFocus = () => {
    setIsFocused(true);
    animateLabel(animatedValue, 1);
    placeholderTimeout.current = setTimeout(() => {
      setShowPlaceholder(true);
    }, 10);
  };

  const handleBlur = () => {
    setIsFocused(false);
    if (!value) {
      animateLabel(animatedValue, 0);
    }
    if (placeholderTimeout.current) {
      clearTimeout(placeholderTimeout.current);
      placeholderTimeout.current = null;
    }
    setShowPlaceholder(false);
  };

  // Use red if error is true; otherwise, use the primary color.
  const effectiveColor = error ? 'red' : colors.colors.primary;

  return (
    <View style={styles.inputContainer}>
      <Icon
        name={icon}
        size={24}
        color={colors.colors.primary}
        style={styles.icon}
      />
      <View style={[styles.inputWrapper, { borderColor: effectiveColor }]}>
        <Animated.Text
          style={[
            styles.label,
            {
              transform: [
                {
                  translateY: animatedValue.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -30],
                  }),
                },
                {
                  scale: animatedValue.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 1.1],
                  }),
                },
              ],
              backgroundColor: colors.colors.surface,
              color: effectiveColor,
              left: animatedValue.interpolate({
                inputRange: [0, 1],
                outputRange: [20, 15],
              }),
            },
          ]}
        >
          {label}
        </Animated.Text>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.colors.primary,
              paddingVertical: 0,
            },
          ]}
          value={value}
          onChangeText={onChangeText}
          onFocus={handleFocus}
          onBlur={handleBlur}
          secureTextEntry={secure}
          placeholder={
            showPlaceholder && !value ? (customPlaceholder || label) : ''
          }
          placeholderTextColor={colors.colors.onSurface}
          selectionColor={colors.colors.primary}
          keyboardType={keyboardType || 'default'}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 25,
  },
  icon: {
    marginRight: 15,
  },
  inputWrapper: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 25,
    height: 60,
    justifyContent: 'center',
    position: 'relative',
  },
  label: {
    position: 'absolute',
    paddingHorizontal: 4,
    fontSize: 15,
    fontWeight: '400',
  },
  input: {
    paddingHorizontal: 20,
    fontSize: 18,
    height: 50,
    textAlignVertical: 'center',
  },
});

export default FloatingInput;
