import { useState, useEffect } from "react";
import * as Permissions from "expo-permissions";

export default function usePermissions() {
  const [permissions, setPermissions] = useState({});

  useEffect(() => {
    const requestPermissions = async () => {
      const permissionList = {
        location: await Permissions.askAsync(Permissions.LOCATION),
        notifications: await Permissions.askAsync(Permissions.NOTIFICATIONS),
      };

      setPermissions(permissionList);
    };

    requestPermissions();
  }, []);

  return permissions;
}
