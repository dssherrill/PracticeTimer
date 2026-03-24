# Music Practice Timer — App Specification

Version 1.0 · React Native / Expo

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [Technology Stack](#3-technology-stack)
4. [Audio Detection Logic](#4-audio-detection-logic)
5. [Screens and Navigation](#5-screens-and-navigation)
6. [Settings and Configuration](#6-settings-and-configuration)
7. [Data Model](#7-data-model)
8. [Session Flow](#8-session-flow)
9. [Permissions and Privacy](#9-permissions-and-privacy)
10. [Build Prompts for Claude Opus 4.6](#10-build-prompts-for-claude-opus-46)

---

## 1. Overview

Music Practice Timer is a mobile app for instrumentalists who want to track their actual playing time versus resting time during a practice session. The app uses the phone's microphone to detect sound automatically, distinguishing playing from silence, so the musician does not need to interact with the phone while practicing.

The primary user is a French horn player, but the app is designed to be general-purpose and suitable for any solo instrument practice.

---

## 2. Goals and Non-Goals

### Goals

- Accurately track time spent actively playing vs. resting within a practice session
- Ignore short rests (e.g. breath pauses between phrases) using a configurable threshold
- Provide a manual pause button for deliberate breaks, conversations, or interruptions
- Display a live session view during practice with real-time play/rest status
- Display a detailed timeline view showing the sequence of play/rest intervals as they build
- Save full session history that can be reviewed or deleted later
- Maintain cumulative statistics (total time, play/rest ratio, daily/weekly/monthly) that persist even after session history is deleted
- Support system default light/dark theme automatically

### Non-Goals

- The app will **not** attempt to classify music vs. speech vs. background noise using ML audio classification — volume threshold is sufficient for solo instrument practice
- The app will **not** record or store any audio
- The app will **not** require an internet connection
- The app will **not** support multiple instruments or user profiles in v1

---

## 3. Technology Stack

| Component | Choice |
|---|---|
| Framework | React Native with Expo (managed workflow) |
| Language | TypeScript |
| Audio detection | expo-av for microphone metering |
| Storage | AsyncStorage for session history and cumulative stats |
| Navigation | React Navigation — bottom tab navigator |
| Theming | React Native Appearance API (system light/dark auto-detection) |
| Target platforms | Android (primary), iOS (secondary) |

---

## 4. Audio Detection Logic

### 4.1 Mechanism

The app requests microphone permission on first launch. During an active session it samples the microphone input level every 100ms and compares the RMS or peak amplitude against a configurable sensitivity threshold.

- Amplitude **above** threshold → state is **PLAYING**
- Amplitude **below** threshold → potential REST begins
- A rest is only recorded as a true REST interval if the silence is sustained for at least the configured **minimum rest duration** (see Section 6)
- If silence ends before the minimum rest duration elapses, the entire gap is counted as continuous playing time

### 4.2 Sensitivity Threshold

A slider in Settings allows the user to adjust the volume sensitivity. A live microphone level indicator (VU meter or bar) is visible on the Settings screen when adjusting, so the user can calibrate it for their instrument and room.

### 4.3 Minimum Rest Duration

A separate slider or numeric input in Settings sets the minimum silence duration before a gap is classified as a rest.

- Default: 5 seconds
- Range: 1–60 seconds
- This is the primary tuning control for ignoring breath pauses or page turns

### 4.4 Manual Pause

A prominent PAUSE button on the session screen immediately suspends all timers and audio monitoring. Time spent in manual pause is excluded from both playing time and rest time. A RESUME button restores the session. This is intended for conversations, phone calls, or deliberate breaks that the user does not want to appear in the session data.

---

## 5. Screens and Navigation

The app uses a bottom tab navigator with four tabs:

| Tab | Screen | Purpose |
|---|---|---|
| 1 | Session — Simple | Large-format timer, start/stop/pause, current status |
| 2 | Session — Detail | Live timeline of play/rest intervals as they accumulate |
| 3 | History | Past sessions list, session detail view, delete controls |
| 4 | Settings | Sensitivity, min rest duration, cumulative stats |

### 5.1 Session Screen — Simple View

- Large elapsed session time display (HH:MM:SS)
- Current status indicator: **PLAYING** (green), **RESTING** (amber), or **PAUSED** (gray)
- Live microphone level bar (subtle, non-distracting)
- START / STOP button (prominent, large, tap-friendly for mid-practice use)
- PAUSE / RESUME button (secondary size)
- When STOP is tapped: show session summary modal before saving (see Section 7.1)

### 5.2 Session Screen — Detail View

- Same header stats as simple view (elapsed time, status)
- Scrollable timeline of intervals in chronological order
- Each interval row shows: type (PLAY / REST), start time offset from session start, duration
- Color-coded rows: green for PLAY, amber for REST
- Auto-scrolls to the latest interval
- STOP and PAUSE buttons available (same behavior as simple view)

### 5.3 History Screen

- List of past sessions sorted by date, most recent first
- Each row shows: date, total session duration, play time, rest time, play/rest ratio
- Tap a session to view full interval breakdown
- Swipe-to-delete on individual sessions
- "Delete all history" button with confirmation dialog
- Deleting history does **not** affect cumulative statistics

### 5.4 Settings Screen

- Sensitivity slider with live microphone level preview
- Minimum rest duration control (slider or numeric stepper, 1–60 seconds, default 5 seconds)
- Cumulative statistics panel (see Section 7.2)
- "Reset cumulative stats" button with confirmation dialog (separate from deleting session history)

---

## 6. Settings and Configuration

| Setting | Default | Description |
|---|---|---|
| Sensitivity threshold | Medium | Volume level above which sound is classified as playing. Adjustable via slider with live mic preview. |
| Minimum rest duration | 5 seconds | Silence must last at least this long to be recorded as a rest interval. Range: 1–60 seconds. |
| Theme | System default | Follows the device's light/dark mode setting automatically. No manual override needed. |

---

## 7. Data Model

### 7.1 Session Record

Each completed session stores:

```typescript
{
  id: string;                  // unique identifier
  date: string;                // ISO timestamp of session start
  totalDuration: number;       // total elapsed time in seconds (excludes manual pause)
  playTime: number;            // total time classified as playing (seconds)
  restTime: number;            // total time classified as resting (seconds)
  pauseTime: number;           // total manual pause duration (seconds)
  intervals: Array<{
    type: 'play' | 'rest';
    startOffset: number;       // seconds from session start
    duration: number;          // seconds
  }>;
  notes: string;               // optional free-text, may be empty
}
```

### 7.2 Cumulative Statistics Record

A separate persistent record — never deleted with session history — stores:

```typescript
{
  allTimeTotalDuration: number;   // sum of all session totalDuration values ever recorded
  allTimePlayTime: number;        // sum of all session playTime values
  allTimeRestTime: number;        // sum of all session restTime values
  sessionCount: number;           // total number of completed sessions
  dailyTotals: {                  // rolling 90-day map
    [dateString: string]: {
      totalDuration: number;
      playTime: number;
    }
  }
}
```

These values are incremented at session save time and are never decremented by history deletion.

The Settings screen displays derived stats including:

- All-time total practice time
- All-time play/rest ratio
- This week's total practice time
- This month's total practice time
- Average session length (all-time)
- Total session count

---

## 8. Session Flow

1. User opens the app and navigates to the Session tab (simple or detail view)
2. User taps START — app requests microphone permission if not already granted
3. Audio monitoring begins; session timer starts
4. App samples mic level every 100ms, updating play/rest state in real time
5. Short silences (below minimum rest duration) are counted as continuous playing time
6. Sustained silence (at or above minimum rest duration) transitions state to RESTING
7. User may tap PAUSE at any time to freeze timers and suspend audio monitoring
8. User taps RESUME to continue the session
9. User taps STOP when practice is complete
10. Session summary modal appears: total time, play time, rest time, play %, interval count, optional notes field
11. User taps SAVE — session is written to storage and cumulative stats are updated
12. App returns to the Session screen, reset and ready for the next session

---

## 9. Permissions and Privacy

- **Microphone:** required — requested on first session start with a clear explanation
- No audio data is ever recorded, stored, or transmitted — only the amplitude level (a single number per sample) is read from the audio stream
- All session data is stored locally on the device only
- No network access is required or requested

---

## 10. Build Prompts for Claude Opus 4.6

Use these prompts in Claude Opus 4.6 **agent mode** in VS Code. Work through them in order. Confirm each step runs correctly on Expo Go before moving to the next. You can tell Opus to "refer to SPEC.md in the project root" for full context at any point.

---

### Step 1 — Project scaffold

```
Create a new Expo project using TypeScript. App name: "PracticeTimer". Set up React Navigation with a bottom tab navigator containing four tabs: Session Simple, Session Detail, History, and Settings. Use the system color scheme for light/dark theming via the React Native Appearance API. Confirm the app runs on Expo Go before finishing.
```

---

### Step 2 — Microphone metering

```
Add microphone access using expo-av. On the Settings screen, show a live microphone level bar that updates every 100ms using the audio metering API. Add a sensitivity slider that sets a threshold value (stored in app state). The bar should visually indicate when the current level exceeds the threshold. Request microphone permission before starting the meter. The sensitivity value will be used by the session logic in the next step.
```

---

### Step 3 — Session state machine

```
Implement the session state machine with these states: IDLE, PLAYING, RESTING, PAUSED.

Transitions:
- START begins audio monitoring and the session timer
- Amplitude above threshold → PLAYING
- Amplitude below threshold → start a silence timer
- If silence timer reaches the minimum rest duration (from Settings, default 5s), transition to RESTING
- Any amplitude above threshold cancels the silence timer and stays/returns to PLAYING
- PAUSE freezes all timers and suspends audio monitoring
- RESUME restores the session
- STOP ends the session

Track play time, rest time, and pause time as separate running totals. Track the intervals array (type, startOffset, duration) as each interval completes.
```

---

### Step 4 — Simple session screen

```
Build the Session Simple screen using the state machine from Step 3. Show:
- Elapsed session time (HH:MM:SS)
- Current status (PLAYING / RESTING / PAUSED) with color coding: green / amber / gray
- A subtle live mic level bar
- A large START/STOP button
- A secondary PAUSE/RESUME button

When STOP is tapped, show a modal with the session summary: total time, play time, rest time, play percentage, interval count, and an optional notes text field. Include SAVE and DISCARD buttons. SAVE stores the session (storage implementation comes in Step 6 — for now, log it to console).
```

---

### Step 5 — Detail session screen

```
Build the Session Detail screen. Show the same header stats as the simple screen (elapsed time, current status). Below the header, show a scrollable FlatList of intervals in chronological order. Each row shows: interval type (PLAY or REST), start time offset from session start (MM:SS format), and duration (MM:SS format). Color-code rows green for PLAY and amber for REST. Auto-scroll to the bottom as new intervals are added. Include the same STOP and PAUSE buttons as the simple screen.
```

---

### Step 6 — Storage and history

```
Implement local storage using AsyncStorage. 

On session save, write the full session record as defined in SPEC.md Section 7.1 (id, date, totalDuration, playTime, restTime, pauseTime, intervals array, notes).

Also update a separate cumulative stats record as defined in SPEC.md Section 7.2 (allTimeTotalDuration, allTimePlayTime, allTimeRestTime, sessionCount, dailyTotals). Cumulative stats must be incremented at save time and must never be affected by history deletion.

Build the History screen:
- List sessions sorted by date descending
- Each row shows date, total duration, play time, rest time, and play/rest ratio
- Tap a session to view its full interval breakdown
- Swipe-to-delete on individual sessions
- "Delete all history" button with confirmation dialog
- Confirm that deleting history leaves cumulative stats unchanged
```

---

### Step 7 — Settings and cumulative stats

```
Complete the Settings screen:
- Sensitivity slider with live mic level preview (from Step 2)
- Minimum rest duration control — slider or numeric stepper, range 1–60 seconds, default 5 seconds
- Cumulative statistics panel showing: all-time total practice time, all-time play/rest ratio, this week's total, this month's total, average session length, and total session count — all derived from the cumulative stats record in storage
- "Reset cumulative stats" button with a confirmation dialog — this resets only the stats record, not session history
```

---

### Step 8 — Polish and testing

```
Review the full app for the following and fix any issues found:

1. Light/dark theme applies correctly on all screens using the system setting
2. All timers pause correctly when the app is backgrounded (use AppState API)
3. Microphone permission denial is handled gracefully with a clear user-facing message
4. Session data persists correctly across app restarts
5. Cumulative stats are never affected by session history deletion
6. The minimum rest duration setting is correctly applied by the session state machine
7. All time displays use HH:MM:SS or MM:SS format consistently and never show raw seconds
```

---

## Appendix — Key Design Decisions

- **ML audio classification deferred:** YAMNet-based music/speech detection was considered but deferred from v1. Volume threshold is sufficient for solo French horn practice where the instrument is significantly louder than ambient noise. Can be added in v2.
- **Manual pause chosen over speech detection:** A manual pause button is the practical solution for conversations and deliberate breaks, replacing any need for real-time speech detection.
- **React Native / Expo over PWA:** Chosen to enable reliable microphone metering on both Android and iOS, and to allow future distribution as a native app via the app stores.
- **Cumulative stats stored separately:** Users can freely delete old session history without losing their long-term practice record.
- **Two session views as separate tabs:** The simple and detail views are separate tabs so the user can choose their preferred view before starting — no interaction needed mid-practice.
