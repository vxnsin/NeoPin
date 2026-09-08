import { useState, useEffect } from "react";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";

export default function usePermissions() {
  const [permissions, setPermissions] = useState<{
    location: Location.LocationPermissionResponse | null;
    backgroundLocation: Location.LocationPermissionResponse | null;
    notifications: Notifications.NotificationPermissionsStatus | null;
  }>({
    location: null,
    backgroundLocation: null,
    notifications: null,
  });

  useEffect(() => {
    const requestPermissions = async () => {
      try {
        const location = await Location.requestForegroundPermissionsAsync();
        const backgroundLocation =
          location.status === "granted"
            ? await Location.requestBackgroundPermissionsAsync()
            : null;
        const notifications = await Notifications.requestPermissionsAsync();

        setPermissions({ location, backgroundLocation, notifications });
      } catch (error) {
        console.error("Error requesting permissions:", error);
      }
    };

    requestPermissions();
  }, []);

  return permissions;
}
