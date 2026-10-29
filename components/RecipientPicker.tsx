import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import Avatar from "@/components/Avatar";
import type { Group } from "@/lib/api";
import { toggleId, type Contact, type Recipients } from "@/lib/recipients";

type Props = {
  contacts: Contact[];
  groups: Pick<Group, "id" | "name">[];
  value: Recipients;
  onChange: (next: Recipients) => void;
  avatarFor: (url?: string | null) => string | null;
  disabled?: boolean;
};

// People and groups as chips to tap on and off. Each chip has a height and a background of its own,
// a bare label took no taps on Android.
export default function RecipientPicker({ contacts, groups, value, onChange, avatarFor, disabled }: Props) {
  const { colors: c } = useThemeManager();

  if (contacts.length === 0 && groups.length === 0) {
    return <Text style={[styles.empty, { color: c.muted }]}>Nobody to pick yet. People show up here once you share a group.</Text>;
  }

  return (
    <View>
      {contacts.length > 0 && (
        <>
          <Text style={[styles.label, { color: c.muted }]}>People</Text>
          <View style={styles.chips}>
            {contacts.map((contact) => {
              const active = value.users.includes(contact.id);
              return (
                <Pressable
                  key={contact.id}
                  disabled={disabled}
                  onPress={() => onChange({ ...value, users: toggleId(value.users, contact.id) })}
                  style={[styles.chip, { backgroundColor: active ? c.secondary : c.subtle }]}
                  accessibilityRole="button"
                  accessibilityLabel={contact.displayName}
                  accessibilityState={{ selected: active, disabled }}
                >
                  <Avatar name={contact.displayName} uri={avatarFor(contact.avatarUrl)} state="offline" size={20} gapColor={active ? c.secondary : c.subtle} />
                  <Text style={[styles.chipText, { color: active ? c.onSecondary : c.primary }]} numberOfLines={1}>
                    {contact.displayName}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
      {groups.length > 0 && (
        <>
          <Text style={[styles.label, { color: c.muted }]}>Groups</Text>
          <View style={styles.chips}>
            {groups.map((group) => {
              const active = value.groups.includes(group.id);
              return (
                <Pressable
                  key={group.id}
                  disabled={disabled}
                  onPress={() => onChange({ ...value, groups: toggleId(value.groups, group.id) })}
                  style={[styles.chip, styles.groupChip, { backgroundColor: active ? c.secondary : c.subtle }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Group ${group.name}`}
                  accessibilityState={{ selected: active, disabled }}
                >
                  <MaterialIcons name="group" size={18} color={active ? c.onSecondary : c.muted} />
                  <Text style={[styles.chipText, { color: active ? c.onSecondary : c.primary }]} numberOfLines={1}>
                    {group.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 12.5, fontWeight: "600", marginTop: 10, marginBottom: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 8, height: 38, paddingLeft: 6, paddingRight: 14, borderRadius: 19, maxWidth: 220 },
  groupChip: { paddingLeft: 12 },
  chipText: { fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
  empty: { fontSize: 12.5, marginTop: 4 },
});
