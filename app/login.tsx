import React, { useEffect, useState } from "react";
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
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useWebSocketContext } from "@/context/WebSocket";
import { STORAGE_KEY } from "@/lib/socket";

// "192.168.1.20:3012" is what people type, the socket needs a scheme.
function normalizeUrl(input: string) {
  const url = input.trim();
  return /^wss?:\/\//i.test(url) ? url : `ws://${url}`;
}

type Errors = { server?: string; password?: string; name?: string };

const Login = () => {
  const { colors } = useThemeManager();
  const router = useRouter();
  const { storeValue } = useAsyncStorage(STORAGE_KEY);
  const { connect } = useWebSocketContext();
  const [server, setServer] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [modelName, setModelName] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState("");
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    setModelName(Device.modelName || "My phone");
  }, []);

  const handleConnect = async () => {
    if (connecting) return;
    // The name is what the server calls this device, its deviceId.
    const deviceId = name.trim();
    const url = server.trim();
    const next: Errors = {
      server: url ? undefined : "Server address is required",
      password: password ? undefined : "Password is required",
      name: deviceId ? undefined : "Name is required",
    };
    setErrors(next);
    setFailure("");
    if (next.server || next.password || next.name) return;

    setConnecting(true);
    // Log in with the shared socket right away instead of a throwaway test
    // connection: it has the auth timeout and clean error handling already.
    const serverUrl = normalizeUrl(url);
    try {
      await connect(serverUrl, deviceId, password);
      await storeValue(JSON.stringify({ deviceId, serverIp: serverUrl, password }));
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
        <Text style={[styles.lead, { color: colors.muted }]}>Connect this phone to your NeoPin server.</Text>

        <View style={styles.form}>
          <Field
            label="Server address"
            icon="dns"
            placeholder="192.168.1.20:3012"
            value={server}
            onChangeText={(text) => {
              setServer(text);
              setErrors((e) => ({ ...e, server: undefined }));
            }}
            keyboardType="url"
            error={errors.server}
            returnKeyType="next"
          />
          <Field
            label="Password"
            icon="lock-outline"
            placeholder="Server password"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              setErrors((e) => ({ ...e, password: undefined }));
            }}
            secret
            error={errors.password}
            returnKeyType="next"
          />
          <Field
            label="Name"
            icon="person-outline"
            placeholder={modelName}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setErrors((e) => ({ ...e, name: undefined }));
            }}
            autoCapitalize="words"
            error={errors.name}
            hint="Everyone on the map sees you under this name."
            returnKeyType="go"
            onSubmitEditing={handleConnect}
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
            onPress={handleConnect}
            disabled={connecting}
            accessibilityRole="button"
          >
            {connecting ? (
              <ActivityIndicator color={colors.onSecondary} />
            ) : (
              <>
                <Text style={[styles.buttonText, { color: colors.onSecondary }]}>Connect</Text>
                <MaterialIcons name="arrow-forward" size={20} color={colors.onSecondary} />
              </>
            )}
          </Pressable>
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
});

export default Login;
