import { useState, useEffect, useCallback } from "react";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useRouter, useSegments } from "expo-router";
import { useWebSocket } from "@/hooks/useWebSocket";

export const useAuthCheck = () => {
  const [status, setStatus] = useState<"loading" | "authenticated" | "unauthenticated" | "error">("loading");
  const [message, setMessage] = useState("Connecting...");
  const { getValue } = useAsyncStorage("userData");
  const router = useRouter();
  const ws = useWebSocket();

  const MAX_RETRIES = 5;
  const [retryCount, setRetryCount] = useState(0);

  const segments: string[] = useSegments(); // Get current route

  const checkAuth = useCallback(async () => {
    if (retryCount > 0) {
      setMessage(`Retrying (${retryCount}/${MAX_RETRIES})`);
    } else {
      setMessage("Connecting...");
    }

    if (retryCount >= MAX_RETRIES) {
      console.error("Max retry limit reached. Redirecting to error screen.");
      
      if (!segments.includes("error")) {
        router.replace("/error?error=Connection Failed&description=Unable to connect after multiple attempts.");
      }

      setStatus("error");
      return;
    }

    try {
      const userData = await getValue();
      if (!userData) {
        setStatus("unauthenticated");
        router.replace("/login");
        return;
      }

      const { serverIp, deviceId, password } = JSON.parse(userData);

      ws.close();
      await new Promise((resolve) => setTimeout(resolve, 2000)); 
      await ws.connect(serverIp, deviceId, password);

      setStatus("authenticated");
      router.replace("/");
    } catch (error) {
      console.error(`Auth or connection error (Retry ${retryCount + 1}/${MAX_RETRIES}):`, error);
      setRetryCount((prev) => prev + 1);

      setTimeout(() => {
        checkAuth();
      }, 3000);
    }
  }, [getValue, ws, router, retryCount, segments]);

  useEffect(() => {
    checkAuth();
  }, []);

  return { status, message, refreshAuth: checkAuth };
};
