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
import { useLocalSearchParams, useRouter } from "expo-router";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import Field from "@/components/Field";
import { useWebSocketContext } from "@/context/WebSocket";
import { ApiError, checkInviteCode, fetchServerStatus, loginRequest, normalizeServerUrl, registerRequest } from "@/lib/api";
import { currentDeviceType } from "@/lib/deviceType";
import { saveCredentials } from "@/lib/credentials";
import { checkLine, formatCode, hasProblems, isFullCode, normalizeCode, registerProblems, type RegisterErrors } from "@/lib/invite";

type Errors = RegisterErrors & { server?: string; name?: string };
type CodeState = { state: "idle" | "checking" | "valid" | "invalid" | "unknown"; text: string };

const CHECK_DELAY_MS = 500;

const Login = () => {
  const { colors } = useThemeManager();
  const router = useRouter();
  const { connect } = useWebSocketContext();
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // The name is what the server calls this device, its deviceId.
  const [name, setName] = useState(Device.deviceName || Device.modelName || "My phone");
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState("");
  const [connecting, setConnecting] = useState(false);
  const params = useLocalSearchParams<{ code?: string }>();
  const linkCode = typeof params.code === "string" ? normalizeCode(params.code) : "";
  const [register, setRegister] = useState(!!linkCode);
  const [code, setCode] = useState(linkCode ? formatCode(linkCode) : "");
  const [displayName, setDisplayName] = useState("");
  const [confirm, setConfirm] = useState("");
  const [invitesOffered, setInvitesOffered] = useState(false);
  const [codeCheck, setCodeCheck] = useState<CodeState>({ state: "idle", text: "" });

  // A link that arrives while the screen is open fills the code and switches over.
  useEffect(() => {
    if (!linkCode) return;
    setRegister(true);
    setCode(formatCode(linkCode));
  }, [linkCode]);

  // Only servers that hand out invite codes offer the other mode.
  useEffect(() => {
    const url = server.trim();
    setInvitesOffered(false);
    if (!url) return;
    let active = true;
    const timer = setTimeout(() => {
      fetchServerStatus(normalizeServerUrl(url))
        .then((status) => active && setInvitesOffered(status.invites === true))
        .catch(() => {});
    }, CHECK_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [server]);

  // A full code is looked up while the person keeps typing the rest.
  useEffect(() => {
    if (!register || !isFullCode(code) || !server.trim()) {
      setCodeCheck({ state: "idle", text: "" });
      return;
    }
    let active = true;
    setCodeCheck({ state: "checking", text: "Checking the code" });
    const timer = setTimeout(() => {
      checkInviteCode(normalizeServerUrl(server.trim()), normalizeCode(code))
        .then((result) => active && setCodeCheck({ state: result.valid ? "valid" : "invalid", text: checkLine(result) }))
        .catch((error: any) => active && setCodeCheck({ state: "unknown", text: error?.message || "Could not check the code" }));
    }, CHECK_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [register, code, server]);

  const clear = (key: keyof Errors) => setErrors((e) => ({ ...e, [key]: undefined }));

  const handleSubmit = async () => {
    if (connecting) return;
    const deviceId = name.trim();
    const url = server.trim();
    const user = username.trim();
    const next: Errors = register
      ? {
          ...registerProblems({ code, username, displayName, password, confirm }),
          server: url ? undefined : "Server address is required",
          name: deviceId ? undefined : "Name is required",
        }
      : {
          server: url ? undefined : "Server address is required",
          username: user ? undefined : "Username is required",
          password: password ? undefined : "Password is required",
          name: deviceId ? undefined : "Name is required",
        };
    setErrors(next);
    setFailure("");
    if (hasProblems(next)) return;

    setConnecting(true);
    const serverUrl = normalizeServerUrl(url);
    try {
      if (register) {
        await registerRequest(serverUrl, {
          code: normalizeCode(code),
          username: user,
          password,
          ...(displayName.trim() && { displayName: displayName.trim() }),
        });
      }
      const { token, user: account } = await loginRequest(serverUrl, { username: user, password, deviceId, deviceType: currentDeviceType() });
      // Connect with the shared socket right away instead of a throwaway test
      // connection: it has the auth timeout and clean error handling already.
      await connect(serverUrl, deviceId, token);
      await saveCredentials({ serverIp: serverUrl, deviceId, token, user: account });
      router.replace("/");
    } catch (error: any) {
      const message = error?.message || "Could not connect";
      if (register && error instanceof ApiError && error.status === 404) setErrors({ code: message });
      else if (register && error instanceof ApiError && error.status === 409) setErrors({ username: message });
      else setFailure(message);
    } finally {
      setConnecting(false);
    }
  };

  const switchMode = (toRegister: boolean) => {
    setRegister(toRegister);
    setErrors({});
    setFailure("");
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
          {register ? "Create your account with an invite code." : "Log in to your NeoPin server."}
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
            keyboardType="url"
            error={errors.server}
            returnKeyType="next"
          />
          {register && (
            <>
              <Field
                label="Invite code"
                icon="vpn-key"
                placeholder="XXXXX-XXXXX"
                value={code}
                onChangeText={(text) => {
                  setCode(formatCode(text));
                  clear("code");
                }}
                autoCapitalize="characters"
                maxLength={24}
                error={errors.code}
                returnKeyType="next"
              />
              {!errors.code && codeCheck.state !== "idle" ? (
                <Text style={[styles.codeLine, { color: codeCheck.state === "valid" ? colors.primary : colors.muted }]}>
                  {codeCheck.text}
                </Text>
              ) : null}
            </>
          )}
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
          {register && (
            <Field
              label="Display name (optional)"
              icon="badge"
              placeholder="How others see you"
              value={displayName}
              onChangeText={(text) => {
                setDisplayName(text);
                clear("displayName");
              }}
              autoCapitalize="words"
              error={errors.displayName}
              returnKeyType="next"
            />
          )}
          <Field
            label="Password"
            icon="lock-outline"
            placeholder="Password"
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              clear("password");
            }}
            textContentType={register ? "newPassword" : "password"}
            secret
            error={errors.password}
            returnKeyType="next"
          />
          {register && (
            <Field
              label="Repeat password"
              icon="lock-outline"
              placeholder="Repeat password"
              value={confirm}
              onChangeText={(text) => {
                setConfirm(text);
                clear("confirm");
              }}
              textContentType="newPassword"
              secret
              error={errors.confirm}
              returnKeyType="next"
            />
          )}
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
                <Text style={[styles.buttonText, { color: colors.onSecondary }]}>{register ? "Create account" : "Log in"}</Text>
                <MaterialIcons name="arrow-forward" size={20} color={colors.onSecondary} />
              </>
            )}
          </Pressable>

          {(invitesOffered || register) && (
            <Pressable style={styles.switch} onPress={() => switchMode(!register)} accessibilityRole="button">
              <Text style={[styles.switchText, { color: colors.secondary }]}>
                {register ? "I already have an account" : "Create account with an invite code"}
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
  codeLine: { fontSize: 13, marginTop: -6, marginBottom: 14, marginLeft: 4 },
  switch: { alignItems: "center", paddingVertical: 16 },
  switchText: { fontSize: 15, fontWeight: "600" },
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
