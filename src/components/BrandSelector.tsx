import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native';
import { PoiIcon } from './AppIcon';
import { fonts, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme';
import { brandsForType } from '../services/brandDictionary';

interface BrandSelectorProps {
  poiType: 'gym' | 'bank';
  selected: string | null;
  suggested?: string | null;
  onSelect: (brand: string) => void;
}

/** Curated canonical chains only. There is intentionally no free-text route. */
export default function BrandSelector({ poiType, selected, suggested, onSelect }: BrandSelectorProps) {
  const { palette } = useTheme();
  const brands = brandsForType(poiType);

  const renderBrand = ({ item: brand }: ListRenderItemInfo<string>) => {
    const active = selected === brand;
    const guessed = suggested === brand;
    const highlighted = active || guessed;
    return (
      <Pressable
        onPress={() => onSelect(brand)}
        accessibilityRole="radio"
        accessibilityLabel={brand}
        accessibilityState={{ selected: active }}
        style={[
          styles.pill,
          guessed && styles.pillSuggested,
          {
            backgroundColor: active ? palette.nearTint2 : guessed ? palette.nearTint : palette.surface,
            borderColor: highlighted ? palette.nearBorder : palette.line,
          },
        ]}>
        <View style={[styles.iconPill, { backgroundColor: palette.surface2 }]}>
          <PoiIcon type={poiType} color={palette.muted} size={20} />
        </View>
        <Text style={[styles.label, { color: highlighted ? palette.nearText : palette.text }]} numberOfLines={1}>
          {brand}
        </Text>
      </Pressable>
    );
  };

  return (
    <FlatList
      horizontal
      data={brands}
      renderItem={renderBrand}
      keyExtractor={brand => brand}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
      style={styles.mask}
    />
  );
}

const styles = StyleSheet.create({
  mask: { marginRight: -spacing.page },
  row: { gap: 8, paddingRight: spacing.page },
  pill: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.chip,
    paddingLeft: 7,
    paddingRight: 12,
  },
  pillSuggested: { borderStyle: 'dashed' },
  iconPill: {
    width: 36,
    height: 36,
    borderRadius: radius.listIcon,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 13, fontFamily: fonts.families.medium, fontWeight: '500' },
});
