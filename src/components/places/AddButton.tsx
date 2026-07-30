/** Outlined "+ label" CTA used to teach a place / plan a trip (KAN-304). */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { radius as radii } from '../../theme/tokens';
import { PlusIcon } from '../AppIcon';
import type { Palette } from './shared';

export default function AddButton({ label, onPress, palette }: { label: string; onPress: () => void; palette: Palette }) {
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

const styles = StyleSheet.create({
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 44, borderRadius: radii.ctaBtn, borderWidth: 1,
  },
  addLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500' },
});
