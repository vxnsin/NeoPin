import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import { claimPlace, fetchPlaceChoices, savePlaceAt, type PlaceChoice, type PlaceKind, type Visit } from "@/lib/api";
import type { StoredCredentials } from "@/lib/credentials";
import { PLACE_ICONS, PLACE_LABELS, formatDistance } from "@/lib/timeline";

type Props = {
  creds: StoredCredentials;
  visit: Visit;
  // An admin naming the places of another account.
  userId?: number;
  onSaved: () => void;
};

const OWN_KINDS: PlaceKind[] = ["place", "home", "work"];

// Under a visit: confirm the suggestion, pick another place close by, or name it.
export default function PlacePicker({ creds, visit, userId, onSaved }: Props) {
  const { colors: c } = useThemeManager();
  const [choices, setChoices] = useState<PlaceChoice[] | null>(null);
  const [name, setName] = useState("");
  // Renaming an own place keeps what it is, Home stays Home.
  const ownKind = visit.place?.source === "own" ? visit.place.kind : null;
  const [kind, setKind] = useState<PlaceKind>(ownKind ?? "place");
  const kinds = ownKind && !OWN_KINDS.includes(ownKind) ? [ownKind, ...OWN_KINDS] : OWN_KINDS;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetchPlaceChoices(creds, visit.lat, visit.lon, userId)
      .then((list) => live && setChoices(list))
      .catch(() => live && setChoices([]));
    return () => {
      live = false;
    };
  }, [creds, visit.lat, visit.lon, userId]);

  const save = async (action: () => Promise<void>) => {
    setSaving(true);
    setError("");
    try {
      await action();
      onSaved();
    } catch (e: any) {
      setError(e?.message || "Could not save, try again.");
      setSaving(false);
    }
  };

  const pick = (choice: PlaceChoice) =>
    save(() =>
      choice.source === "own" && choice.id !== null
        ? claimPlace(creds, choice.id, visit.lat, visit.lon, userId)
        : savePlaceAt(creds, { lat: visit.lat, lon: visit.lon, name: choice.name, kind: choice.kind, osmId: choice.osmId }, userId)
    );

  const current = visit.place;
  const typed = name.trim();
  const saveTyped = () => typed && save(() => savePlaceAt(creds, { lat: visit.lat, lon: visit.lon, name: typed, kind }, userId));

  return (
    <View style={[styles.box, { backgroundColor: c.subtle }]}>
      {current?.source === "osm" && (
        <Pressable
          style={[styles.confirm, { backgroundColor: c.secondary }]}
          disabled={saving}
          onPress={() =>
            save(() =>
              savePlaceAt(creds, { lat: visit.lat, lon: visit.lon, name: current.name, kind: current.kind, osmId: current.osmId }, userId)
            )
          }
          accessibilityLabel={`Yes, I was at ${current.name}`}
        >
          <MaterialIcons name="check" size={18} color={c.onSecondary} />
          <Text style={[styles.confirmText, { color: c.onSecondary }]} numberOfLines={1}>
            Yes, I was at {current.name}
          </Text>
        </Pressable>
      )}

      {choices === null ? (
        <ActivityIndicator color={c.secondary} style={styles.loading} />
      ) : choices.length === 0 ? (
        <Text style={[styles.note, { color: c.muted }]}>Nothing named close by.</Text>
      ) : (
        choices.slice(0, 8).map((choice) => (
          <Pressable
            key={`${choice.source}-${choice.id ?? choice.osmId ?? choice.name}`}
            style={styles.choice}
            disabled={saving}
            onPress={() => pick(choice)}
            accessibilityLabel={`I was at ${choice.name}`}
          >
            <MaterialIcons name={PLACE_ICONS[choice.kind] ?? "place"} size={18} color={c.muted} />
            <View style={styles.choiceText}>
              <Text style={[styles.choiceName, { color: c.primary }]} numberOfLines={1}>
                {choice.name}
              </Text>
              <Text style={[styles.choiceMeta, { color: c.muted }]} numberOfLines={1}>
                {PLACE_LABELS[choice.kind] ?? "Place"} · {formatDistance(choice.distanceM)}
                {choice.source === "own" ? " · yours" : ""}
              </Text>
            </View>
          </Pressable>
        ))
      )}

      <View style={styles.own}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name it yourself"
          placeholderTextColor={c.muted}
          maxLength={80}
          style={[styles.input, { color: c.primary, backgroundColor: c.raised }]}
          returnKeyType="done"
          onSubmitEditing={saveTyped}
        />
        <Pressable
          style={[styles.save, { backgroundColor: typed ? c.secondary : c.raised }]}
          disabled={!typed || saving}
          onPress={saveTyped}
          accessibilityLabel="Save the name"
        >
          {saving ? (
            <ActivityIndicator size="small" color={c.onSecondary} />
          ) : (
            <Text style={[styles.saveText, { color: typed ? c.onSecondary : c.muted }]}>Save</Text>
          )}
        </Pressable>
      </View>
      <View style={styles.kinds}>
        {kinds.map((k) => {
          const active = k === kind;
          return (
            <Pressable
              key={k}
              onPress={() => setKind(k)}
              style={[styles.kind, { backgroundColor: active ? c.primary : c.raised }]}
              accessibilityState={{ selected: active }}
            >
              <MaterialIcons name={PLACE_ICONS[k]} size={14} color={active ? c.raised : c.muted} />
              <Text style={[styles.kindText, { color: active ? c.raised : c.primary }]}>{PLACE_LABELS[k]}</Text>
            </Pressable>
          );
        })}
      </View>
      {!!error && <Text style={[styles.note, { color: c.secondary }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginLeft: 40, marginBottom: 8, padding: 10, borderRadius: 16, gap: 4 },
  loading: { marginVertical: 10 },
  confirm: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, marginBottom: 4 },
  confirmText: { flex: 1, fontSize: 14, fontWeight: "700" },
  choice: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 6, paddingVertical: 7 },
  choiceText: { flex: 1 },
  choiceName: { fontSize: 14, fontWeight: "600" },
  choiceMeta: { fontSize: 12, marginTop: 1 },
  own: { flexDirection: "row", gap: 8, marginTop: 6 },
  input: { flex: 1, height: 38, paddingHorizontal: 12, borderRadius: 12, fontSize: 14 },
  save: { height: 38, minWidth: 64, paddingHorizontal: 14, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  saveText: { fontSize: 14, fontWeight: "700" },
  kinds: { flexDirection: "row", gap: 6, marginTop: 6 },
  kind: { flexDirection: "row", alignItems: "center", gap: 4, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  kindText: { fontSize: 12.5, fontWeight: "600" },
  note: { fontSize: 13, paddingVertical: 6 },
});
