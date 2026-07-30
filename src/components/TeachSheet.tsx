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
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import { CloseIcon, PoiIcon } from './AppIcon';
import { TEACHABLE_POI_TYPES, poiCatalogLabel, type PoiType } from '../types';
import { COPY } from '../constants/copy';
import { getBrandSuggestions, getCanonicalBrand } from '../services/brandDictionary';

export interface TeachSheetProps {
  visible: boolean;
  onClose: () => void;
  onSave: (poiType: string, name: string) => void;
}

export default function TeachSheet({ visible, onClose, onSave }: TeachSheetProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [type, setType] = useState<PoiType | null>(null);
  const [name, setName] = useState('');
  const [selectedBrand, setSelectedBrand] = useState<string | null>(null);
  const canonicalName = getCanonicalBrand(type, name);
  const suggestions = getBrandSuggestions(type, name);
  const canSave = type != null && selectedBrand != null && selectedBrand === canonicalName;

  const reset = () => { setType(null); setName(''); setSelectedBrand(null); };
  // Every dismissal clears the form, so reopening always starts empty.
  const handleClose = () => { reset(); onClose(); };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={[styles.scrim, { backgroundColor: palette.scrim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} accessibilityLabel={COPY.places.teachCancelA11y} />
        <View style={[styles.sheet, { backgroundColor: palette.bg, paddingBottom: spacing.page + insets.bottom }]}>
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
              const selected = t === type;
              return (
                <Pressable
                  key={t}
                  onPress={() => { setType(t); setName(''); setSelectedBrand(null); }}
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
            onChangeText={value => { setName(value); setSelectedBrand(null); }}
            returnKeyType="done"
          />
          {type && suggestions.length > 0 && (
            <View style={styles.suggestionList}>
              {suggestions.map(brand => {
                const selected = brand === selectedBrand;
                return (
                  <Pressable
                    key={brand}
                    onPress={() => { setName(brand); setSelectedBrand(brand); }}
                    style={[
                      styles.suggestionRow,
                      {
                        borderColor: selected ? palette.accent : palette.line,
                        backgroundColor: selected ? palette.nearTint : palette.surface,
                      },
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
            style={[styles.saveBtn, { backgroundColor: palette.accent }, !canSave && styles.saveBtnDisabled]}
            disabled={!canSave}
            onPress={() => { if (canSave && type && selectedBrand) { onSave(type, selectedBrand); reset(); } }}
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
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: spacing.page, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginRight: -12 },
  title: { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  subtitle: { fontSize: 13, fontFamily: 'Geist-Regular', marginTop: -4 },
  fieldLabel: { fontSize: 12, fontFamily: 'Geist-Medium', fontWeight: '500', marginTop: 4 },
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
    minHeight: 40,
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
