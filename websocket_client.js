const WebSocket = require('ws');


const wstest = new WebSocket('ws://localhost:3012');
const ws = new WebSocket('wss://neopin.storagevault.me/ws');

wstest.on('open', () => {
  console.log('Connected to the server');

  const authData = { deviceId: 'device-1', password: 'neopin123' };
  console.log('Sending auth data:', authData);

  wstest.send(JSON.stringify(authData));

  setTimeout(() => {
    wstest.send(JSON.stringify({ ping: 'Hello from client 1' }));
  }, 1000); 
});

wstest.on('message', (data) => {
    const parsedMessage = JSON.parse(data);
  console.log('Received from server:', parsedMessage);

    if(parsedMessage.ping) {
      wstest.send(JSON.stringify({latitude: "50.1234", longitude: "-501.123"}))
    }
});

wstest.on('error', (error) => {
  console.error('WebSocket error:', error);
});

wstest.on('close', () => {
  console.log('Connection closed');
});
