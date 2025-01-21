import 'dart:convert';
import 'dart:ffi';
import 'package:flutter/material.dart';
import 'package:neopin/components.dart';
//import 'package:latlong2/latlong.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'server.dart';
import 'package:neopin/components.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  _LoginPageState createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final TextEditingController _serverIPController = TextEditingController();
  final TextEditingController _serverPasswordController = TextEditingController();
  final TextEditingController _userNameController = TextEditingController();
  final WebSocketService _webSocketService = WebSocketService();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Theme.of(context).colorScheme.surface,
      body: Padding(
        padding: const EdgeInsets.all(50),
        child: Column(
          children: [
            Icon(
              Icons.wifi_tethering,
              size: 100,
              color: Theme.of(context).colorScheme.primary
            ),

            SizedBox(height: 100),
            
            LoginField(controller: _serverIPController, hintText: "Enter a valid Hostname", labelText: "Hostname", obscureText: false, hintIcon: Icon(Icons.storage_rounded),),

            SizedBox(height: 10),

            LoginField(controller: _serverPasswordController, hintText: "Enter a valid password", labelText: "Password", obscureText: true, hintIcon: Icon(Icons.password_rounded),),

            SizedBox(height: 10),

            LoginField(controller: _userNameController, hintText: 'How others see you', labelText: "Username",obscureText: false, hintIcon: Icon(Icons.person_pin_circle_rounded),),

            SizedBox(height: 30),

            //Login Button
            MyButton(WhenPressed: null, ButtonText: 'Connect to server',),
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

    await _webSocketService.connectToServer(
      serverIP,
      serverPassword,
      userName,
      (message) {
        print('Received message: $message');
        Map<String, dynamic> response = jsonDecode(message);

        if (response['successful'] == true) {
          Navigator.pushReplacementNamed(
            context,
            '/home'
          );
        } else if (message.contains('Unauthorized')) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Invalid Data')));
        } else {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Unexpected error occurred')));
        }
      },
    );
  }
}