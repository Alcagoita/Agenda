/**
 * TeachSheet — KAN-304
 *
 * "Teach a place" bottom sheet: pick a POI type + name the brand. A standalone
 * component so the flow, fields and validation stay identical wherever teaching
 * is offered (the Places tab, and any future entry point).
 *
 * Self-contained: owns its own form state and resets on every dismissal, so
 * reopening always starts empty.
 */
import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import { CloseIcon, FoodTypeIcon, PoiIcon } from './AppIcon';
import { TEACHABLE_POI_TYPES, poiCatalogLabel, type PoiType } from '../types';
import { COPY } from '../constants/copy';
import { getBrandSuggestions, getCanonicalBrand } from '../services/brandDictionary';
import FoodTypeSelector from './FoodTypeSelector';
import {
  restaurantFoodTypeFavouriteName,
  type RestaurantFoodType,
} from '../services/restaurantFoodTypes';

export interface TeachSheetProps {
  visible: boolean;
  onClose: () => void;
  onSave: (poiType: string, name: string) => void;
}

export default function TeachSheet({ visible, onClose, onSave }: TeachSheetProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const themedStyles = useMemo(() => StyleSheet.create({
    suggestionRow: {
      borderColor: palette.line,
      backgroundColor: palette.surface,
    },
    suggestionRowSelected: {
      borderColor: palette.accent,
      backgroundColor: palette.nearTint,
    },
    saveBtn: {
      backgroundColor: palette.accent,
    },
  }), [palette]);
  const [kind, setKind] = useState<'place' | 'food'>('place');
  const [type, setType] = useState<PoiType | null>(null);
  const [name, setName] = useState('');
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);
  const [selectedFoodType, setSelectedFoodType] = useState<RestaurantFoodType | null>(null);
  const trimmedName = name.trim();
  const canonicalName = kind === 'place' ? getCanonicalBrand(type, name) : null;
  const brandSuggestions = kind === 'place' && trimmedName.length >= 2 ? getBrandSuggestions(type, name) : [];
  const shouldShowBrandSuggestions = kind === 'place' && type != null && brandSuggestions.length > 0;
  const canSave = kind === 'food'
    ? selectedFoodType != null
    : type != null && selectedBrand != null && selectedBrand === canonicalName;

  const reset = () => {
    setKind('place');
    setType(null);
    setName('');
    setSelectedBrand(null);
    setSelectedFoodType(null);
  };
  // Every dismissal clears the form, so reopening always starts empty.
  const handleClose = () => { reset(); onClose(); };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={[styles.scrim, { backgroundColor: palette.scrim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} accessibilityLabel={COPY.places.teachCancelA11y} />
        <View style={[styles.sheet, { backgroundColor: palette.bg, paddingBottom: spacing.page + insets.bottom }]}>
          <ScrollView
            style={styles.scroller}
            contentContainerStyle={styles.scrollerContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Text style={[styles.title, { color: palette.text }]}>{COPY.places.teachTitle}</Text>
              <Pressable onPress={handleClose} hitSlop={8} style={styles.closeBtn} accessibilityRole="button" accessibilityLabel={COPY.places.teachCancelA11y}>
                <CloseIcon color={palette.muted} size={18} />
              </Pressable>
            </View>
            <Text style={[styles.subtitle, { color: palette.muted }]}>{COPY.places.teachSubtitle}</Text>

            <Text style={[styles.fieldLabel, { color: palette.muted }]}>{COPY.places.teachTypeLabel}</Text>
            <View style={styles.typeGrid}>
              {TEACHABLE_POI_TYPES.map(t => {
                const selected = kind === 'place' && t === type;
                return (
                  <Pressable
                    key={t}
                    onPress={() => { setKind('place'); setType(t); setName(''); setSelectedBrand(null); setSelectedFoodType(null); }}
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
              <Pressable
                onPress={() => { setKind('food'); setType(null); setName(''); setSelectedBrand(null); setSelectedFoodType(null); }}
                style={[
                  styles.typeChip,
                  {
                    borderColor: kind === 'food' ? palette.accent : palette.line,
                    backgroundColor: kind === 'food' ? palette.nearTint : palette.surface,
                  },
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: kind === 'food' }}
                accessibilityLabel={COPY.places.teachFoodType}>
                <FoodTypeIcon color={kind === 'food' ? palette.nearText : palette.muted} size={18} />
                <Text style={[styles.typeChipLabel, { color: kind === 'food' ? palette.nearText : palette.text }]}>
                  {COPY.places.teachFoodType}
                </Text>
              </Pressable>
            </View>

            <Text style={[styles.fieldLabel, kind === 'food' && styles.dynamicFieldLabel, { color: palette.muted }]}>
              {kind === 'food'
                ? COPY.places.teachFoodTypeNameLabel
                : COPY.places.teachNameLabel}
            </Text>
            {kind === 'food' ? (
              <FoodTypeSelector selected={selectedFoodType} onSelect={setSelectedFoodType} />
            ) : (
              <TextInput
                style={[styles.nameInput, { color: palette.text, borderColor: palette.line, backgroundColor: palette.surface }]}
                placeholder={COPY.places.teachNamePlaceholder}
                placeholderTextColor={palette.muted}
                value={name}
                onChangeText={value => { setName(value); setSelectedBrand(null); }}
                returnKeyType="done"
              />
            )}
            {shouldShowBrandSuggestions && (
              <View style={styles.suggestionList}>
                {brandSuggestions.map(brand => {
                  const selected = brand === selectedBrand;
                  return (
                    <Pressable
                      key={brand}
                      onPress={() => { setName(brand); setSelectedBrand(brand); }}
                      style={[
                        styles.suggestionRow,
                        selected ? themedStyles.suggestionRowSelected : themedStyles.suggestionRow,
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={brand}>
                      <Text style={[styles.suggestionLabel, { color: selected ? palette.nearText : palette.text }]}>
                        {brand}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <Pressable
              style={[styles.saveBtn, themedStyles.saveBtn, !canSave && styles.saveBtnDisabled]}
              disabled={!canSave}
              onPress={() => {
                if (kind === 'food' && selectedFoodType) {
                  onSave('restaurant', restaurantFoodTypeFavouriteName(selectedFoodType));
                  reset();
                  return;
                }
                if (canSave && type && selectedBrand) { onSave(type, selectedBrand); reset(); }
              }}
              accessibilityRole="button"
              accessibilityLabel={COPY.places.teachSaveAction}>
              <Text style={[styles.saveLabel, { color: palette.onAccent }]}>{COPY.places.teachSaveAction}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '86%', overflow: 'hidden' },
  scroller: { flexGrow: 0 },
  scrollerContent: { padding: spacing.page, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginRight: -12 },
  title: { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  subtitle: { fontSize: 13, fontFamily: 'Geist-Regular', marginTop: -4 },
  fieldLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 4 },
  dynamicFieldLabel: { marginTop: 12 },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44,
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1,
  },
  typeChipLabel: { fontSize: 13, fontFamily: 'Geist-Medium', fontWeight: '500' },
  nameInput: {
    height: 46, borderRadius: radii.ctaBtn, borderWidth: 1, paddingHorizontal: 14,
    fontSize: 15, fontFamily: 'Geist-Regular',
  },
  suggestionList: { gap: 8, marginTop: -4 },
  suggestionRow: {
    minHeight: 44,
    borderRadius: radii.ctaBtn,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  suggestionLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500' },
  saveBtn: { height: 50, borderRadius: radii.ctaBtn, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  saveBtnDisabled: { opacity: 0.5 },
  saveLabel: { fontSize: 16, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
});
