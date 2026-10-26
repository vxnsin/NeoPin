import AsyncStorage from "@react-native-async-storage/async-storage";
import { socket, STORAGE_KEY } from "@/lib/socket";
import { stopBackgroundLocation } from "@/tasks/LocationTask";
import { stopWebSocketService } from "@/services/WebSocketService";

// Closes the socket, stops everything that would reconnect it in the
// background and forgets the stored login.
export async function logout() {
  socket.close();
  await Promise.all([stopWebSocketService(), stopBackgroundLocation().catch(() => {})]);
  await AsyncStorage.removeItem(STORAGE_KEY);
}
