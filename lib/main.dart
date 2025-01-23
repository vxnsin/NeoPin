import 'package:flutter/material.dart';
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:neopin/background_service.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'login.dart';
import 'map.dart';

void main() async {
 // await initializeService();

  String initialRoute = await determineInitialRoute();

  runApp(MyApp(initialRoute: initialRoute));
}

Future<String> determineInitialRoute() async {
  final permissionStatus = await Future.wait([
    Permission.location.request(),
    Permission.notification.request(),
  ]);

  if (!permissionStatus[0].isGranted || !permissionStatus[1].isGranted) {
    print("Some permissions are denied");
    return '/login'; 
  }

  SharedPreferences prefs = await SharedPreferences.getInstance();
  String? storedServerIP = prefs.getString('server_ip');
  String? storedUserName = prefs.getString('user_name');

  if (storedServerIP != null && storedUserName != null) {
    return '/map';
  } else {
    return '/login';
  }
}

class MyApp extends StatelessWidget {
  final String initialRoute;

  const MyApp({super.key, required this.initialRoute});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NeoPin',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color.fromARGB(255, 100, 11, 255)),
        useMaterial3: true,
      ),
      initialRoute: initialRoute,
      routes: {
        '/login': (context) => const LoginPage(),
        '/map': (context) => const MapPage(),
      },
    );
  }
}
