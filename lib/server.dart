import 'package:web_socket_channel/web_socket_channel.dart';

class WebSocketService {
  WebSocketChannel? _channel;

  Future<void> connectToServer(String serverIP, String serverPassword, String userName, Function(String) onMessage) async {
    String url = 'ws://$serverIP'; 
    _channel = WebSocketChannel.connect(Uri.parse(url));

    print('Connecting to $url');

    _channel?.sink.add('{"password": "$serverPassword", "deviceId": "$userName"}');

    _channel?.stream.listen((message) {
      onMessage(message);
    });
  }

  void sendMessage(String message) {
    if (_channel != null) {
      _channel?.sink.add(message);
    }
  }

  void disconnect() {
    _channel?.sink.close();
  }
}
