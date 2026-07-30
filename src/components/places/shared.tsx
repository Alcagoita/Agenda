/**
 * Shared types, the × remove control, and the common list-row styles used by
 * the Places screen's presentational components (KAN-304). Kept in one place so
 * PlaceRow / PastTripRow / TripCard don't each redeclare the same geometry.
 */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '../../theme';
import { radius as radii } from '../../theme/tokens';
import type { IconProps } from '../AppIcon/shared';

export type Palette = ReturnType<typeof useTheme>['palette'];
export type IconCmp = (props: IconProps) => React.JSX.Element;

/** Small × remove control, shared by every row/card. */
export function RemoveX({ onPress, label, palette }: { onPress: () => void; label: string; palette: Palette }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} style={styles.removeBtn} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[styles.removeX, { color: palette.muted }]}>×</Text>
    </Pressable>
  );
}

/** TaskRow geometry: plain list item, hairline divider, 36px icon tile, two text lines. */
export const rowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  iconTile: { width: 36, height: 36, borderRadius: radii.listIcon, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  rowSub: { fontSize: 13, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },
});

const styles = StyleSheet.create({
  removeBtn: { paddingHorizontal: 4, paddingVertical: 4, alignItems: 'center', justifyContent: 'center' },
  removeX: { fontSize: 22, lineHeight: 24 },
});
