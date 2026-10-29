import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import LineBadge from "@/components/LineBadge";
import { rideQuestionDetail, rideQuestionText, type RideAnswer, type RideQuestion } from "@/lib/rides";
import { TRANSIT_ICONS } from "@/lib/timeline";

type Props = {
  question: RideQuestion;
  // Sends the answer; throws with a message for people when it did not get through.
  onAnswer: (answer: RideAnswer) => Promise<void>;
  onDone: () => void;
};

// "Are you on Bus 10 towards Hauptbahnhof?" with Yes and No. Closing the sheet without an answer
// changes nothing, the timeline goes on guessing as before.
export default function RideSheet({ question, onAnswer, onDone }: Props) {
  const { colors: c } = useThemeManager();
  const [busy, setBusy] = useState<RideAnswer | null>(null);
  const [error, setError] = useState("");
  const { transit } = question;

  const answer = async (value: RideAnswer) => {
    setBusy(value);
    setError("");
    try {
      await onAnswer(value);
      onDone();
    } catch (e: any) {
      setError(e?.message || "Could not send the answer, try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View>
      <View style={[styles.card, { backgroundColor: c.subtle }]}>
        <View style={styles.lineRow}>
          <MaterialIcons name={transit.kind ? TRANSIT_ICONS[transit.kind] : "directions-transit"} size={22} color={c.muted} />
          <LineBadge line={transit.line} color={transit.color} textColor={transit.textColor} large />
        </View>
        <Text style={[styles.question, { color: c.primary }]}>{rideQuestionText(question)}</Text>
        <Text style={[styles.meta, { color: c.muted }]}>{rideQuestionDetail(question)}</Text>
      </View>
      <View style={styles.buttons}>
        <Pressable
          style={({ pressed }) => [styles.button, { backgroundColor: c.subtle, opacity: pressed ? 0.7 : 1 }]}
          disabled={busy !== null}
          onPress={() => answer("no")}
          accessibilityRole="button"
          accessibilityLabel="No, I am not on it"
        >
          {busy === "no" ? <ActivityIndicator size="small" color={c.primary} /> : <Text style={[styles.buttonText, { color: c.primary }]}>No</Text>}
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.button, { backgroundColor: c.secondary, opacity: pressed ? 0.7 : 1 }]}
          disabled={busy !== null}
          onPress={() => answer("yes")}
          accessibilityRole="button"
          accessibilityLabel="Yes, I am on it"
        >
          {busy === "yes" ? (
            <ActivityIndicator size="small" color={c.onSecondary} />
          ) : (
            <Text style={[styles.buttonText, { color: c.onSecondary }]}>Yes</Text>
          )}
        </Pressable>
      </View>
      {!!error && <Text style={[styles.meta, { color: c.secondary, marginTop: 10 }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, padding: 16, marginTop: 14, gap: 6 },
  lineRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  question: { fontSize: 17, fontWeight: "700" },
  meta: { fontSize: 13 },
  buttons: { flexDirection: "row", gap: 10, marginTop: 14 },
  button: { flex: 1, height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 16, fontWeight: "700" },
});
