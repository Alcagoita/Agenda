/** Places section heading — uses the shared uppercase sectionTitleStyle (KAN-304). */
import React from 'react';
import { Text } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import { sectionTitleStyle } from '../../theme/tokens';
import type { Palette } from './shared';

export default function SectionHeader({ label, palette, style }: {
  label: string; palette: Palette; style?: StyleProp<TextStyle>;
}) {
  return <Text style={[sectionTitleStyle, { color: palette.muted }, style]}>{label}</Text>;
}
