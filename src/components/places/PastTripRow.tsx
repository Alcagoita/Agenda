/** Past-trip row ("Where you've been") — TaskRow geometry with a pin (KAN-304). */
import React from 'react';
import { Text, View } from 'react-native';
import { PinIcon } from '../AppIcon';
import { RemoveX, rowStyles, type Palette } from './shared';
import { tripDates } from '../../services/placesFormat';
import type { Trip } from '../../types';
import { COPY } from '../../constants/copy';

export default function PastTripRow({ trip, palette, onRemove }: { trip: Trip; palette: Palette; onRemove: () => void }) {
  return (
    <View style={[rowStyles.row, { borderBottomColor: palette.line }]}>
      <View style={[rowStyles.iconTile, { backgroundColor: palette.surface2 }]}>
        <PinIcon color={palette.muted} size={20} />
      </View>
      <View style={rowStyles.rowText}>
        <Text style={[rowStyles.rowTitle, { color: palette.text }]} numberOfLines={1}>{trip.destination}</Text>
        <Text style={[rowStyles.rowSub, { color: palette.muted }]} numberOfLines={1}>{tripDates(trip)}</Text>
      </View>
      <RemoveX onPress={onRemove} label={COPY.places.forgetA11y(trip.destination)} palette={palette} />
    </View>
  );
}
