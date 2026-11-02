import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import type { StoredCredentials } from "@/lib/credentials";
import { clearDiagnostics, diagnosticsEvents } from "@/lib/diagnostics";
import { exportDiagnostics } from "@/lib/diagnosticsExport";
import { isDeveloperBuild } from "@/lib/updates";

// In the settings of preview and development builds only: the diagnostics log as a link to
// paste into a chat (see lib/diagnosticsExport), and a way to start the log over.
export default function DeveloperSection({ auth }: { auth: StoredCredentials }) {
  const { colors: c } = useThemeManager();
  const [busy, setBusy] = useState<"export" | "clear" | null>(null);
  const [note, setNote] = useState("");
  const [count, setCount] = useState<number | null>(null);

  const refresh = () => diagnosticsEvents().then((events) => setCount(events.length), () => {});
  useEffect(() => {
    refresh();
  }, []);

  if (!isDeveloperBuild()) return null;

  const run = async (key: "export" | "clear", action: () => Promise<string>) => {
    setBusy(key);
    setNote("");
    try {
      setNote(await action());
    } catch (e: any) {
      setNote(e?.message || "That did not work, try again.");
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const row = (key: "export" | "clear", icon: keyof typeof MaterialIcons.glyphMap, label: string, action: () => Promise<string>) => (
    <Pressable
      style={[styles.row, { backgroundColor: c.subtle }]}
      disabled={busy !== null}
      onPress={() => run(key, action)}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <MaterialIcons name={icon} size={20} color={key === "clear" ? c.secondary : c.primary} />
      <Text style={[styles.rowText, { color: key === "clear" ? c.secondary : c.primary }]}>{label}</Text>
      {busy === key && <ActivityIndicator size="small" color={c.secondary} />}
    </Pressable>
  );

  return (
    <View>
      <Text style={[styles.title, { color: c.muted }]}>Developer</Text>
      {row("export", "bug-report", "Export diagnostics", async () => {
        await exportDiagnostics(auth);
        return "Uploaded. The link works for 7 days.";
      })}
      {row("clear", "delete-outline", "Clear log", async () => {
        await clearDiagnostics();
        return "The log is empty.";
      })}
      <Text style={[styles.hint, { color: c.muted }]}>
        {note ||
          `${count ?? "…"} events. Fixes, connections, battery and errors go to your server as a zip, without exact positions or tokens.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, height: 52, paddingHorizontal: 16, borderRadius: 14, marginBottom: 8 },
  rowText: { flex: 1, fontSize: 15, fontWeight: "600" },
  hint: { fontSize: 12 },
});
