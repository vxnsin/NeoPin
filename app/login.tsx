import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import Field from "@/components/Field";
import { useWebSocketContext } from "@/context/WebSocket";
import { fetchStatus, loginRequest, normalizeServerUrl, registerRequest } from "@/lib/api";
import { saveCredentials } from "@/lib/credentials";
import { passwordError, usernameError } from "@/lib/validation";

type Mode = "login" | "register";
type Errors = { server?: string; username?: string; password?: string; name?: string };

const STATUS_DELAY_MS = 700;

const Login = () => {
  const { colors } = useThemeManager();
  const router = useRouter();
  const { connect } = useWebSocketContext();
  const [mode, setMode] = useState<Mode>("login");
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  // The name is what the server calls this device, its deviceId.
  const [name, setName] = useState(Device.deviceName || Device.modelName || "My phone");
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState("");
  const [connecting, setConnecting] = useState(false);
  const statusRun = useRef(0);

  const creating = mode === "register";

  // Ask the server whether it takes new accounts once the address looks complete.
  const checkStatus = (address: string) => {
    const run = ++statusRun.current;
    const url = address.trim();
    if (!url) {
      setRegistrationOpen(false);
      return;
    }
    fetchStatus(normalizeServerUrl(url))
      .then((status) => run === statusRun.current && setRegistrationOpen(status.registrationOpen))
      .catch(() => run === statusRun.current && setRegistrationOpen(false));
  };

  useEffect(() => {
    const timer = setTimeout(() => checkStatus(server), STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [server]);

  useEffect(() => {
    if (!registrationOpen && mode === "register") setMode("login");
  }, [registrationOpen, mode]);

  const clear = (key: keyof Errors) => setErrors((e) => ({ ...e, [key]: undefined }));

  const switchMode = (next: Mode) => {
    setMode(next);
    setErrors({});
    setFailure("");
  };

  const handleSubmit = async () => {
    if (connecting) return;
    const deviceId = name.trim();
    const url = server.trim();
    const user = username.trim();
    const next: Errors = {
      server: url ? undefined : "Server address is required",
      username: creating ? usernameError(user) : user ? undefined : "Username is required",
      password: passwordError(password, creating),
      name: deviceId ? undefined : "Name is required",
    };
    setErrors(next);
    setFailure("");
    if (next.server || next.username || next.password || next.name) return;

    setConnecting(true);
    const serverUrl = normalizeServerUrl(url);
    try {
      if (creating) {
        await registerRequest(serverUrl, { username: user, password, displayName: displayName.trim() || undefined });
        // A failed login below then retries as a plain login instead of registering twice.
        setMode("login");
      }
      const { token, user: account } = await loginRequest(serverUrl, { username: user, password, deviceId });
      // Connect with the shared socket right away instead of a throwaway test
      // connection: it has the auth timeout and clean error handling already.
      await connect(serverUrl, deviceId, token);
      await saveCredentials({ serverIp: serverUrl, deviceId, token, user: account });
      router.replace("/");
    } catch (error: any) {
      setFailure(error?.message || "Could not connect");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.surface }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Image source={require("@/assets/images/logo.png")} style={styles.logo} />
        <Text style={[styles.title, { color: colors.primary }]}>NeoPin</Text>
        <Text style={[styles.lead, { color: colors.muted }]}>
          {creating ? "Create an account on your NeoPin server." : "Log in to your NeoPin server."}
        </Text>

        <View style={styles.form}>
          <Field
            label="Server address"
            icon="dns"
            placeholder="192.168.1.20:3012"
            value={server}
            onChangeText={(text) => {
              setServer(text);
              clear("server");
            }}
            onBlur={() => checkStatus(server)}
            keyboardType="url"
            error={errors.server}
            returnKeyType="next"
          />
          <Field
            label="Username"
            icon="person-outline"
            placeholder="username"
            value={username}
            onChangeText={(text) => {
              setUsername(text);
              clear("username");
            }}
            textContentType="username"
            error={errors.username}
            returnKeyType="next"
          />
          {creating && (
            <Field
              label="Display name"
              icon="badge"
              placeholder={username.trim() || "How others see you"}
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
              hint="Optional, shown instead of the username."
              returnKeyType="next"
            />
          )}
          <Field
            label="Password"
            icon="lock-outline"
            placeholder={creating ? "At least 8 characters" : "Password"}
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              clear("password");
            }}
            textContentType={creating ? "newPassword" : "password"}
            secret
            error={errors.password}
            returnKeyType="next"
          />
          <Field
            label="Device name"
            icon="smartphone"
            placeholder="My phone"
            value={name}
            onChangeText={(text) => {
              setName(text);
              clear("name");
            }}
            autoCapitalize="words"
            error={errors.name}
            hint="This phone appears on the map under this name."
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
          />

          {failure ? (
            <View style={[styles.failure, { backgroundColor: colors.subtle }]}>
              <MaterialIcons name="error-outline" size={18} color={colors.secondary} />
              <Text style={[styles.failureText, { color: colors.primary }]}>{failure}</Text>
            </View>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: colors.secondary, opacity: connecting ? 0.7 : pressed ? 0.88 : 1 },
            ]}
            onPress={handleSubmit}
            disabled={connecting}
            accessibilityRole="button"
          >
            {connecting ? (
              <ActivityIndicator color={colors.onSecondary} />
            ) : (
              <>
                <Text style={[styles.buttonText, { color: colors.onSecondary }]}>
                  {creating ? "Create account" : "Log in"}
                </Text>
                <MaterialIcons name="arrow-forward" size={20} color={colors.onSecondary} />
              </>
            )}
          </Pressable>

          {(registrationOpen || creating) && (
            <Pressable
              onPress={() => switchMode(creating ? "login" : "register")}
              disabled={connecting}
              style={styles.switch}
              hitSlop={8}
            >
              <Text style={[styles.switchText, { color: colors.muted }]}>
                {creating ? "Already have an account? " : "New here? "}
                <Text style={{ color: colors.secondary, fontWeight: "700" }}>
                  {creating ? "Log in" : "Create account"}
                </Text>
              </Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingTop: 48, paddingBottom: 110 },
  logo: { width: 84, height: 84, marginBottom: 14 },
  title: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  lead: { fontSize: 15, marginTop: 6, marginBottom: 30, textAlign: "center" },
  form: { width: "100%", maxWidth: 420 },
  failure: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, marginBottom: 14 },
  failureText: { flex: 1, fontSize: 13.5 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: 54,
    borderRadius: 14,
    marginTop: 6,
  },
  buttonText: { fontSize: 17, fontWeight: "700" },
  switch: { alignItems: "center", paddingVertical: 18 },
  switchText: { fontSize: 14.5 },
});

export default Login;
