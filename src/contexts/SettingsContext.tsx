import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Settings } from '../types';

const SETTINGS_KEY = '@PracticeTimer:settings';

const DEFAULT_SETTINGS: Settings = {
  sensitivityThreshold: 0.5,
  minRestDuration: 5,
  minPlayDuration: 30,
  musicDetectionEnabled: false,
  musicDetectionStrictness: 0.3,
};

interface SettingsContextValue {
  settings: Settings;
  updateSettings: (partial: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  updateSettings: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((json) => {
      if (json) {
        try {
          const saved = JSON.parse(json) as Partial<Settings>;
          setSettings((prev) => ({ ...prev, ...saved }));
        } catch {}
      }
      setLoaded(true);
    });
  }, []);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  if (!loaded) return null;

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
