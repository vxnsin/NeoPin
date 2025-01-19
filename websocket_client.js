const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3012');

ws.on('open', () => {
  console.log('Connected to the server');

  const authData = { deviceId: 'device-1', password: 'test' };
  console.log('Sending auth data:', authData);

  ws.send(JSON.stringify(authData));

  setTimeout(() => {
    ws.send(JSON.stringify({ ping: 'Hello from client 1' }));
  }, 1000); 
});

ws.on('message', (data) => {
    const parsedMessage = JSON.parse(data);
  console.log('Received from server:', parsedMessage);

    if(parsedMessage.ping) {
        ws.send(JSON.stringify({latitude: "50.1234", longitude: "-501.123"}))
    }
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
});

ws.on('close', () => {
  console.log('Connection closed');
});
