import BackgroundService from "react-native-background-actions";
import { useAsyncStorage } from "@/hooks/useAsyncStorage";
import { useWebSocket } from "@/hooks/useWebSocket";

const BackgroundTask = async () => {
    console.log("Starte Service");

    const { getValue } = useAsyncStorage("userData");
    const { connect, close, isConnected } = useWebSocket();

    const userData = await getValue();
    if (!userData) {
        return;
    }

    const { serverIp, deviceId, password } = JSON.parse(userData);

    try {
        await connect(serverIp, deviceId, password, {
            reconnecting: false,
        });

        while (isConnected) {
            console.log("Connected");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    } catch (error) {
        console.error("Error:", error);
    }
};



export async function startWebSocketService() {
    const options = {
      taskName: 'NeoPin - WebSocket',
      taskTitle: 'WebSocket Active',
      taskDesc: 'Maintaining connection...',
      taskIcon: {
        name: 'ic_launcher',
        type: 'mipmap',
      },
      color: '#FF0000',
      linkingURI: 'neopin://',
      parameters: {
        delay: 1000,
      },
      foregroundService: {
        type: 'dataSync',
        notificationId: 112233,
        pressAction: {
          id: 'default',
          launchActivity: 'de.vensin.neopin.MainActivity',
          extras: {}
        },
        notificationChannel: {
          id: 'websocket_channel',
          name: 'WebSocket Channel',
          description: 'Background connection channel',
          enableVibration: false,
          importance: 2,
          showBadge: false
        }
      },
      allowWhileIdle: true,
      wakeLock: true,
      wakeLockTimeout: 5000
    };
  
    try {
      await BackgroundService.start(BackgroundTask, options);
      await BackgroundService.updateNotification({
        taskDesc: 'Connection maintained in background'
      });
    } catch (error) {
      console.error('Background service error:', error);
    }
  }

export async function stopWebSocketService() {
    await BackgroundService.stop();
}
  