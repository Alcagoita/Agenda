/**
 * PlacesTab — the "Places" tab body (KAN-304): Favourites (taught) and Your
 * usuals (inferred), never merged, with the teach CTA under the Favourites
 * list. Presentational; receives data + remove handlers from PlacesScreen.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { sectionTitleStyle } from '../theme/tokens';
import { StarIcon, FootstepsIcon } from '../components/AppIcon';
import SectionHeader from '../components/places/SectionHeader';
import AddButton from '../components/places/AddButton';
import EmptyPanel from '../components/places/EmptyPanel';
import PlaceRow from '../components/places/PlaceRow';
import type { Palette } from '../components/places/shared';
import type { PlaceEntry } from '../services/places';
import { COPY } from '../constants/copy';

export default function PlacesTab({ palette, favourites, usuals, onTeach, onRemoveFavourite, onRemoveUsual }: {
  palette: Palette;
  favourites: PlaceEntry[];
  usuals: PlaceEntry[];
  onTeach: () => void;
  onRemoveFavourite: (id: string) => void;
  onRemoveUsual: (poiType: string, name: string) => void;
}) {
  return (
    <>
      <SectionHeader label={COPY.places.sectionFavourites} palette={palette} />
      {favourites.length === 0 ? (
        <EmptyPanel icon={StarIcon} line={COPY.places.emptyFavourites} palette={palette} />
      ) : (
        favourites.map(p => (
          <PlaceRow key={`${p.poiType} ${p.name}`} place={p} palette={palette} onRemove={() => onRemoveFavourite(p.id!)} />
        ))
      )}
      {/* Add button UNDER the list, so the items stay the focus. */}
      <View style={styles.favAddWrap}>
        <AddButton label={COPY.places.teachAction} onPress={onTeach} palette={palette} />
      </View>

      {/* Double the gap before the second section. */}
      <SectionHeader label={COPY.places.sectionUsuals} palette={palette} style={styles.secondSection} />
      {usuals.length === 0 ? (
        <EmptyPanel icon={FootstepsIcon} line={COPY.places.emptyUsuals} palette={palette} />
      ) : (
        usuals.map(p => (
          <PlaceRow key={`${p.poiType} ${p.name}`} place={p} palette={palette} onRemove={() => onRemoveUsual(p.poiType, p.name)} />
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  favAddWrap: { marginTop: 12 },
  // 2× the shared section-header top margin, to open up the gap before the
  // second section.
  secondSection: { marginTop: (sectionTitleStyle.marginTop as number) * 2 },
});
