import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import Avatar from "@/components/Avatar";
import type { AppNotification } from "@/lib/api";
import { notificationDetail, notificationTitle } from "@/lib/notifications";
import { clockTime } from "@/lib/time";

type Props = {
  items: AppNotification[];
  // Ids that were unread when the sheet opened, they keep their highlight while it is open.
  fresh: number[];
  avatarFor: (url?: string | null) => string | null;
  onMarkAll: () => void;
};

export default function NotificationsPanel({ items, fresh, avatarFor, onMarkAll }: Props) {
  const { colors: c } = useThemeManager();

  return (
    <View>
      {fresh.length > 0 && (
        <Pressable style={[styles.markAll, { backgroundColor: c.subtle }]} onPress={onMarkAll} accessibilityRole="button">
          <MaterialIcons name="done-all" size={18} color={c.primary} />
          <Text style={[styles.markText, { color: c.primary }]}>Mark all read</Text>
        </Pressable>
      )}
      {items.length === 0 && <Text style={[styles.meta, { color: c.muted }]}>Nothing new.</Text>}
      {items.map((item) => (
        <View key={item.id} style={[styles.card, { backgroundColor: c.subtle }]}>
          <Avatar name={item.data.user.displayName} uri={avatarFor(item.data.user.avatarUrl)} state="offline" size={40} gapColor={c.subtle} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: c.primary }]}>{notificationTitle(item)}</Text>
            <Text style={[styles.meta, { color: c.muted }]}>{notificationDetail(item, clockTime)}</Text>
          </View>
          {fresh.includes(item.id) && <View style={[styles.unread, { backgroundColor: c.secondary }]} />}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  markAll: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 44, borderRadius: 12, marginTop: 14 },
  markText: { fontSize: 14.5, fontWeight: "700" },
  card: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 18, padding: 14, marginTop: 10 },
  title: { fontSize: 14.5, fontWeight: "600" },
  meta: { fontSize: 12.5, marginTop: 2 },
  unread: { width: 10, height: 10, borderRadius: 5 },
});
