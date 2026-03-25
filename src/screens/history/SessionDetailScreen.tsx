import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  Modal,
  ScrollView,
  Alert,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useAppColors } from '../../theme';
import { SessionRecord, DisplayPair } from '../../types';
import { getSessions, updateSession } from '../../utils/storage';
import { getPieceNames, addPieceName, removePieceName } from '../../utils/storage';
import { formatHMS } from '../../utils/format';
import { computeDisplayPairs } from '../../utils/pairs';

export default function SessionDetailScreen() {
  const colors = useAppColors();
  const route = useRoute<any>();
  const { sessionId } = route.params;

  const [session, setSession] = useState<SessionRecord | null>(null);
  const [editingPairIndex, setEditingPairIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [knownPieces, setKnownPieces] = useState<string[]>([]);

  useEffect(() => {
    getSessions().then((all) => {
      const found = all.find((s) => s.id === sessionId);
      if (found) setSession(found);
    });
    getPieceNames().then(setKnownPieces);
  }, [sessionId]);

  const pairs = useMemo(() => {
    if (!session) return [];
    return computeDisplayPairs(session.intervals, session.pairBoundaries ?? [0]);
  }, [session]);

  const handleOpenEdit = (pairIndex: number) => {
    setEditingPairIndex(pairIndex);
    setEditText(pairs[pairIndex]?.pieceName || '');
  };

  const handleSavePieceName = useCallback(async () => {
    if (editingPairIndex === null || !session) return;
    const pair = pairs[editingPairIndex];
    if (!pair) return;

    const trimmed = editText.trim();
    const newIntervals = [...session.intervals];
    // Set pieceName on all play intervals within this pair's range
    for (let j = pair.intervalStartIndex; j < pair.intervalEndIndex; j++) {
      if (newIntervals[j].type === 'play') {
        newIntervals[j] = { ...newIntervals[j], pieceName: trimmed || undefined };
      }
    }

    const updated = { ...session, intervals: newIntervals };
    setSession(updated);
    await updateSession(updated);

    if (trimmed) {
      await addPieceName(trimmed);
      setKnownPieces(await getPieceNames());
    }

    setEditingPairIndex(null);
  }, [editingPairIndex, editText, session, pairs]);

  const handlePickPiece = (name: string) => {
    setEditText(name);
  };

  // Filter known pieces by what the user is typing
  const filteredPieces = useMemo(() => {
    const query = editText.trim().toLowerCase();
    if (!query) return knownPieces;
    return knownPieces.filter((name) => name.toLowerCase().includes(query));
  }, [editText, knownPieces]);

  if (!session) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>Loading…</Text>
      </View>
    );
  }

  const ratio =
    session.playTime + session.restTime > 0
      ? Math.round((session.playTime / (session.playTime + session.restTime)) * 100)
      : 0;

  const renderPair = ({ item, index }: { item: DisplayPair; index: number }) => (
    <TouchableOpacity
      style={[styles.pairCard, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => handleOpenEdit(index)}
      activeOpacity={0.7}
    >
      <View style={styles.pairHeader}>
        <Text style={[styles.pairLabel, { color: colors.textSecondary }]}>
          Section {index + 1}
        </Text>
        <Text
          style={[
            styles.pairPiece,
            { color: item.pieceName ? colors.text : colors.textSecondary },
          ]}
          numberOfLines={1}
        >
          {item.pieceName || 'tap to name…'}
        </Text>
      </View>
      <View style={styles.pairTimes}>
        <View style={styles.pairTimeStat}>
          <Text style={[styles.pairTimeLabel, { color: colors.textSecondary }]}>Play</Text>
          <Text style={[styles.pairTimeValue, { color: colors.playing }]}>
            {formatHMS(item.playTime)}
          </Text>
        </View>
        <View style={styles.pairTimeStat}>
          <Text style={[styles.pairTimeLabel, { color: colors.textSecondary }]}>Rest</Text>
          <Text style={[styles.pairTimeValue, { color: colors.resting }]}>
            {formatHMS(item.restTime)}
          </Text>
        </View>
        <View style={styles.pairTimeStat}>
          <Text style={[styles.pairTimeLabel, { color: colors.textSecondary }]}>Total</Text>
          <Text style={[styles.pairTimeValue, { color: colors.text }]}>
            {formatHMS(item.totalTime)}
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Summary header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Total</Text>
            <Text style={[styles.statValue, { color: colors.text }]}>{formatHMS(session.totalDuration)}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Play</Text>
            <Text style={[styles.statValue, { color: colors.playing }]}>{formatHMS(session.playTime)}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Rest</Text>
            <Text style={[styles.statValue, { color: colors.resting }]}>{formatHMS(session.restTime)}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>Play%</Text>
            <Text style={[styles.statValue, { color: colors.text }]}>{ratio}%</Text>
          </View>
        </View>
        {session.notes ? (
          <Text style={[styles.notes, { color: colors.textSecondary }]}>{session.notes}</Text>
        ) : null}
      </View>

      <FlatList
        data={pairs}
        keyExtractor={(_, i) => i.toString()}
        renderItem={renderPair}
        contentContainerStyle={styles.listContent}
      />

      {/* ── Piece Name Edit Modal ──────────────────── */}
      <Modal visible={editingPairIndex !== null} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Piece Name</Text>

            <TextInput
              style={[
                styles.input,
                { color: colors.text, borderColor: colors.border, backgroundColor: colors.background },
              ]}
              value={editText}
              onChangeText={setEditText}
              placeholder="Enter piece name"
              placeholderTextColor={colors.textSecondary}
              autoFocus
            />

            {filteredPieces.length > 0 && (
              <ScrollView style={styles.pieceList} keyboardShouldPersistTaps="handled">
                {filteredPieces.map((name) => (
                  <TouchableOpacity
                    key={name}
                    style={[
                      styles.pieceItem,
                      {
                        backgroundColor: editText === name ? colors.primary + '30' : 'transparent',
                        borderColor: colors.border,
                      },
                    ]}
                    onPress={() => handlePickPiece(name)}
                    onLongPress={() => {
                      Alert.alert('Delete Piece', `Remove "${name}" from saved pieces?`, [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete',
                          style: 'destructive',
                          onPress: async () => {
                            await removePieceName(name);
                            setKnownPieces(await getPieceNames());
                            if (editText === name) setEditText('');
                          },
                        },
                      ]);
                    }}
                  >
                    <Text style={[styles.pieceItemText, { color: colors.text }]}>{name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.playing }]}
                onPress={handleSavePieceName}
              >
                <Text style={styles.modalBtnText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, { backgroundColor: colors.paused }]}
                onPress={() => setEditingPairIndex(null)}
              >
                <Text style={styles.modalBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16, borderBottomWidth: 1 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stat: { alignItems: 'center' },
  statLabel: { fontSize: 12, marginBottom: 2 },
  statValue: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  notes: { fontSize: 13, fontStyle: 'italic', marginTop: 8, textAlign: 'center' },
  listContent: { padding: 16, paddingBottom: 32 },
  emptyText: { textAlign: 'center', marginTop: 48, fontSize: 15 },
  pairCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  pairHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  pairLabel: { fontSize: 13, fontWeight: '700' },
  pairPiece: { fontSize: 13, flex: 1, textAlign: 'right', marginLeft: 12 },
  pairTimes: { flexDirection: 'row', justifyContent: 'space-around' },
  pairTimeStat: { alignItems: 'center' },
  pairTimeLabel: { fontSize: 11, marginBottom: 2 },
  pairTimeValue: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  modalOverlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalContent: { margin: 24, borderRadius: 16, padding: 24, maxHeight: '70%' },
  modalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  pieceList: { maxHeight: 180, marginBottom: 12 },
  pieceItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderRadius: 4,
  },
  pieceItemText: { fontSize: 15 },
  modalButtons: { flexDirection: 'row', gap: 12, justifyContent: 'center' },
  modalBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  modalBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
