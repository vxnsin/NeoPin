import 'package:flutter/material.dart';
import 'package:neopin/theme/theme.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:location/location.dart';
import 'login.dart';
import 'map.dart';
import 'home.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'NeoPin',
      theme: lightMode,
      darkTheme: darkMode,
      initialRoute: '/splash',
      routes: {
        '/splash': (context) => const SplashScreen(),
        '/login': (context) => const LoginPage(),
        '/map': (context) => const MapPage(),
        '/home': (context) => const HomePage(),
      },
    );
  }
}

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  _SplashScreenState createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  LocationData? _currentLocation;

  @override
  void initState() {
    super.initState();
    _requestLocationPermission();
    //initializeService();
  }

  Future<void> _requestLocationPermission() async {
    final permissionStatus = await Permission.location.request();
    if (permissionStatus.isGranted) {
      _getCurrentLocation();
    } else {
      print("Location permission denied");
    }
  }

  Future<void> _getCurrentLocation() async {
    Location location = Location();
    try {
      _currentLocation = await location.getLocation();
      if (_currentLocation != null) {
        _checkForStoredData();
      }
    } catch (e) {
      print("Error getting location: $e");
    }
  }

  Future<void> _checkForStoredData() async {
    SharedPreferences prefs = await SharedPreferences.getInstance();
    String? storedServerIP = prefs.getString('server_ip');
    String? storedUserName = prefs.getString('user_name');

    if (storedServerIP != null && storedUserName != null) {
      Navigator.pushReplacementNamed(
        context,
        '/login',
        arguments: _currentLocation, 
      );
    } else {
      Navigator.pushReplacementNamed(context, '/login');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(child: CircularProgressIndicator()), 
    );
  }
}
