export function registerHandlers(ws: {
    addMessageListener: (fn: (data: any) => void) => () => void;
    emit: (msg: any) => void;
  }) {
    const unsubscribe = ws.addMessageListener((data: any) => {
      if (!data || !data.type) return;
      switch (data.type) {
        case 'requestLocation':
          ws.emit({
            type: 'locationResponse',
            location: { latitude: 37.7749, longitude: -122.4194 }
          });
          break;
        case 'ping':
          ws.emit({ type: 'pong' });
          break;
        default:
          console.warn('Unhandled message type:', data.type);
          break;
      }
    });
    return unsubscribe;
  }
  