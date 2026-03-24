import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAppColors } from '../../theme';
import { SessionRecord } from '../../types';
import { getSessions } from '../../utils/storage';
import { formatHMS } from '../../utils/format';
import { computeDisplayPairs } from '../../utils/pairs';

// ── Types ───────────────────────────────────────────────────

interface PieceSummary {
  pieceName: string;
  playTime: number;
  restTime: number;
  totalTime: number;
}

interface DayData {
  dateLabel: string;
  dateKey: string;
  pieces: PieceSummary[];
  dayPlayTime: number;
  dayRestTime: number;
  dayTotalTime: number;
}

interface WeekSection {
  title: string;
  data: DayData[];
  weekPlayTime: number;
  weekRestTime: number;
  weekTotalTime: number;
}

// ── Attribution logic ───────────────────────────────────────

function attributeSession(session: SessionRecord): PieceSummary[] {
  const pairs = computeDisplayPairs(session.intervals, session.pairBoundaries ?? [0]);
  const map = new Map<string, { playTime: number; restTime: number }>();

  for (const pair of pairs) {
    const name = pair.pieceName || '(unnamed)';
    const entry = map.get(name) || { playTime: 0, restTime: 0 };
    entry.playTime += pair.playTime;
    entry.restTime += pair.restTime;
    map.set(name, entry);
  }

  return Array.from(map.entries())
    .map(([pieceName, { playTime, restTime }]) => ({
      pieceName,
      playTime,
      restTime,
      totalTime: playTime + restTime,
    }))
    .sort((a, b) => b.totalTime - a.totalTime);
}

function mergePieceSummaries(lists: PieceSummary[][]): PieceSummary[] {
  const map = new Map<string, { playTime: number; restTime: number }>();
  for (const list of lists) {
    for (const ps of list) {
      const entry = map.get(ps.pieceName) || { playTime: 0, restTime: 0 };
      entry.playTime += ps.playTime;
      entry.restTime += ps.restTime;
      map.set(ps.pieceName, entry);
    }
  }
  return Array.from(map.entries())
    .map(([pieceName, { playTime, restTime }]) => ({
      pieceName,
      playTime,
      restTime,
      totalTime: playTime + restTime,
    }))
    .sort((a, b) => b.totalTime - a.totalTime);
}

// ── Build sections ──────────────────────────────────────────

function getISOWeekLabel(date: Date): string {
  // Get Monday of the week
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const fmt = (dt: Date) =>
    dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Week of ${fmt(monday)} – ${fmt(sunday)}`;
}

function getWeekKey(date: Date): string {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().slice(0, 10);
}

function buildSections(sessions: SessionRecord[]): WeekSection[] {
  // Group sessions by day
  const dayMap = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const dayKey = s.date.slice(0, 10);
    const arr = dayMap.get(dayKey) || [];
    arr.push(s);
    dayMap.set(dayKey, arr);
  }

  // Build day data
  const days: DayData[] = [];
  for (const [dayKey, daySessions] of dayMap) {
    const pieceLists = daySessions.map((s) => attributeSession(s));
    const pieces = mergePieceSummaries(pieceLists);
    const dayPlayTime = pieces.reduce((sum, p) => sum + p.playTime, 0);
    const dayRestTime = pieces.reduce((sum, p) => sum + p.restTime, 0);
    const d = new Date(dayKey + 'T00:00:00');
    days.push({
      dateLabel: d.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      }),
      dateKey: dayKey,
      pieces,
      dayPlayTime,
      dayRestTime,
      dayTotalTime: dayPlayTime + dayRestTime,
    });
  }

  // Sort days descending
  days.sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  // Group by week
  const weekMap = new Map<string, DayData[]>();
  const weekLabels = new Map<string, string>();
  for (const day of days) {
    const date = new Date(day.dateKey + 'T00:00:00');
    const wk = getWeekKey(date);
    const arr = weekMap.get(wk) || [];
    arr.push(day);
    weekMap.set(wk, arr);
    if (!weekLabels.has(wk)) {
      weekLabels.set(wk, getISOWeekLabel(date));
    }
  }

  // Build sections
  const sections: WeekSection[] = [];
  const sortedWeeks = Array.from(weekMap.keys()).sort((a, b) => b.localeCompare(a));
  for (const wk of sortedWeeks) {
    const data = weekMap.get(wk)!;
    const weekPlayTime = data.reduce((s, d) => s + d.dayPlayTime, 0);
    const weekRestTime = data.reduce((s, d) => s + d.dayRestTime, 0);
    sections.push({
      title: weekLabels.get(wk)!,
      data,
      weekPlayTime,
      weekRestTime,
      weekTotalTime: weekPlayTime + weekRestTime,
    });
  }

  return sections;
}

// ── Component ───────────────────────────────────────────────

export default function PracticeReportScreen() {
  const colors = useAppColors();
  const [sections, setSections] = useState<WeekSection[]>([]);

  useFocusEffect(
    useCallback(() => {
      getSessions().then((sessions) => setSections(buildSections(sessions)));
    }, [])
  );

  const renderPiece = (piece: PieceSummary) => (
    <View key={piece.pieceName} style={[styles.pieceRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.pieceName, { color: colors.text }]} numberOfLines={1}>
        {piece.pieceName}
      </Text>
      <Text style={[styles.pieceTime, { color: colors.playing }]}>{formatHMS(piece.playTime)}</Text>
      <Text style={[styles.pieceTime, { color: colors.resting }]}>{formatHMS(piece.restTime)}</Text>
      <Text style={[styles.pieceTime, { color: colors.text }]}>{formatHMS(piece.totalTime)}</Text>
    </View>
  );

  const renderColumnHeaders = () => (
    <View style={styles.pieceRow}>
      <Text style={[styles.pieceName, { color: colors.textSecondary, fontWeight: '600' }]}>Piece</Text>
      <Text style={[styles.pieceTime, { color: colors.textSecondary, fontWeight: '600' }]}>Play</Text>
      <Text style={[styles.pieceTime, { color: colors.textSecondary, fontWeight: '600' }]}>Rest</Text>
      <Text style={[styles.pieceTime, { color: colors.textSecondary, fontWeight: '600' }]}>Total</Text>
    </View>
  );

  const renderTotalRow = (label: string, play: number, rest: number, total: number) => (
    <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
      <Text style={[styles.totalLabel, { color: colors.text }]}>{label}</Text>
      <Text style={[styles.pieceTime, { color: colors.playing, fontWeight: '700' }]}>{formatHMS(play)}</Text>
      <Text style={[styles.pieceTime, { color: colors.resting, fontWeight: '700' }]}>{formatHMS(rest)}</Text>
      <Text style={[styles.pieceTime, { color: colors.text, fontWeight: '700' }]}>{formatHMS(total)}</Text>
    </View>
  );

  const renderDay = ({ item }: { item: DayData }) => (
    <View style={[styles.dayCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.dayTitle, { color: colors.text }]}>{item.dateLabel}</Text>
      {renderColumnHeaders()}
      {item.pieces.map(renderPiece)}
      {renderTotalRow('Day Total', item.dayPlayTime, item.dayRestTime, item.dayTotalTime)}
    </View>
  );

  const renderSectionHeader = ({ section }: { section: WeekSection }) => (
    <View style={[styles.weekHeader, { backgroundColor: colors.surface }]}>
      <Text style={[styles.weekTitle, { color: colors.text }]}>{section.title}</Text>
    </View>
  );

  const renderSectionFooter = ({ section }: { section: WeekSection }) => (
    <View style={[styles.weekFooter, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      {renderTotalRow('Week Total', section.weekPlayTime, section.weekRestTime, section.weekTotalTime)}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.dateKey}
        renderItem={renderDay}
        renderSectionHeader={renderSectionHeader}
        renderSectionFooter={renderSectionFooter}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No sessions recorded yet.
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: { padding: 16, paddingBottom: 32 },
  emptyText: { textAlign: 'center', marginTop: 48, fontSize: 15 },
  weekHeader: { paddingVertical: 10, paddingHorizontal: 4, marginTop: 8 },
  weekTitle: { fontSize: 16, fontWeight: '700' },
  weekFooter: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 16,
    borderTopWidth: 1,
    borderRadius: 6,
  },
  dayCard: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  dayTitle: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
  pieceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pieceName: { flex: 1, fontSize: 13 },
  pieceTime: { width: 64, fontSize: 13, fontVariant: ['tabular-nums'], textAlign: 'right' },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderTopWidth: 1,
    marginTop: 4,
  },
  totalLabel: { flex: 1, fontSize: 13, fontWeight: '700' },
});
