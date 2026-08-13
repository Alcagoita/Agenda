import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { S } from './AppIcon/shared';
import { fonts, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme';
import {
  financialServiceKindDisplayLabel,
  listFinancialServiceKinds,
  type FinancialServiceKind,
} from '../services/financialServiceKinds';

interface FinancialServiceKindSelectorProps {
  selected: FinancialServiceKind | null;
  onSelect: (kind: FinancialServiceKind | null) => void;
}

function FinancialServiceKindIcon({ kind, color }: { kind: FinancialServiceKind; color: string }) {
  const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none' };
  switch (kind) {
    case 'consumer_credit':
      return <Svg {...p}><Rect x="4" y="6" width="16" height="12" rx="2" stroke={color} strokeWidth={1.6} {...S} /><Path d="M4 10h16M8 14h4" stroke={color} strokeWidth={1.6} {...S} /></Svg>;
    case 'insurance':
      return <Svg {...p}><Path d="M12 3l7 3v5c0 4.6-3 7.6-7 10-4-2.4-7-5.4-7-10V6l7-3z" stroke={color} strokeWidth={1.6} {...S} /><Path d="m9 12 2 2 4-4" stroke={color} strokeWidth={1.6} {...S} /></Svg>;
    case 'financial_intermediary':
      return <Svg {...p}><Circle cx="8" cy="8" r="3" stroke={color} strokeWidth={1.6} {...S} /><Circle cx="16" cy="8" r="3" stroke={color} strokeWidth={1.6} {...S} /><Path d="M3 20c.6-4 3-6 5-6s4.4 2 5 6M11 20c.6-4 3-6 5-6s4.4 2 5 6" stroke={color} strokeWidth={1.6} {...S} /></Svg>;
    case 'leasing_factoring':
      return <Svg {...p}><Path d="M6 3h8l4 4v14H6V3zM14 3v5h5M9 13h6M9 17h4" stroke={color} strokeWidth={1.6} {...S} /></Svg>;
    case 'central_bank':
      return <Svg {...p}><Path d="M3 10h18M12 3l9 7H3l9-7zM5 20h14M7 10v8M12 10v8M17 10v8" stroke={color} strokeWidth={1.6} {...S} /></Svg>;
    case 'public_finance':
      return <Svg {...p}><Rect x="5" y="3" width="14" height="18" rx="2" stroke={color} strokeWidth={1.6} {...S} /><Path d="M8 8h8M8 12h8M8 16h5" stroke={color} strokeWidth={1.6} {...S} /></Svg>;
  }
}

export default function FinancialServiceKindSelector({ selected, onSelect }: FinancialServiceKindSelectorProps) {
  const { palette, language } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.list}
      style={styles.mask}>
      {listFinancialServiceKinds().map(kind => {
        const highlighted = selected === kind;
        return (
      <Pressable
        key={kind}
        accessibilityRole="radio"
        accessibilityLabel={financialServiceKindDisplayLabel(kind, language)}
        accessibilityState={{ selected: highlighted }}
        onPress={() => onSelect(highlighted ? null : kind)}
        style={[styles.chip, { backgroundColor: highlighted ? palette.nearTint : palette.surface2, borderColor: highlighted ? palette.nearBorder : palette.line }]}>
        <View style={[styles.icon, { backgroundColor: highlighted ? palette.nearTint2 : palette.surface }]}>
          <FinancialServiceKindIcon kind={kind} color={highlighted ? palette.nearText : palette.muted} />
        </View>
        <Text style={[styles.label, { color: highlighted ? palette.nearText : palette.text }]}>{financialServiceKindDisplayLabel(kind, language)}</Text>
      </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  mask: { marginRight: -spacing.page },
  list: { gap: spacing[2], paddingRight: spacing[3] },
  chip: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing[1], paddingHorizontal: spacing[2], borderRadius: radius.chip, borderWidth: 1 },
  icon: { width: 28, height: 28, borderRadius: radius.listIcon, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: fonts.families.medium, fontSize: 13 },
});
