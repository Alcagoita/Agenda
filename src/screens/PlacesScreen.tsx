/**
 * PlacesScreen — KAN-304
 *
 * Behind the Lantern's "Places I know" pill (shares its name). One screen,
 * three sections, in order (bounded first, unbounded last):
 *   1. Places I know — taught + learned brands, capped at 5 with an overflow
 *      row into the full directory; a "Teach it a new place" action. (No
 *      section header — the screen title already names it.)
 *   2. Trips — current/upcoming trips.
 *   3. Places I've been — past trips, uncapped.
 *
 * This screen is for looking, not managing: rows are plain list items (no cards)
 * and carry no remove control — teaching and forgetting live in the full
 * directory (AllPlacesScreen). Empty sections render their own faint icon on a
 * surface2 panel plus one line; only Trips' empty state carries an action.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import {
  ChevronLeftIcon, ChevronRightIcon, PlusIcon, PinIcon, ClockIcon, SuitcaseIcon, FilledStarIcon, PoiIcon,
} from '../components/AppIcon';
import type { IconProps } from '../components/AppIcon/shared';
import TeachSheet from '../components/TeachSheet';
import { usePlaces } from '../hooks/usePlaces';
import { capPlaces, type PlaceEntry } from '../services/places';
import type { Trip } from '../types';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { COPY } from '../constants/copy';
import { formatDateShort } from '../utils/date';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Places'>;
type IconCmp = (props: IconProps) => React.JSX.Element;

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
  const { loading, places, activeTrips, pastTripGroups, addPlace } = usePlaces();
  const [teaching, setTeaching] = useState(false);

  const { visible: visiblePlaces, total, hasOverflow } = capPlaces(places);

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

          {/* 1. Places I know — no header; the screen title names it. */}
          {visiblePlaces.length === 0 ? (
            <EmptyPanel icon={PinIcon} line={COPY.places.emptyPlaces} palette={palette} />
          ) : (
            visiblePlaces.map(place => (
              <PlaceRow key={`${place.poiType} ${place.name}`} place={place} palette={palette} />
            ))
          )}
          {hasOverflow && (
            <Pressable
              style={[styles.actionRow, { borderBottomColor: palette.line }]}
              onPress={() => navigation.navigate('AllPlaces')}
              accessibilityRole="button"
              accessibilityLabel={COPY.places.allPlacesA11y(total)}>
              <Text style={[styles.actionLabel, { color: palette.text }]}>{COPY.places.allPlaces(total)}</Text>
              <ChevronRightIcon color={palette.faint} size={16} strokeWidth={1.8} />
            </Pressable>
          )}
          <Pressable
            style={styles.teachRow}
            onPress={() => setTeaching(true)}
            accessibilityRole="button"
            accessibilityLabel={COPY.places.teachAction}>
            <PlusIcon color={palette.accent} size={18} />
            <Text style={[styles.teachLabel, { color: palette.accent }]}>{COPY.places.teachAction}</Text>
          </Pressable>

          {/* 2. Trips */}
          <SectionHeader label={COPY.places.sectionTrips} palette={palette} />
          {activeTrips.length === 0 ? (
            <EmptyPanel
              icon={SuitcaseIcon}
              line={COPY.places.emptyTrips}
              palette={palette}
              action={{ label: COPY.places.emptyTripsAction, onPress: () => navigation.navigate('TripPlanner') }}
            />
          ) : (
            <>
              {activeTrips.slice(0, TRIPS_PREVIEW).map(trip => (
                <TripRow key={trip.id} trip={trip} palette={palette} />
              ))}
              {activeTrips.length > TRIPS_PREVIEW && (
                <Pressable
                  style={[styles.actionRow, { borderBottomColor: palette.line }]}
                  onPress={() => navigation.navigate('PlacesIKnow')}
                  accessibilityRole="button">
                  <Text style={[styles.actionLabel, { color: palette.text }]}>{COPY.places.allPlaces(activeTrips.length)}</Text>
                  <ChevronRightIcon color={palette.faint} size={16} strokeWidth={1.8} />
                </Pressable>
              )}
            </>
          )}

          {/* 3. Places I've been (uncapped, last) */}
          <SectionHeader label={COPY.places.sectionPastTrips} palette={palette} />
          {pastTripGroups.length === 0 ? (
            <EmptyPanel icon={ClockIcon} line={COPY.places.emptyPastTrips} palette={palette} />
          ) : (
            pastTripGroups.map(group => (
              <View key={group.year}>
                <Text style={[styles.yearLabel, { color: palette.faint }]}>{group.year}</Text>
                {group.trips.map(trip => <TripRow key={trip.id} trip={trip} palette={palette} />)}
              </View>
            ))
          )}
        </ScrollView>
      )}

      <TeachSheet
        visible={teaching}
        onClose={() => setTeaching(false)}
        onSave={(poiType, name) => { addPlace(poiType, name); setTeaching(false); }}
      />
    </View>
  );
}

type Palette = ReturnType<typeof useTheme>['palette'];

function SectionHeader({ label, palette }: { label: string; palette: Palette }) {
  return <Text style={[styles.sectionTitle, { color: palette.muted }]}>{label}</Text>;
}

// ── A single brand row — plain list item, no card ──────────────────────────────
function PlaceRow({ place, palette }: { place: PlaceEntry; palette: Palette }) {
  return (
    <View style={[styles.row, { borderBottomColor: palette.line }]}>
      <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
        <PoiIcon type={place.poiType} color={palette.muted} size={20} />
      </View>
      <Text style={[styles.brandName, { color: palette.text }]} numberOfLines={1}>{place.name}</Text>
      {place.taught && (
        <View accessibilityLabel={COPY.places.taughtMarkerA11y}>
          <FilledStarIcon color={palette.accent} size={13} />
        </View>
      )}
    </View>
  );
}

function TripRow({ trip, palette }: { trip: Trip; palette: Palette }) {
  return (
    <View style={[styles.row, { borderBottomColor: palette.line }]}>
      <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
        <SuitcaseIcon color={palette.muted} size={20} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>{trip.destination}</Text>
        <Text style={[styles.rowSub, { color: palette.muted }]} numberOfLines={1}>{tripDates(trip)}</Text>
      </View>
    </View>
  );
}

// ── Empty-state panel — keeps the surface2 fill so it reads as a placeholder ────
function EmptyPanel({ icon: Icon, line, palette, action }: {
  icon: IconCmp;
  line: string;
  palette: Palette;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={[styles.emptyPanel, { backgroundColor: palette.surface2 }]}>
      <Icon color={palette.faint} size={22} />
      <Text style={[styles.emptyLine, { color: palette.muted }]}>{line}</Text>
      {action && (
        <Pressable onPress={action.onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={action.label}>
          <Text style={[styles.emptyAction, { color: palette.accent }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
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
  content: { paddingHorizontal: spacing.page, paddingTop: 8 },

  sectionTitle: { fontSize: 11, fontWeight: '600', fontFamily: 'Geist-SemiBold', letterSpacing: 1, marginTop: 24, marginBottom: 4 },

  // Plain list rows separated by a hairline divider — no card background/border.
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconTile: { width: 36, height: 36, borderRadius: radii.listIcon, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  rowSub: { fontSize: 12, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },
  brandName: { flex: 1, fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },

  actionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    minHeight: 44, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500', fontVariant: ['tabular-nums'] },
  teachRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingVertical: 12 },
  teachLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500' },

  yearLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 6, fontVariant: ['tabular-nums'] },

  emptyPanel: { alignItems: 'center', gap: 8, paddingVertical: 24, paddingHorizontal: 16, borderRadius: radii.card, marginTop: 4 },
  emptyLine: { fontSize: 13, fontFamily: 'Geist-Regular', textAlign: 'center' },
  emptyAction: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 2 },
});
