/** Brand row (Favourites / Your usuals) — TaskRow geometry, two lines (KAN-304). */
import React from 'react';
import { Text, View } from 'react-native';
import { PoiIcon } from '../AppIcon';
import { RemoveX, rowStyles, type Palette } from './shared';
import { placeEntryTitle, placeEntryTypeLabel } from '../../services/placesFormat';
import type { PlaceEntry } from '../../services/places';
import { COPY } from '../../constants/copy';
import { useTheme } from '../../theme';

export default function PlaceRow({ place, palette, onRemove }: { place: PlaceEntry; palette: Palette; onRemove: () => void }) {
  const { language } = useTheme();
  const title = placeEntryTitle(place.name, language);
  const type = placeEntryTypeLabel(place.poiType, place.name);
  const secondary = place.taught ? type : COPY.places.usualSecondary(type);
  return (
    <View style={[rowStyles.row, { borderBottomColor: palette.line }]}>
      <View style={[rowStyles.iconTile, { backgroundColor: palette.surface2 }]}>
        <PoiIcon type={place.poiType} color={palette.muted} size={20} />
      </View>
      <View style={rowStyles.rowText}>
        <Text style={[rowStyles.rowTitle, { color: palette.text }]} numberOfLines={1}>{title}</Text>
        <Text style={[rowStyles.rowSub, { color: palette.muted }]} numberOfLines={1}>{secondary}</Text>
      </View>
      <RemoveX onPress={onRemove} label={COPY.places.forgetA11y(title)} palette={palette} />
    </View>
  );
}
