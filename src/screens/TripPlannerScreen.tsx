/**
 * TripPlannerScreen — KAN-234
 *
 * "Going somewhere?" flow: destination search → optional dates → radius +
 * static map preview + size estimate → download. All state/logic lives in
 * useTripPlanner (see that file) — this component is rendering only.
 *
 * No region drawing — the user thinks in destinations. Copy never says
 * "POI"/"cache"/"download region" (see constants/copy.ts's tripPlanner
 * section).
 */

import React from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import { getScreenKeyboardAvoidingBehavior } from '../utils/keyboardAvoiding';
import { ChevronLeftIcon, SuitcaseIcon } from '../components/AppIcon';
import LoadingDots from '../components/LoadingDots';
import MiniCalendar from '../components/MiniCalendar';
import { useTripPlanner, TRIP_PREVIEW_WIDTH, TRIP_PREVIEW_HEIGHT } from '../hooks/useTripPlanner';
import { CIRCLE_FRACTION_OF_HALF_DIM } from '../services/maps';
import { TRIP_RADIUS_PRESETS, formatTripSizeMb } from '../services/tripDownload';
import type { RootStackParamList } from '../navigation/AppNavigator';
import type { TripRadiusPreset } from '../types';
import { todayISO, formatDateShort } from '../utils/date';
import { COPY } from '../constants/copy';

type Nav   = NativeStackNavigationProp<RootStackParamList, 'TripPlanner'>;
type Route = RouteProp<RootStackParamList, 'TripPlanner'>;

const CIRCLE_DIAMETER = Math.min(TRIP_PREVIEW_WIDTH, TRIP_PREVIEW_HEIGHT) * CIRCLE_FRACTION_OF_HALF_DIM;

/** Looks up a radius preset's label live at render time (KAN-252 review) —
 *  TRIP_RADIUS_PRESETS itself carries no label since COPY is language-dynamic
 *  and that constant is only evaluated once, at import time. */
function radiusPresetLabel(key: TripRadiusPreset): string {
  switch (key) {
    case 'town':            return COPY.tripPlanner.radiusTown;
    case 'town_and_around': return COPY.tripPlanner.radiusTownAndAround;
    case 'region':           return COPY.tripPlanner.radiusRegion;
  }
}

const STEPS = ['destination', 'dates', 'radius'] as const;

export default function TripPlannerScreen() {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const insets = useSafeAreaInsets();
  const editOptions = route.params?.editTripId && route.params.initialStep
    ? { editTripId: route.params.editTripId, initialStep: route.params.initialStep }
    : undefined;

  const {
    step, query, setQuery, suggestions, searching, selectDestination, destination,
    startDate, endDate, setStartDate, setEndDate, goToRadius, skipDates,
    radiusKey, setRadiusKey, estimatedBytes, previewUrl,
    confirmDownload, error, goBack, isEditing, editInitialStep,
  } = useTripPlanner(
    () => navigation.navigate(route.params?.doneReturnTo ?? 'PlacesIKnow'),
    route.params?.prefillStartDate,
    route.params?.prefillDestinationQuery,
    editOptions,
  );

  const [openPicker, setOpenPicker] = React.useState<'start' | 'end' | null>(null);

  const stepIndex = STEPS.indexOf(step as (typeof STEPS)[number]);
  const stepTitle =
    isEditing && editInitialStep === 'dates'  ? COPY.tripPlanner.changeDatesTitle :
    isEditing && editInitialStep === 'radius' ? COPY.tripPlanner.learnBiggerArea :
    step === 'destination' ? COPY.tripPlanner.destinationQuestion :
    step === 'dates'       ? COPY.tripPlanner.datesQuestion :
    step === 'radius'      ? COPY.tripPlanner.entryRowLabel :
    COPY.tripPlanner.downloadingLabel;

  const untilDate = destination
    ? (endDate ? formatDateShort(endDate) : undefined)
    : undefined;

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.bg }]}
      behavior={getScreenKeyboardAvoidingBehavior()}>
      <View style={{ paddingTop: insets.top }}>
        <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
          <Pressable
            style={styles.navBtn}
            onPress={() => (isEditing && step === editInitialStep) || stepIndex <= 0 ? navigation.goBack() : goBack()}
            accessibilityRole="button"
            accessibilityLabel={COPY.tripPlannerScreen.backA11y}>
            <ChevronLeftIcon color={palette.text} size={22} />
          </Pressable>
          <Text style={[styles.title, { color: palette.text }]}>{stepTitle}</Text>
          <View style={styles.navBtn} />
        </View>

        {step !== 'downloading' && (
          <View style={styles.stepDots}>
            {STEPS.map((s, i) => (
              <View
                key={s}
                style={[styles.dot, { backgroundColor: i <= stepIndex ? palette.accent : palette.line }]}
              />
            ))}
          </View>
        )}
      </View>

      <ScrollView
        style={[styles.scrollView, { backgroundColor: palette.bg }]}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 120 }]}
        keyboardShouldPersistTaps="handled">

        {step === 'destination' && (
          <View style={styles.destinationSection}>
            <View style={[styles.searchWrap, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <SuitcaseIcon color={palette.faint} size={16} />
              <TextInput
                style={[styles.searchInput, { color: palette.text }]}
                placeholder={COPY.tripPlanner.destinationPlaceholder}
                placeholderTextColor={palette.muted}
                value={query}
                onChangeText={setQuery}
                autoFocus
                returnKeyType="search"
              />
            </View>

            {searching && suggestions.length === 0 && (
              <View style={styles.searchLoadingWrap}>
                <LoadingDots color={palette.accent} size={6} />
              </View>
            )}

            {suggestions.length > 0 && (
              <View style={[styles.dropdown, { backgroundColor: palette.surface, borderColor: palette.line }]}>
                {suggestions.map((s, i) => (
                  <Pressable
                    key={s.placeId}
                    style={[
                      styles.dropdownRow,
                      i < suggestions.length - 1 && { borderBottomWidth: 1, borderBottomColor: palette.line },
                    ]}
                    onPress={() => selectDestination(s)}>
                    <Text style={[styles.dropdownLabel, { color: palette.text }]}>{s.name}</Text>
                    {!!s.address && (
                      <Text style={[styles.dropdownSub, { color: palette.muted }]} numberOfLines={1}>{s.address}</Text>
                    )}
                  </Pressable>
                ))}
              </View>
            )}

            {!!error && <Text style={[styles.errorText, { color: palette.nearText }]}>{error}</Text>}
          </View>
        )}

        {step === 'dates' && (
          <View style={styles.datesSection}>
            <Pressable
              style={[
                styles.dateField,
                { borderColor: openPicker === 'start' ? palette.text : palette.line, backgroundColor: palette.surface },
              ]}
              onPress={() => setOpenPicker(p => p === 'start' ? null : 'start')}
              accessibilityRole="button"
              accessibilityLabel={COPY.tripPlannerScreen.startDateA11y}>
              <Text style={[styles.dateFieldText, { color: startDate ? palette.text : palette.muted }]}>
                {startDate ? formatDateShort(startDate) : 'Start date'}
              </Text>
            </Pressable>
            {openPicker === 'start' && (
              <MiniCalendar
                value={startDate ?? null}
                minimumDate={todayISO()}
                onChange={iso => {
                  setStartDate(iso);
                  if (endDate && iso > endDate) { setEndDate(undefined); }
                  setOpenPicker(null);
                }}
              />
            )}

            <Pressable
              style={[
                styles.dateField,
                { borderColor: openPicker === 'end' ? palette.text : palette.line, backgroundColor: palette.surface },
              ]}
              onPress={() => setOpenPicker(p => p === 'end' ? null : 'end')}
              accessibilityRole="button"
              accessibilityLabel={COPY.tripPlannerScreen.endDateA11y}>
              <Text style={[styles.dateFieldText, { color: endDate ? palette.text : palette.muted }]}>
                {endDate ? formatDateShort(endDate) : 'End date'}
              </Text>
            </Pressable>
            {openPicker === 'end' && (
              <MiniCalendar
                value={endDate ?? null}
                minimumDate={startDate ?? todayISO()}
                onChange={iso => { setEndDate(iso); setOpenPicker(null); }}
              />
            )}

            {!isEditing && (
              <Pressable onPress={skipDates} accessibilityRole="button">
                <Text style={[styles.skipLink, { color: palette.muted }]}>{COPY.tripPlanner.datesSkip}</Text>
              </Pressable>
            )}
          </View>
        )}

        {step === 'radius' && destination && (
          <View style={styles.radiusSection}>
            <View style={[styles.previewFrame, { width: TRIP_PREVIEW_WIDTH, height: TRIP_PREVIEW_HEIGHT, backgroundColor: palette.surface2 }]}>
              {previewUrl ? (
                <Image
                  source={{ uri: previewUrl }}
                  style={{ width: TRIP_PREVIEW_WIDTH, height: TRIP_PREVIEW_HEIGHT, borderRadius: radii.card }}
                  onError={() => { /* falls back to the plain surface backdrop below — never blocks the flow */ }}
                />
              ) : null}
              <View
                pointerEvents="none"
                style={[
                  styles.previewCircle,
                  {
                    width: CIRCLE_DIAMETER, height: CIRCLE_DIAMETER, borderRadius: CIRCLE_DIAMETER / 2,
                    marginLeft: -CIRCLE_DIAMETER / 2, marginTop: -CIRCLE_DIAMETER / 2,
                    backgroundColor: `${palette.accent}33`, borderColor: palette.accent,
                  },
                ]}
              />
            </View>

            <View style={styles.radiusChips}>
              {TRIP_RADIUS_PRESETS.map(preset => {
                const selected = preset.key === radiusKey;
                return (
                  <Pressable
                    key={preset.key}
                    style={[
                      styles.radiusChip,
                      { backgroundColor: selected ? palette.text : palette.surface2, borderColor: selected ? palette.text : palette.line },
                    ]}
                    onPress={() => setRadiusKey(preset.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}>
                    <Text style={[styles.radiusChipLabel, { color: selected ? palette.bg : palette.text }]}>
                      {radiusPresetLabel(preset.key)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={[styles.sizeEstimate, { color: palette.muted }]}>
              {COPY.tripPlanner.sizeEstimateLine(formatTripSizeMb(estimatedBytes), untilDate)}
            </Text>

            {!!error && <Text style={[styles.errorText, { color: palette.nearText }]}>{error}</Text>}
          </View>
        )}

        {step === 'downloading' && (
          <View style={styles.downloadingSection}>
            <LoadingDots color={palette.accent} />
            <Text style={[styles.downloadingLabel, { color: palette.muted }]}>{COPY.tripPlanner.downloadingLabel}</Text>
          </View>
        )}
      </ScrollView>

	      {step === 'radius' && (
	        <View style={[styles.footer, { paddingBottom: insets.bottom + 16, borderTopColor: palette.line, backgroundColor: palette.bg }]}>
	          <Pressable
	            style={({ pressed }) => [styles.cta, { backgroundColor: palette.text }, pressed && { opacity: 0.8 }]}
	            onPress={confirmDownload}
	            accessibilityRole="button"
	            accessibilityLabel={isEditing ? COPY.tripPlanner.saveAreaButton : COPY.tripPlanner.downloadButton}>
	            <Text style={[styles.ctaLabel, { color: palette.bg }]}>
	              {isEditing ? COPY.tripPlanner.saveAreaButton : COPY.tripPlanner.downloadButton}
	            </Text>
	          </Pressable>
	        </View>
	      )}

      {step === 'dates' && (
        <View style={[styles.footer, { paddingBottom: insets.bottom + 16, borderTopColor: palette.line, backgroundColor: palette.bg }]}>
	          <Pressable
	            style={({ pressed }) => [styles.cta, { backgroundColor: palette.text }, pressed && { opacity: 0.8 }]}
	            onPress={isEditing ? confirmDownload : goToRadius}
	            accessibilityRole="button"
	            accessibilityLabel={isEditing ? COPY.tripPlanner.saveDatesButton : COPY.tripPlannerScreen.continueA11y}>
	            <Text style={[styles.ctaLabel, { color: palette.bg }]}>
	              {isEditing ? COPY.tripPlanner.saveDatesButton : COPY.tripPlannerScreen.continue}
	            </Text>
	          </Pressable>
	        </View>
	      )}
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollView: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.page, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },

  stepDots: {
    flexDirection: 'row', gap: 6, paddingHorizontal: spacing.page,
    paddingVertical: 12, justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },

  content: { flexGrow: 1, paddingHorizontal: spacing.page, paddingTop: 16, gap: 16 },

  // Destination
  destinationSection: { gap: 10 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: radii.ctaBtn, borderWidth: 1, paddingHorizontal: 14, height: 48,
  },
  searchInput: { flex: 1, fontSize: 16, fontFamily: 'Geist-Regular', height: '100%' },
  searchLoadingWrap: { alignItems: 'center', paddingVertical: 14 },
  dropdown: { borderRadius: radii.card, borderWidth: 1, overflow: 'hidden' },
  dropdownRow: { paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
  dropdownLabel: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  dropdownSub: { fontSize: 13, fontFamily: 'Geist-Regular' },

  // Dates
  datesSection: { gap: 12 },
  dateField: { height: 48, borderRadius: radii.ctaBtn, borderWidth: 1, paddingHorizontal: 16, justifyContent: 'center' },
  dateFieldText: { fontSize: 15, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },
  skipLink: { fontSize: 14, fontFamily: 'Geist-Regular', textAlign: 'center', marginTop: 4 },

  // Radius + preview
  radiusSection: { gap: 16, alignItems: 'center' },
  previewFrame: { borderRadius: radii.card, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  previewCircle: { position: 'absolute', left: '50%', top: '50%', borderWidth: 2 },
  radiusChips: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  radiusChip: { flex: 1, height: 44, borderRadius: radii.ctaBtn, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  radiusChipLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', textAlign: 'center' },
  sizeEstimate: { fontSize: 13, fontFamily: 'Geist-Regular', textAlign: 'center', fontVariant: ['tabular-nums'] },

  // Downloading
  downloadingSection: { alignItems: 'center', justifyContent: 'center', gap: 16, paddingTop: 60 },
  downloadingLabel: { fontSize: 15, fontFamily: 'Geist-Regular' },

  errorText: { fontSize: 13, fontFamily: 'Geist-Regular', textAlign: 'center' },

  // Footer
  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: spacing.page, paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cta: { height: 52, borderRadius: radii.ctaBtn, alignItems: 'center', justifyContent: 'center' },
  ctaLabel: { fontSize: 16, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
});
