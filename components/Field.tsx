import React, { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";

type Props = Omit<TextInputProps, "style"> & {
  label: string;
  icon: React.ComponentProps<typeof MaterialIcons>["name"];
  error?: string;
  hint?: string;
  secret?: boolean;
};

// A labelled input: label above, icon inside, an eye for secrets, the error underneath.
export default function Field({ label, icon, error, hint, secret, ...input }: Props) {
  const { colors } = useThemeManager();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const border = error ? colors.secondary : focused ? colors.secondary : "transparent";

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      <View style={[styles.control, { backgroundColor: colors.subtle, borderColor: border }]}>
        <MaterialIcons name={icon} size={20} color={focused ? colors.primary : colors.muted} />
        <TextInput
          {...input}
          style={[styles.input, { color: colors.primary }]}
          placeholderTextColor={colors.muted}
          selectionColor={colors.secondary}
          secureTextEntry={secret && !revealed}
          autoCapitalize={input.autoCapitalize ?? "none"}
          autoCorrect={false}
          onFocus={(event) => {
            setFocused(true);
            input.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            input.onBlur?.(event);
          }}
        />
        {secret && (
          <Pressable
            onPress={() => setRevealed((r) => !r)}
            hitSlop={10}
            accessibilityLabel={revealed ? "Hide password" : "Show password"}
          >
            <MaterialIcons name={revealed ? "visibility-off" : "visibility"} size={20} color={colors.muted} />
          </Pressable>
        )}
      </View>
      {error ? (
        <Text style={[styles.note, { color: colors.secondary }]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.note, { color: colors.muted }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { width: "100%", marginBottom: 16 },
  label: { fontSize: 13, fontWeight: "600", marginBottom: 7, marginLeft: 2 },
  control: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 52,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  note: { fontSize: 12.5, marginTop: 6, marginLeft: 2 },
});
