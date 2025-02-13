import * as Location from "expo-location";

export function registerHandlers(ws: {
  addMessageListener: (fn: (data: any) => void) => () => void;
  emit: (msg: any) => void;
}) {
  const unsubscribe = ws.addMessageListener(async (data: any) => {
    if (!data || !data.type) return;

    switch (data.type) {
      case "requestLocation":
        try {
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status !== "granted") {
            console.error("Location permission denied");
            ws.emit({ type: "locationError", message: "Permission denied" });
            return;
          }

          const position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High,
          });

          ws.emit({
            type: "updatePosition",
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });

        } catch (error: any) {
          console.error("Error getting location:", error);
          ws.emit({ type: "locationError", message: error.message || "Unknown error" });
        }
        break;

      case "ping":
          ws.emit({ type: "pong" });
        break;

      case "dataResponse":
        break;

      default:
        console.warn("Unhandled message type:", data.type);
        break;
    }
  });

  return unsubscribe;
}
