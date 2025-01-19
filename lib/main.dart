import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:location/location.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'map.dart'; 

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
        colorScheme: ColorScheme.fromSeed(seedColor: const Color.fromARGB(255, 100, 11, 255)),
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
  bool _isServerIPEntered = false;
  bool _isUserNameEntered = false;

  TextEditingController _serverIPController = TextEditingController();
  TextEditingController _serverPasswordController = TextEditingController();
  TextEditingController _userNameController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _checkForStoredData();
    _getLocationPermission();
  }

  Future<void> _checkForStoredData() async {
    SharedPreferences prefs = await SharedPreferences.getInstance();
    String? storedServerIP = prefs.getString('server_ip');
    String? storedUserName = prefs.getString('user_name');
    if (storedServerIP != null && storedUserName != null) {
      setState(() {
        _isServerIPEntered = true;
        _isUserNameEntered = true;
      });
    }
  }

  Future<void> _getLocationPermission() async {
    final permissionStatus = await Permission.location.request();
    if (permissionStatus.isGranted) {
      _getCurrentLocation();
    } else {
      // Fehleranzeige
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

  Future<void> _saveServerData() async {
    String serverIP = _serverIPController.text;
    String serverPassword = _serverPasswordController.text;

    SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_ip', serverIP);
    await prefs.setString('server_password', serverPassword);

    setState(() {
      _isServerIPEntered = true;
    });
  }

  Future<void> _saveUserName() async {
    String userName = _userNameController.text;

    SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.setString('user_name', userName);

    setState(() {
      _isUserNameEntered = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_currentLocation == null) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Stack(
        children: [
          if (_isServerIPEntered && _isUserNameEntered)
            MapPage(currentLocation: _currentLocation!),
          
          if (!_isServerIPEntered)
            _buildServerIPForm(),
          if (_isServerIPEntered && !_isUserNameEntered)
            _buildUserNameForm(),
        ],
      ),
    );
  }

  Widget _buildServerIPForm() {
    return Positioned(
      top: 100,
      left: 16,
      right: 16,
      child: Card(
        elevation: 10,
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: _serverIPController,
                decoration: const InputDecoration(labelText: 'Enter Server IP'),
              ),
              SizedBox(height: 16),
              TextField(
                controller: _serverPasswordController,
                obscureText: true,
                decoration: const InputDecoration(labelText: 'Enter Server Password'),
              ),
              SizedBox(height: 16),
              ElevatedButton(
                onPressed: _saveServerData,
                child: const Text('Connect to Server'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildUserNameForm() {
    return Positioned(
      top: 200,
      left: 16,
      right: 16,
      child: Card(
        elevation: 10,
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: _userNameController,
                decoration: const InputDecoration(labelText: 'Enter Your Name'),
              ),
              SizedBox(height: 16),
              ElevatedButton(
                onPressed: _saveUserName,
                child: const Text('Save User Name'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
