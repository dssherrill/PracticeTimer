import { useColorScheme } from 'react-native';

const LightColors = {
  background: '#ffffff',
  surface: '#f5f5f5',
  text: '#1a1a1a',
  textSecondary: '#666666',
  border: '#e0e0e0',
  playing: '#22c55e',       // green
  resting: '#f59e0b',       // amber
  paused: '#9ca3af',        // gray
  primary: '#3b82f6',       // blue
  danger: '#ef4444',        // red
  tabBar: '#ffffff',
  tabBarBorder: '#e0e0e0',
  tabBarActive: '#3b82f6',
  tabBarInactive: '#9ca3af',
  card: '#ffffff',
};

const DarkColors: typeof LightColors = {
  background: '#121212',
  surface: '#1e1e1e',
  text: '#f0f0f0',
  textSecondary: '#a0a0a0',
  border: '#333333',
  playing: '#4ade80',
  resting: '#fbbf24',
  paused: '#6b7280',
  primary: '#60a5fa',
  danger: '#f87171',
  tabBar: '#1e1e1e',
  tabBarBorder: '#333333',
  tabBarActive: '#60a5fa',
  tabBarInactive: '#6b7280',
  card: '#1e1e1e',
};

export type AppColors = typeof LightColors;

export function useAppColors(): AppColors {
  const scheme = useColorScheme();
  return scheme === 'dark' ? DarkColors : LightColors;
}
