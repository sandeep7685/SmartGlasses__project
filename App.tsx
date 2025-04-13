import React, { useEffect, useState, useCallback, useRef } from 'react';

import {
  SafeAreaView,
  StyleSheet,
  Text,
  View,
  Switch,
  Platform,
  StatusBar,
  ScrollView,
  Alert,
  PermissionsAndroid,
  AppRegistry,
} from 'react-native';

import Geolocation from '@react-native-community/geolocation';
import MQTT, { IMqttClient } from 'sp-react-native-mqtt';
import RNAndroidNotificationListener, { RNAndroidNotificationListenerHeadlessJsName } from 'react-native-android-notification-listener';

import { OPEN_WEATHER_MAP_API_KEY } from '@env';

interface MQTTConfig {
  host: string;
  port: number;
  clientId: string;
}

interface WeatherTimestamp {
  DayDateTime: string;
  TemperatureWeather: string;
}

const mqttConfig: MQTTConfig = {
  host: 'broker.emqx.io',
  port: 1883,
  clientId: `mobile_${Math.random().toString(16).slice(3)}`,
};

const WEATHER_UPDATE_INTERVAL = 30000; // 30 seconds

const App: React.FC = () => {
  const [client, setClient] = useState<IMqttClient | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(false);
  const [weatherTimestamp, setWeatherTimestamp] = useState<WeatherTimestamp>({
    temperature: '',
    weather: '',
  });
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);

  const weatherInterval = useRef<NodeJS.Timeout | null>(null);

  const checkPermission = async () => {
    const status = await RNAndroidNotificationListener.getPermissionStatus();
    if (status !== 'authorized') {
      Alert.alert(
        'Permission Required',
        'The app needs notification listener permission to forward notifications. Would you like to open the settings to grant permission?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open Settings',
            onPress: async () => {
              try {
                await RNAndroidNotificationListener.requestPermission();
              } catch (error) {
                Alert.alert('Error', 'Unable to open settings. Please enable the permission manually.');
              }
            },
          },
        ]
      );
    }
  };

const checkPhonePermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
          {
            title: 'Phone State Permission',
            message: 'This app needs access to phone state to forward call notifications.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          },
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch (err) {
        console.error('Error requesting phone permission:', err);
        return false;
      }
    }
    return true;
  };

  const requestLocationPermission = async () => {
    if (Platform.OS === 'ios') {
      Geolocation.requestAuthorization();
      getLocation();
    } else {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location Permission',
            message: 'This app needs access to location to fetch weather data.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          },
        );
        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          getLocation();
        }
      } catch (err) {
        console.error('Error requesting location permission:', err);
      }
    }
  };

  const getLocation = () => {
    Geolocation.getCurrentPosition(
      position => {
        setLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      error => console.error('Error getting location:', error),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 },
    );
  };

  const fetchWeatherTimestamp = useCallback(async () => {
    if (!location) {
      return;
    }

    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${location.latitude}&lon=${location.longitude}&appid=${OPEN_WEATHER_MAP_API_KEY}&units=metric`
      );
      const data = await response.json();

      const options = { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' };
      const DDT = new Date(data.dt * 1000).toLocaleDateString('en-US', options);

      const place = data.name
      const temperature = Math.round(data.main.temp).toString();
      const weather = data.weather[0].main

      const newWeatherTimestamp = {
        DayDateTime: DDT,
//         TemperatureWeather: `${place}, ${temperature}°C ${weather}`,
        TemperatureWeather: place.concat(" ,", temperature, "°C ", weather),
      };

      setWeatherTimestamp(newWeatherTimestamp);

      if (client && isConnected) {
        publishWeatherTimestamp(newWeatherTimestamp);
      }
    } catch (error) {
      console.error('Error fetching weather:', error);
    }
  }, [location, client, isConnected]);

  const setupMQTTClient = useCallback(async () => {
    try {
      const mqttClient = await MQTT.createClient({
        uri: `mqtt://${mqttConfig.host}:${mqttConfig.port}`,
        clientId: mqttConfig.clientId,
        keepalive: 60,
        clean: true,
        auth: false,
        reconnect: true,
      });

      mqttClient.on('connect', () => {
        setIsConnected(true);
      });

      mqttClient.on('closed', () => {
        setIsConnected(false);
      });

      mqttClient.connect();
      setClient(mqttClient);
    } catch (error) {
      Alert.alert('Setup Error', 'Failed to initialize MQTT client.');
    }
  }, []);

  const publishWeatherTimestamp = useCallback(
    (data: WeatherTimestamp) => {
      if (client && isConnected) {
              const weatherPayload = JSON.stringify({
                DayDateTime: data.DayDateTime,
                TemperatureWeather: data.TemperatureWeather
              });
              client.publish('flutter/weather_data', weatherPayload, 2, false);
      }
    },
    [client, isConnected]
  );

  const forwardNotification = useCallback(
      async (notification: any) => {
        if (client && isConnected && notificationsEnabled) {
          const notificationObj = JSON.parse(notification.notification);
          const { title, text, app } = notificationObj;
          const message = `${app}: ${title} - ${text}`;
          console.log(message);
          client.publish('flutter/notification', message, 2, false);
        }
      },
      [client, isConnected, notificationsEnabled]
  );

  useEffect(() => {
    requestLocationPermission();
    checkPhonePermissions();
    checkPermission();
    setupMQTTClient();

    return () => {
      if (client) {
        client.disconnect();
      }
      if (weatherInterval.current) {
        clearInterval(weatherInterval.current);
      }
    };
  }, [setupMQTTClient]);

  useEffect(() => {
    if (location) {
      fetchWeatherTimestamp();

      if (weatherInterval.current) {
        clearInterval(weatherInterval.current);
      }

      weatherInterval.current = setInterval(fetchWeatherTimestamp, WEATHER_UPDATE_INTERVAL);
    }

    return () => {
      if (weatherInterval.current) {
        clearInterval(weatherInterval.current);
      }
    };
  }, [location, fetchWeatherTimestamp]);

//   useEffect(() => {
    if(!AppRegistry.getRunnable(RNAndroidNotificationListenerHeadlessJsName)) {
      AppRegistry.registerHeadlessTask(
        RNAndroidNotificationListenerHeadlessJsName,
        () => forwardNotification
      );
    }
//   }, []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle={Platform.OS === 'ios' ? 'dark-content' : 'light-content'} />
      <ScrollView style={styles.content}>
        <Text style={styles.statusText}>
          MQTT Status: {isConnected ? 'Connected' : 'Disconnected'}
        </Text>

        <View style={styles.weatherInfo}>
          <Text style={styles.label}>
            Weather Snapshot
          </Text>
          <Text style={styles.weatherText}>
            {weatherTimestamp.DayDateTime}
          </Text>
          <Text style={styles.weatherText}>
            {weatherTimestamp.TemperatureWeather}
          </Text>
        </View>

        <View style={styles.notificationControl}>
          <Text style={styles.notifyLabel}>Forward Notifications</Text>
          <Switch
            value={notificationsEnabled}
            onValueChange={setNotificationsEnabled}
            trackColor={{ false: '#767577', true: '#81b0ff' }}
            thumbColor={notificationsEnabled ? '#007AFF' : '#f4f3f4'}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    flex: 1,
    padding: 20,
  },
  statusText: {
    fontSize: 18,
    marginBottom: 20,
    textAlign: 'center',
    fontWeight: '500',
  },
  weatherInfo: {
    backgroundColor: 'white',
    padding: 15,
    borderRadius: 10,
    marginBottom: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  weatherText: {
    fontSize: 16,
    marginBottom: 8,
  },
  label: {
    fontSize: 18,
    fontWeight: '500',
    marginBottom: 8
  },
  notifyLabel: {
    fontSize: 18,
    fontWeight: '500',
  },
  notificationControl: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'white',
    padding: 15,
    borderRadius: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
});

export default App;