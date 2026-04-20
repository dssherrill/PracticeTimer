import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Switch } from 'react-native';
import Slider from '@react-native-community/slider';
import { useFocusEffect } from '@react-navigation/native';
import { useAppColors } from '../theme';
import { useSettings } from '../contexts/SettingsContext';
import { useSession } from '../contexts/SessionContext';
import { useMicMeter } from '../hooks/useMicMeter';
import { getCumulativeStats, resetCumulativeStats, getSessions, deleteAllSessions } from '../utils/storage';
import { formatHuman } from '../utils/format';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File as FSFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import type { CumulativeStats } from '../types';

/**
 * Isolated component that owns the useAudioRecorder hook.
 * Mounting it allocates the native recorder; unmounting releases it.
 * This prevents it from competing with the session's recorder.
 */
function LocalMicMeter({ onUpdate }: { onUpdate: (level: number, active: boolean) => void }) {
  const { level, isActive, start, stop } = useMicMeter();

  useEffect(() => {
    start();
    return () => { stop(); };
  }, [start, stop]);

  useEffect(() => {
    onUpdate(level, isActive);
  }, [level, isActive, onUpdate]);

  return null;
}

export default function SettingsScreen() {
  const colors = useAppColors();
  const { settings, updateSettings } = useSettings();
  const { status: sessionStatus, micLevel: sessionMicLevel } = useSession();
  const sessionActive = sessionStatus !== 'idle';
  const [localLevel, setLocalLevel] = useState(0);
  const [localActive, setLocalActive] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [stats, setStats] = useState<CumulativeStats | null>(null);

  // Track focus so we only mount the local recorder when this tab is visible
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => { setIsFocused(false); };
    }, []),
  );

  const handleMicUpdate = useCallback((level: number, active: boolean) => {
    setLocalLevel(level);
    setLocalActive(active);
  }, []);

  // When a session is active, show its mic level; otherwise use the local meter
  const displayLevel = sessionActive ? sessionMicLevel : localLevel;
  const displayActive = sessionActive || localActive;

  // Reload cumulative stats every time the tab is focused
  useFocusEffect(
    useCallback(() => {
      getCumulativeStats().then(setStats);
    }, []),
  );

  const handleResetStats = () => {
    Alert.alert(
      'Reset Statistics',
      'This will permanently reset all cumulative statistics. Session history will not be affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await resetCumulativeStats();
            setStats(await getCumulativeStats());
          },
        },
      ],
    );
  };

  // Compute period totals from daily breakdown
  const periodTotals = (() => {
    if (!stats) return null;
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);

    // Start of current ISO week (Monday)
    const dayOfWeek = today.getDay(); // 0=Sun
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(today);
    monday.setDate(today.getDate() - mondayOffset);
    const weekStartKey = monday.toISOString().slice(0, 10);

    // Start of current month
    const monthStartKey = todayKey.slice(0, 7) + '-01';

    let weekPlay = 0, weekTotal = 0;
    let monthPlay = 0, monthTotal = 0;

    for (const [day, dt] of Object.entries(stats.dailyTotals)) {
      if (day >= weekStartKey && day <= todayKey) {
        weekPlay += dt.playTime;
        weekTotal += dt.totalDuration;
      }
      if (day >= monthStartKey && day <= todayKey) {
        monthPlay += dt.playTime;
        monthTotal += dt.totalDuration;
      }
    }

    return { weekPlay, weekTotal, monthPlay, monthTotal };
  })();

  const thresholdNorm = settings.sensitivityThreshold; // 0–1

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      {/* Mount the local recorder ONLY when focused and no session is active.
          Unmounting fully releases the native AudioRecorder resource. */}
      {isFocused && !sessionActive && (
        <LocalMicMeter onUpdate={handleMicUpdate} />
      )}

      {/* ── Sensitivity ─────────────────────────────── */}
      <Text style={[styles.sectionTitle, { color: colors.text }]}>Sensitivity</Text>

      {/* Live mic level bar */}
      <View style={[styles.meterContainer, { borderColor: colors.border }]}>
        {/* Level fill */}
        <View
          style={[
            styles.meterFill,
            {
              width: `${Math.round(displayLevel * 100)}%`,
              backgroundColor: displayLevel >= thresholdNorm ? colors.playing : colors.resting,
            },
          ]}
        />
        {/* Threshold line */}
        <View
          style={[
            styles.thresholdLine,
            { left: `${Math.round(thresholdNorm * 100)}%`, backgroundColor: colors.danger },
          ]}
        />
      </View>

      <Text style={[styles.label, { color: colors.textSecondary }]}>
        {displayActive
          ? displayLevel >= thresholdNorm
            ? 'Sound detected — PLAYING'
            : 'Below threshold — silence'
          : 'Microphone not active'}
      </Text>

      <Text style={[styles.label, { color: colors.text }]}>
        Threshold: {Math.round(thresholdNorm * 100)}%
      </Text>
      <Slider
        style={styles.slider}
        minimumValue={0.05}
        maximumValue={0.95}
        step={0.01}
        value={thresholdNorm}
        onValueChange={(v) => updateSettings({ sensitivityThreshold: v })}
        minimumTrackTintColor={colors.primary}
        maximumTrackTintColor={colors.border}
        thumbTintColor={colors.primary}
      />

      {/* ── Min Rest Duration ───────────────────────── */}
      <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 32 }]}>
        Minimum Rest Duration
      </Text>
      <Text style={[styles.label, { color: colors.text }]}>
        {settings.minRestDuration} second{settings.minRestDuration !== 1 ? 's' : ''}
      </Text>
      <Slider
        style={styles.slider}
        minimumValue={1}
        maximumValue={30}
        step={1}
        value={settings.minRestDuration}
        onValueChange={(v) => updateSettings({ minRestDuration: v })}
        minimumTrackTintColor={colors.primary}
        maximumTrackTintColor={colors.border}
        thumbTintColor={colors.primary}
      />
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        Silence shorter than this is counted as continuous playing.
      </Text>

      {/* ── Min Play Duration ──────────────────────── */}
      <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 32 }]}>
        Minimum Play Duration
      </Text>
      <Text style={[styles.label, { color: colors.text }]}>
        {settings.minPlayDuration} second{settings.minPlayDuration !== 1 ? 's' : ''}
      </Text>
      <Slider
        style={styles.slider}
        minimumValue={1}
        maximumValue={30}
        step={1}
        value={settings.minPlayDuration}
        onValueChange={(v) => updateSettings({ minPlayDuration: v })}
        minimumTrackTintColor={colors.primary}
        maximumTrackTintColor={colors.border}
        thumbTintColor={colors.primary}
      />
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        Sound shorter than this is ignored. Filters coughs and page turns.
      </Text>

      {/* ── Music Detection ──────────────────────── */}
      <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 32 }]}>
        Music Detection
      </Text>

      <View style={styles.toggleRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.text }]}>
            Filter non-music sounds
          </Text>
          <Text style={[styles.hint, { color: colors.textSecondary, marginTop: 2 }]}>
            Distinguishes sustained instrument tones from speech and noise.
          </Text>
        </View>
        <Switch
          value={settings.musicDetectionEnabled}
          onValueChange={(v) => updateSettings({ musicDetectionEnabled: v })}
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor={settings.musicDetectionEnabled ? colors.primary : colors.textSecondary}
        />
      </View>

      {settings.musicDetectionEnabled && (
        <>
          <Text style={[styles.label, { color: colors.text, marginTop: 16 }]}>
            Strictness: {Math.round(settings.musicDetectionStrictness * 100)}%
          </Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            step={0.05}
            value={settings.musicDetectionStrictness}
            onValueChange={(v) => updateSettings({ musicDetectionStrictness: v })}
            minimumTrackTintColor={colors.primary}
            maximumTrackTintColor={colors.border}
            thumbTintColor={colors.primary}
          />
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            Low = permissive (more sounds count as music). High = strict (only clear sustained tones).
          </Text>
        </>
      )}

      {/* ── Cumulative Statistics ──────────────────── */}
      <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 32 }]}>
        Cumulative Statistics
      </Text>

      {stats && periodTotals ? (
        <View style={[styles.statsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <StatRow label="Sessions" value={String(stats.sessionCount)} colors={colors} />
          <StatRow label="All-time total" value={formatHuman(stats.allTimeTotalDuration)} colors={colors} />
          <StatRow label="All-time play" value={formatHuman(stats.allTimePlayTime)} colors={colors} />
          <StatRow label="All-time rest" value={formatHuman(stats.allTimeRestTime)} colors={colors} />
          <StatRow
            label="Avg session"
            value={stats.sessionCount > 0 ? formatHuman(stats.allTimeTotalDuration / stats.sessionCount) : '—'}
            colors={colors}
          />
          <View style={[styles.statsDivider, { backgroundColor: colors.border }]} />
          <StatRow label="This week play" value={formatHuman(periodTotals.weekPlay)} colors={colors} />
          <StatRow label="This week total" value={formatHuman(periodTotals.weekTotal)} colors={colors} />
          <StatRow label="This month play" value={formatHuman(periodTotals.monthPlay)} colors={colors} />
          <StatRow label="This month total" value={formatHuman(periodTotals.monthTotal)} colors={colors} />
        </View>
      ) : (
        <Text style={{ color: colors.textSecondary }}>Loading…</Text>
      )}

      <TouchableOpacity
        style={[styles.resetButton, { borderColor: colors.danger }]}
        onPress={handleResetStats}
      >
        <Text style={{ color: colors.danger, fontWeight: '600' }}>Reset Statistics</Text>
      </TouchableOpacity>

      {/* ── Data Recovery ─────────────────────────── */}
      <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 32 }]}>
        Data Recovery
      </Text>
      <TouchableOpacity
        style={[styles.resetButton, { borderColor: colors.primary }]}
        onPress={async () => {
          try {
            const sessions = await getSessions();
            const stats = await getCumulativeStats();
            const pieceNames = await AsyncStorage.getItem('@PracticeTimer:pieceNames');
            const backup = JSON.stringify({
              sessions,
              cumulativeStats: stats,
              pieceNames: pieceNames ? JSON.parse(pieceNames) : [],
              exportedAt: new Date().toISOString(),
            });
            const date = new Date().toISOString().slice(0, 10);
            const fileName = `PracticeTimer-backup-${date}.json`;
            const file = new FSFile(Paths.cache, fileName);
            await file.write(backup);
            await Sharing.shareAsync(file.uri, {
              mimeType: 'application/json',
              dialogTitle: 'Save Backup',
              UTI: 'public.json',
            });
          } catch (e: any) {
            console.error('Export failed:', e);
            Alert.alert('Error', e?.message ?? 'Failed to export backup.');
          }
        }}
      >
        <Text style={{ color: colors.primary, fontWeight: '600' }}>Export Backup to File</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.resetButton, { borderColor: colors.primary }]}
        onPress={async () => {
          try {
            const result = await DocumentPicker.getDocumentAsync({
              type: 'application/json',
              copyToCacheDirectory: true,
            });
            if (result.canceled) return;
            const asset = result.assets[0];
            if (!asset) return;
            const pickedFile = new FSFile(asset.uri);
            const content = await pickedFile.text();
            let data: any;
            try {
              data = JSON.parse(content);
            } catch {
              Alert.alert('Error', 'The selected file is not valid JSON.');
              return;
            }
            if (!data.sessions || !Array.isArray(data.sessions)) {
              Alert.alert('Error', 'The file does not contain valid backup data.');
              return;
            }
            const count = data.sessions.length;
            Alert.alert(
              'Restore from File',
              `This backup contains ${count} session(s)${data.exportedAt ? ` (exported ${new Date(data.exportedAt).toLocaleDateString()})` : ''}. This will replace your current data.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Restore',
                  style: 'destructive',
                  onPress: async () => {
                    await AsyncStorage.setItem('@PracticeTimer:sessions', JSON.stringify(data.sessions));
                    if (data.cumulativeStats) {
                      await AsyncStorage.setItem('@PracticeTimer:cumulativeStats', JSON.stringify(data.cumulativeStats));
                    }
                    if (Array.isArray(data.pieceNames)) {
                      await AsyncStorage.setItem('@PracticeTimer:pieceNames', JSON.stringify(data.pieceNames));
                    }
                    setStats(await getCumulativeStats());
                    Alert.alert('Restored', `${count} session(s) restored from file.`);
                  },
                },
              ],
            );
          } catch (e: any) {
            console.error('Import failed:', e);
            Alert.alert('Error', e?.message ?? 'Failed to import backup.');
          }
        }}
      >
        <Text style={{ color: colors.primary, fontWeight: '600' }}>Restore from File</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.resetButton, { borderColor: colors.primary }]}
        onPress={async () => {
          try {
            const backup = await AsyncStorage.getItem('@PracticeTimer:sessionsBackup');
            if (!backup) {
              Alert.alert('No Backup', 'No session backup is available.');
              return;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(backup);
            } catch {
              Alert.alert('Error', 'Backup data is corrupted and cannot be restored.');
              return;
            }
            if (!Array.isArray(parsed)) {
              Alert.alert('Error', 'Backup data is not in the expected format.');
              return;
            }
            const count = parsed.length;
            Alert.alert(
              'Restore Sessions',
              `Restore ${count} session(s) from backup? This will replace your current session history.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Restore',
                  onPress: async () => {
                    await AsyncStorage.setItem('@PracticeTimer:sessions', backup);
                    Alert.alert('Restored', `${count} session(s) restored from backup.`);
                  },
                },
              ],
            );
          } catch (e: any) {
            console.error('Restore failed:', e);
            Alert.alert('Error', e?.message ?? 'Failed to restore sessions.');
          }
        }}
      >
        <Text style={{ color: colors.primary, fontWeight: '600' }}>Restore Sessions from Backup</Text>
      </TouchableOpacity>

      {/* ── Delete All History ────────────────────── */}
      <Text style={[styles.sectionTitle, { color: colors.text, marginTop: 32 }]}>
        History
      </Text>
      <TouchableOpacity
        style={[styles.resetButton, { borderColor: colors.danger }]}
        onPress={() => {
          Alert.alert(
            'Delete All History',
            'This will delete all session history. Cumulative statistics will not be affected.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete All',
                style: 'destructive',
                onPress: async () => {
                  try {
                    await deleteAllSessions();
                    Alert.alert('Deleted', 'All session history has been deleted.');
                  } catch (e: any) {
                    console.error('Delete all failed:', e);
                    Alert.alert('Error', e?.message ?? 'Failed to delete session history.');
                  }
                },
              },
            ],
          );
        }}
      >
        <Text style={{ color: colors.danger, fontWeight: '600' }}>Delete All History</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function StatRow({ label, value, colors }: { label: string; value: string; colors: any }) {
  return (
    <View style={styles.statRow}>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 48 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  label: { fontSize: 14, marginBottom: 4 },
  hint: { fontSize: 12, marginTop: 4 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  slider: { width: '100%', height: 40, marginVertical: 8 },
  meterContainer: {
    width: '100%',
    height: 32,
    borderRadius: 6,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 8,
    position: 'relative',
  },
  meterFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 5,
  },
  thresholdLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
  },
  statsCard: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  statLabel: { fontSize: 14 },
  statValue: { fontSize: 14, fontWeight: '600' },
  statsDivider: { height: 1, marginVertical: 6 },
  resetButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 24,
  },
});
