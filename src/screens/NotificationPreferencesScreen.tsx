/**
 * NotificationPreferencesScreen — KAN-80, restructured in KAN-303.
 *
 * Three channels, each mapping to one of the only honest reasons to interrupt
 * someone — a place, a time they chose, or a person:
 *
 *   When I'm out — proximity alerts (notif_nearby_enabled) + the exit prompt
 *   Daily        — the morning check-in, with its user-set reminder time
 *   From people  — shared tasks from friends (sharedTasks)
 *
 * The old Streaks / Summary / Engagement / Achievements sections were cut
 * entirely (KAN-303) — they were performance nagging, against the app's
 * no-guilt contract.
 *
 * Each row reads from / writes to users/{uid}/userPreferences/prefs.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import { useTheme } from '../theme';
import { radius, spacing } from '../theme/tokens';
import {
  getUserPreferences,
  updateUserPreferences,
} from '../services/firestore';
import { scheduleEodReminder } from '../services/notifications';
import {
  BellIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ClockIcon,
} from '../components/AppIcon';
import { RootStackParamList } from '../navigation/AppNavigator';
import { UserPreferences, DEFAULT_USER_PREFERENCES } from '../types';
import { COPY } from '../constants/copy';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// ─── Time options for the Daily check-in (30-min increments, morning) ─────────
// KAN-303: the Daily channel is a morning intention, so the picker offers
// morning slots. The default (DEFAULT_USER_PREFERENCES.eodReminder.time) is one
// of these; a legacy evening time saved before this change is still respected
// and scheduled — it just isn't one of the options offered here.

const EOD_TIMES = [
  '06:00', '06:30', '07:00', '07:30',
  '08:00', '08:30', '09:00', '09:30',
  '10:00', '10:30', '11:00', '11:30',
];

function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const period = h < 12 ? 'AM' : 'PM';
  const hour   = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { palette } = useTheme();
  return (
    <View style={s.sectionWrapper}>
      <Text style={[s.sectionLabel, { color: palette.muted }]}>{title}</Text>
      <View style={[s.card, { backgroundColor: palette.surface, borderColor: palette.line }]}>
        {children}
      </View>
    </View>
  );
}

interface PrefRowProps {
  Icon:    React.FC<{ color: string; size?: number }>;
  label:   string;
  sublabel?: string;
  value:   boolean;
  onToggle: (v: boolean) => void;
  isLast?: boolean;
  disabled?: boolean;
}

function PrefRow({ Icon, label, sublabel, value, onToggle, isLast = false, disabled = false }: PrefRowProps) {
  const { palette } = useTheme();
  return (
    <>
      <View style={s.row}>
        <View style={[s.iconTile, { backgroundColor: palette.surface2 }]}>
          <Icon color={palette.muted} size={19} />
        </View>
        <View style={s.rowLabelGroup}>
          <Text style={[s.rowLabel, { color: palette.text }]}>{label}</Text>
          {sublabel ? (
            <Text style={[s.rowSublabel, { color: palette.muted }]} numberOfLines={2}>
              {sublabel}
            </Text>
          ) : null}
        </View>
        <Switch
          value={value}
          onValueChange={onToggle}
          disabled={disabled}
          trackColor={{ true: palette.accent, false: palette.surface2 }}
          thumbColor={Platform.OS === 'android' ? palette.bg : undefined}
          accessibilityRole="switch"
          accessibilityLabel={label}
          accessibilityState={{ checked: value }}
        />
      </View>
      {!isLast && <View style={[s.divider, { backgroundColor: palette.line }]} />}
    </>
  );
}

interface TimePickerRowProps {
  selectedTime: string;
  onSelect: (time: string) => void;
  isLast?: boolean;
}

function TimePickerRow({ selectedTime, onSelect, isLast = false }: TimePickerRowProps) {
  const { palette } = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <Pressable
        style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}
        onPress={() => setExpanded(v => !v)}
        accessibilityRole="button"
        accessibilityLabel={COPY.notificationPreferences.reminderTimeA11y(formatTime(selectedTime))}>
        <View style={[s.iconTile, { backgroundColor: palette.surface2 }]}>
          <ClockIcon color={palette.muted} size={19} />
        </View>
        <Text style={[s.rowLabel, { color: palette.text }]}>{COPY.notificationPreferences.reminderTimeLabel}</Text>
        <Text style={[s.timeValue, { color: palette.muted }]}>
          {formatTime(selectedTime)}
        </Text>
      </Pressable>
      {expanded && (
        <View style={[s.timePicker, { borderTopColor: palette.line }]}>
          {EOD_TIMES.map((t, i) => {
            const selected = t === selectedTime;
            return (
              <Pressable
                key={t}
                style={({ pressed }) => [
                  s.timeOption,
                  i < EOD_TIMES.length - 1 && { borderBottomColor: palette.line, borderBottomWidth: StyleSheet.hairlineWidth },
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => { onSelect(t); setExpanded(false); }}
                accessibilityRole="radio"
                accessibilityLabel={formatTime(t)}
                accessibilityState={{ selected }}>
                <Text style={[s.timeOptionText, { color: selected ? palette.accent : palette.text }]}>
                  {formatTime(t)}
                </Text>
                {selected && (
                  <View style={[s.timeSelectedDot, { backgroundColor: palette.accent }]} />
                )}
              </Pressable>
            );
          })}
        </View>
      )}
      {!isLast && !expanded && <View style={[s.divider, { backgroundColor: palette.line }]} />}
    </>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function NotificationPreferencesScreen() {
  const { palette } = useTheme();
  const navigation  = useNavigation<Nav>();
  const insets      = useSafeAreaInsets();
  const uid         = getAuth().currentUser?.uid ?? '';

  const [prefs,   setPrefs]   = useState<Partial<UserPreferences>>({});
  const [loading, setLoading] = useState(true);

  // ── One-shot fetch (KAN-218) ────────────────────────────────────────────────
  useEffect(() => {
    if (!uid) { return; }
    getUserPreferences(uid)
      .then(p => setPrefs(p))
      .catch(err => console.warn('[NotifPrefs] preferences fetch error', err))
      .finally(() => setLoading(false));
  }, [uid]);

  // ── Derived preference values with defaults ────────────────────────────────
  const proximityOn   = prefs.notif_nearby_enabled ?? DEFAULT_USER_PREFERENCES.notif_nearby_enabled;
  const exitPromptOn  = prefs.exitPrompt            ?? DEFAULT_USER_PREFERENCES.exitPrompt;
  const eodEnabled    = prefs.eodReminder?.enabled  ?? DEFAULT_USER_PREFERENCES.eodReminder.enabled;
  const eodTime       = prefs.eodReminder?.time     ?? DEFAULT_USER_PREFERENCES.eodReminder.time;
  const sharedTasksOn = prefs.sharedTasks           ?? DEFAULT_USER_PREFERENCES.sharedTasks;

  // ── Re-schedule the Daily check-in whenever its prefs change ──────────────
  // No task count is involved any more (KAN-303) — it's a morning intention,
  // not a tally, so it fires at the set time regardless of what's outstanding.
  useEffect(() => {
    if (loading) { return; }
    scheduleEodReminder({ enabled: eodEnabled, time: eodTime })
      .catch(err => console.warn('[NotifPrefs] scheduleEod error', err));
  }, [eodEnabled, eodTime, loading]);

  // ── Toggle handlers ────────────────────────────────────────────────────────

  const handleProximityToggle = useCallback(async (value: boolean) => {
    setPrefs(p => ({ ...p, notif_nearby_enabled: value }));
    try {
      await updateUserPreferences(uid, { notif_nearby_enabled: value });
    } catch {
      setPrefs(p => ({ ...p, notif_nearby_enabled: !value }));
    }
  }, [uid]);

  const handleExitPromptToggle = useCallback(async (value: boolean) => {
    setPrefs(p => ({ ...p, exitPrompt: value }));
    try {
      await updateUserPreferences(uid, { exitPrompt: value });
    } catch {
      setPrefs(p => ({ ...p, exitPrompt: !value }));
    }
  }, [uid]);

  const handleEodToggle = useCallback(async (value: boolean) => {
    setPrefs(p => ({ ...p, eodReminder: { enabled: value, time: p.eodReminder?.time ?? eodTime } }));
    try {
      await updateUserPreferences(uid, { eodReminder: { enabled: value, time: eodTime } });
    } catch (err) {
      console.warn('[NotifPrefs] save eodReminder failed', err);
      setPrefs(p => ({ ...p, eodReminder: { enabled: !value, time: eodTime } }));
    }
  }, [uid, eodTime]);

  const handleEodTimeChange = useCallback(async (time: string) => {
    setPrefs(p => ({ ...p, eodReminder: { enabled: eodEnabled, time } }));
    try {
      await updateUserPreferences(uid, { eodReminder: { enabled: eodEnabled, time } });
    } catch (err) {
      console.warn('[NotifPrefs] save eodTime failed', err);
      setPrefs(p => ({ ...p, eodReminder: { enabled: eodEnabled, time: eodTime } }));
    }
  }, [uid, eodEnabled, eodTime]);

  const handleSharedTasksToggle = useCallback(async (value: boolean) => {
    setPrefs(p => ({ ...p, sharedTasks: value }));
    try {
      await updateUserPreferences(uid, { sharedTasks: value });
    } catch {
      setPrefs(p => ({ ...p, sharedTasks: !value }));
    }
  }, [uid]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[s.loadingContainer, { backgroundColor: palette.bg }]}>
        <ActivityIndicator color={palette.muted} accessibilityLabel={COPY.notificationPreferences.loadingA11y} />
      </View>
    );
  }

  return (
    <View style={[s.screen, { backgroundColor: palette.bg }]}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 12, borderBottomColor: palette.line }]}>
        <Pressable
          style={({ pressed }) => [s.backBtn, pressed && { opacity: 0.6 }]}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.notificationPreferences.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[s.headerTitle, { color: palette.text }]}>{COPY.notificationPreferences.screenTitle}</Text>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}>

        {/* When I'm out — a place */}
        <Section title={COPY.notificationPreferences.sectionWhenOut}>
          <PrefRow
            Icon={BellIcon}
            label={COPY.notificationPreferences.proximityLabel}
            sublabel={COPY.notificationPreferences.proximitySublabel}
            value={proximityOn}
            onToggle={handleProximityToggle}
          />
          <PrefRow
            Icon={BellIcon}
            label={COPY.notificationPreferences.exitPromptLabel}
            sublabel={COPY.notificationPreferences.exitPromptSublabel}
            value={exitPromptOn}
            onToggle={handleExitPromptToggle}
            isLast
          />
        </Section>

        {/* Daily — a time they chose */}
        <Section title={COPY.notificationPreferences.sectionDaily}>
          <PrefRow
            Icon={CalendarIcon}
            label={COPY.notificationPreferences.eodLabel}
            sublabel={COPY.notificationPreferences.eodSublabel}
            value={eodEnabled}
            onToggle={handleEodToggle}
          />
          <TimePickerRow
            selectedTime={eodTime}
            onSelect={handleEodTimeChange}
            isLast
          />
        </Section>

        {/* From people — a person */}
        <Section title={COPY.notificationPreferences.sectionFromPeople}>
          <PrefRow
            Icon={BellIcon}
            label={COPY.notificationPreferences.sharedTasksLabel}
            sublabel={COPY.notificationPreferences.sharedTasksSublabel}
            value={sharedTasksOn}
            onToggle={handleSharedTasksToggle}
            isLast
          />
        </Section>

      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems:     'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection:    'row',
    alignItems:       'center',
    justifyContent:   'space-between',
    paddingHorizontal: spacing[4],
    paddingBottom:     12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width:  40,
    height: 40,
    alignItems:     'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize:   17,
    fontFamily: 'Geist-SemiBold',
    fontWeight: '600',
  },
  content: {
    paddingTop:        24,
    paddingHorizontal: spacing.page,
    gap:               24,
  },
  sectionWrapper: {
    gap: 8,
  },
  // KAN-303: sentence case, per the voice rule — no textTransform.
  sectionLabel: {
    fontSize:      12,
    fontFamily:    'Geist-Medium',
    fontWeight:    '500',
    letterSpacing: 0.2,
    paddingLeft:   4,
  },
  card: {
    borderRadius: radius.card,
    borderWidth:  1,
    overflow:     'hidden',
  },
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: 16,
    paddingVertical:   13,
    gap:               12,
    minHeight:         52,
  },
  iconTile: {
    width:          36,
    height:         36,
    borderRadius:   radius.listIcon,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  rowLabelGroup: {
    flex: 1,
    gap:  2,
  },
  rowLabel: {
    fontSize:   15,
    fontFamily: 'Geist-Regular',
  },
  rowSublabel: {
    fontSize:   12,
    fontFamily: 'Geist-Regular',
    lineHeight: 16,
  },
  timeValue: {
    fontSize:    13,
    fontFamily:  'Geist-Regular',
    fontVariant: ['tabular-nums'],
  },
  divider: {
    height:     StyleSheet.hairlineWidth,
    marginLeft: 16 + 36 + 12, // align with label start
  },
  timePicker: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  timeOption: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: 16 + 36 + 12, // align with label start
    paddingVertical:   13,
  },
  timeOptionText: {
    fontSize:   15,
    fontFamily: 'Geist-Regular',
  },
  timeSelectedDot: {
    width:        7,
    height:       7,
    borderRadius: 9999,
  },
});
