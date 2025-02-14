import { useState, useEffect } from "react";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";

export default function usePermissions() {
  const [permissions, setPermissions] = useState<{
    location: Location.LocationPermissionResponse | null,
    notifications: Notifications.NotificationPermissionsStatus | null,
  }>({
    location: null,
    notifications: null,
  });

  useEffect(() => {
    const requestPermissions = async () => {
      try {
        const locationPermission = await Location.requestForegroundPermissionsAsync();
        const notificationPermission = await Notifications.requestPermissionsAsync();

        setPermissions({
          location: locationPermission,
          notifications: notificationPermission,
        });
      } catch (error) {
        console.error("Error requesting permissions:", error);
      }
    };

    requestPermissions();
  }, []);

  return permissions;
}
