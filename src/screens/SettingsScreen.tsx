/**
 * SettingsScreen — KAN-113
 *
 * Sections:
 *   TASKS            — Manage Categories, Notification Preferences (dynamic count)
 *   APPEARANCE       — Dark mode toggle
 *   LOCATION & BATTERY — Pause nearby alerts on low battery toggle
 *   IMPORT TASKS     — per-platform import sources (tap-to-import, inline state)
 *   ACCOUNT          — Sign out (danger)
 *
 * Footer: "Brush Away · v{APP_VERSION}" (faint, 12px)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import { useTheme } from '../theme';
import { radius, spacing } from '../theme/tokens';
import {
  getLowBatteryPausePref,
  setLowBatteryPausePref,
  getUser,
} from '../services/firestore';
import { logout } from '../services/auth';
import { logTap } from '../services/analytics';
import {
  BatteryIcon,
  BellIcon,
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeIcon,
  GridIcon,
  HomeIcon,
  ListCheckIcon,
  LogOutIcon,
  MoonIcon,
  SunIcon,
} from '../components/AppIcon';
import { RootStackParamList } from '../navigation/AppNavigator';
import { ImportResult } from '../types';
import { COPY, type SupportedLanguage } from '../constants/copy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const APP_VERSION: string = require('../../package.json').version;

type Nav = NativeStackNavigationProp<RootStackParamList>;
type ImportConnector = (uid: string) => Promise<ImportResult>;

interface ImportSource {
  key:       ImportSourceKey;
  Icon:      React.FC<{ color: string; size?: number }>;
  connector: ImportConnector;
}

type ImportSourceKey = 'google_tasks' | 'google_calendar' | 'eventkit_reminders' | 'eventkit_calendar';

type ImportStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; result: ImportResult }
  | { kind: 'error'; message: string };


// ─── Import row ───────────────────────────────────────────────────────────────

interface ImportRowProps {
  source: ImportSource;
  /** Looked up live at render time (KAN-252 review) — never bundled into the
   *  ref-cached `source` object, which is only computed once on first mount
   *  and would otherwise freeze this label in whatever language was active
   *  at that point. */
  label:  string;
  uid:    string;
  isLast: boolean;
}

function ImportRow({ source, label, uid, isLast }: ImportRowProps) {
  const { palette } = useTheme();
  const [status, setStatus] = useState<ImportStatus>({ kind: 'idle' });

  const handlePress = useCallback(async () => {
    if (status.kind === 'loading') { return; }
    setStatus({ kind: 'loading' });
    try {
      const result = await source.connector(uid);
      setStatus({ kind: 'success', result });
      logTap('calendar_import', { source: source.key });
    } catch {
      setStatus({ kind: 'error', message: COPY.settings.importErrorMessage });
    }
  }, [status.kind, source, uid]);

  const isLoading = status.kind === 'loading';
  const { Icon } = source;

  let trailing: React.ReactNode;
  if (isLoading) {
    trailing = (
      <ActivityIndicator
        size="small"
        color={palette.muted}
        accessibilityLabel={COPY.settings.importInProgressA11y}
      />
    );
  } else if (status.kind === 'success') {
    trailing = (
      <Text style={[s.trailingText, { color: palette.muted }]}>
        {COPY.settings.importedCount(status.result.imported)}
      </Text>
    );
  } else if (status.kind === 'error') {
    trailing = (
      <Text style={[s.trailingText, { color: palette.accent }]}>
        {COPY.settings.importFailedRetry}
      </Text>
    );
  } else {
    trailing = <ChevronRightIcon color={palette.faint} size={16} />;
  }

  return (
    <>
      <Pressable
        style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}
        onPress={handlePress}
        disabled={isLoading}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy: isLoading }}>
        <View style={[s.iconTile, { backgroundColor: palette.surface2 }]}>
          <Icon color={palette.muted} size={19} />
        </View>
        <Text style={[s.rowLabel, s.rowLabelStandalone, { color: palette.text }]}>{label}</Text>
        <View style={s.trailingSlot}>{trailing}</View>
      </Pressable>
      {!isLast && <View style={[s.divider, { backgroundColor: palette.line }]} />}
    </>
  );
}

// ─── Generic settings row ─────────────────────────────────────────────────────

interface SettingsRowProps {
  Icon:     React.FC<{ color: string; size?: number }>;
  label:    string;
  /** Optional secondary line of text below the label. */
  sublabel?: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
  danger?:  boolean;
  isLast?:  boolean;
  accessibilityLabel?: string;
}

function SettingsRow({
  Icon,
  label,
  sublabel,
  onPress,
  trailing,
  danger = false,
  isLast = false,
  accessibilityLabel,
}: SettingsRowProps) {
  const { palette } = useTheme();
  const textColor = danger ? palette.accent : palette.text;

  return (
    <>
      <Pressable
        style={({ pressed }) => [s.row, pressed && onPress && { opacity: 0.6 }]}
        onPress={onPress}
        accessibilityRole={onPress ? 'button' : 'none'}
        accessibilityLabel={accessibilityLabel ?? label}>
        <View style={[s.iconTile, { backgroundColor: palette.surface2 }]}>
          <Icon color={danger ? palette.accent : palette.muted} size={19} />
        </View>
        <View style={s.rowLabelGroup}>
          <Text style={[s.rowLabel, { color: textColor }]}>{label}</Text>
          {sublabel ? (
            <Text style={[s.rowSublabel, { color: palette.muted }]} numberOfLines={2}>
              {sublabel}
            </Text>
          ) : null}
        </View>
        <View style={s.trailingSlot}>
          {trailing !== undefined
            ? trailing
            : onPress && <ChevronRightIcon color={palette.faint} size={16} />}
        </View>
      </Pressable>
      {!isLast && <View style={[s.divider, { backgroundColor: palette.line }]} />}
    </>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { palette } = useTheme();
  return (
    <View style={s.sectionWrapper}>
      <Text style={[s.sectionLabel, { color: palette.muted }]}>{title}</Text>
      <View style={[s.card, { backgroundColor: palette.surface }]}>{children}</View>
    </View>
  );
}

/** Reads COPY live at call time (not module load) since COPY's active
 *  language can change at runtime — see constants/copy.ts. */
function languageLabel(lang: SupportedLanguage): string {
  return lang === 'pt-PT' ? COPY.settings.languagePortuguese : COPY.settings.languageEnglish;
}

// ─── Language picker sheet ────────────────────────────────────────────────────
//
// A native Alert.alert has OS chrome that never matches the app's own theme
// (radius, palette, typography) — this is a themed bottom sheet instead,
// styled the same way as the rest of Settings (card + row + divider).

interface LanguagePickerSheetProps {
  visible:  boolean;
  current:  SupportedLanguage;
  onSelect: (lang: SupportedLanguage) => void;
  onClose:  () => void;
}

const LANGUAGE_OPTIONS: SupportedLanguage[] = ['en', 'pt-PT'];

function LanguagePickerSheet({ visible, current, onSelect, onClose }: LanguagePickerSheetProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={COPY.settings.languageCancel}
      />
      <View style={[s.sheetWrap, { paddingBottom: insets.bottom + 12 }]}>
        <View style={[s.sheetCard, { backgroundColor: palette.surface }]}>
          <Text style={[s.sheetTitle, { color: palette.muted }]}>
            {COPY.settings.languageSheetTitle}
          </Text>
          <View accessibilityRole="radiogroup">
            {LANGUAGE_OPTIONS.map((lang, idx) => {
              const selected = lang === current;
              return (
                <React.Fragment key={lang}>
                  <Pressable
                    style={({ pressed }) => [s.row, pressed && { opacity: 0.6 }]}
                    onPress={() => onSelect(lang)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={languageLabel(lang)}>
                    <Text style={[s.rowLabel, { color: palette.text, flex: 1 }]}>
                      {languageLabel(lang)}
                    </Text>
                    {selected && <CheckIcon color={palette.accent} size={18} />}
                  </Pressable>
                  {idx < LANGUAGE_OPTIONS.length - 1 && (
                    <View style={[s.divider, { backgroundColor: palette.line, marginLeft: 16 }]} />
                  )}
                </React.Fragment>
              );
            })}
          </View>
        </View>
        <Pressable
          style={({ pressed }) => [s.sheetCancel, { backgroundColor: palette.surface }, pressed && { opacity: 0.6 }]}
          onPress={onClose}>
          <Text style={[s.sheetCancelLabel, { color: palette.text }]}>
            {COPY.settings.languageCancel}
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const { palette, dark, setDark, language, setLanguage } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets     = useSafeAreaInsets();

  const uid = getAuth().currentUser?.uid ?? '';

  const [lowBatteryPause, setLowBatteryPause] = useState(false);

  useEffect(() => {
    if (!uid) { return; }
    getLowBatteryPausePref(uid).then(setLowBatteryPause).catch(() => {});
  }, [uid]);

  // ── Home address (KAN-247) — re-fetched on every focus so returning from
  // HomeAddressScreen after a set/change/clear shows the current value. ──
  const [homeAddress, setHomeAddress] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    if (!uid) { setHomeAddress(null); return; }
    getUser(uid).then(u => setHomeAddress(u?.home?.address ?? null)).catch(() => {});
  }, [uid]));

  const handleDarkToggle = useCallback((value: boolean) => {
    setDark(value);
    logTap('settings_theme_toggle', { dark: value });
  }, [setDark]);

  const [languageSheetOpen, setLanguageSheetOpen] = useState(false);

  const handleLanguageSelect = useCallback((value: SupportedLanguage) => {
    setLanguage(value);
    logTap('settings_language_change', { language: value });
    setLanguageSheetOpen(false);
  }, [setLanguage]);

  const handleLowBatteryToggle = useCallback(async (value: boolean) => {
    setLowBatteryPause(value);
    try {
      await setLowBatteryPausePref(uid, value);
    } catch {
      setLowBatteryPause(!value);
    }
  }, [uid]);

  const handleSignOut = useCallback(() => {
    Alert.alert(
      COPY.settings.signOutConfirmTitle,
      COPY.settings.signOutConfirmBody,
      [
        { text: COPY.settings.signOutCancelAction, style: 'cancel' },
        {
          text: COPY.settings.signOutConfirmAction,
          style: 'destructive',
          onPress: async () => {
            try {
              await logout();
              logTap('logout');
            } catch {
              Alert.alert(COPY.settings.signOutErrorTitle, COPY.settings.signOutErrorBody);
            }
          },
        },
      ],
    );
  }, []);

  // Stable across the component's lifetime — the platform-specific connector
  // choice never changes at runtime, only the label needs to stay live (see
  // importLabels below).
  const importSources = useRef<ImportSource[]>((() => {
    if (Platform.OS === 'android') {
      const { importFromGoogleTasks, importFromGoogleCalendar } = require('../services/import');
      return [
        { key: 'google_tasks',    Icon: ListCheckIcon, connector: importFromGoogleTasks    },
        { key: 'google_calendar', Icon: CalendarIcon,  connector: importFromGoogleCalendar },
      ];
    }
    const { importFromReminders, importFromCalendar } = require('../services/import');
    return [
      { key: 'eventkit_reminders', Icon: ListCheckIcon, connector: importFromReminders },
      { key: 'eventkit_calendar',  Icon: CalendarIcon,  connector: importFromCalendar  },
    ];
  })()).current;

  const importLabels: Record<ImportSourceKey, string> = {
    google_tasks:        COPY.settings.importGoogleTasks,
    google_calendar:     COPY.settings.importGoogleCalendar,
    eventkit_reminders:  COPY.settings.importReminders,
    eventkit_calendar:   COPY.settings.importCalendar,
  };

  const AppearanceIcon = dark ? MoonIcon : SunIcon;

  return (
    <View style={[s.root, { backgroundColor: palette.bg }]}>
      {/* Header */}
      <View
        style={[
          s.header,
          { paddingTop: insets.top + 8, borderBottomColor: palette.line },
        ]}>
        <Pressable
          style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.6 }]}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.settings.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[s.headerTitle, { color: palette.text }]}>{COPY.settings.screenTitle}</Text>
        {/* balance the back button so title centers */}
        <View style={s.headerBtn} />
      </View>

      <ScrollView
        style={[s.scrollView, { backgroundColor: palette.bg }]}
        contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* TASKS */}
        <Section title={COPY.settings.sectionTasks}>
          <SettingsRow
            Icon={GridIcon}
            label={COPY.settings.manageCategories}
            onPress={() => navigation.navigate('Categories')}
            accessibilityLabel={COPY.settings.manageCategories}
          />
          <SettingsRow
            Icon={BellIcon}
            label={COPY.settings.notificationPreferences}
            onPress={() => navigation.navigate('NotificationPreferences')}
            isLast
            accessibilityLabel={COPY.settings.notificationPreferences}
          />
        </Section>

        {/* APPEARANCE */}
        <Section title={COPY.settings.sectionAppearance}>
          <SettingsRow
            Icon={AppearanceIcon}
            label={COPY.settings.darkMode}
            trailing={
              <Switch
                value={dark}
                onValueChange={handleDarkToggle}
                trackColor={{ false: palette.surface2, true: palette.accent }}
                thumbColor={palette.bg}
                accessibilityLabel={COPY.settings.darkModeToggleA11y}
              />
            }
          />
          <SettingsRow
            Icon={GlobeIcon}
            label={COPY.settings.languageRowLabel}
            sublabel={languageLabel(language)}
            onPress={() => setLanguageSheetOpen(true)}
            isLast
            accessibilityLabel={COPY.settings.languageRowLabel}
          />
        </Section>

        {/* LOCATION & BATTERY */}
        <Section title={COPY.settings.sectionLocationBattery}>
          <SettingsRow
            Icon={HomeIcon}
            label={COPY.home.settingsRowLabel}
            sublabel={homeAddress ?? COPY.home.settingsRowEmptySublabel}
            onPress={() => navigation.navigate('HomeAddress')}
            accessibilityLabel={COPY.home.settingsRowLabel}
          />
          <SettingsRow
            Icon={BatteryIcon}
            label={COPY.settings.pauseLowBattery}
            isLast
            trailing={
              <Switch
                value={lowBatteryPause}
                onValueChange={handleLowBatteryToggle}
                trackColor={{ false: palette.surface2, true: palette.accent }}
                thumbColor={palette.bg}
                accessibilityLabel={COPY.settings.pauseLowBatteryToggleA11y}
              />
            }
          />
        </Section>

        {/* IMPORT TASKS */}
        <Section title={COPY.settings.sectionImportTasks}>
          {importSources.map((src, idx) => (
            <ImportRow
              key={src.key}
              label={importLabels[src.key]}
              source={src}
              uid={uid}
              isLast={idx === importSources.length - 1}
            />
          ))}
        </Section>

        {/* ACCOUNT */}
        <Section title={COPY.settings.sectionAccount}>
          <SettingsRow
            Icon={LogOutIcon}
            label={COPY.settings.signOutConfirmAction}
            onPress={handleSignOut}
            danger
            isLast
            accessibilityLabel={COPY.settings.signOutConfirmAction}
          />
        </Section>

        <Text style={[s.footer, { color: palette.faint }]}>
          {COPY.settings.footerVersion(APP_VERSION)}
        </Text>
        <Text style={[s.footer, { color: palette.faint }]}>
          {COPY.settings.footerAttribution}
        </Text>
      </ScrollView>

      <LanguagePickerSheet
        visible={languageSheetOpen}
        current={language}
        onSelect={handleLanguageSelect}
        onClose={() => setLanguageSheetOpen(false)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.page,
    paddingBottom:     12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: {
    width:          36,
    height:         36,
    alignItems:     'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize:   17,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },

  scroll: {
    flexGrow:   1,
    paddingTop: 20,
    gap:        16,
  },
  scrollView: {
    flex: 1,
  },

  sectionWrapper: {
    gap: 6,
  },
  sectionLabel: {
    fontSize:          12,
    fontWeight:        '500',
    fontFamily:        'Geist-Medium',
    letterSpacing:     0.5,
    paddingHorizontal: spacing.page + 6,
  },
  card: {
    borderRadius:     radius.card,
    marginHorizontal: spacing.page,
    overflow:         'hidden',
  },

  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: 16,
    paddingVertical:   10,
    minHeight:         52,
    gap:               12,
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
    flex:    1,
    gap:     2,
    minWidth: 0,
  },
  rowLabel: {
    fontSize:   15,
    fontWeight: '400',
    fontFamily: 'Geist-Regular',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  rowLabelStandalone: {
    flex: 1,
  },
  rowSublabel: {
    fontSize:   12,
    fontFamily: 'Geist-Regular',
    lineHeight: 16,
    includeFontPadding: false,
  },
  trailingSlot: {
    alignItems:     'center',
    justifyContent: 'center',
  },
  trailingGroup: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  },
  trailingText: {
    fontSize:   13,
    fontFamily: 'Geist-Regular',
  },

  divider: {
    height:     StyleSheet.hairlineWidth,
    marginLeft: 16 + 36 + 12, // align with label start
  },

  footer: {
    fontSize:   12,
    fontFamily: 'Geist-Regular',
    textAlign:  'center',
    marginTop:  8,
  },

  sheetWrap: {
    position:          'absolute',
    left:              0,
    right:             0,
    bottom:            0,
    paddingHorizontal: spacing.page,
    gap:               8,
  },
  sheetCard: {
    borderRadius: radius.card,
    overflow:     'hidden',
  },
  sheetTitle: {
    fontSize:          12,
    fontWeight:        '500',
    fontFamily:        'Geist-Medium',
    letterSpacing:     0.5,
    paddingHorizontal: 16,
    paddingTop:        14,
    paddingBottom:     8,
  },
  sheetCancel: {
    borderRadius:   radius.card,
    paddingVertical: 14,
    alignItems:     'center',
  },
  sheetCancelLabel: {
    fontSize:   15,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },
});
