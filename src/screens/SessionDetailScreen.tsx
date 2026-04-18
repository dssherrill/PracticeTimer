import React, { useRef, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { useAppColors } from '../theme';
import { useSession } from '../contexts/SessionContext';
import { useSettings } from '../contexts/SettingsContext';
import { formatHMS } from '../utils/format';
import { computeDisplayPairs, computeLivePairs } from '../utils/pairs';
import { getPieceNames, addPieceName, removePieceName } from '../utils/storage';
import type { DisplayPair } from '../types';

export default function SessionDetailScreen() {
  const colors = useAppColors();
  const { settings } = useSettings();
  const thresholdNorm = settings.sensitivityThreshold;
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
    nextPair,
    pendingSession,
    updateLivePairPieceName,
  } = useSession();

  const isRunning = status !== 'idle' && !pendingSession;

  const [editingPairIdx, setEditingPairIdx] = useState<number | null>(null);
  const [editPieceText, setEditPieceText] = useState('');
  const [knownPieces, setKnownPieces] = useState<string[]>([]);

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

  // Filter known pieces by what the user is typing
  const filteredPieces = useMemo(() => {
    const query = editPieceText.trim().toLowerCase();
    if (!query) return knownPieces;
    return knownPieces.filter((name) => name.toLowerCase().includes(query));
  }, [editPieceText, knownPieces]);

  const openPieceNameModal = (originalPairIndex: number) => {
    const pair = isRunning
      ? computeLivePairs(intervals, pairBoundaries, playTime, restTime)[originalPairIndex]
      : undefined;
    setEditPieceText(pair?.pieceName || '');
    setEditingPairIdx(originalPairIndex);
    getPieceNames().then(setKnownPieces);
  };

  const handleSavePieceName = async () => {
    if (editingPairIdx === null) return;
    const trimmed = editPieceText.trim();
    updateLivePairPieceName(editingPairIdx, trimmed);
    if (trimmed) {
      await addPieceName(trimmed);
      setKnownPieces(await getPieceNames());
    }
    setEditingPairIdx(null);
  };

  const handleStartStop = async () => {
    if (isRunning) stop();
    else if (!pendingSession) {
      const started = await start();
      if (started) {
      // Prompt for piece name
      setEditPieceText('');
      setEditingPairIdx(0);
      getPieceNames().then(setKnownPieces);
      }
    }
  };

  const handleNext = () => {
    nextPair();
    // Prompt for piece name on the new section
    setEditPieceText('');
    setEditingPairIdx(pairBoundaries.length); // new pair index after nextPair adds boundary
    getPieceNames().then(setKnownPieces);
  };

  const renderPair = ({ item, index }: { item: DisplayPair; index: number }) => {
    const originalIndex = totalPairs - index - 1;
    return (
    <TouchableOpacity
      style={[
        styles.pairRow,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
      onPress={() => isRunning && openPieceNameModal(originalIndex)}
      activeOpacity={isRunning ? 0.7 : 1}
    >
      <View style={styles.pairHeader}>
        <Text style={[styles.pairNum, { color: colors.text }]}>Section {totalPairs - index}</Text>
        <Text
          style={[styles.pairName, { color: colors.textSecondary }]}
          numberOfLines={1}
        >
          {item.pieceName || (isRunning ? 'tap to name…' : '')}
        </Text>
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
    </TouchableOpacity>
    );
  };

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
                  backgroundColor: micLevel >= thresholdNorm ? colors.playing : colors.resting,
                },
              ]}
            />
            <View
              style={[
                styles.thresholdLine,
                { left: `${Math.round(thresholdNorm * 100)}%`, backgroundColor: colors.danger },
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
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.primary }]}
              onPress={handleNext}
            >
              <Text style={styles.btnText}>NEXT</Text>
            </TouchableOpacity>
        )}
      </View>

      {/* ── Piece Name Edit Modal ──────────────────── */}
      <Modal visible={editingPairIdx !== null} transparent animationType="fade">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Piece Name</Text>
            <TextInput
              style={[
                styles.modalInput,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
              ]}
              value={editPieceText}
              onChangeText={setEditPieceText}
              placeholder="Enter piece name"
              placeholderTextColor={colors.textSecondary}
              autoFocus
            />
            {filteredPieces.length > 0 && (
              <ScrollView style={{ maxHeight: 150, marginTop: 8 }} keyboardShouldPersistTaps="handled">
                {filteredPieces.map((name) => (
                  <TouchableOpacity
                    key={name}
                    style={[
                      styles.piecePickerItem,
                      {
                        borderBottomColor: colors.border,
                        backgroundColor: editPieceText === name ? colors.primary + '30' : 'transparent',
                      },
                    ]}
                    onPress={() => setEditPieceText(name)}
                    onLongPress={() => {
                      Alert.alert('Delete Piece', `Remove "${name}" from saved pieces?`, [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: async () => {
                            await removePieceName(name);
                            setKnownPieces(await getPieceNames());
                            if (editPieceText === name) setEditPieceText('');
                          },
                        },
                      ]);
                    }}
                  >
                    <Text style={{ color: colors.text, fontSize: 14 }}>{name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.playing }]}
                onPress={handleSavePieceName}
              >
                <Text style={styles.modalBtnText}>OK</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.border }]}
                onPress={() => setEditingPairIdx(null)}
              >
                <Text style={[styles.modalBtnText, { color: colors.text }]}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
    position: 'relative',
  },
  meterFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3 },
  thresholdLine: { position: 'absolute', top: 0, bottom: 0, width: 2 },
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
  modalOverlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalContent: { margin: 24, borderRadius: 16, padding: 24, maxHeight: '70%' },
  modalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  modalInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    minHeight: 44,
  },
  piecePickerItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalButtons: { flexDirection: 'row', gap: 12, marginTop: 20, justifyContent: 'center' },
  modalBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 8 },
  modalBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
