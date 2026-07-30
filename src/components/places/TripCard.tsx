/**
 * Planned trip card (KAN-304) — three fixed lines, uniform across every card:
 *   1: destination (left)  ·  NEXT UP (right)
 *   2: dates (left)        ·  × remove (right)
 *   3: KAN-266 edits — change/add dates | learn a bigger area
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius as radii } from '../../theme/tokens';
import { RemoveX, type Palette } from './shared';
import { tripDates } from '../../services/placesFormat';
import type { Trip } from '../../types';
import { COPY } from '../../constants/copy';

export default function TripCard({ trip, nextUp, palette, onEditDates, onEditArea, onRemove }: {
  trip: Trip; nextUp: boolean; palette: Palette;
  onEditDates: () => void; onEditArea: () => void; onRemove: () => void;
}) {
  const hasDates = !!(trip.startDate || trip.endDate);
  return (
    <View
      style={[
        styles.tripCard,
        nextUp
          ? { backgroundColor: palette.nearTint, borderColor: palette.nearBorder }
          : { backgroundColor: palette.surface, borderColor: palette.line },
      ]}>
      {/* Line 1 — destination + Next up */}
      <View style={styles.tripLine}>
        <Text style={[styles.tripDest, { color: palette.text }]} numberOfLines={1}>{trip.destination}</Text>
        {nextUp && <Text style={[styles.nextUp, { color: palette.nearText }]}>{COPY.places.nextUp}</Text>}
      </View>

      {/* Line 2 — dates + remove */}
      <View style={styles.tripLine}>
        <Text style={[styles.tripDatesText, { color: palette.muted }]} numberOfLines={1}>{tripDates(trip)}</Text>
        <RemoveX onPress={onRemove} label={COPY.places.forgetA11y(trip.destination)} palette={palette} />
      </View>

      {/* Line 3 — change dates / grow the learned area, in place (no recreate). */}
      <View style={styles.inlineActions}>
        <Pressable
          onPress={onEditDates}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={COPY.tripPlanner.changeTripDatesA11y(trip.destination)}>
          <Text style={[styles.inlineActionLabel, { color: palette.accent }]}>
            {hasDates ? COPY.tripPlanner.changeTripDates : COPY.tripPlanner.addTripDates}
          </Text>
        </Pressable>
        <Text style={[styles.actionDot, { color: palette.faint }]}>·</Text>
        <Pressable
          onPress={onEditArea}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel={COPY.tripPlanner.learnBiggerAreaA11y(trip.destination)}>
          <Text style={[styles.inlineActionLabel, { color: palette.accent }]}>{COPY.tripPlanner.learnBiggerArea}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tripCard: { borderRadius: radii.card, borderWidth: 1, padding: 14, marginTop: 10, rowGap: 4 },
  tripLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 24 },
  nextUp: { fontSize: 11, fontWeight: '600', fontFamily: 'Geist-SemiBold', letterSpacing: 1, textTransform: 'uppercase' },
  tripDest: { flex: 1, fontSize: 16, fontFamily: 'Geist-Medium', fontWeight: '500' },
  tripDatesText: { flex: 1, fontSize: 13, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },
  inlineActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  inlineActionLabel: { fontSize: 13, fontFamily: 'Geist-Medium', fontWeight: '500' },
  actionDot: { fontSize: 13 },
});
