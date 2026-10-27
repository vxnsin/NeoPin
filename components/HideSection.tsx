import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import { setHidden, showMe, type DeviceAuth, type User } from "@/lib/api";
import { HIDE_CHOICES, hiddenLabel } from "@/lib/hidden";

type Props = {
  auth: DeviceAuth;
  // undefined: the server is older and cannot hide anyone, the section stays away.
  hiddenUntil: number | null | undefined;
  onChange: (user: User) => void;
};

// In the settings: gone from everyone else's map for a while. The own map and timeline go on.
export default function HideSection({ auth, hiddenUntil, onChange }: Props) {
  const { colors: c } = useThemeManager();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [, setTick] = useState(0);

  // The label and the end of a short hiding move with the clock.
  const active = hiddenUntil != null && hiddenUntil > Date.now();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, [active]);

  if (hiddenUntil === undefined) return null;

  const run = async (key: string, action: () => Promise<User>) => {
    setBusy(key);
    setError("");
    try {
      onChange(await action());
    } catch (e: any) {
      setError(e?.message || "That did not work, try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View>
      <Text style={[styles.title, { color: c.muted }]}>Invisible</Text>
      {active ? (
        <View style={[styles.active, { backgroundColor: c.subtle }]}>
          <MaterialIcons name="visibility-off" size={20} color={c.secondary} />
          <Text style={[styles.activeText, { color: c.primary }]}>{hiddenLabel(hiddenUntil)}</Text>
          <Pressable
            style={[styles.showButton, { backgroundColor: c.secondary }]}
            disabled={busy !== null}
            onPress={() => run("show", () => showMe(auth))}
            accessibilityLabel="Show me again"
          >
            {busy === "show" ? (
              <ActivityIndicator size="small" color={c.onSecondary} />
            ) : (
              <Text style={[styles.showText, { color: c.onSecondary }]}>Show me</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.choices}>
          {HIDE_CHOICES.map((choice) => (
            <Pressable
              key={choice.key}
              style={[styles.chip, { backgroundColor: c.subtle }]}
              disabled={busy !== null}
              onPress={() => run(choice.key, () => setHidden(auth, choice.minutes(new Date())))}
              accessibilityLabel={`Hide me: ${choice.label}`}
            >
              {busy === choice.key ? (
                <ActivityIndicator size="small" color={c.secondary} />
              ) : (
                <Text style={[styles.chipText, { color: c.primary }]}>{choice.label}</Text>
              )}
            </Pressable>
          ))}
        </View>
      )}
      <Text style={[styles.hint, { color: c.muted }]}>
        {active
          ? "Nobody else sees you on the map, not even the admin. Your own map and timeline go on."
          : "Gone from everyone else's map for a while. It turns itself off again, also when the app is closed."}
      </Text>
      {!!error && <Text style={[styles.hint, { color: c.secondary }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { minWidth: "30%", flexGrow: 1, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 10, alignItems: "center" },
  chipText: { fontSize: 13, fontWeight: "600" },
  active: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 14 },
  activeText: { flex: 1, fontSize: 14, fontWeight: "600" },
  showButton: { borderRadius: 10, paddingHorizontal: 14, height: 34, minWidth: 80, alignItems: "center", justifyContent: "center" },
  showText: { fontSize: 13, fontWeight: "700" },
  hint: { fontSize: 12, marginTop: 8 },
});
