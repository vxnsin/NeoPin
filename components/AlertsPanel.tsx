import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import RecipientPicker from "@/components/RecipientPicker";
import { fetchPlaces, getAlerts, setAlerts, type AlertSettings, type DeviceAuth, type Group, type OwnPlace } from "@/lib/api";
import { contactsFrom, pruneRecipients, type Recipients } from "@/lib/recipients";
import { PLACE_ICONS, PLACE_LABELS } from "@/lib/timeline";

type Props = {
  auth: DeviceAuth;
  userId: number;
  groups: Group[];
  avatarFor: (url?: string | null) => string | null;
};

// "Arrival alerts": which of my places tell others when I arrive or leave, and who hears about it.
// Every change is saved right away; a failed save puts back what the server has.
export default function AlertsPanel({ auth, userId, groups, avatarFor }: Props) {
  const { colors: c } = useThemeManager();
  const [places, setPlaces] = useState<OwnPlace[] | null>(null);
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [reloads, setReloads] = useState(0);
  const saved = useRef<AlertSettings | null>(null);
  // Saves go out one after the other, so the last change is the one the server keeps.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);

  const contacts = useMemo(() => contactsFrom(groups, userId), [groups, userId]);

  useEffect(() => {
    let live = true;
    setLoadError("");
    Promise.all([getAlerts(auth), fetchPlaces(auth)])
      .then(([current, own]) => {
        if (!live) return;
        const value = current ?? { places: [], recipients: { users: [], groups: [] } };
        saved.current = value;
        setSettings(value);
        setPlaces(own);
      })
      .catch((e: any) => live && setLoadError(e?.message || "The alerts could not be loaded."));
    return () => {
      live = false;
    };
    // A fresh copy of the same login (a new picture, say) must not reload the sheet under the finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.serverIp, auth.deviceId, auth.token, reloads]);

  const save = (next: AlertSettings) => {
    const clean = { ...next, recipients: pruneRecipients(next.recipients, contacts, groups) };
    const mine = ++latest.current;
    setSettings(clean);
    setSaveError("");
    queue.current = queue.current
      .then(() => setAlerts(auth, clean))
      .then(() => {
        saved.current = clean;
      })
      .catch((e: any) => {
        if (mine !== latest.current) return;
        setSaveError(e?.message || "Could not save, try again.");
        setSettings(saved.current);
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

  if (!settings || !places) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={c.secondary} />
      </View>
    );
  }

  const togglePlace = (id: number, on: boolean) =>
    save({ ...settings, places: on ? [...settings.places.filter((p) => p !== id), id] : settings.places.filter((p) => p !== id) });
  const changeRecipients = (recipients: Recipients) => save({ ...settings, recipients });

  return (
    <View>
      <Text style={[styles.hint, { color: c.muted, marginTop: 6 }]}>
        When you arrive at or leave one of these places, the people below get a notification.
      </Text>

      <Text style={[styles.section, { color: c.muted }]}>Places</Text>
      {places.length === 0 && (
        <Text style={[styles.hint, { color: c.muted }]}>No places yet. Name a stop in your timeline, Home or Work for example.</Text>
      )}
      {places.map((place) => {
        const on = settings.places.includes(place.id);
        const name = place.name || PLACE_LABELS[place.kind];
        return (
          <Pressable
            key={place.id}
            style={[styles.placeRow, { backgroundColor: c.subtle }]}
            onPress={() => togglePlace(place.id, !on)}
            accessibilityRole="switch"
            accessibilityLabel={name}
            accessibilityState={{ checked: on }}
          >
            <MaterialIcons name={PLACE_ICONS[place.kind] ?? "place"} size={20} color={c.muted} />
            <Text style={[styles.placeName, { color: c.primary }]} numberOfLines={1}>
              {name}
            </Text>
            <Switch
              value={on}
              onValueChange={(value) => togglePlace(place.id, value)}
              trackColor={{ true: c.secondary, false: c.raised }}
              thumbColor={on ? c.onSecondary : undefined}
            />
          </Pressable>
        );
      })}

      <Text style={[styles.section, { color: c.muted }]}>Who gets told</Text>
      <RecipientPicker contacts={contacts} groups={groups} value={settings.recipients} onChange={changeRecipients} avatarFor={avatarFor} />

      {!!saveError && <Text style={[styles.hint, { color: c.secondary, marginTop: 10 }]}>{saveError}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 28 },
  section: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8 },
  hint: { fontSize: 12.5 },
  placeRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingLeft: 16, paddingRight: 10, borderRadius: 14, marginBottom: 8 },
  placeName: { flex: 1, fontSize: 15, fontWeight: "600" },
  retry: { height: 38, paddingHorizontal: 18, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  retryText: { fontSize: 14, fontWeight: "600" },
});
