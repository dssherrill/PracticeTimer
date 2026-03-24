import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useAppColors } from '../theme';
import { useSession } from '../contexts/SessionContext';
import { formatHMS } from '../utils/format';
import { getPieceNames, addPieceName } from '../utils/storage';
import { computeDisplayPairs, computeLivePairs } from '../utils/pairs';

export default function SessionSimpleScreen() {
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
    saveSession,
    discardSession,
    updatePairPieceName,
    currentPieceName,
    updateCurrentPieceName,
  } = useSession();

  const [notes, setNotes] = useState('');
  const [editingPairIdx, setEditingPairIdx] = useState<number | null>(null);
  const [editPieceText, setEditPieceText] = useState('');
  const [knownPieces, setKnownPieces] = useState<string[]>([]);
  const [isLiveEdit, setIsLiveEdit] = useState(false);

  const isRunning = status !== 'idle' && !pendingSession;

  // Compute display pairs for live view (with in-progress time)
  const livePairs = useMemo(
    () => isRunning
      ? computeLivePairs(intervals, pairBoundaries, playTime, restTime)
      : computeDisplayPairs(intervals, pairBoundaries),
    [intervals, pairBoundaries, playTime, restTime, isRunning],
  );

  // Compute display pairs for pending session modal
  const pendingPairs = useMemo(
    () => pendingSession
      ? computeDisplayPairs(pendingSession.intervals, pendingSession.pairBoundaries)
      : [],
    [pendingSession],
  );

  // Load known piece names when summary modal opens
  useEffect(() => {
    if (pendingSession) {
      getPieceNames().then(setKnownPieces);
    }
  }, [pendingSession]);

  // Filter known pieces by what the user is typing
  const filteredPieces = useMemo(() => {
    const query = editPieceText.trim().toLowerCase();
    if (!query) return knownPieces;
    return knownPieces.filter((name) => name.toLowerCase().includes(query));
  }, [editPieceText, knownPieces]);

  // Status label + color
  let statusLabel = 'READY';
  let statusColor = colors.textSecondary;
  if (status === 'waiting') { statusLabel = 'LISTENING…'; statusColor = colors.textSecondary; }
  else if (status === 'playing') { statusLabel = 'PLAYING'; statusColor = colors.playing; }
  else if (status === 'resting') { statusLabel = 'RESTING'; statusColor = colors.resting; }
  else if (status === 'paused') { statusLabel = 'PAUSED'; statusColor = colors.paused; }

  const handleStartStop = async () => {
    if (isRunning) {
      stop();
    } else if (!pendingSession) {
      setNotes('');
      await start();
    }
  };

  const handlePauseResume = () => {
    if (status === 'paused') resume();
    else pause();
  };

  const handleSave = () => {
    saveSession(notes);
  };

  const handleDiscard = () => {
    discardSession();
  };

  const handleOpenPairEdit = (pairIdx: number) => {
    setEditingPairIdx(pairIdx);
    setEditPieceText(pendingPairs[pairIdx]?.pieceName || '');
    setIsLiveEdit(false);
  };

  const handleOpenLivePairEdit = () => {
    setEditPieceText(currentPieceName);
    setEditingPairIdx(0);
    setIsLiveEdit(true);
    getPieceNames().then(setKnownPieces);
  };

  const handleSavePieceName = async () => {
    if (editingPairIdx === null) return;
    const trimmed = editPieceText.trim();
    if (isLiveEdit) {
      updateCurrentPieceName(trimmed);
    } else {
      updatePairPieceName(editingPairIdx, trimmed);
    }
    if (trimmed) {
      await addPieceName(trimmed);
      setKnownPieces(await getPieceNames());
    }
    setEditingPairIdx(null);
    setIsLiveEdit(false);
  };

  const playPct = elapsed > 0 ? Math.round((playTime / elapsed) * 100) : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Status */}
      <Text style={[styles.status, { color: statusColor }]}>{statusLabel}</Text>

      {/* Timer */}
      <Text style={[styles.timer, { color: colors.text }]}>{formatHMS(elapsed)}</Text>

      {/* Mic level bar */}
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

      {/* Play / Rest summary */}
      {isRunning && (
        <View style={styles.statsRow}>
          <Text style={[styles.statText, { color: colors.playing }]}>
            Play: {formatHMS(playTime)}
          </Text>
          <Text style={[styles.statText, { color: colors.resting }]}>
            Rest: {formatHMS(restTime)}
          </Text>
        </View>
      )}

      {/* Current pair info */}
      {isRunning && livePairs.length > 0 && (
        <TouchableOpacity onPress={handleOpenLivePairEdit} style={styles.pairLabelTouchable}>
          <Text style={[styles.pairLabel, { color: colors.textSecondary }]}>
            Section {livePairs.length}
            {currentPieceName ? ` — ${currentPieceName}` : ''}
            {'\n'}Play: {formatHMS(livePairs[livePairs.length - 1].playTime)}
            {' / '}Rest: {formatHMS(livePairs[livePairs.length - 1].restTime)}
          </Text>
          <Text style={[styles.pairEditHint, { color: colors.primary }]}>
            {currentPieceName ? 'edit piece name' : 'tap to name piece…'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Start / Stop */}
      <TouchableOpacity
        style={[
          styles.mainButton,
          { backgroundColor: isRunning ? colors.danger : colors.playing },
        ]}
        onPress={handleStartStop}
        disabled={!!pendingSession}
      >
        <Text style={styles.mainButtonText}>{isRunning ? 'STOP' : 'START'}</Text>
      </TouchableOpacity>

      {/* Pause / Resume + Next */}
      {isRunning && (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.secondaryButton, { borderColor: colors.paused }]}
            onPress={handlePauseResume}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
              {status === 'paused' ? 'RESUME' : 'PAUSE'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondaryButton, { borderColor: colors.primary }]}
            onPress={nextPair}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.text }]}>NEXT</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Session Summary Modal ──────────────────── */}
      <Modal visible={!!pendingSession} animationType="slide" transparent>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
            <ScrollView>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Session Summary</Text>

              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Total time</Text>
                <Text style={[styles.summaryValue, { color: colors.text }]}>
                  {formatHMS(pendingSession?.totalDuration ?? 0)}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Play time</Text>
                <Text style={[styles.summaryValue, { color: colors.playing }]}>
                  {formatHMS(pendingSession?.playTime ?? 0)}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Rest time</Text>
                <Text style={[styles.summaryValue, { color: colors.resting }]}>
                  {formatHMS(pendingSession?.restTime ?? 0)}
                </Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Play %</Text>
                <Text style={[styles.summaryValue, { color: colors.text }]}>{playPct}%</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>Sections</Text>
                <Text style={[styles.summaryValue, { color: colors.text }]}>
                  {pendingPairs.length}
                </Text>
              </View>

              {/* Sections — tap to name */}
              {pendingPairs.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={[styles.summaryLabel, { color: colors.textSecondary, marginBottom: 6 }]}>
                    Tap sections to name pieces:
                  </Text>
                  {pendingPairs.map((pair, idx) => (
                    <TouchableOpacity
                      key={idx}
                      style={[styles.pieceRow, { borderColor: colors.border }]}
                      onPress={() => handleOpenPairEdit(idx)}
                    >
                      <Text style={[styles.pieceRowTime, { color: colors.playing }]}>
                        {formatHMS(pair.playTime)}
                      </Text>
                      <Text style={[styles.pieceRowTime, { color: colors.resting }]}>
                        {formatHMS(pair.restTime)}
                      </Text>
                      <Text
                        style={[
                          styles.pieceRowName,
                          { color: pair.pieceName ? colors.text : colors.textSecondary },
                        ]}
                        numberOfLines={1}
                      >
                        {pair.pieceName || 'tap to name…'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <TextInput
                style={[
                  styles.notesInput,
                  { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
                ]}
                placeholder="Notes (optional)"
                placeholderTextColor={colors.textSecondary}
                value={notes}
                onChangeText={setNotes}
                multiline
              />

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalBtn, { backgroundColor: colors.playing }]}
                  onPress={handleSave}
                >
                  <Text style={styles.modalBtnText}>SAVE</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, { backgroundColor: colors.danger }]}
                  onPress={handleDiscard}
                >
                  <Text style={styles.modalBtnText}>DISCARD</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

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
                styles.notesInput,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.background, minHeight: 44 },
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
                    style={[styles.piecePickerItem, { borderBottomColor: colors.border, backgroundColor: editPieceText === name ? colors.primary + '30' : 'transparent' }]}
                    onPress={() => setEditPieceText(name)}
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
                style={[styles.modalBtn, { backgroundColor: colors.paused }]}
                onPress={() => setEditingPairIdx(null)}
              >
                <Text style={styles.modalBtnText}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  status: { fontSize: 18, fontWeight: '600', letterSpacing: 2, marginBottom: 8 },
  timer: { fontSize: 56, fontWeight: '200', fontVariant: ['tabular-nums'], marginBottom: 16 },
  meterContainer: {
    width: '80%',
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: 16,
  },
  meterFill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 5 },
  statsRow: { flexDirection: 'row', gap: 24, marginBottom: 12 },
  statText: { fontSize: 16, fontWeight: '500', fontVariant: ['tabular-nums'] },
  pairLabel: { fontSize: 13, fontVariant: ['tabular-nums'], textAlign: 'center' },
  pairLabelTouchable: { alignItems: 'center', marginBottom: 32 },
  pairEditHint: { fontSize: 12, marginTop: 4 },
  mainButton: {
    width: 160,
    height: 160,
    borderRadius: 80,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  mainButtonText: { color: '#fff', fontSize: 24, fontWeight: '700', letterSpacing: 2 },
  actionRow: { flexDirection: 'row', gap: 16 },
  secondaryButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 2,
  },
  secondaryButtonText: { fontSize: 16, fontWeight: '600', letterSpacing: 1 },
  modalOverlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalContent: { margin: 24, borderRadius: 16, padding: 24, maxHeight: '80%' },
  modalTitle: { fontSize: 22, fontWeight: '700', marginBottom: 20, textAlign: 'center' },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  summaryLabel: { fontSize: 16 },
  summaryValue: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  notesInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginTop: 16,
    minHeight: 60,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  modalButtons: { flexDirection: 'row', gap: 12, marginTop: 20, justifyContent: 'center' },
  modalBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 8 },
  modalBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  pieceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 6,
    marginBottom: 4,
    gap: 10,
  },
  pieceRowTime: { fontSize: 12, fontVariant: ['tabular-nums'] },
  pieceRowName: { fontSize: 13, flex: 1 },
  piecePickerItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
