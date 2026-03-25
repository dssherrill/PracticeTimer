import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { useAppColors } from '../../theme';
import { SessionRecord } from '../../types';
import { getSessions, deleteSession, deleteAllSessions } from '../../utils/storage';
import { formatHMS } from '../../utils/format';

export default function SessionListScreen() {
  const colors = useAppColors();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const listRef = useRef<FlatList<SessionRecord>>(null);

  useFocusEffect(
    useCallback(() => {
      getSessions().then((loaded) => {
        setSessions(loaded);
        const scrollToDate = route.params?.scrollToDate as string | undefined;
        if (scrollToDate && loaded.length > 0) {
          // Find first session matching the target date (local YYYY-MM-DD)
          const idx = loaded.findIndex((s) => {
            const d = new Date(s.date);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            return key === scrollToDate;
          });
          if (idx >= 0) {
            // Delay to let the list render first
            setTimeout(() => {
              listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
            }, 300);
          }
          // Clear the param so it doesn't re-scroll on next focus
          navigation.setParams({ scrollToDate: undefined });
        }
      });
    }, [route.params?.scrollToDate])
  );

  const handleDelete = (id: string) => {
    Alert.alert('Delete Session', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteSession(id);
          setSessions((prev) => prev.filter((s) => s.id !== id));
        },
      },
    ]);
  };

  const handleDeleteAll = () => {
    Alert.alert(
      'Delete All History',
      'This will delete all session history. Cumulative statistics will not be affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All',
          style: 'destructive',
          onPress: async () => {
            await deleteAllSessions();
            setSessions([]);
          },
        },
      ],
    );
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const renderSession = ({ item }: { item: SessionRecord }) => {
    const ratio =
      item.playTime + item.restTime > 0
        ? Math.round((item.playTime / (item.playTime + item.restTime)) * 100)
        : 0;

    return (
      <TouchableOpacity
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        onPress={() => navigation.navigate('SessionDetail', { sessionId: item.id })}
        onLongPress={() => handleDelete(item.id)}
      >
        <View style={styles.cardHeader}>
          <Text style={[styles.cardDate, { color: colors.text }]}>{formatDate(item.date)}</Text>
          <Text style={[styles.cardTime, { color: colors.textSecondary }]}>{formatTime(item.date)}</Text>
        </View>
        <View style={styles.cardStats}>
          <View style={styles.cardStat}>
            <Text style={[styles.cardStatLabel, { color: colors.textSecondary }]}>Total</Text>
            <Text style={[styles.cardStatValue, { color: colors.text }]}>{formatHMS(item.totalDuration)}</Text>
          </View>
          <View style={styles.cardStat}>
            <Text style={[styles.cardStatLabel, { color: colors.textSecondary }]}>Play</Text>
            <Text style={[styles.cardStatValue, { color: colors.playing }]}>{formatHMS(item.playTime)}</Text>
          </View>
          <View style={styles.cardStat}>
            <Text style={[styles.cardStatLabel, { color: colors.textSecondary }]}>Rest</Text>
            <Text style={[styles.cardStatValue, { color: colors.resting }]}>{formatHMS(item.restTime)}</Text>
          </View>
          <View style={styles.cardStat}>
            <Text style={[styles.cardStatLabel, { color: colors.textSecondary }]}>Play%</Text>
            <Text style={[styles.cardStatValue, { color: colors.text }]}>{ratio}%</Text>
          </View>
        </View>
        {item.notes ? (
          <Text style={[styles.cardNotes, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.notes}
          </Text>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        ref={listRef}
        data={sessions}
        keyExtractor={(item) => item.id}
        renderItem={renderSession}
        contentContainerStyle={styles.listContent}
onScrollToIndexFailed={(info) => {
  const offset = info.averageItemLength * info.index;
  listRef.current?.scrollToOffset({ offset, animated: true });
}}        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No sessions recorded yet.
          </Text>
        }
        ListHeaderComponent={
          sessions.length > 0 ? (
            <View style={styles.headerRow}>
              <View style={styles.headerBtnGroup}>
                <TouchableOpacity
                  style={[styles.reportBtn, { backgroundColor: colors.primary }]}
                  onPress={() => navigation.navigate('PracticeReport')}
                >
                  <Text style={styles.reportBtnText}>Report</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.reportBtn, { backgroundColor: colors.primary }]}
                  onPress={() => navigation.navigate('Calendar')}
                >
                  <Text style={styles.reportBtnText}>Calendar</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={handleDeleteAll}>
                <Text style={[styles.deleteAllText, { color: colors.danger }]}>Delete All</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 32 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  headerBtnGroup: { flexDirection: 'row', gap: 8 },
  reportBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6 },
  reportBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  deleteAllText: { fontSize: 14, fontWeight: '600' },
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  cardDate: { fontSize: 15, fontWeight: '600' },
  cardTime: { fontSize: 13 },
  cardStats: { flexDirection: 'row', justifyContent: 'space-between' },
  cardStat: { alignItems: 'center' },
  cardStatLabel: { fontSize: 11, marginBottom: 2 },
  cardStatValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  cardNotes: { fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  emptyText: { textAlign: 'center', marginTop: 48, fontSize: 15 },
});
