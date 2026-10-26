import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import Field from "@/components/Field";
import { changePasswordRequest, type DeviceAuth } from "@/lib/api";
import { PASSWORD_MIN, passwordProblem } from "@/lib/password";

type Props = {
  auth: DeviceAuth;
  // The server revokes the old token and answers with a fresh one for this device.
  onChanged: (token: string) => void;
};

// Collapsed to one button until the user wants to change the password.
export default function PasswordForm({ auth, onChanged }: Props) {
  const { colors: c } = useThemeManager();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const close = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
  };

  const save = async () => {
    if (busy) return;
    const problem = passwordProblem(current, next, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { token } = await changePasswordRequest(auth, current, next);
      onChanged(token);
      close();
      setDone(true);
    } catch (e: any) {
      setError(e?.message || "The password could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <View>
        <Pressable
          style={[styles.toggle, { backgroundColor: c.subtle }]}
          onPress={() => {
            setDone(false);
            setOpen(true);
          }}
        >
          <Text style={[styles.toggleText, { color: c.primary }]}>Change password</Text>
        </Pressable>
        {done ? <Text style={[styles.note, { color: c.muted }]}>Password changed. Your other devices were logged out.</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.form}>
      <Field label="Current password" icon="lock-outline" value={current} onChangeText={setCurrent} secret textContentType="password" />
      <Field
        label="New password"
        icon="lock"
        value={next}
        onChangeText={setNext}
        secret
        textContentType="newPassword"
        hint={`At least ${PASSWORD_MIN} characters.`}
      />
      <Field label="Repeat new password" icon="lock" value={confirm} onChangeText={setConfirm} secret textContentType="newPassword" />
      {error ? <Text style={[styles.error, { color: c.secondary }]}>{error}</Text> : null}
      <View style={styles.actions}>
        <Pressable style={[styles.button, { backgroundColor: c.subtle }]} onPress={close} disabled={busy}>
          <Text style={[styles.buttonText, { color: c.primary }]}>Cancel</Text>
        </Pressable>
        <Pressable style={[styles.button, { backgroundColor: c.secondary, opacity: busy ? 0.7 : 1 }]} onPress={save} disabled={busy}>
          {busy ? <ActivityIndicator color={c.onSecondary} /> : <Text style={[styles.buttonText, { color: c.onSecondary }]}>Save</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toggle: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center", marginTop: 12 },
  toggleText: { fontSize: 15, fontWeight: "600" },
  note: { fontSize: 12.5, marginTop: 8, textAlign: "center" },
  form: { marginTop: 16 },
  error: { fontSize: 13, marginBottom: 10 },
  actions: { flexDirection: "row", gap: 10 },
  button: { flex: 1, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "700" },
});
