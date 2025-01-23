import 'dart:async';
import 'dart:ui';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'server.dart';

void startBackgroundService() {
  final service = FlutterBackgroundService();
  service.startService();
}

void stopBackgroundService() {
  final service = FlutterBackgroundService();
  service.invoke("stop");
}

Future<void> initializeService() async {
  final service = FlutterBackgroundService();

  await service.configure(
    iosConfiguration: IosConfiguration(),
    androidConfiguration: AndroidConfiguration(
      autoStart: false,
      onStart: onStart,
      isForegroundMode: false,
      autoStartOnBoot: false,
    ),
  );
}


@pragma('vm:entry-point')
void onStart(ServiceInstance service) async {
WebSocketService socketService = WebSocketService();

    SharedPreferences prefs = await SharedPreferences.getInstance();
  String? serverIP = prefs.getString('server_ip');
  String? serverPassword = prefs.getString('server_password');
  String? userName = prefs.getString('user_name');

  if(serverIP == null || serverPassword == null || userName == null) {
    print("Server IP, Server Password or User Name does not exist.");
    service.stopSelf();
    return;
  }

  await socketService.connectToServer(
    serverIP,
    serverPassword,
    userName,
    (message) {
      print('Message received: $message');
    },
  );

  service.on("stop").listen((event) {
    service.stopSelf();
    socketService.disconnect(); 
  });

  service.on("start").listen((event) {});

  Timer.periodic(const Duration(seconds: 1), (timer) {
   // socketService.sendPing();
    print("Background service is running ${DateTime.now().second}");
  });
}
