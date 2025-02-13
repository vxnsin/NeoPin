// useAsyncStorage.ts
import { useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const useAsyncStorage = (key: string) => {
  const getValue = useCallback(async (): Promise<string | null> => {
    try {
      const value = await AsyncStorage.getItem(key);
      return value;
    } catch (error) {
      console.error(`Error reading value for key "${key}":`, error);
      return null;
    }
  }, [key]);

  const storeValue = useCallback(
    async (value: string): Promise<void> => {
      try {
        await AsyncStorage.setItem(key, value);
      } catch (error) {
        console.error(`Error storing value for key "${key}":`, error);
      }
    },
    [key]
  );

  const removeValue = useCallback(async (): Promise<void> => {
    try {
      await AsyncStorage.removeItem(key);
    } catch (error) {
      console.error(`Error removing value for key "${key}":`, error);
    }
  }, [key]);

  return { getValue, storeValue, removeValue };
};
