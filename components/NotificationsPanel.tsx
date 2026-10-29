import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import Avatar from "@/components/Avatar";
import type { AppNotification } from "@/lib/api";
import { isPlaceNotification, isReviewNotification, notificationDetail, notificationPerson, notificationTitle } from "@/lib/notifications";
import { reviewTarget, type ReviewTarget } from "@/lib/review";
import { clockTime } from "@/lib/time";

type Props = {
  items: AppNotification[];
  // Ids that were unread when the sheet opened, they keep their highlight while it is open.
  fresh: number[];
  avatarFor: (url?: string | null) => string | null;
  // The picture of an account the app already knows, for notifications that only name the person.
  avatarOfUser: (userId: number) => string | null | undefined;
  // An arrival or a departure opens the map at that person.
  onOpenPerson: (userId: number) => void;
  // A review opens its week or month.
  onOpenReview: (target: ReviewTarget) => void;
  onMarkAll: () => void;
};

export default function NotificationsPanel({ items, fresh, avatarFor, avatarOfUser, onOpenPerson, onOpenReview, onMarkAll }: Props) {
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
      {items.map((item) => {
        const person = notificationPerson(item);
        const title = notificationTitle(item, clockTime);
        const detail = notificationDetail(item, clockTime);
        const content = (
          <>
            {person ? (
              <Avatar name={person.name} uri={avatarFor(person.avatarUrl ?? avatarOfUser(person.userId))} state="offline" size={40} gapColor={c.subtle} />
            ) : (
              <View style={[styles.icon, { backgroundColor: c.raised }]}>
                <MaterialIcons name="insights" size={20} color={c.secondary} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: c.primary }]}>{title}</Text>
              {!!detail && <Text style={[styles.meta, { color: c.muted }]}>{detail}</Text>}
            </View>
            {fresh.includes(item.id) && <View style={[styles.unread, { backgroundColor: c.secondary }]} />}
          </>
        );
        const open = isReviewNotification(item)
          ? { run: () => onOpenReview(reviewTarget(item.data)), label: `${title}. Open the review` }
          : isPlaceNotification(item)
            ? { run: () => onOpenPerson(item.data.userId), label: `${title}. Show ${person?.name ?? ""} on the map` }
            : null;
        // The card has a background and padding of its own, so it takes taps on Android too.
        return open ? (
          <Pressable
            key={item.id}
            style={({ pressed }) => [styles.card, { backgroundColor: c.subtle, opacity: pressed ? 0.7 : 1 }]}
            onPress={open.run}
            accessibilityRole="button"
            accessibilityLabel={open.label}
          >
            {content}
          </Pressable>
        ) : (
          <View key={item.id} style={[styles.card, { backgroundColor: c.subtle }]}>
            {content}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  markAll: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 44, borderRadius: 12, marginTop: 14 },
  markText: { fontSize: 14.5, fontWeight: "700" },
  card: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 18, padding: 14, marginTop: 10 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 14.5, fontWeight: "600" },
  meta: { fontSize: 12.5, marginTop: 2 },
  unread: { width: 10, height: 10, borderRadius: 5 },
});
