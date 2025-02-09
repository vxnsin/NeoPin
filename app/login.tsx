// Login.tsx
import React, { useState, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, Animated } from 'react-native';
import useThemeManager from '../hooks/useThemeManager';
import Icon from 'react-native-vector-icons/MaterialIcons';
import FloatingInput from '../components/FloatingInput'; 

const Login = () => {
  const colors = useThemeManager();
  const [username, setUsername] = useState('');
  const [serverIp, setServerIp] = useState('');
  const [serverPassword, setServerPassword] = useState('');

  const animations = {
    username: useRef(new Animated.Value(0)).current,
    serverIp: useRef(new Animated.Value(0)).current,
    serverPassword: useRef(new Animated.Value(0)).current,
  };

  const handleConnect = () => {
    console.log("Connecting to the server...");
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
      <Icon
        name="wifi-tethering"
        size={100}
        color={colors.colors.primary}
        style={styles.iconTop}
      />

      <FloatingInput
        label="Hostname"
        customPlaceholder='127.0.0.0'
        value={serverIp}
        onChangeText={setServerIp}
        secure={false}
        animatedValue={animations.serverIp}
        icon="list"
        colors={colors}
      />

      <FloatingInput
        label="Password"
        value={serverPassword}
        onChangeText={setServerPassword}
        secure={true}
        animatedValue={animations.serverPassword}
        icon="lock"
        colors={colors}
      />

      <FloatingInput
        label="Username"
        value={username}
        onChangeText={setUsername}
        secure={false}
        animatedValue={animations.username}
        icon="person"
        colors={colors}
      />

      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.colors.secondary }]}
        onPress={handleConnect}
      >
        <Text style={[styles.buttonText, { color: colors.colors.onSecondary }]}>
          Connect to Server
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  iconTop: {
    position: 'absolute',
    top: 100,
  },
  button: {
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 28,
    marginTop: 30,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: 'bold',
  },
});

export default Login;
