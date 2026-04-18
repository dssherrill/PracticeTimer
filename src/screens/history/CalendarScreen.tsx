import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useAppColors } from '../../theme';
import { SessionRecord } from '../../types';
import { getSessions } from '../../utils/storage';
import { formatHuman } from '../../utils/format';

// ── helpers ──────────────────────────────────────────────────

/** Monday = 0 … Sunday = 6 */
function mondayBasedDay(date: Date): number {
  return (date.getDay() + 6) % 7;
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Build a map of YYYY-MM-DD (local time) → total practice duration (seconds). */
function buildDailyMap(sessions: SessionRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of sessions) {
    const key = dateKey(new Date(s.date));
    map.set(key, (map.get(key) ?? 0) + s.totalDuration);
  }
  return map;
}

/** Pad YYYY-MM-DD from a Date. */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface CalendarRow {
  /** 7 cells: null for empty/future cells, or Date objects */
  days: (Date | null)[];
  /** Label to display above this row when it's the first row of a month */
  monthLabel?: string;
}

/**
 * Build calendar rows month-by-month in standard calendar layout.
 * Returns rows in reverse order for use with an inverted FlatList
 * (data[0] = newest row displayed at visual bottom).
 */
function buildCalendarRows(today: Date, monthCount: number): CalendarRow[] {
  const rows: CalendarRow[] = [];

  for (let m = monthCount - 1; m >= 0; m--) {
    const monthDate = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const monthLabel = `${MONTH_NAMES[month]} ${year}`;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = mondayBasedDay(monthDate);

    let currentDay = 1;
    let isFirstRow = true;

    while (currentDay <= daysInMonth) {
      const days: (Date | null)[] = [];
      const startCol = isFirstRow ? startOffset : 0;

      for (let i = 0; i < startCol; i++) days.push(null);
      for (let i = startCol; i < 7 && currentDay <= daysInMonth; i++) {
        const d = new Date(year, month, currentDay);
        days.push(d > today ? null : d);
        currentDay++;
      }
      while (days.length < 7) days.push(null);

      rows.push({ days, monthLabel: isFirstRow ? monthLabel : undefined });
      isFirstRow = false;
    }
  }

  // Reverse so data[0] = newest row (displayed at bottom by inverted FlatList)
  return rows.reverse();
}

// ── color intensity ──────────────────────────────────────────

/** Map practice minutes to an opacity level (0.15 – 1.0) */
function practiceOpacity(seconds: number): number {
  const minutes = seconds / 60;
  if (minutes <= 0) return 0;
  if (minutes < 10) return 0.2;
  if (minutes < 20) return 0.35;
  if (minutes < 30) return 0.5;
  if (minutes < 45) return 0.65;
  if (minutes < 60) return 0.8;
  return 1.0;
}

// ── component ────────────────────────────────────────────────

const INITIAL_MONTHS = 6;
const LOAD_MORE_MONTHS = 3;

export default function CalendarScreen() {
  const colors = useAppColors();
  const navigation = useNavigation<any>();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [monthCount, setMonthCount] = useState(INITIAL_MONTHS);

  const [today, setToday] = useState(() => new Date());

  useFocusEffect(
    useCallback(() => {
      setToday(new Date());
      getSessions().then(setSessions).catch((e) => console.error('Failed to load sessions:', e));
    }, []),
  );

  const dailyMap = useMemo(() => buildDailyMap(sessions), [sessions]);
  const weeks = useMemo(() => buildCalendarRows(today, monthCount), [today, monthCount]);

  const handleEndReached = useCallback(() => {
    setMonthCount((c) => c + LOAD_MORE_MONTHS);
  }, []);

  const renderWeek = useCallback(
    ({ item }: { item: CalendarRow }) => {
      return (
        <View>
          {item.monthLabel && (
            <Text style={[styles.monthLabel, { color: colors.text }]}>{item.monthLabel}</Text>
          )}
          <View style={styles.weekRow}>
            {item.days.map((day, i) => {
              if (!day) {
                return <View key={i} style={styles.dayCell} />;
              }
              const key = dateKey(day);
              const playSeconds = dailyMap.get(key) ?? 0;
              const opacity = practiceOpacity(playSeconds);
              const isToday = isSameDay(day, today);

              return (
                <TouchableOpacity
                  key={i}
                  activeOpacity={playSeconds > 0 ? 0.6 : 1}
                  onPress={() => {
                    if (playSeconds > 0) {
                      navigation.navigate('SessionList', { scrollToDate: key });
                    }
                  }}
                  style={[
                    styles.dayCell,
                    isToday && { borderWidth: 2, borderColor: colors.primary, borderRadius: 8 },
                  ]}
                >
                  <View
                    style={[
                      styles.dayCellInner,
                      {
                        backgroundColor:
                          playSeconds > 0 ? colors.playing + alphaHex(opacity) : 'transparent',
                        borderRadius: 6,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.dayNumber,
                        { color: playSeconds > 0 ? colors.text : colors.textSecondary },
                      ]}
                    >
                      {day.getDate()}
                    </Text>
                    {playSeconds > 0 && (
                      <Text style={[styles.dayTime, { color: colors.text }]}>
                        {formatHuman(playSeconds)}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      );
    },
    [dailyMap, colors, navigation, today],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Day-of-week header */}
      <View style={styles.headerRow}>
        {DAY_HEADERS.map((d) => (
          <View key={d} style={styles.dayCell}>
            <Text style={[styles.headerText, { color: colors.textSecondary }]}>{d}</Text>
          </View>
        ))}
      </View>

      <FlatList
        inverted
        data={weeks}
        keyExtractor={(_, i) => i.toString()}
        renderItem={renderWeek}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
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

/** Convert 0–1 opacity to a 2-char hex suffix for color strings */
function alphaHex(opacity: number): string {
  const clamped = Math.max(0, Math.min(1, opacity));
  const hex = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  return hex;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerRow: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingTop: 12,
    paddingBottom: 4,
  },
  headerText: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
  listContent: { paddingHorizontal: 8, paddingBottom: 32 },
  monthLabel: {
    fontSize: 16,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 4,
    marginLeft: 4,
  },
  weekRow: { flexDirection: 'row' },
  dayCell: {
    flex: 1,
    height: 54,
    padding: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayCellInner: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumber: { fontSize: 12, fontWeight: '500' },
  dayTime: { fontSize: 10, fontWeight: '700', marginTop: 2 },
  emptyText: { textAlign: 'center', marginTop: 48, fontSize: 15 },
});
