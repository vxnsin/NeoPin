import * as Location from "expo-location";
import type { Message } from "@/lib/SocketClient";

type Socket = {
  onMessage: (fn: (data: Message) => void) => () => void;
  emit: (msg: Message) => void;
};

export function registerHandlers(ws: Socket) {
  return ws.onMessage(async (data) => {
    if (!data || !data.type) return;

    switch (data.type) {
      case "requestLocation":
        try {
          const { status } = await Location.getForegroundPermissionsAsync();
          if (status !== "granted") {
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
          ws.emit({
            type: "locationError",
            message: error?.message || "Unknown error",
          });
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
}
