import React, { useState, useRef, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, Animated, Linking } from 'react-native';
import useThemeManager from '@/hooks/useThemeManager';
import Icon from 'react-native-vector-icons/MaterialIcons';
import FloatingInput from '@/components/FloatingInput';
import * as Device from 'expo-device';
import pkg from '@/package.json';
import { FontAwesome } from '@expo/vector-icons';
import { useAuthWebSocket, WebSocketConfig } from '@/hooks/useWebSocket';
import { useAsyncStorage } from '@/hooks/useAsyncStorage';

const Login = () => {
  const colors = useThemeManager();
  const [username, setUsername] = useState('');
  const [serverIp, setServerIp] = useState('');
  const [serverPassword, setServerPassword] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [wsConfig, setWsConfig] = useState<WebSocketConfig | undefined>(undefined);
  const [connectionStatus, setConnectionStatus] = useState<string>('');

  const animations = {
    username: useRef(new Animated.Value(0)).current,
    serverIp: useRef(new Animated.Value(0)).current,
    serverPassword: useRef(new Animated.Value(0)).current,
  };

  useEffect(() => {
    setDeviceName(Device.modelName ?? 'Unknown Device');
  }, []);

  const { messages, sendMessage } = useAuthWebSocket(wsConfig);
  const { storeValue, getValue } = useAsyncStorage('userData');
  
  const handleConnect = async () => {
    if (!serverIp || !username || !serverPassword) {
      return;
    }

    const testConnection = new WebSocket("wss://4sw16n7h-3012.euw.devtunnels.ms/ws");
  
    testConnection.onopen = () => {
      setConnectionStatus('Attempting to authenticate...');
  
      const authMessage = JSON.stringify({
        type: 'authenticate',
        deviceId: username,
        password: serverPassword
      });
  
      testConnection.send(authMessage);
    };
  
    testConnection.onmessage = async (event) => {
      try {
        const response = JSON.parse(event.data);
  
        if (response.successful === true) {
          setConnectionStatus('Connection successful and authenticated!');
          console.log("WebSocket authentication successful!");
  
          const userData = JSON.stringify({
            deviceId:  username,
            serverIp: "wss://4sw16n7h-3012.euw.devtunnels.ms/ws",
            password: serverPassword,
          });
          await storeValue(userData);
  
          const config: WebSocketConfig = {
            url: "wss://4sw16n7h-3012.euw.devtunnels.ms/ws",
            deviceId: username,
            password: "neopin123",
          };
          setWsConfig(config);

          testConnection.close()
  
        } else {
          setConnectionStatus('Authentication failed. Please check your credentials.');
          console.error("Authentication failed. Server response:", response);
        }
      } catch (error) {
        setConnectionStatus('Failed to parse response.');
        console.error("Error parsing WebSocket response:", error);
      }
    };
  
    testConnection.onerror = (event) => {
      setConnectionStatus('Connection failed. Please check the server IP or credentials.');
      console.error("WebSocket connection failed", event);
    };
    
    testConnection.onclose = (event) => {
      if (event.code === 4000) {
        setConnectionStatus('Connection failed: Unauthorized');
        console.log('WebSocket closed with unauthorized error');
      } else {
        setConnectionStatus('Connection closed unexpectedly');
        console.log('WebSocket connection closed with code: ' + event.code);
      }
    };
  };
  
  const handleGithubPress = () => {
    Linking.openURL('https://github.com/vxnsin/NeoPin');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
      <Icon name="wifi-tethering" size={100} color={colors.colors.primary} style={styles.iconTop} />
      <FloatingInput
        label="Hostname"
        customPlaceholder="ws://127.0.0.1:3012"
        value={serverIp}
        onChangeText={setServerIp}
        secure={false}
        animatedValue={animations.serverIp}
        icon="list"
        colors={colors}
      />
      <FloatingInput
        label="Password"
        value={serverPassword}
        onChangeText={setServerPassword}
        secure={true}
        animatedValue={animations.serverPassword}
        icon="lock"
        colors={colors}
      />
      <FloatingInput
        label="Username"
        customPlaceholder={deviceName}
        value={username}
        onChangeText={setUsername}
        secure={false}
        animatedValue={animations.username}
        icon="person"
        colors={colors}
      />
      <TouchableOpacity style={[styles.button, { backgroundColor: colors.colors.secondary }]} onPress={handleConnect}>
        <Text style={[styles.buttonText, { color: colors.colors.onSecondary }]}>Connect to Server</Text>
      </TouchableOpacity>
      
      {/* Display connection status */}
      {connectionStatus ? (
        <Text style={{ color: connectionStatus.includes('failed') ? 'red' : 'green' }}>
          {connectionStatus}
        </Text>
      ) : null}

      <TouchableOpacity style={styles.footer} onPress={handleGithubPress}>
        <FontAwesome name="github" size={24} color={colors.colors.primary} />
        <Text style={[styles.footerText, { color: colors.colors.primary }]}>{`v${pkg.version}`}</Text>
      </TouchableOpacity>
    </View>
  );
};


const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  iconTop: { position: 'absolute', top: 100 },
  button: { paddingVertical: 16, paddingHorizontal: 32, borderRadius: 28, marginTop: 30 },
  buttonText: { fontSize: 18, fontWeight: 'bold' },
  footer: { position: 'absolute', bottom: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  footerText: { marginLeft: 8, fontSize: 16 }
});

export default Login;
