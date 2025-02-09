import React, { useState } from 'react';
import { View, TextInput, StyleSheet, TouchableOpacity, Text, Platform } from 'react-native';
import useThemeManager from '../hooks/useThemeManager';
import Icon from 'react-native-vector-icons/MaterialIcons'; 

const Login = () => {
  const colors = useThemeManager(); 
  const [username, setUsername] = useState('');
  const [serverIp, setServerIp] = useState('');
  const [serverPassword, setServerPassword] = useState('');

  const handleConnect = () => {
    console.log("Connecting to the server...");
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.colors.surface }]}>
      {/* Server IP Input */}
      <View style={styles.inputContainer}>
        <Icon name="list" size={24} color={colors.colors.primary} style={styles.icon} />
        <TextInput
          style={[styles.input, { borderColor: colors.colors.primary, color: colors.colors.primary }]}
          placeholder="Hostname"
          value={serverIp}
          onChangeText={setServerIp}
        />
      </View>

      {/* Server Password Input */}
      <View style={styles.inputContainer}>
        <Icon name="password" size={24} color={colors.colors.primary} style={styles.icon} />
        <TextInput
          style={[styles.input, { borderColor: colors.colors.primary, color: colors.colors.primary }]}
          placeholder="Password"
          value={serverPassword}
          onChangeText={setServerPassword}
          secureTextEntry
        />
      </View>

      {/* Username Input */}
      <View style={styles.inputContainer}>
        <Icon name="person" size={24} color={colors.colors.primary} style={styles.icon} />
        <TextInput
          style={[styles.input, { borderColor: colors.colors.primary, color: colors.colors.primary }]}
          placeholder="Username"
          value={username}
          onChangeText={setUsername}
        />
      </View>
      
      <TouchableOpacity
        style={[styles.button, { backgroundColor: colors.colors.secondary }]}  
        onPress={handleConnect}
      >
        <Text style={[styles.buttonText, { color: colors.colors.onSecondary }]}>Connect to Server</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center', 
    padding: 20,
  },
  inputContainer: {
    flexDirection: 'row', 
    alignItems: 'center',
    width: '100%',
    marginBottom: 15,
    borderRadius: 25,
    paddingLeft: 10,
    paddingRight: 30,  
  },
  icon: {
    marginRight: 10,  
  },
  input: {
    flex: 1, 
    paddingVertical: 20,
    paddingHorizontal: 20,
    borderRadius: 25,
    borderWidth: 1,
  },
  button: {
    paddingVertical: 25,
    paddingHorizontal: 20,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default Login;
