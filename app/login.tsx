import React, { useState, useRef, useEffect } from "react";
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  Animated,
} from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import { MaterialIcons as Icon } from "@expo/vector-icons";
import FloatingInput from "@/components/FloatingInput";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useWebSocketContext } from "@/context/WebSocket";
import { STORAGE_KEY } from "@/lib/socket";

// "192.168.1.20:3012" is what people type, the socket needs a scheme.
function normalizeUrl(input: string) {
  const url = input.trim();
  return /^wss?:\/\//i.test(url) ? url : `ws://${url}`;
}

const Login = () => {
  const colors = useThemeManager();
  const [username, setUsername] = useState("");
  const [serverIp, setServerIp] = useState("");
  const [serverPassword, setServerPassword] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("");
  const [errors, setErrors] = useState({
    username: false,
    serverIp: false,
    serverPassword: false,
  });
  const animations = {
    username: useRef(new Animated.Value(0)).current,
    serverIp: useRef(new Animated.Value(0)).current,
    serverPassword: useRef(new Animated.Value(0)).current,
  };
  const router = useRouter();
  const { storeValue } = useAsyncStorage(STORAGE_KEY);
  const { connect } = useWebSocketContext();
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    setDeviceName(Device.modelName || "Unknown Device");
  }, []);

  const handleUsernameChange = (text: string) => {
    setUsername(text);
    if (errors.username && text.trim() !== "") {
      setErrors((prev) => ({ ...prev, username: false }));
    }
  };

  const handleServerIpChange = (text: string) => {
    setServerIp(text);
    if (errors.serverIp && text.trim() !== "") {
      setErrors((prev) => ({ ...prev, serverIp: false }));
    }
  };

  const handleServerPasswordChange = (text: string) => {
    setServerPassword(text);
    if (errors.serverPassword && text.trim() !== "") {
      setErrors((prev) => ({ ...prev, serverPassword: false }));
    }
  };

  const handleConnect = async () => {
    setErrors({ username: false, serverIp: false, serverPassword: false });
    const deviceId = username.trim();
    const url = serverIp.trim();
    const newErrors = {
      username: !deviceId,
      serverIp: !url,
      serverPassword: !serverPassword,
    };
    if (newErrors.username || newErrors.serverIp || newErrors.serverPassword) {
      setErrors(newErrors);
      setConnectionStatus("Please fill in all fields");
      return;
    }
    if (connecting) return;
    setConnecting(true);
    setConnectionStatus("Connecting...");
    // Log in with the shared socket right away instead of a throwaway test
    // connection: it has the auth timeout and clean error handling already.
    const serverUrl = normalizeUrl(url);
    try {
      await connect(serverUrl, deviceId, serverPassword);
      await storeValue(JSON.stringify({ deviceId, serverIp: serverUrl, password: serverPassword }));
      router.replace("/");
    } catch (error: any) {
      setConnectionStatus("Connection failed: " + error.message);
    } finally {
      setConnecting(false);
    }
  };
  return (
    <View
      style={[styles.container, { backgroundColor: colors.colors.surface }]}
    >
      <Icon
        name="wifi-tethering"
        size={100}
        color={colors.colors.primary}
        style={styles.iconTop}
      />
      <FloatingInput
        label="Hostname"
        customPlaceholder="ws://127.0.0.1:3012"
        value={serverIp}
        onChangeText={handleServerIpChange}
        secure={false}
        animatedValue={animations.serverIp}
        icon="list"
        colors={colors}
        error={errors.serverIp}
        errorMessage="Hostname is required"
      />
      <FloatingInput
        label="Password"
        value={serverPassword}
        onChangeText={handleServerPasswordChange}
        secure={true}
        animatedValue={animations.serverPassword}
        icon="lock"
        colors={colors}
        error={errors.serverPassword}
        errorMessage="Password is required"
      />
      <FloatingInput
        label="Username"
        customPlaceholder={deviceName}
        value={username}
        onChangeText={handleUsernameChange}
        secure={false}
        animatedValue={animations.username}
        icon="person"
        colors={colors}
        error={errors.username}
        errorMessage="Username is required"
      />
      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.colors.secondary }]}
        onPress={handleConnect}
        disabled={connecting}
      >
        <Text style={[styles.buttonText, { color: colors.colors.onSecondary }]}>
          {connecting ? "Connecting..." : "Connect to Server"}
        </Text>
      </TouchableOpacity>
      {connectionStatus && !connecting ? (
        <Text style={[styles.status, { color: colors.colors.primary }]}>{connectionStatus}</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  iconTop: { position: "absolute", top: 100 },
  button: {
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 28,
    marginTop: 30,
  },
  buttonText: { fontSize: 18, fontWeight: "bold" },
  status: { fontSize: 14, marginTop: 16, textAlign: "center" },
});

export default Login;
