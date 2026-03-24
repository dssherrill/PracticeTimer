import React, { useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
} from 'react-native';
import { useAppColors } from '../theme';
import { useSession } from '../contexts/SessionContext';
import { formatHMS } from '../utils/format';
import { computeDisplayPairs, computeLivePairs } from '../utils/pairs';
import type { DisplayPair } from '../types';

export default function SessionDetailScreen() {
  const colors = useAppColors();
  const {
    status,
    elapsed,
    playTime,
    restTime,
    micLevel,
    intervals,
    pairBoundaries,
    start,
    stop,
    pause,
    resume,
    nextPair,
    pendingSession,
  } = useSession();

  const isRunning = status !== 'idle' && !pendingSession;

  const pairs = useMemo(() => {
    const list = isRunning
      ? computeLivePairs(intervals, pairBoundaries, playTime, restTime)
      : computeDisplayPairs(intervals, pairBoundaries);
    // Reverse so the current/latest section is at the top
    return list.slice().reverse();
  }, [intervals, pairBoundaries, playTime, restTime, isRunning]);

  const totalPairs = pairs.length;
  const listRef = useRef<FlatList<DisplayPair>>(null);

  let statusLabel = 'READY';
  let statusColor = colors.textSecondary;
  if (status === 'waiting') { statusLabel = 'LISTENING…'; statusColor = colors.textSecondary; }
  else if (status === 'playing') { statusLabel = 'PLAYING'; statusColor = colors.playing; }
  else if (status === 'resting') { statusLabel = 'RESTING'; statusColor = colors.resting; }
  else if (status === 'paused') { statusLabel = 'PAUSED'; statusColor = colors.paused; }

  const handleStartStop = async () => {
    if (isRunning) stop();
    else if (!pendingSession) await start();
  };

  const handlePauseResume = () => {
    if (status === 'paused') resume();
    else pause();
  };

  const renderPair = ({ item, index }: { item: DisplayPair; index: number }) => (
    <View
      style={[
        styles.pairRow,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.pairHeader}>
        <Text style={[styles.pairNum, { color: colors.text }]}>Section {totalPairs - index}</Text>
        {item.pieceName ? (
          <Text style={[styles.pairName, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.pieceName}
          </Text>
        ) : null}
      </View>
      <View style={styles.pairStats}>
        <Text style={[styles.pairStatText, { color: colors.playing }]}>
          Play: {formatHMS(item.playTime)}
        </Text>
        <Text style={[styles.pairStatText, { color: colors.resting }]}>
          Rest: {formatHMS(item.restTime)}
        </Text>
        <Text style={[styles.pairStatText, { color: colors.text }]}>
          Total: {formatHMS(item.totalTime)}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.status, { color: statusColor }]}>{statusLabel}</Text>
        <Text style={[styles.timer, { color: colors.text }]}>{formatHMS(elapsed)}</Text>

        {isRunning && (
          <View style={[styles.meterContainer, { borderColor: colors.border }]}>
            <View
              style={[
                styles.meterFill,
                {
                  width: `${Math.round(micLevel * 100)}%`,
                  backgroundColor: status === 'playing' ? colors.playing : colors.resting,
                },
              ]}
            />
          </View>
        )}

        <View style={styles.statsRow}>
          <Text style={[styles.statText, { color: colors.playing }]}>
            Play: {formatHMS(playTime)}
          </Text>
          <Text style={[styles.statText, { color: colors.resting }]}>
            Rest: {formatHMS(restTime)}
          </Text>
        </View>
      </View>

      {/* Pairs list */}
      <FlatList
        ref={listRef}
        data={pairs}
        keyExtractor={(_, i) => i.toString()}
        renderItem={renderPair}
        contentContainerStyle={styles.listContent}
        style={styles.list}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {isRunning ? 'Sections will appear here…' : 'Start a session to see sections.'}
          </Text>
        }
      />

      {/* Buttons */}
      <View style={styles.buttonsRow}>
        <TouchableOpacity
          style={[
            styles.btn,
            { backgroundColor: isRunning ? colors.danger : colors.playing },
          ]}
          onPress={handleStartStop}
          disabled={!!pendingSession}
        >
          <Text style={styles.btnText}>{isRunning ? 'STOP' : 'START'}</Text>
        </TouchableOpacity>

        {isRunning && (
          <>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.paused }]}
              onPress={handlePauseResume}
            >
              <Text style={styles.btnText}>{status === 'paused' ? 'RESUME' : 'PAUSE'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.primary }]}
              onPress={nextPair}
            >
              <Text style={styles.btnText}>NEXT</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { alignItems: 'center', paddingTop: 12, paddingBottom: 8, paddingHorizontal: 24 },
  status: { fontSize: 14, fontWeight: '600', letterSpacing: 2, marginBottom: 4 },
  timer: { fontSize: 36, fontWeight: '200', fontVariant: ['tabular-nums'], marginBottom: 8 },
  meterContainer: {
    width: '70%',
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 8,
  },
  meterFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3 },
  statsRow: { flexDirection: 'row', gap: 20, marginBottom: 4 },
  statText: { fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 16 },
  emptyText: { textAlign: 'center', marginTop: 32, fontSize: 14 },
  pairRow: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginVertical: 4,
  },
  pairHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  pairNum: { fontSize: 14, fontWeight: '700' },
  pairName: { fontSize: 13, flex: 1, textAlign: 'right', marginLeft: 8 },
  pairStats: { flexDirection: 'row', justifyContent: 'space-between' },
  pairStatText: { fontSize: 13, fontWeight: '500', fontVariant: ['tabular-nums'] },
  buttonsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    paddingVertical: 16,
    paddingHorizontal: 24,
  },
  btn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 8 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 1 },
});
