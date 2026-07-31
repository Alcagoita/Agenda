/**
 * OffGridScreen — KAN-246
 *
 * "Going off-grid for a bit?" flow: one screen, two taps — pick a duration
 * chip, then confirm. Area defaults to current location; "Somewhere else?"
 * optionally overrides it with a destination search (same autocomplete as
 * Trip Planner). All state/logic lives in useOffGridWindow — this component
 * is rendering only.
 */

import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import { getScreenKeyboardAvoidingBehavior } from '../utils/keyboardAvoiding';
import { ChevronLeftIcon, SuitcaseIcon } from '../components/AppIcon';
import LoadingDots from '../components/LoadingDots';
import { useOffGridWindow } from '../hooks/useOffGridWindow';
import type { OffGridDurationKey } from '../services/offGrid';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { COPY } from '../constants/copy';

type Nav = NativeStackNavigationProp<RootStackParamList, 'OffGrid'>;

const DURATION_OPTIONS: { key: OffGridDurationKey; label: () => string }[] = [
  { key: 'few_hours',     label: () => COPY.offGrid.durationFewHours },
  { key: 'until_tonight', label: () => COPY.offGrid.durationUntilTonight },
  { key: 'pick_time',     label: () => COPY.offGrid.durationPickTime },
];

export default function OffGridScreen() {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const {
    duration, setDuration,
    destinationOverride, destinationQuery, setDestinationQuery,
    destinationSuggestions, destinationSearching, selectDestinationOverride, clearDestinationOverride,
    confirming, error, canConfirm, confirm,
  } = useOffGridWindow(() => navigation.goBack());

  const [showDestinationSearch, setShowDestinationSearch] = React.useState(false);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.bg }]}
      behavior={getScreenKeyboardAvoidingBehavior()}>
      <View style={{ paddingTop: insets.top }}>
        <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
          <Pressable
            style={styles.navBtn}
            onPress={() => navigation.goBack()}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={COPY.tripPlannerScreen.backA11y}>
            <ChevronLeftIcon color={palette.text} size={22} />
          </Pressable>
          <Text style={[styles.title, { color: palette.text }]}>{COPY.offGrid.screenTitle}</Text>
          <View style={styles.navBtn} />
        </View>
      </View>

      <ScrollView
        style={[styles.scrollView, { backgroundColor: palette.bg }]}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled">

        <View style={styles.chipRow} accessibilityRole="radiogroup">
          {DURATION_OPTIONS.map(opt => {
            const selected = duration === opt.key;
            return (
              <Pressable
                key={opt.key}
                onPress={() => setDuration(opt.key)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: selected ? palette.text : palette.surface,
                    borderColor:     selected ? palette.text : palette.line,
                  },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={opt.label()}>
                <Text style={[styles.chipLabel, { color: selected ? palette.bg : palette.text }]}>
                  {opt.label()}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {!showDestinationSearch && !destinationOverride && (
          <Pressable onPress={() => setShowDestinationSearch(true)} hitSlop={12} accessibilityRole="button">
            <Text style={[styles.linkText, { color: palette.muted }]}>{COPY.offGrid.destinationOverridePrompt}</Text>
          </Pressable>
        )}

        {destinationOverride && (
          <Pressable
            onPress={clearDestinationOverride}
            style={[styles.overrideChip, { backgroundColor: palette.surface2, borderColor: palette.line }]}
            accessibilityRole="button">
            <SuitcaseIcon color={palette.muted} size={14} />
            <Text style={[styles.overrideChipLabel, { color: palette.text }]} numberOfLines={1}>
              {destinationOverride.name}
            </Text>
            <Text style={[styles.overrideChipClear, { color: palette.muted }]}>×</Text>
          </Pressable>
        )}

        {showDestinationSearch && !destinationOverride && (
          <View style={styles.destinationSection}>
            <View style={[styles.searchWrap, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <SuitcaseIcon color={palette.faint} size={16} />
              <TextInput
                style={[styles.searchInput, { color: palette.text }]}
                placeholder={COPY.offGrid.destinationPlaceholder}
                placeholderTextColor={palette.muted}
                value={destinationQuery}
                onChangeText={setDestinationQuery}
                autoFocus
                returnKeyType="search"
              />
            </View>

            {destinationSearching && destinationSuggestions.length === 0 && (
              <View style={styles.searchLoadingWrap}>
                <LoadingDots color={palette.muted} size={6} />
              </View>
            )}

            {destinationSuggestions.length > 0 && (
              <View style={[styles.dropdown, { backgroundColor: palette.surface, borderColor: palette.line }]}>
                {destinationSuggestions.map((s, i) => (
                  <Pressable
                    key={s.placeId}
                    style={[
                      styles.dropdownRow,
                      i < destinationSuggestions.length - 1 && { borderBottomWidth: 1, borderBottomColor: palette.line },
                    ]}
                    onPress={() => selectDestinationOverride(s)}>
                    <Text style={[styles.dropdownLabel, { color: palette.text }]}>{s.name}</Text>
                    {!!s.address && (
                      <Text style={[styles.dropdownSub, { color: palette.muted }]} numberOfLines={1}>{s.address}</Text>
                    )}
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        )}

        {error && (
          <Text style={[styles.errorText, { color: palette.danger }]} accessibilityRole="alert">{error}</Text>
        )}

        <Pressable
          style={[
            styles.confirmBtn,
            { backgroundColor: palette.text, opacity: canConfirm ? 1 : 0.5 },
          ]}
          onPress={confirm}
          disabled={!canConfirm}
          accessibilityRole="button"
          accessibilityLabel={confirming ? COPY.offGrid.confirmingLabel : COPY.offGrid.confirmButton}>
          {confirming ? (
            <ActivityIndicator size="small" color={palette.bg} />
          ) : (
            <Text style={[styles.confirmLabel, { color: palette.bg }]}>{COPY.offGrid.confirmButton}</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollView: { flex: 1 },
  topBar: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.page,
    paddingVertical:   12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title:  { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },

  content: { flexGrow: 1, paddingHorizontal: spacing.page, paddingTop: 24, gap: 16 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    borderRadius:      9999,
    borderWidth:        1,
    paddingHorizontal: 16,
    paddingVertical:    12,
  },
  chipLabel: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },

  linkText: { fontSize: 14, fontFamily: 'Geist-Regular' },

  overrideChip: {
    flexDirection:     'row',
    alignItems:        'center',
    alignSelf:         'flex-start',
    gap:               8,
    paddingHorizontal: 12,
    paddingVertical:   12,
    borderRadius:      9999,
    borderWidth:        1,
  },
  overrideChipLabel: { fontSize: 14, fontFamily: 'Geist-Medium', maxWidth: 220 },
  overrideChipClear: { fontSize: 16, lineHeight: 18, fontFamily: 'Geist-Regular' },

  destinationSection: { gap: 10 },
  searchWrap: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               10,
    height:            52,
    paddingHorizontal: 14,
    borderRadius:      radii.card,
    borderWidth:        1,
  },
  searchInput: { flex: 1, fontSize: 16, fontFamily: 'Geist-Regular', height: '100%' },
  searchLoadingWrap: { alignItems: 'center', paddingVertical: 14 },
  dropdown: { borderRadius: radii.card, borderWidth: 1, overflow: 'hidden' },
  dropdownRow: { paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
  dropdownLabel: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  dropdownSub: { fontSize: 13, fontFamily: 'Geist-Regular' },

  errorText: { fontSize: 13, fontFamily: 'Geist-Regular' },

  confirmBtn: {
    height:         52,
    borderRadius:   radii.ctaBtn,
    alignItems:     'center',
    justifyContent: 'center',
    marginTop:      8,
  },
  confirmLabel: { fontSize: 16, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
});
