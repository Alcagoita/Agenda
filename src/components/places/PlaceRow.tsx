/** Brand row (Favourites / Your usuals) — TaskRow geometry, two lines (KAN-304). */
import React from 'react';
import { Text, View } from 'react-native';
import { PoiIcon } from '../AppIcon';
import { RemoveX, rowStyles, type Palette } from './shared';
import { typeLabel } from '../../services/placesFormat';
import type { PlaceEntry } from '../../services/places';
import { COPY } from '../../constants/copy';

export default function PlaceRow({ place, palette, onRemove }: { place: PlaceEntry; palette: Palette; onRemove: () => void }) {
  const secondary = place.taught ? typeLabel(place.poiType) : COPY.places.usualSecondary(typeLabel(place.poiType));
  return (
    <View style={[rowStyles.row, { borderBottomColor: palette.line }]}>
      <View style={[rowStyles.iconTile, { backgroundColor: palette.surface2 }]}>
        <PoiIcon type={place.poiType} color={palette.muted} size={20} />
      </View>
      <View style={rowStyles.rowText}>
        <Text style={[rowStyles.rowTitle, { color: palette.text }]} numberOfLines={1}>{place.name}</Text>
        <Text style={[rowStyles.rowSub, { color: palette.muted }]} numberOfLines={1}>{secondary}</Text>
      </View>
      <RemoveX onPress={onRemove} label={COPY.places.forgetA11y(place.name)} palette={palette} />
    </View>
  );
}
