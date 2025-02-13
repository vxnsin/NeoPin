import { useState, useEffect } from "react";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import * as Permissions from "expo-permissions";

export default function useNotify() {
  const [expoPushToken, setExpoPushToken] = useState("");

  useEffect(() => {
    const registerForPushNotifications = async () => {
      if (!Device.isDevice) {
        console.log("Notify not working on this Device");
        return;
      }

      const { status } = await Permissions.askAsync(Permissions.NOTIFICATIONS);
      if (status !== "granted") {
        console.log("No Perms for Notify.");
        return;
      }

      const token = (await Notifications.getExpoPushTokenAsync()).data;
      setExpoPushToken(token);
    };

    registerForPushNotifications();
  }, []);

  return expoPushToken;
}
