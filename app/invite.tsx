import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import Footer from "@/components/Footer";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import useThemeManager from "@/hooks/useThemeManager";
import { readCredentials } from "@/lib/socket";
import { httpBase } from "@/lib/api";
import { logout } from "@/lib/logout";
import { formatCode, linkServerParams, normalizeCode, serverFromLink } from "@/lib/invite";

// neopin://invite?code=XXXXX-XXXXX&server=https://... lands here (the server's /invite page sends
// it) and goes on to the login screen in invite mode, with the server filled in when it came along.
// Someone who is logged in already cannot sign up on top of that: they get told so instead.
export default function Invite() {
  const { colors } = useThemeManager();
  const router = useRouter();
  const { code, server, secure } = useLocalSearchParams<{ code?: string; server?: string; secure?: string }>();
  const params: Record<string, string> = {};
  if (typeof code === "string" && code) params.code = code;
  const from = serverFromLink(server, secure);
  if (from) Object.assign(params, linkServerParams(from));

  // null while the stored login is looked up, "" when there is none.
  const [loggedInTo, setLoggedInTo] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let live = true;
    readCredentials()
      .then((creds) => live && setLoggedInTo(creds ? httpBase(creds.serverIp).replace(/^https?:\/\//i, "") : ""))
      .catch(() => live && setLoggedInTo(""));
    return () => {
      live = false;
    };
  }, []);

  if (loggedInTo === "") return <Redirect href={{ pathname: "/login", params }} />;

  if (loggedInTo === null) {
    return (
      <View style={[styles.center, { backgroundColor: colors.surface }]}>
        <ActivityIndicator color={colors.secondary} />
      </View>
    );
  }

  const logOutAndUse = async () => {
    setLeaving(true);
    await logout();
    router.replace({ pathname: "/login", params });
  };

  return (
    <ScrollView style={{ backgroundColor: colors.surface }} contentContainerStyle={styles.content}>
      <View style={[styles.badge, { backgroundColor: colors.subtle }]}>
        <MaterialIcons name="person-off" size={44} color={colors.secondary} />
      </View>
      <Text style={[styles.title, { color: colors.primary }]}>You are already logged in</Text>
      <Text style={[styles.lead, { color: colors.muted }]}>
        An invite code creates a new account, so it cannot be used while this phone is logged in.
        {params.code ? ` The code ${formatCode(normalizeCode(params.code))} stays valid.` : ""}
      </Text>

      <View style={styles.form}>
        <View style={[styles.serverRow, { backgroundColor: colors.subtle }]}>
          <MaterialIcons name="dns" size={18} color={colors.muted} />
          <Text style={[styles.serverHost, { color: colors.primary }]} numberOfLines={1}>
            {loggedInTo}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.button, { backgroundColor: colors.secondary, opacity: pressed ? 0.88 : 1 }]}
          onPress={() => router.replace("/")}
          disabled={leaving}
          accessibilityRole="button"
        >
          <MaterialIcons name="map" size={20} color={colors.onSecondary} />
          <Text style={[styles.buttonText, { color: colors.onSecondary }]}>Back to the map</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.button, styles.second, { backgroundColor: colors.subtle, opacity: leaving ? 0.7 : pressed ? 0.88 : 1 }]}
          onPress={logOutAndUse}
          disabled={leaving}
          accessibilityRole="button"
        >
          {leaving ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <>
              <MaterialIcons name="logout" size={19} color={colors.primary} />
              <Text style={[styles.buttonText, { color: colors.primary }]}>Log out and use the code</Text>
            </>
          )}
        </Pressable>
      </View>
      <Footer inline />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { flexGrow: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, paddingTop: 48, paddingBottom: 32 },
  badge: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center", marginBottom: 20 },
  title: { fontSize: 26, fontWeight: "800", letterSpacing: -0.4, textAlign: "center" },
  lead: { fontSize: 15, marginTop: 8, marginBottom: 28, textAlign: "center", maxWidth: 420 },
  form: { width: "100%", maxWidth: 420 },
  serverRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, height: 48, borderRadius: 14, marginBottom: 14 },
  serverHost: { flex: 1, fontSize: 15, fontWeight: "600" },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 54, borderRadius: 14, marginTop: 6 },
  second: { marginTop: 12 },
  buttonText: { fontSize: 17, fontWeight: "700" },
});
