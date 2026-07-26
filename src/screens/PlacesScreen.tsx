/**
 * PlacesScreen — KAN-304
 *
 * Behind the Lantern's "Places I know" pill (shares its name). Two tabs:
 *   • Places — a "Teach it a new place" button, then Favourites (taught) and
 *     Your usuals (inferred). Never merged. No caps; the list scrolls freely.
 *   • Trips — planned trips (nearest one flagged "Next up"), a "Going somewhere?"
 *     button, a separation band, then "Where you've been" (past trips by year).
 *
 * For looking, not managing: rows match TaskRow geometry (plain list items,
 * hairline divider, no cards) and carry no visible remove control — forgetting
 * a favourite or a past trip is a long-press with a confirm.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import {
  ChevronLeftIcon, PlusIcon, StarIcon, RefreshIcon, SuitcaseIcon, PinIcon, PoiIcon,
} from '../components/AppIcon';
import type { IconProps } from '../components/AppIcon/shared';
import TabControl from '../components/TabControl';
import TeachSheet from '../components/TeachSheet';
import { usePlaces } from '../hooks/usePlaces';
import { nextUpTripId, type PlaceEntry } from '../services/places';
import { poiCatalogLabel, type PoiType, type Trip } from '../types';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { COPY } from '../constants/copy';
import { formatDateShort } from '../utils/date';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Places'>;
type IconCmp = (props: IconProps) => React.JSX.Element;
type Palette = ReturnType<typeof useTheme>['palette'];

function typeLabel(poiType: string): string {
  return poiCatalogLabel(poiType as PoiType).toLowerCase();
}
function tripDates(trip: Trip): string {
  return trip.startDate && trip.endDate
    ? COPY.tripPlanner.tripRowDates(formatDateShort(trip.startDate), formatDateShort(trip.endDate))
    : COPY.tripPlanner.tripRowNoDates;
}

export default function PlacesScreen() {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {
    loading, favourites, usuals, activeTrips, pastTripGroups,
    addPlace, removePlace, removeUsual, forgetTrip, refreshTrip, refreshingTripId,
  } = usePlaces();
  const [tab, setTab] = useState<'places' | 'trips'>('places');
  const [teaching, setTeaching] = useState(false);
  const nextUpId = nextUpTripId(activeTrips);

  const editTrip = (trip: Trip) =>
    navigation.navigate('TripPlanner', { editTripId: trip.id, initialStep: 'dates', doneReturnTo: 'Places' });

  const confirmForgetTrip = (trip: Trip) => {
    Alert.alert(COPY.places.forgetTripTitle(trip.destination), COPY.places.forgetTripBody, [
      { text: COPY.places.forgetTripCancel, style: 'cancel' },
      { text: COPY.places.forgetTripConfirm, style: 'destructive', onPress: () => forgetTrip(trip) },
    ]);
  };

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
        <Pressable style={styles.navBtn} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel={COPY.places.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.places.screenTitle}</Text>
        <View style={styles.navBtn} />
      </View>

      <View style={styles.tabWrap}>
        <TabControl
          tabs={[{ key: 'places', label: COPY.places.tabPlaces }, { key: 'trips', label: COPY.places.tabTrips }]}
          activeKey={tab}
          onChange={k => setTab(k as 'places' | 'trips')}
        />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}><ActivityIndicator color={palette.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
          {tab === 'places' ? (
            <>
              {/* Add button ABOVE the unbounded list so it stays reachable. */}
              <AddButton label={COPY.places.teachAction} onPress={() => setTeaching(true)} palette={palette} />

              <SectionHeader label={COPY.places.sectionFavourites} palette={palette} />
              {favourites.length === 0 ? (
                <EmptyPanel icon={StarIcon} line={COPY.places.emptyFavourites} palette={palette} />
              ) : (
                favourites.map(p => (
                  <PlaceRow key={`${p.poiType} ${p.name}`} place={p} palette={palette} onRemove={() => removePlace(p.id!)} />
                ))
              )}

              <SectionHeader label={COPY.places.sectionUsuals} palette={palette} />
              {usuals.length === 0 ? (
                <EmptyPanel icon={RefreshIcon} line={COPY.places.emptyUsuals} palette={palette} />
              ) : (
                usuals.map(p => (
                  <PlaceRow key={`${p.poiType} ${p.name}`} place={p} palette={palette} onRemove={() => removeUsual(p.poiType, p.name)} />
                ))
              )}
            </>
          ) : (
            <>
              {/* Planned trips */}
              {activeTrips.length === 0 ? (
                <EmptyPanel
                  icon={SuitcaseIcon}
                  line={COPY.places.emptyPlanned}
                  palette={palette}
                  action={{ label: COPY.places.tripsAddAction, onPress: () => navigation.navigate('TripPlanner', { doneReturnTo: 'Places' }) }}
                />
              ) : (
                <>
                  {activeTrips.map(trip => (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      nextUp={trip.id === nextUpId}
                      palette={palette}
                      refreshing={refreshingTripId === trip.id}
                      onEdit={() => editTrip(trip)}
                      onRefresh={() => refreshTrip(trip)}
                      onRemove={() => confirmForgetTrip(trip)}
                    />
                  ))}
                  {/* Add button AFTER the bounded list of planned trips. */}
                  <View style={styles.tripsAddWrap}>
                    <AddButton label={COPY.places.tripsAddAction} onPress={() => navigation.navigate('TripPlanner', { doneReturnTo: 'Places' })} palette={palette} />
                  </View>
                </>
              )}

              {/* Separation: above is ahead, below is behind. */}
              <View testID="trips-separator" style={[styles.separator, { backgroundColor: palette.surface2 }]} />

              <SectionHeader label={COPY.places.sectionWhereBeen} palette={palette} />
              {pastTripGroups.length === 0 ? (
                <EmptyPanel icon={PinIcon} line={COPY.places.emptyPastTrips} palette={palette} />
              ) : (
                pastTripGroups.map(group => (
                  <View key={group.year}>
                    <Text style={[styles.yearLabel, { color: palette.faint }]}>{group.year}</Text>
                    {group.trips.map(trip => (
                      <PastTripRow key={trip.id} trip={trip} palette={palette} onRemove={() => confirmForgetTrip(trip)} />
                    ))}
                  </View>
                ))
              )}
            </>
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

function SectionHeader({ label, palette }: { label: string; palette: Palette }) {
  return <Text style={[styles.sectionTitle, { color: palette.muted }]}>{label}</Text>;
}

function AddButton({ label, onPress, palette }: { label: string; onPress: () => void; palette: Palette }) {
  return (
    <Pressable
      style={[styles.addBtn, { borderColor: palette.line }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}>
      <PlusIcon color={palette.text} size={16} />
      <Text style={[styles.addLabel, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

// ── Small × remove control, shared by every row/card ────────────────────────────
function RemoveX({ onPress, label, palette }: { onPress: () => void; label: string; palette: Palette }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} style={styles.removeBtn} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[styles.removeX, { color: palette.muted }]}>×</Text>
    </Pressable>
  );
}

// ── Brand row — TaskRow geometry, two lines, no card ────────────────────────────
function PlaceRow({ place, palette, onRemove }: { place: PlaceEntry; palette: Palette; onRemove: () => void }) {
  const secondary = place.taught ? typeLabel(place.poiType) : COPY.places.usualSecondary(typeLabel(place.poiType));
  return (
    <View style={[styles.row, { borderBottomColor: palette.line }]}>
      <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
        <PoiIcon type={place.poiType} color={palette.muted} size={20} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>{place.name}</Text>
        <Text style={[styles.rowSub, { color: palette.muted }]} numberOfLines={1}>{secondary}</Text>
      </View>
      <RemoveX onPress={onRemove} label={COPY.places.forgetA11y(place.name)} palette={palette} />
    </View>
  );
}

function PastTripRow({ trip, palette, onRemove }: { trip: Trip; palette: Palette; onRemove: () => void }) {
  return (
    <View style={[styles.row, { borderBottomColor: palette.line }]}>
      <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
        <PinIcon color={palette.muted} size={20} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>{trip.destination}</Text>
        <Text style={[styles.rowSub, { color: palette.muted }]} numberOfLines={1}>{tripDates(trip)}</Text>
      </View>
      <RemoveX onPress={onRemove} label={COPY.places.forgetA11y(trip.destination)} palette={palette} />
    </View>
  );
}

// ── Planned trip card — tap to edit dates; refresh + remove inline ──────────────
function TripCard({ trip, nextUp, palette, refreshing, onEdit, onRefresh, onRemove }: {
  trip: Trip; nextUp: boolean; palette: Palette; refreshing: boolean;
  onEdit: () => void; onRefresh: () => void; onRemove: () => void;
}) {
  return (
    <Pressable
      onPress={onEdit}
      accessibilityRole="button"
      accessibilityLabel={COPY.tripPlanner.changeTripDatesA11y(trip.destination)}
      style={[
        styles.tripCard,
        nextUp
          ? { backgroundColor: palette.nearTint, borderColor: palette.nearBorder }
          : { backgroundColor: palette.surface, borderColor: palette.line },
      ]}>
      <View style={styles.tripHeaderRow}>
        {nextUp
          ? <Text style={[styles.nextUp, { color: palette.nearText }]}>{COPY.places.nextUp}</Text>
          : <View />}
        <View style={styles.tripActions}>
          {refreshing ? (
            <ActivityIndicator size="small" color={palette.muted} />
          ) : (
            <Pressable
              onPress={onRefresh}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={COPY.tripPlanner.refreshTripA11y(trip.destination)}>
              <RefreshIcon color={palette.accent} size={16} />
            </Pressable>
          )}
          <RemoveX onPress={onRemove} label={COPY.places.forgetA11y(trip.destination)} palette={palette} />
        </View>
      </View>
      <Text style={[styles.tripDest, { color: palette.text }]} numberOfLines={1}>{trip.destination}</Text>
      <Text style={[styles.tripDatesText, { color: palette.muted }]} numberOfLines={1}>{tripDates(trip)}</Text>
    </Pressable>
  );
}

// ── Empty-state panel — surface2 fill so it reads as a placeholder ──────────────
function EmptyPanel({ icon: Icon, line, palette, action }: {
  icon: IconCmp; line: string; palette: Palette; action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.emptyPanel}>
      <Icon color={palette.accent} size={24} />
      <Text style={[styles.emptyLine, { color: palette.text }]}>{line}</Text>
      {action && (
        <Pressable
          style={[styles.emptyActionPill, { borderColor: palette.line }]}
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}>
          <Text style={[styles.emptyActionLabel, { color: palette.text }]}>{action.label}</Text>
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
  tabWrap: { paddingHorizontal: spacing.page, marginTop: 12 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: spacing.page, paddingTop: 12 },

  sectionTitle: { fontSize: 11, fontWeight: '600', fontFamily: 'Geist-SemiBold', letterSpacing: 1, marginTop: 22, marginBottom: 4 },

  // Rows — match TaskRow: plain list items, hairline divider, no card.
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  iconTile: { width: 36, height: 36, borderRadius: radii.listIcon, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  rowSub: { fontSize: 13, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },
  removeBtn: { paddingHorizontal: 4, paddingVertical: 4, alignItems: 'center', justifyContent: 'center' },
  removeX: { fontSize: 22, lineHeight: 24 },

  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 44, borderRadius: radii.ctaBtn, borderWidth: 1,
  },
  addLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500' },
  tripsAddWrap: { marginTop: 10 },

  tripCard: { borderRadius: radii.card, borderWidth: 1, padding: 14, marginTop: 10 },
  tripHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 20, marginBottom: 2 },
  tripActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nextUp: { fontSize: 11, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  tripDest: { fontSize: 16, fontFamily: 'Geist-Medium', fontWeight: '500' },
  tripDatesText: { fontSize: 13, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'], marginTop: 3 },

  // Full-bleed band separating ahead from behind.
  separator: { height: 8, marginTop: 22, marginHorizontal: -spacing.page },

  yearLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 10, fontVariant: ['tabular-nums'] },

  emptyPanel: { alignItems: 'center', gap: 8, paddingVertical: 28, paddingHorizontal: 16, marginTop: 4 },
  emptyLine: { fontSize: 13, fontFamily: 'Geist-Regular', textAlign: 'center' },
  emptyActionPill: { marginTop: 4, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1 },
  emptyActionLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500' },
});
