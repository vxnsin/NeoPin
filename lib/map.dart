import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:location/location.dart';

class MapPage extends StatelessWidget {
  final LocationData currentLocation;
//
  const MapPage({super.key, required this.currentLocation});

  @override
  Widget build(BuildContext context) {
    return FlutterMap(
      options: MapOptions(
      initialCenter: LatLng(currentLocation.latitude!, currentLocation.longitude!), 
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
              point: LatLng(currentLocation.latitude!, currentLocation.longitude!),
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
