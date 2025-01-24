import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as status;

class WebSocketService {
  WebSocketChannel? _channel;

  bool get isConnected => _channel != null && _channel!.closeCode == null;

  Future<void> connectToServer(
      String serverIP,
      String serverPassword,
      String userName,
      Function(String) onMessage,
      ) async {
    if (isConnected) {
      print('Already connected to the server!');
      return;
    }

    try {
      String url = 'wss://$serverIP';
      print('Trying to connect to $url...');

      _channel = WebSocketChannel.connect(Uri.parse(url));

      _channel!.stream.listen((data) {
        print('Message received: $data');
        onMessage(data);

        var message = jsonDecode(data);
        if (message['type'] == 'requestLocation') {
          sendLocation(52.5200, 13.4050);
        }
      }, onDone: () {
        print('Connection closed.');
      }, onError: (error) {
        print('Connection error: $error');
      });

      sendMessage(jsonEncode({
        'password': serverPassword,
        'deviceId': userName,
      }));

      print('Connected to $url');
    } catch (e) {
      print('Failed to connect via wss, trying ws fallback: $e');
      String fallbackUrl = 'ws://$serverIP';
      print('Trying to connect to $fallbackUrl...');

      try {
        _channel = WebSocketChannel.connect(Uri.parse(fallbackUrl));

        _channel!.stream.listen((data) {
          print('Message received: $data');
          onMessage(data);

          var message = jsonDecode(data);
          if (message['type'] == 'requestLocation') {
            sendLocation(52.5200, 13.4050);
          }
        }, onDone: () {
          print('Connection closed.');
        }, onError: (error) {
          print('Connection error: $error');
        });

        // Sende die Verbindungsnachricht
        sendMessage(jsonEncode({
          'password': serverPassword,
          'deviceId': userName,
        }));

        print('Connected to $fallbackUrl');
      } catch (e) {
        print('Failed to connect using both wss and ws: $e');
      }
    }
  }

  void sendMessage(String message) {
    if (_channel != null) {
      _channel!.sink.add(message);
      print('Message sent: $message');
    } else {
      print('WebSocket is not connected. Cannot send message.');
    }
  }

  void sendLocation(double latitude, double longitude) {
    if (_channel != null) {
      final locationMessage = jsonEncode({
        'type': 'updatePosition',
        'latitude': latitude,
        'longitude': longitude,
      });
      _channel!.sink.add(locationMessage);
      print('Location sent: lat=$latitude, lon=$longitude');
    } else {
      print('WebSocket is not connected. Cannot send location.');
    }
  }

  void disconnect() {
    if (_channel != null) {
      _channel!.sink.close(status.goingAway);
      print('WebSocket disconnected.');
    } else {
      print('WebSocket is already disconnected.');
    }
  }
}