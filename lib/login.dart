import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:location/location.dart';
import 'server.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  _LoginPageState createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  TextEditingController _serverIPController = TextEditingController();
  TextEditingController _serverPasswordController = TextEditingController();
  TextEditingController _userNameController = TextEditingController();
  final WebSocketService _webSocketService = WebSocketService();
  LocationData? _currentLocation;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Login')),
      body: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          children: [
            TextField(
              controller: _serverIPController,
              decoration: const InputDecoration(labelText: 'Enter Server IP'),
            ),
            TextField(
              controller: _serverPasswordController,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Enter Server Password'),
            ),
            TextField(
              controller: _userNameController,
              decoration: const InputDecoration(labelText: 'Enter Your Name'),
            ),
            SizedBox(height: 16),
            ElevatedButton(
              onPressed: _connectToServer,
              child: const Text('Login'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _connectToServer() async {
    String serverIP = _serverIPController.text;
    String serverPassword = _serverPasswordController.text;
    String userName = _userNameController.text;

    SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_ip', serverIP);
    await prefs.setString('server_password', serverPassword);
    await prefs.setString('user_name', userName);

    await _getCurrentLocation();

    await _webSocketService.connectToServer(
      serverIP,
      serverPassword,
      userName,
      (message) {
        print("Received message: $message");
        Map<String, dynamic> response = jsonDecode(message);

        if (response['successful'] == true) {
          Navigator.pushReplacementNamed(
            context,
            '/map',
            arguments: _currentLocation,
          );
        } else if (message.contains('Unauthorized')) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Invalid Data')));
        } else {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Unexpected error occurred')));
        }
      },
    );
  }

  Future<void> _getCurrentLocation() async {
    Location location = Location();
    try {
      _currentLocation = await location.getLocation();
    } catch (e) {
      print("Error getting location: $e");
    }
  }
}