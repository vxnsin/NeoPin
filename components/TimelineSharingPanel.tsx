import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import RecipientPicker from "@/components/RecipientPicker";
import { getTimelineSharing, setTimelineSharing, type DeviceAuth, type Group, type TimelineSharing } from "@/lib/api";
import { contactsFrom, pruneRecipients, type Recipients } from "@/lib/recipients";
import { SHARING_CHOICES } from "@/lib/timelinePeople";

type Props = {
  auth: DeviceAuth;
  userId: number;
  groups: Group[];
  avatarFor: (url?: string | null) => string | null;
};

// "Share my timeline": off, everyone in my groups, or the people and groups picked here. Every change
// is saved right away; a failed save puts back what the server has.
export default function TimelineSharingPanel({ auth, userId, groups, avatarFor }: Props) {
  const { colors: c } = useThemeManager();
  const [sharing, setSharing] = useState<TimelineSharing | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [reloads, setReloads] = useState(0);
  const saved = useRef<TimelineSharing | null>(null);
  // Saves go out one after the other, so the last change is the one the server keeps.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);

  const contacts = useMemo(() => contactsFrom(groups, userId), [groups, userId]);

  useEffect(() => {
    let live = true;
    setLoadError("");
    getTimelineSharing(auth)
      .then((current) => {
        if (!live) return;
        const value = current ?? { mode: "off" as const, users: [], groups: [] };
        saved.current = value;
        setSharing(value);
      })
      .catch((e: any) => live && setLoadError(e?.message || "The setting could not be loaded."));
    return () => {
      live = false;
    };
    // A fresh copy of the same login (a new picture, say) must not reload the sheet under the finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.serverIp, auth.deviceId, auth.token, reloads]);

  const save = (next: TimelineSharing) => {
    const picks = pruneRecipients({ users: next.users, groups: next.groups }, contacts, groups);
    const clean = { ...next, ...picks };
    const mine = ++latest.current;
    setSharing(clean);
    setSaveError("");
    queue.current = queue.current
      .then(() => setTimelineSharing(auth, clean))
      .then(() => {
        saved.current = clean;
      })
      .catch((e: any) => {
        if (mine !== latest.current) return;
        setSaveError(e?.message || "Could not save, try again.");
        setSharing(saved.current);
      });
  };

  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={[styles.hint, { color: c.secondary }]}>{loadError}</Text>
        <Pressable style={[styles.retry, { backgroundColor: c.subtle }]} onPress={() => setReloads((n) => n + 1)} accessibilityRole="button">
          <Text style={[styles.retryText, { color: c.primary }]}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!sharing) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.secondary} />
      </View>
    );
  }

  const current = SHARING_CHOICES.find((choice) => choice.mode === sharing.mode) ?? SHARING_CHOICES[0];

  return (
    <View>
      <View style={styles.choices}>
        {SHARING_CHOICES.map((choice) => {
          const active = choice.mode === sharing.mode;
          return (
            <Pressable
              key={choice.mode}
              style={[styles.choice, { backgroundColor: c.subtle }]}
              // Switching keeps the picks, so going back to "Selected" does not lose them.
              onPress={() => !active && save({ ...sharing, mode: choice.mode })}
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
            >
              <MaterialIcons name={active ? "radio-button-checked" : "radio-button-unchecked"} size={22} color={active ? c.secondary : c.muted} />
              <Text style={[styles.choiceText, { color: c.primary }]}>{choice.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.hint, { color: c.muted, marginTop: 8 }]}>{current.hint} The admin can always see it.</Text>

      {sharing.mode === "selected" && (
        <>
          <Text style={[styles.section, { color: c.muted }]}>Who can see it</Text>
          <RecipientPicker
            contacts={contacts}
            groups={groups}
            value={{ users: sharing.users, groups: sharing.groups }}
            onChange={(picks: Recipients) => save({ ...sharing, ...picks })}
            avatarFor={avatarFor}
          />
        </>
      )}

      {!!saveError && <Text style={[styles.hint, { color: c.secondary, marginTop: 10 }]}>{saveError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 28 },
  choices: { gap: 8, marginTop: 14 },
  choice: { flexDirection: "row", alignItems: "center", gap: 12, height: 52, paddingHorizontal: 16, borderRadius: 14 },
  choiceText: { flex: 1, fontSize: 15, fontWeight: "600" },
  section: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 2 },
  hint: { fontSize: 12.5 },
  retry: { height: 38, paddingHorizontal: 18, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  retryText: { fontSize: 14, fontWeight: "600" },
});
