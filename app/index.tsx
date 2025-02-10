import { View, ActivityIndicator, Text } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import { useAuthCheck } from "@/hooks/useAuthCheck";

export default function Index() {
  const colors = useThemeManager();
  const { status } = useAuthCheck();

  if (status === "loading") {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={colors.colors.primary} />
      </View>
    );
  }

  if (status === "error") {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: colors.colors.surface }}>
        <Text style={{ color: colors.colors.primary, fontSize: 18 }}>⚠️ Cannot connect to the server.</Text>
      </View>
    );
  }

  return null; // Redirect happens automatically
}
