import React, { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import Avatar from "@/components/Avatar";
import {
  arrowAngle,
  bearingDeg,
  distanceBand,
  distanceBetween,
  endedText,
  formatMeters,
  hintFor,
  mapsUrls,
  type FindFix,
  type FindState,
} from "@/lib/find";

type Props = {
  state: FindState;
  // My own latest fix and where my phone points, both null until known.
  mine: FindFix | null;
  heading: number | null;
  avatarFor: (url?: string | null) => string | null;
  onAccept: () => void;
  onDecline: () => void;
  onStop: () => void;
  onClose: () => void;
};

// Opens the first maps app that takes the link.
async function openMaps(lat: number, lon: number) {
  for (const url of mapsUrls(Platform.OS, lat, lon)) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // the next one
    }
  }
}

export default function FindSheet({ state, mine, heading, avatarFor, onAccept, onDecline, onStop, onClose }: Props) {
  const { colors: c } = useThemeManager();
  const [, setTick] = useState(0);

  // The "last seen" line and the countdown move with the clock.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const peer = state.peer;
  const who = peer ? (
    <View style={styles.who}>
      <Avatar name={peer.displayName} uri={avatarFor(peer.avatarUrl)} state="online" size={56} gapColor={c.raised} />
      <Text style={[styles.name, { color: c.primary }]} numberOfLines={1}>
        {peer.displayName}
      </Text>
    </View>
  ) : null;

  if (state.phase === "asked") {
    return (
      <View style={styles.box}>
        {who}
        <Text style={[styles.lead, { color: c.primary }]}>wants to find you</Text>
        <Text style={[styles.hint, { color: c.muted }]}>
          Say yes and you both see where the other one is, for up to half an hour. You can stop any time.
        </Text>
        <View style={styles.row}>
          <Pressable style={[styles.button, { backgroundColor: c.subtle }]} onPress={onDecline} accessibilityLabel="No, not now">
            <Text style={[styles.buttonText, { color: c.primary }]}>Not now</Text>
          </Pressable>
          <Pressable
            style={[styles.button, { backgroundColor: c.secondary }]}
            onPress={onAccept}
            accessibilityLabel={`Yes, let ${peer?.displayName} find me`}
          >
            <Text style={[styles.buttonText, { color: c.onSecondary }]}>Yes, find me</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (state.phase === "pending") {
    return (
      <View style={styles.box}>
        {who}
        <ActivityIndicator color={c.secondary} style={{ marginTop: 8 }} />
        <Text style={[styles.lead, { color: c.primary }]}>Waiting for {peer?.displayName}…</Text>
        <Text style={[styles.hint, { color: c.muted }]}>Their phone asks them now. Without an answer this stops in two minutes.</Text>
        <Pressable style={[styles.button, styles.wide, { backgroundColor: c.subtle }]} onPress={onStop} accessibilityLabel="Cancel the search">
          <Text style={[styles.buttonText, { color: c.primary }]}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (state.phase === "ended") {
    return (
      <View style={styles.box}>
        {who}
        <MaterialIcons name={state.reason === "met" ? "celebration" : "info-outline"} size={32} color={c.muted} />
        <Text style={[styles.lead, { color: c.primary }]}>{endedText(state.reason, peer?.displayName ?? null)}</Text>
        <Pressable style={[styles.button, styles.wide, { backgroundColor: c.subtle }]} onPress={onClose} accessibilityLabel="Close">
          <Text style={[styles.buttonText, { color: c.primary }]}>Close</Text>
        </Pressable>
      </View>
    );
  }

  // Active: the arrow, the metres and what to do.
  const theirs = state.theirs;
  const known = mine && theirs;
  const distance = known ? distanceBetween(mine, theirs) : null;
  const bearing = known ? bearingDeg(mine, theirs) : null;
  const band = distance === null ? null : distanceBand(distance);
  const angle = bearing !== null && heading !== null ? arrowAngle(bearing, heading) : null;
  const ageS = theirs ? Math.max(0, Math.round((Date.now() - theirs.at) / 1000)) : null;
  const left = Math.max(0, Math.round((state.expiresAt - Date.now()) / 60_000));

  return (
    <View style={styles.box}>
      {who}
      <View style={[styles.dial, { backgroundColor: c.subtle }]}>
        {angle !== null ? (
          <MaterialIcons name="navigation" size={96} color={c.secondary} style={{ transform: [{ rotate: `${angle}deg` }] }} />
        ) : (
          <MaterialIcons name={known ? "explore" : "gps-not-fixed"} size={72} color={c.muted} />
        )}
      </View>
      <Text style={[styles.distance, { color: c.primary }]}>{distance === null ? "…" : formatMeters(distance)}</Text>
      <Text style={[styles.hint, { color: c.muted }]}>
        {band ? hintFor(band, heading !== null) : theirs ? "Waiting for your own position…" : `Waiting for ${peer?.displayName}'s position…`}
      </Text>
      <Text style={[styles.meta, { color: c.muted }]}>
        {ageS === null ? "No position yet" : ageS < 3 ? "Live" : `Last seen ${ageS} s ago`}
        {theirs?.accuracy ? ` · ±${Math.round(theirs.accuracy)} m` : ""} · {left} min left
      </Text>
      <View style={styles.row}>
        <Pressable style={[styles.button, { backgroundColor: c.subtle }]} onPress={onStop} accessibilityLabel="Stop the search">
          <Text style={[styles.buttonText, { color: c.primary }]}>Stop</Text>
        </Pressable>
        {theirs && band !== "close" && (
          <Pressable
            style={[styles.button, { backgroundColor: c.secondary }]}
            onPress={() => openMaps(theirs.latitude, theirs.longitude)}
            accessibilityLabel="Open walking directions in the maps app"
          >
            <MaterialIcons name="directions-walk" size={18} color={c.onSecondary} />
            <Text style={[styles.buttonText, { color: c.onSecondary }]}>Open in Maps</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", gap: 10, paddingVertical: 8 },
  who: { alignItems: "center", gap: 8 },
  name: { fontSize: 18, fontWeight: "700" },
  lead: { fontSize: 16, fontWeight: "600", textAlign: "center" },
  hint: { fontSize: 13, textAlign: "center", paddingHorizontal: 12 },
  meta: { fontSize: 12, textAlign: "center" },
  dial: { width: 180, height: 180, borderRadius: 90, alignItems: "center", justifyContent: "center", marginTop: 4 },
  distance: { fontSize: 40, fontWeight: "800", letterSpacing: -1, fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", gap: 10, marginTop: 6 },
  button: { flexDirection: "row", alignItems: "center", gap: 6, height: 46, paddingHorizontal: 20, borderRadius: 14 },
  wide: { marginTop: 6, minWidth: 160, justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "700" },
});
