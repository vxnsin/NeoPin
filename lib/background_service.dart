import 'package:flutter_background_service/flutter_background_service.dart';
import 'server.dart';

void onBackgroundService(ServiceInstance service) async {
  if (service is AndroidServiceInstance) {
    service.setForegroundNotificationInfo(
      title: "NeoPin Background Service",
      content: "Service is running...",
    );
    service.on('start').listen((event) async {
      final serverIP = event?['serverIP'];
      final serverPassword = event?['serverPassword'];
      final userName = event?['userName'];

      if (serverIP != null && serverPassword != null && userName != null) {
        final webSocketService = WebSocketService();
        await webSocketService.connectToServer(
          serverIP,
          serverPassword,
          userName,
          (message) {
            print('Background WebSocket Message: $message');
          },
        );
      }
    });

    service.on('stop').listen((event) {
      print('Background service stopped.');
    });
  }
}

