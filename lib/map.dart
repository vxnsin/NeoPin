import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:location/location.dart';

class MapPage extends StatefulWidget {
  const MapPage({super.key});

  @override
  _MapPageState createState() => _MapPageState();
}

class _MapPageState extends State<MapPage> {
  LocationData? _currentLocation;
  final Location _locationService = Location();
  late Stream<LocationData> _locationStream;

  @override
  void initState() {
    super.initState();
    _locationStream = _locationService.onLocationChanged;
    _locationStream.listen((LocationData location) {
      setState(() {
        _currentLocation = location;
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_currentLocation == null) {
      return Scaffold(
        appBar: AppBar(title: Text('Map')),
        body: Center(
          child: CircularProgressIndicator(),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text('Map')),
      body: FlutterMap(
        options: MapOptions(
          initialCenter: LatLng(_currentLocation?.latitude ?? 0.0, _currentLocation?.longitude ?? 0.0), 
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
                child: Icon(
                  Icons.location_pin,
                  color: Colors.red,
                  size: 40,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
