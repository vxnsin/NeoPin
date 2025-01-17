import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:location/location.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Flutter Demo',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const MyHomePage(title: 'NeoPin'),
    );
  }
}

class MyHomePage extends StatefulWidget {
  const MyHomePage({super.key, required this.title});
  final String title;

  @override
  State<MyHomePage> createState() => _MyHomePageState();
}

class _MyHomePageState extends State<MyHomePage> {
  LocationData? _currentLocation;

  @override
  void initState() {
    super.initState();
    _getLocationPermission();
  }

  Future<void> _getLocationPermission() async {
    final permissionStatus = await Permission.location.request();

    if(permissionStatus.isGranted) {
      _getCurrentLocation();
    } else {
      //Fehler anzeigen
    }
  }

  Future<void> _getCurrentLocation() async {
  Location location = Location();

  try {
    _currentLocation = await location.getLocation();
     setState(() {});
  } catch (e) {
    print("Error getting location: $e");
  }

  
  }

  @override
  Widget build(BuildContext context) {
  if (_currentLocation == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    return FlutterMap(
      options: MapOptions(
      initialCenter: LatLng(_currentLocation!.latitude!, _currentLocation!.longitude!), 
      initialZoom: 9.2,
      ),
      children: [
      TileLayer( 
        urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        userAgentPackageName: 'net.neopin',
      ),
      MarkerLayer(
        markers: [
          Marker(
            point: LatLng(_currentLocation!.latitude!, _currentLocation!.longitude!),
            width: 80,
            height: 80,
            child: FlutterLogo(),
          ),
        ],
      ),
    ],
    );
  }
}

