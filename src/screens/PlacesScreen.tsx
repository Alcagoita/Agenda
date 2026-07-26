/**
 * PlacesScreen — KAN-304
 *
 * Behind the Lantern's "Places I know" pill. One screen, three sections, in
 * order (bounded first, unbounded last):
 *   1. Places I know — taught + learned brands, capped at 5 with an overflow
 *      row into the full directory; a "Teach it a new place" action.
 *   2. Trips — current/upcoming trips.
 *   3. Places I've been — past trips, uncapped.
 *
 * Empty sections render a faint icon on a surface2 panel plus one line (a
 * destination that renders nothing is broken). Only Trips' empty state carries
 * an action.
 */
import React, { useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import {
  ChevronLeftIcon, ChevronRightIcon, PlusIcon, CloseIcon, SuitcaseIcon, FilledStarIcon,
} from '../components/AppIcon';
import { PoiIcon } from '../components/AppIcon';
import { usePlaces } from '../hooks/usePlaces';
import { capPlaces, type PlaceEntry } from '../services/places';
import { ALL_POI_TYPES, poiCatalogLabel, type PoiType } from '../types';
import type { Trip } from '../types';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { COPY } from '../constants/copy';
import { formatDateShort } from '../utils/date';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Places'>;

const TRIPS_PREVIEW = 2;

function tripDates(trip: Trip): string {
  return trip.startDate && trip.endDate
    ? COPY.tripPlanner.tripRowDates(formatDateShort(trip.startDate), formatDateShort(trip.endDate))
    : COPY.tripPlanner.tripRowNoDates;
}

export default function PlacesScreen() {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { loading, places, activeTrips, pastTripGroups, addPlace, removePlace, forgetTrip } = usePlaces();
  const [teaching, setTeaching] = useState(false);

  const { visible: visiblePlaces, total, hasOverflow } = capPlaces(places);

  const confirmForget = (trip: Trip) => {
    Alert.alert(
      COPY.places.forgetTripTitle(trip.destination),
      COPY.places.forgetTripBody,
      [
        { text: COPY.places.forgetTripCancel, style: 'cancel' },
        { text: COPY.places.forgetTripConfirm, style: 'destructive', onPress: () => forgetTrip(trip) },
      ],
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
        <Pressable
          style={styles.navBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.places.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.places.screenTitle}</Text>
        <View style={styles.navBtn} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}><ActivityIndicator color={palette.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>

          {/* 1. Places I know */}
          <Text style={[styles.sectionTitle, { color: palette.muted }]}>{COPY.places.sectionPlaces}</Text>
          {visiblePlaces.length === 0 ? (
            <EmptyPanel line={COPY.places.emptyPlaces} palette={palette} />
          ) : (
            visiblePlaces.map(place => (
              <PlaceRow
                key={`${place.poiType} ${place.name}`}
                place={place}
                palette={palette}
                onRemove={place.taught && place.id ? () => removePlace(place.id!) : undefined}
              />
            ))
          )}
          {hasOverflow && (
            <Pressable
              style={[styles.overflowRow, { borderColor: palette.line }]}
              onPress={() => navigation.navigate('AllPlaces')}
              accessibilityRole="button"
              accessibilityLabel={COPY.places.allPlacesA11y(total)}>
              <Text style={[styles.overflowLabel, { color: palette.text }]}>{COPY.places.allPlaces(total)}</Text>
              <ChevronRightIcon color={palette.faint} size={16} strokeWidth={1.8} />
            </Pressable>
          )}
          <Pressable
            style={[styles.teachRow, { borderColor: palette.line }]}
            onPress={() => setTeaching(true)}
            accessibilityRole="button"
            accessibilityLabel={COPY.places.teachAction}>
            <PlusIcon color={palette.accent} size={18} />
            <Text style={[styles.teachLabel, { color: palette.text }]}>{COPY.places.teachAction}</Text>
          </Pressable>

          {/* 2. Trips */}
          <Text style={[styles.sectionTitle, styles.sectionGap, { color: palette.muted }]}>{COPY.places.sectionTrips}</Text>
          {activeTrips.length === 0 ? (
            <EmptyPanel
              line={COPY.places.emptyTrips}
              palette={palette}
              action={{ label: COPY.places.emptyTripsAction, onPress: () => navigation.navigate('TripPlanner') }}
            />
          ) : (
            <>
              {activeTrips.slice(0, TRIPS_PREVIEW).map(trip => (
                <View key={trip.id} style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.line }]}>
                  <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
                    <SuitcaseIcon color={palette.muted} size={20} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>{trip.destination}</Text>
                    <Text style={[styles.rowSub, { color: palette.muted }]} numberOfLines={1}>{tripDates(trip)}</Text>
                  </View>
                </View>
              ))}
              {activeTrips.length > TRIPS_PREVIEW && (
                <Pressable
                  style={[styles.overflowRow, { borderColor: palette.line }]}
                  onPress={() => navigation.navigate('PlacesIKnow')}
                  accessibilityRole="button">
                  <Text style={[styles.overflowLabel, { color: palette.text }]}>{COPY.places.allPlaces(activeTrips.length)}</Text>
                  <ChevronRightIcon color={palette.faint} size={16} strokeWidth={1.8} />
                </Pressable>
              )}
            </>
          )}

          {/* 3. Places I've been (uncapped, last) */}
          <Text style={[styles.sectionTitle, styles.sectionGap, { color: palette.muted }]}>{COPY.places.sectionPastTrips}</Text>
          {pastTripGroups.length === 0 ? (
            <EmptyPanel line={COPY.places.emptyPastTrips} palette={palette} />
          ) : (
            pastTripGroups.map(group => (
              <View key={group.year}>
                <Text style={[styles.yearLabel, { color: palette.faint }]}>{group.year}</Text>
                {group.trips.map(trip => (
                  <View key={trip.id} style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.line }]}>
                    <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
                      <SuitcaseIcon color={palette.muted} size={20} />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>{trip.destination}</Text>
                      <Text style={[styles.rowSub, { color: palette.muted }]} numberOfLines={1}>{tripDates(trip)}</Text>
                    </View>
                    <Pressable
                      onPress={() => confirmForget(trip)}
                      hitSlop={8}
                      style={styles.removeBtn}
                      accessibilityRole="button"
                      accessibilityLabel={COPY.places.removeA11y(trip.destination)}>
                      <Text style={[styles.removeX, { color: palette.muted }]}>×</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ))
          )}
        </ScrollView>
      )}

      <TeachSheet
        visible={teaching}
        palette={palette}
        onClose={() => setTeaching(false)}
        onSave={(poiType, name) => { addPlace(poiType, name); setTeaching(false); }}
      />
    </View>
  );
}

// ── A single brand row ──────────────────────────────────────────────────────────
function PlaceRow({ place, palette, onRemove }: {
  place: PlaceEntry;
  palette: ReturnType<typeof useTheme>['palette'];
  onRemove?: () => void;
}) {
  return (
    <View style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.line }]}>
      <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
        <PoiIcon type={place.poiType} color={palette.muted} size={20} />
      </View>
      <Text style={[styles.brandName, { color: palette.text }]} numberOfLines={1}>{place.name}</Text>
      {place.taught && (
        <View accessibilityLabel={COPY.places.taughtMarkerA11y}>
          <FilledStarIcon color={palette.accent} size={13} />
        </View>
      )}
      {onRemove && (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          style={styles.removeBtn}
          accessibilityRole="button"
          accessibilityLabel={COPY.places.removeA11y(place.name)}>
          <Text style={[styles.removeX, { color: palette.muted }]}>×</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Empty-state panel ───────────────────────────────────────────────────────────
function EmptyPanel({ line, palette, action }: {
  line: string;
  palette: ReturnType<typeof useTheme>['palette'];
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={[styles.emptyPanel, { backgroundColor: palette.surface2 }]}>
      <SuitcaseIcon color={palette.faint} size={22} />
      <Text style={[styles.emptyLine, { color: palette.muted }]}>{line}</Text>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={action.label}>
          <Text style={[styles.emptyAction, { color: palette.accent }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Teach-a-place sheet: pick a POI type + name the brand ────────────────────────
function TeachSheet({ visible, palette, onClose, onSave }: {
  visible: boolean;
  palette: ReturnType<typeof useTheme>['palette'];
  onClose: () => void;
  onSave: (poiType: string, name: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [type, setType] = useState<PoiType | null>(null);
  const [name, setName] = useState('');
  const canSave = type != null && name.trim().length > 0;

  const reset = () => { setType(null); setName(''); };
  // Every dismissal clears the form, so reopening always starts empty.
  const handleClose = () => { reset(); onClose(); };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={[styles.sheetScrim, { backgroundColor: palette.scrim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} accessibilityLabel={COPY.places.teachCancelA11y} />
        <View style={[styles.sheet, { backgroundColor: palette.bg, paddingBottom: spacing.page + insets.bottom }]}>
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: palette.text }]}>{COPY.places.teachTitle}</Text>
            <Pressable onPress={handleClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={COPY.places.teachCancelA11y}>
              <CloseIcon color={palette.muted} size={18} />
            </Pressable>
          </View>

          <Text style={[styles.fieldLabel, { color: palette.muted }]}>{COPY.places.teachTypeLabel}</Text>
          <View style={styles.typeGrid}>
            {ALL_POI_TYPES.map(t => {
              const selected = t === type;
              return (
                <Pressable
                  key={t}
                  onPress={() => setType(t)}
                  style={[
                    styles.typeChip,
                    { borderColor: selected ? palette.accent : palette.line, backgroundColor: selected ? palette.nearTint : palette.surface },
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={poiCatalogLabel(t)}>
                  <PoiIcon type={t} color={selected ? palette.nearText : palette.muted} size={18} />
                  <Text style={[styles.typeChipLabel, { color: selected ? palette.nearText : palette.text }]}>{poiCatalogLabel(t)}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, { color: palette.muted }]}>{COPY.places.teachNameLabel}</Text>
          <TextInput
            style={[styles.nameInput, { color: palette.text, borderColor: palette.line, backgroundColor: palette.surface }]}
            placeholder={COPY.places.teachNamePlaceholder}
            placeholderTextColor={palette.muted}
            value={name}
            onChangeText={setName}
            returnKeyType="done"
          />

          <Pressable
            style={[styles.saveBtn, { backgroundColor: palette.accent, opacity: canSave ? 1 : 0.5 }]}
            disabled={!canSave}
            onPress={() => { if (canSave && type) { onSave(type, name.trim()); reset(); } }}
            accessibilityRole="button"
            accessibilityLabel={COPY.places.teachSaveAction}>
            <Text style={[styles.saveLabel, { color: palette.onAccent }]}>{COPY.places.teachSaveAction}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.page, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: spacing.page, paddingTop: 16, gap: 10 },

  sectionTitle: { fontSize: 11, fontWeight: '600', fontFamily: 'Geist-SemiBold', letterSpacing: 1 },
  sectionGap: { marginTop: 22 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: radii.card, borderWidth: 1, padding: 12,
  },
  iconTile: { width: 36, height: 36, borderRadius: radii.listIcon, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  rowSub: { fontSize: 12, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },
  brandName: { flex: 1, fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  removeBtn: { paddingHorizontal: 4, paddingVertical: 4 },
  removeX: { fontSize: 22, lineHeight: 22 },

  overflowRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 44, paddingHorizontal: 12, borderRadius: radii.ctaBtn, borderWidth: 1,
  },
  overflowLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500', fontVariant: ['tabular-nums'] },
  teachRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    minHeight: 44, paddingHorizontal: 12, borderRadius: radii.ctaBtn, borderWidth: 1,
  },
  teachLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500' },

  yearLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 6, fontVariant: ['tabular-nums'] },

  emptyPanel: {
    alignItems: 'center', gap: 8, paddingVertical: 24, paddingHorizontal: 16, borderRadius: radii.card,
  },
  emptyLine: { fontSize: 13, fontFamily: 'Geist-Regular', textAlign: 'center' },
  emptyAction: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 2 },

  // Teach sheet
  sheetScrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: spacing.page, gap: 12 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  fieldLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 4 },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1,
  },
  typeChipLabel: { fontSize: 13, fontFamily: 'Geist-Medium', fontWeight: '500' },
  nameInput: {
    height: 46, borderRadius: radii.ctaBtn, borderWidth: 1, paddingHorizontal: 14,
    fontSize: 15, fontFamily: 'Geist-Regular',
  },
  saveBtn: { height: 50, borderRadius: radii.ctaBtn, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  saveLabel: { fontSize: 16, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
});
