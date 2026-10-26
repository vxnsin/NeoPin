import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import Field from "@/components/Field";
import { updateProfileRequest, type DeviceAuth, type User } from "@/lib/api";
import { DISPLAY_NAME_MAX, displayNameProblem, profileChanges, usernameProblem } from "@/lib/profile";

type Props = {
  auth: DeviceAuth;
  user: User;
  onSaved: (user: User) => void;
  onClose: () => void;
};

export default function ProfileForm({ auth, user, onSaved, onClose }: Props) {
  const { colors: c } = useThemeManager();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);
  const [errors, setErrors] = useState<{ name?: string; username?: string }>({});
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const next = { name: displayNameProblem(displayName), username: usernameProblem(username) };
    setErrors(next);
    setFailure("");
    if (next.name || next.username) return;
    const changes = profileChanges(user, { displayName, username });
    if (!changes.displayName && !changes.username) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      onSaved(await updateProfileRequest(auth, changes));
      onClose();
    } catch (e: any) {
      setFailure(e?.message || "The profile could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.form}>
      <Field
        label="Display name"
        icon="badge"
        value={displayName}
        onChangeText={(text) => {
          setDisplayName(text);
          setErrors((e) => ({ ...e, name: undefined }));
        }}
        autoCapitalize="words"
        maxLength={DISPLAY_NAME_MAX}
        error={errors.name}
        hint="Shown to everyone on the map."
      />
      <Field
        label="Username"
        icon="person-outline"
        value={username}
        onChangeText={(text) => {
          setUsername(text);
          setErrors((e) => ({ ...e, username: undefined }));
        }}
        maxLength={32}
        error={errors.username}
        hint="3-32 characters: letters, digits, _ . -"
      />
      {failure ? <Text style={[styles.error, { color: c.secondary }]}>{failure}</Text> : null}
      <View style={styles.actions}>
        <Pressable style={[styles.button, { backgroundColor: c.subtle }]} onPress={onClose} disabled={busy}>
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
  form: { marginTop: 16 },
  error: { fontSize: 13, marginBottom: 10 },
  actions: { flexDirection: "row", gap: 10 },
  button: { flex: 1, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 15, fontWeight: "700" },
});
