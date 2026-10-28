import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import Field from "@/components/Field";
import { createInviteCode, fetchInviteCodes, revokeInviteCode, type DeviceAuth, type Group, type InviteCode } from "@/lib/api";
import { codeChip, formatCode, shareText } from "@/lib/invite";
import { clockTime } from "@/lib/time";

type Props = {
  auth: DeviceAuth;
  isAdmin: boolean;
  groups: Group[];
};

// The clipboard module is native; a build without it falls back to the share sheet.
async function copyText(text: string): Promise<boolean> {
  try {
    const Clipboard = require("expo-clipboard");
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}

export default function InviteCodesPanel({ auth, isAdmin, groups }: Props) {
  const { colors: c } = useThemeManager();
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<InviteCode | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setCodes(await fetchInviteCodes(auth));
      setError("");
    } catch (e: any) {
      setError(e?.message || "Could not load the codes.");
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const input: { groupId?: number; note?: string } = {};
      if (groupId !== null) input.groupId = groupId;
      if (note.trim()) input.note = note.trim();
      const made = await createInviteCode(auth, input);
      setFresh(made);
      setCopied(false);
      setNote("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not create the code.");
    } finally {
      setCreating(false);
    }
  };

  const copy = async (code: string) => {
    if (await copyText(formatCode(code))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      share(code);
    }
  };

  const share = (code: string) => {
    Share.share({ message: shareText(code) }).catch(() => {});
  };

  const revoke = (code: InviteCode) => {
    Alert.alert("Revoke code", `Revoke ${code.code}? Nobody can use it afterwards.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: async () => {
          try {
            await revokeInviteCode(auth, code.id);
            if (fresh?.id === code.id) setFresh(null);
          } catch (e: any) {
            setError(e?.message || "Could not revoke the code.");
          }
          load();
        },
      },
    ]);
  };

  return (
    <View>
      <Text style={[styles.section, { color: c.muted }]}>Create code</Text>
      {groups.length > 0 && (
        <>
          <Text style={[styles.meta, { color: c.muted }]}>Also add the new person to a group</Text>
          <View style={styles.chips}>
            {[{ id: null as number | null, name: "No group" }, ...groups].map((group) => {
              const active = group.id === groupId;
              return (
                <Pressable
                  key={group.id ?? "none"}
                  style={[styles.chip, { backgroundColor: active ? c.secondary : c.subtle }]}
                  onPress={() => setGroupId(group.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.chipText, { color: active ? c.onSecondary : c.primary }]} numberOfLines={1}>
                    {group.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
      <Field
        label="Note (optional)"
        icon="edit"
        placeholder="Who is it for?"
        value={note}
        onChangeText={setNote}
        autoCapitalize="sentences"
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={create}
      />
      <Pressable
        style={[styles.wide, { backgroundColor: c.secondary, opacity: creating ? 0.7 : 1 }]}
        disabled={creating}
        onPress={create}
        accessibilityRole="button"
      >
        {creating ? <ActivityIndicator color={c.onSecondary} /> : <Text style={[styles.buttonText, { color: c.onSecondary }]}>Create code</Text>}
      </Pressable>
      {error ? <Text style={[styles.error, { color: c.secondary }]}>{error}</Text> : null}

      {fresh && (
        <View style={[styles.fresh, { backgroundColor: c.subtle }]}>
          <Text style={[styles.freshCode, { color: c.primary }]} selectable>
            {fresh.code}
          </Text>
          <Text style={[styles.meta, { color: c.muted, textAlign: "center" }]}>
            {fresh.groupName ? `Joins ${fresh.groupName} · ` : ""}Valid until {clockTime(fresh.expiresAt)}
          </Text>
          <View style={styles.row}>
            <Pressable style={[styles.action, { backgroundColor: c.raised }]} onPress={() => copy(fresh.code)} accessibilityRole="button">
              <MaterialIcons name={copied ? "check" : "content-copy"} size={18} color={c.primary} />
              <Text style={[styles.actionText, { color: c.primary }]}>{copied ? "Copied" : "Copy"}</Text>
            </Pressable>
            <Pressable style={[styles.action, { backgroundColor: c.raised }]} onPress={() => share(fresh.code)} accessibilityRole="button">
              <MaterialIcons name="share" size={18} color={c.primary} />
              <Text style={[styles.actionText, { color: c.primary }]}>Share</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.listHeader}>
        <Text style={[styles.section, { color: c.muted, marginBottom: 0 }]}>{isAdmin ? "All codes" : "My codes"}</Text>
        <Pressable onPress={load} hitSlop={8} accessibilityLabel="Refresh the codes">
          <MaterialIcons name="refresh" size={20} color={c.muted} />
        </Pressable>
      </View>
      {loading ? <ActivityIndicator style={{ marginTop: 12 }} color={c.muted} /> : null}
      {!loading && codes.length === 0 && <Text style={[styles.meta, { color: c.muted }]}>No codes yet.</Text>}
      {codes.map((code) => {
        const chip = codeChip(code, clockTime);
        return (
          <View key={code.id} style={[styles.card, { backgroundColor: c.subtle }]}>
            <View style={styles.row}>
              <Text style={[styles.cardCode, { color: c.primary }]} selectable>
                {code.code}
              </Text>
              {code.status === "open" && (
                <Pressable onPress={() => revoke(code)} hitSlop={8} accessibilityLabel={`Revoke ${code.code}`}>
                  <MaterialIcons name="block" size={21} color={c.secondary} />
                </Pressable>
              )}
            </View>
            <View style={styles.row}>
              <View style={[styles.tag, { backgroundColor: code.status === "open" ? c.secondary : c.raised }]}>
                <Text style={[styles.tagText, { color: code.status === "open" ? c.onSecondary : c.muted }]}>{chip.label}</Text>
              </View>
            </View>
            <Text style={[styles.meta, { color: c.muted }]}>
              {[
                isAdmin ? `By ${code.createdBy.displayName}` : null,
                code.groupName ? `Group ${code.groupName}` : null,
                code.note || null,
              ]
                .filter(Boolean)
                .join(" · ") || " "}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8 },
  meta: { fontSize: 12.5, marginTop: 2, marginBottom: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14, marginTop: 4 },
  chip: { height: 34, maxWidth: 180, paddingHorizontal: 14, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  chipText: { fontSize: 13.5, fontWeight: "600" },
  wide: { height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", marginTop: 4 },
  buttonText: { fontSize: 15, fontWeight: "700" },
  error: { fontSize: 13, marginTop: 8 },
  fresh: { borderRadius: 18, padding: 16, marginTop: 14, alignItems: "stretch" },
  freshCode: { fontSize: 30, fontWeight: "800", letterSpacing: 2, textAlign: "center", marginBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  action: { flex: 1, flexDirection: "row", gap: 8, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: 15, fontWeight: "700" },
  listHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 20, marginBottom: 8 },
  card: { borderRadius: 18, padding: 14, marginBottom: 10 },
  cardCode: { flex: 1, fontSize: 18, fontWeight: "700", letterSpacing: 1 },
  tag: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontSize: 11.5, fontWeight: "700" },
});
