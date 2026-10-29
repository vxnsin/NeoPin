import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import useThemeManager from "@/hooks/useThemeManager";
import { fetchLinkedDevices, unlinkDevice, type DeviceAuth, type LinkedDevice } from "@/lib/api";
import { DEVICE_ICONS, typeOf } from "@/lib/devices";
import { timeAgo } from "@/lib/time";

type Props = {
  auth: DeviceAuth;
};

// In the settings: every device signed in to my account, with a way to unlink the ones that are
// not mine anymore (an old phone, a sold tablet). Unlinking signs it out and takes it off every
// map; this phone itself is left to "Log out".
export default function MyDevicesSection({ auth }: Props) {
  const { colors: c } = useThemeManager();
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    let live = true;
    fetchLinkedDevices(auth)
      .then((list) => live && setDevices(list))
      .catch((e: any) => live && setError(e?.message || "Your devices could not be loaded."));
    return () => {
      live = false;
    };
    // A fresh copy of the same login must not reload the list under the finger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.serverIp, auth.deviceId, auth.token]);

  useEffect(load, [load]);

  const unlink = (device: LinkedDevice) => {
    Alert.alert(
      "Unlink device",
      `Unlink ${device.deviceId}? It is signed out and no longer shown on anyone's map. Its past positions stay in your timeline.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unlink",
          style: "destructive",
          onPress: async () => {
            setBusy(device.deviceId);
            setError("");
            try {
              await unlinkDevice(auth, device.deviceId);
              setDevices((list) => (list ? list.filter((d) => d.deviceId !== device.deviceId) : list));
            } catch (e: any) {
              setError(e?.message || "Could not unlink the device, try again.");
            } finally {
              setBusy(null);
            }
          },
        },
      ]
    );
  };

  if (!devices && !error) {
    return (
      <View>
        <Text style={[styles.title, { color: c.muted }]}>My devices</Text>
        <ActivityIndicator color={c.secondary} style={styles.loading} />
      </View>
    );
  }

  return (
    <View>
      <Text style={[styles.title, { color: c.muted }]}>My devices</Text>
      {(devices ?? []).map((device) => {
        const self = device.deviceId === auth.deviceId;
        return (
          <View key={device.deviceId} style={[styles.row, { backgroundColor: c.subtle }]}>
            <MaterialIcons name={DEVICE_ICONS[typeOf(device)]} size={20} color={c.muted} />
            <View style={styles.text}>
              <Text style={[styles.name, { color: c.primary }]} numberOfLines={1}>
                {device.deviceId}
              </Text>
              <Text style={[styles.meta, { color: c.muted }]} numberOfLines={1}>
                {self ? "This phone" : device.status === "online" ? "Online" : `Last seen ${timeAgo(device.lastPing)}`}
              </Text>
            </View>
            {self ? null : (
              <Pressable
                style={[styles.unlink, { borderColor: c.secondary }]}
                disabled={busy !== null}
                onPress={() => unlink(device)}
                accessibilityRole="button"
                accessibilityLabel={`Unlink ${device.deviceId}`}
              >
                {busy === device.deviceId ? (
                  <ActivityIndicator size="small" color={c.secondary} />
                ) : (
                  <Text style={[styles.unlinkText, { color: c.secondary }]}>Unlink</Text>
                )}
              </Pressable>
            )}
          </View>
        );
      })}
      <Text style={[styles.hint, { color: c.muted }]}>
        Unlink a device that is not yours anymore. To remove this phone, log out.
      </Text>
      {!!error && <Text style={[styles.hint, { color: c.secondary }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "600", marginTop: 20, marginBottom: 8 },
  loading: { marginVertical: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, marginBottom: 8 },
  text: { flex: 1 },
  name: { fontSize: 14, fontWeight: "600" },
  meta: { fontSize: 12, marginTop: 2 },
  unlink: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 12, height: 32, minWidth: 74, alignItems: "center", justifyContent: "center" },
  unlinkText: { fontSize: 13, fontWeight: "700" },
  hint: { fontSize: 12, marginTop: 2 },
});
