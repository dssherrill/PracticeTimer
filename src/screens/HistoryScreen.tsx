import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAppColors } from '../theme';
import SessionListScreen from './history/SessionListScreen';
import SessionDetailScreen from './history/SessionDetailScreen';
import PracticeReportScreen from './history/PracticeReportScreen';

const Stack = createNativeStackNavigator();

export default function HistoryScreen() {
  const colors = useAppColors();

  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
      }}
    >
      <Stack.Screen
        name="SessionList"
        component={SessionListScreen}
        options={{ title: 'History', headerShown: false }}
      />
      <Stack.Screen
        name="SessionDetail"
        component={SessionDetailScreen}
        options={{ title: 'Session Detail' }}
      />
      <Stack.Screen
        name="PracticeReport"
        component={PracticeReportScreen}
        options={{ title: 'Practice Report' }}
      />
    </Stack.Navigator>
  );
}
