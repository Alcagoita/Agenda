import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { COPY } from '../constants/copy';
import { useTheme } from '../theme';
import { fonts, radius, spacing } from '../theme/tokens';

export type StoreDetailMode = 'type' | 'brand';

interface StoreDetailModeSelectorProps {
  value: StoreDetailMode;
  onSelect: (value: StoreDetailMode) => void;
}

/** Shared Store detail choice for quick create and the full task form. */
export default function StoreDetailModeSelector({ value, onSelect }: StoreDetailModeSelectorProps) {
  const { palette } = useTheme();
  const options: Array<{ value: StoreDetailMode; label: string; accessibilityLabel: string }> = [
    { value: 'type', label: COPY.newTaskSheet.storeDetailType, accessibilityLabel: COPY.newTaskSheet.storeDetailType },
    { value: 'brand', label: COPY.newTaskSheet.storeDetailBrand, accessibilityLabel: COPY.newTaskSheet.storeDetailBrandA11y },
  ];

  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {options.map(option => {
        const checked = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel}
            accessibilityState={{ checked }}
            onPress={() => onSelect(option.value)}
            // Theme tokens vary at runtime; this is not a hardcoded style.
            // eslint-disable-next-line react-native/no-inline-styles
            style={[styles.option, {
              borderColor: palette.line,
              backgroundColor: checked ? palette.surface : 'transparent',
            }]}
          >
            <Text style={[styles.label, { color: checked ? palette.text : palette.muted }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginTop: spacing[2],
    gap: spacing[2],
  },
  option: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.ctaBtn,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  label: {
    fontSize: 13,
    fontFamily: fonts.families.medium,
  },
});
