import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useAuthCheck } from "@/hooks/useAuthCheck";
import useThemeManager from "@/hooks/useThemeManager";
import Icon from "react-native-vector-icons/MaterialIcons";
import { useLocalSearchParams } from "expo-router";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useRouter } from "expo-router";

export default function ErrorScreen() {
  const colors = useThemeManager();
  const { refreshAuth } = useAuthCheck();
  const { removeValue } = useAsyncStorage("userData");
  const router = useRouter();
  const params = useLocalSearchParams();

  const errorTitle = params.error || "⚠️ Connection Failed";
  const errorDescription = params.description || "Unable to connect to the server. Please check your network or server settings.";

  const handleLogout = async () => {
    await removeValue();
    router.replace("/login");
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
      <Icon name="wifi-off" size={100} color={colors.colors.primary} style={styles.iconTop} />
      
      <Text style={[styles.errorText, { color: colors.colors.primary }]}>{errorTitle}</Text>
      <Text style={[styles.subText, { color: colors.colors.primary }]}>{errorDescription}</Text>

      {/* Retry Button */}
      <TouchableOpacity style={[styles.button, { backgroundColor: colors.colors.secondary }]} onPress={refreshAuth}>
        <Text style={[styles.buttonText, { color: colors.colors.onSecondary }]}>Retry</Text>
      </TouchableOpacity>

      {/* Logout Button */}
      <TouchableOpacity style={[styles.button, {backgroundColor: colors.colors.secondary}]} onPress={handleLogout}>
        <Text style={[styles.buttonText, { color: colors.colors.primary }]}>Logout</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20 },
  iconTop: { position: "absolute", top: 200 },
  errorText: { fontSize: 24, fontWeight: "bold", marginBottom: 10 },
  subText: { fontSize: 16, textAlign: "center", marginBottom: 20 },
  button: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 24, marginBottom: 10 },
  buttonText: { fontSize: 18, fontWeight: "bold" },
  logoutButton: { borderWidth: 2, },
});
