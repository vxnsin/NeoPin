import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import { MaterialIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useWebSocketContext } from "@/context/WebSocket";
import { readCredentials, socket } from "@/lib/socket";
import { httpBase } from "@/lib/api";
import { logout } from "@/lib/logout";

type IconName = React.ComponentProps<typeof MaterialIcons>["name"];

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

// "wss://neopin.example.org" -> "neopin.example.org", the server the phone tried to reach.
const hostOf = (serverIp: string) => httpBase(serverIp).replace(/^https?:\/\//i, "");

// Where the start ends up when the server does not answer: what went wrong, which server it
// was, and the two ways on. Same look as the login.
export default function ErrorScreen() {
  const { colors } = useThemeManager();
  const router = useRouter();
  const params = useLocalSearchParams<{ error?: string; description?: string; icon?: string }>();
  const { connect } = useWebSocketContext();

  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState("");
  const [server, setServer] = useState("");

  const icon = (first(params.icon) || "wifi-off") as IconName;
  const title = first(params.error) || "Connection failed";
  const description = first(params.description) || "Unable to reach the server.";

  useEffect(() => {
    readCredentials()
      .then((creds) => creds && setServer(hostOf(creds.serverIp)))
      .catch(() => {});
  }, []);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setFailure("");
    try {
      const creds = await readCredentials();
      if (!creds) {
        setFailure("You are logged out.");
        setRetrying(false);
        return;
      }
      await connect(creds.serverIp, creds.deviceId, creds.token);
      router.replace("/map");
    } catch (error: any) {
      // A refused token already sent the user back to the login.
      if (socket.rejected) return;
      setFailure(error?.message || "Still no answer from the server.");
      setRetrying(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.surface }} contentContainerStyle={styles.content}>
      <View style={[styles.badge, { backgroundColor: colors.subtle }]}>
        <MaterialIcons name={icon} size={44} color={colors.secondary} />
      </View>
      <Text style={[styles.title, { color: colors.primary }]}>{title}</Text>
      <Text style={[styles.lead, { color: colors.muted }]}>{description}</Text>

      <View style={styles.form}>
        {server ? (
          <View style={[styles.serverRow, { backgroundColor: colors.subtle }]}>
            <MaterialIcons name="dns" size={18} color={colors.muted} />
            <Text style={[styles.serverHost, { color: colors.primary }]} numberOfLines={1}>
              {server}
            </Text>
          </View>
        ) : null}

        {failure ? (
          <View style={[styles.failure, { backgroundColor: colors.subtle }]}>
            <MaterialIcons name="error-outline" size={18} color={colors.secondary} />
            <Text style={[styles.failureText, { color: colors.primary }]}>{failure}</Text>
          </View>
        ) : null}

        <Pressable
          style={({ pressed }) => [styles.button, { backgroundColor: colors.secondary, opacity: retrying ? 0.7 : pressed ? 0.88 : 1 }]}
          onPress={handleRetry}
          disabled={retrying}
          accessibilityRole="button"
        >
          {retrying ? (
            <ActivityIndicator color={colors.onSecondary} />
          ) : (
            <>
              <MaterialIcons name="refresh" size={20} color={colors.onSecondary} />
              <Text style={[styles.buttonText, { color: colors.onSecondary }]}>Try again</Text>
            </>
          )}
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.button, styles.second, { backgroundColor: colors.subtle, opacity: pressed ? 0.88 : 1 }]}
          onPress={handleLogout}
          disabled={retrying}
          accessibilityRole="button"
        >
          <MaterialIcons name="logout" size={19} color={colors.primary} />
          <Text style={[styles.buttonText, { color: colors.primary }]}>Log out</Text>
        </Pressable>
        <Text style={[styles.hint, { color: colors.muted }]}>
          Check that the phone is online and the server is running. Logging out lets you pick another server.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingTop: 48, paddingBottom: 110 },
  badge: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center", marginBottom: 20 },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.4, textAlign: "center" },
  lead: { fontSize: 15, marginTop: 8, marginBottom: 28, textAlign: "center", maxWidth: 420 },
  form: { width: "100%", maxWidth: 420 },
  serverRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, height: 48, borderRadius: 14, marginBottom: 14 },
  serverHost: { flex: 1, fontSize: 15, fontWeight: "600" },
  failure: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 12, marginBottom: 14 },
  failureText: { flex: 1, fontSize: 13.5 },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 54, borderRadius: 14, marginTop: 6 },
  second: { marginTop: 12 },
  buttonText: { fontSize: 17, fontWeight: "700" },
  hint: { fontSize: 13, textAlign: "center", marginTop: 18, lineHeight: 18 },
});
