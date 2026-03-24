import React from 'react';
import { useColorScheme, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import SessionSimpleScreen from './src/screens/SessionSimpleScreen';
import SessionDetailScreen from './src/screens/SessionDetailScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { useAppColors } from './src/theme';
import { SettingsProvider } from './src/contexts/SettingsContext';
import { SessionProvider } from './src/contexts/SessionContext';

const Tab = createBottomTabNavigator();

export default function App() {
  const scheme = useColorScheme();
  const colors = useAppColors();

  const navTheme = scheme === 'dark'
    ? {
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: colors.background,
          card: colors.tabBar,
          border: colors.tabBarBorder,
          primary: colors.tabBarActive,
          text: colors.text,
        },
      }
    : {
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          background: colors.background,
          card: colors.tabBar,
          border: colors.tabBarBorder,
          primary: colors.tabBarActive,
          text: colors.text,
        },
      };

  return (
    <SettingsProvider>
    <SessionProvider>
    <NavigationContainer theme={navTheme}>
      <Tab.Navigator
        screenOptions={{
          tabBarActiveTintColor: colors.tabBarActive,
          tabBarInactiveTintColor: colors.tabBarInactive,
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
        }}
      >
        <Tab.Screen
          name="SessionSimple"
          component={SessionSimpleScreen}
          options={{
            title: 'Simple',
            tabBarIcon: ({ color, size }) => <Text style={{ fontSize: size, color }}>▶</Text>,
          }}
        />
        <Tab.Screen
          name="SessionDetail"
          component={SessionDetailScreen}
          options={{
            title: 'Detail',
            tabBarIcon: ({ color, size }) => <Text style={{ fontSize: size, color }}>☰</Text>,
          }}
        />
        <Tab.Screen
          name="History"
          component={HistoryScreen}
          options={{
            title: 'History',
            tabBarIcon: ({ color, size }) => <Text style={{ fontSize: size, color }}>📋</Text>,
            headerShown: false,
          }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsScreen}
          options={{
            title: 'Settings',
            tabBarIcon: ({ color, size }) => <Text style={{ fontSize: size, color }}>⚙</Text>,
          }}
        />
      </Tab.Navigator>
      <StatusBar style="auto" />
    </NavigationContainer>
    </SessionProvider>
    </SettingsProvider>
  );
}
