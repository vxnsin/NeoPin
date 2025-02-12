import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from "react-native";
import useThemeManager from "@/hooks/useThemeManager";
import Icon from "react-native-vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useWebSocketContext } from "@/context/WebSocket";

export default function ErrorScreen() {
  const colors = useThemeManager();
  const { getValue, removeValue } = useAsyncStorage("userData");
  const router = useRouter();
  const params = useLocalSearchParams();
  const { connect } = useWebSocketContext();
  
  const [retrying, setRetrying] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const iconName = Array.isArray(params.icon) ? params.icon[0] : (params.icon || "wifi-off");

  const errorTitle = params.error || "Error Title";
  const errorDescription = params.description || "Error Desc";

  const handleLogout = async () => {
    await removeValue();
    router.replace("/login");
  };

  const handleRetry = async () => {
    setRetrying(true);
    setErrorMessage("");
    try {
      const userData = await getValue();
      if (!userData) {
        setErrorMessage("User data not found.");
        setRetrying(false);
        return;
      }
      const { serverIp, deviceId, password } = JSON.parse(userData);
      await connect(serverIp, deviceId, password, { reconnecting: false });
      router.replace("/map");
    } catch (error: any) {
      console.error("Retry connection error:", error);
      setErrorMessage(error.message);
      setRetrying(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
      <Icon 
        name={iconName} 
        size={100} 
        color={colors.colors.primary} 
        style={styles.iconTop} 
      />
      <Text style={[styles.errorText, { color: colors.colors.primary }]}>
        {errorTitle}
      </Text>
      <Text style={[styles.subText, { color: colors.colors.primary }]}>
        {errorDescription}
      </Text>
      {errorMessage ? (
        <Text style={[styles.statusText, { color: colors.colors.primary }]}>
          {errorMessage}
        </Text>
      ) : null}
      {retrying ? (
        <ActivityIndicator size="large" color={colors.colors.primary} />
      ) : (
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.colors.secondary }]}
          onPress={handleRetry}
        >
          <Text style={[styles.buttonText, { color: colors.colors.onSecondary }]}>
            Retry
          </Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.colors.secondary }]}
        onPress={handleLogout}
      >
        <Text style={[styles.buttonText, { color: colors.colors.onSecondary }]}>
          Logout
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    justifyContent: "center", 
    alignItems: "center", 
    padding: 20 
  },
  iconTop: { 
    position: "absolute", 
    top: 160 
  },
  errorText: { 
    fontSize: 24, 
    fontWeight: "bold", 
    marginBottom: 10 
  },
  subText: { 
    fontSize: 16, 
    textAlign: "center", 
    marginBottom: 20 
  },
  statusText: { 
    fontSize: 16, 
    marginBottom: 20 
  },
  button: { 
    paddingVertical: 16, 
    paddingHorizontal: 32, 
    borderRadius: 28, 
    marginTop: 10 
  },
  buttonText: { 
    fontSize: 18, 
    fontWeight: "bold" 
  },
});
