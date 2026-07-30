import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { S } from './AppIcon/shared';
import { fonts, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme';
import { PoiIcon } from './AppIcon';
import {
  listStoreSubtypes,
  storeSubtypeDisplayLabel,
  type StoreSubtype,
} from '../services/storeSubtypes';

interface StoreSubtypeSelectorProps {
  selected: StoreSubtype | null;
  onSelect: (subtype: StoreSubtype | null) => void;
}

function StoreSubtypeIcon({ type, color, size = 16 }: { type: StoreSubtype; color: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' };

  switch (type) {
    case 'any':
      return <PoiIcon type="store" color={color} size={size} />;
    case 'clothing':
      return (
        <Svg {...p}>
          <Path d="M8 4l4 3 4-3 4 4-3 3v9H7v-9L4 8l4-4z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M10 5.5c.6.8 1.2 1.2 2 1.2s1.4-.4 2-1.2" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );
    case 'shoes':
      return (
        <Svg {...p}>
          <Path d="M4 15c4 0 6-3 8-6l3 4 5 2v3H4v-3z" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="7" y1="18" x2="20" y2="18" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'electronics':
      return (
        <Svg {...p}>
          <Rect x="7" y="3" width="10" height="18" rx="2" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="10" y1="17" x2="14" y2="17" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'books':
      return (
        <Svg {...p}>
          <Path d="M5 5h6a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3V5z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M14 8a3 3 0 0 1 3-3h2v15h-5V8z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'toys':
      return (
        <Svg {...p}>
          <Rect x="5" y="9" width="14" height="10" rx="2" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M8 9c-2-3 2-5 4-2 2-3 6-1 4 2" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="12" y1="9" x2="12" y2="19" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'furniture':
      return (
        <Svg {...p}>
          <Path d="M5 11h14v7H5v-7z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M7 11V8c0-2 3-2 3 0v3M14 11V8c0-2 3-2 3 0v3" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="7" y1="18" x2="7" y2="20" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="17" y1="18" x2="17" y2="20" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'hardware':
      return (
        <Svg {...p}>
          <Path d="M15 5l4 4-9 9H6v-4l9-9z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M13 7l4 4" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'bicycle':
      return (
        <Svg {...p}>
          <Circle cx="7" cy="16" r="3" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="17" cy="16" r="3" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M7 16l4-7h3l3 7M11 9l3 7H7M12 7h3" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'jewelry':
      return (
        <Svg {...p}>
          <Path d="M8 6h8l3 4-7 9-7-9 3-4z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M5 10h14M9 6l3 4 3-4" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );
    case 'pet':
      return (
        <Svg {...p}>
          <Circle cx="7" cy="9" r="1.5" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="12" cy="7" r="1.5" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="17" cy="9" r="1.5" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M7 17c2-5 8-5 10 0 1 3-3 4-5 2-2 2-6 1-5-2z" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'sports':
      return (
        <Svg {...p}>
          <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M6 12h12M12 4c2 2 3 5 3 8s-1 6-3 8M12 4c-2 2-3 5-3 8s1 6 3 8" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );
    case 'beauty':
      return (
        <Svg {...p}>
          <Path d="M8 4h8l-1 7H9L8 4z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M9 11v8h6v-8" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="10" y1="15" x2="14" y2="15" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'home':
    default:
      return (
        <Svg {...p}>
          <Path d="M4 11l8-7 8 7" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M6 10v10h12V10" stroke={color} strokeWidth={1.6} {...S} />
          <Rect x="10" y="14" width="4" height="6" rx="1" stroke={color} strokeWidth={1.4} {...S} />
        </Svg>
      );
  }
}

export default function StoreSubtypeSelector({ selected, onSelect }: StoreSubtypeSelectorProps) {
  const { palette, language } = useTheme();
  const subtypes = listStoreSubtypes();

  const renderSubtype = ({ item: type }: ListRenderItemInfo<StoreSubtype>) => {
    const active = selected === type;
    const fg = active ? palette.nearText : palette.text;
    return (
      <Pressable
        onPress={() => onSelect(type)}
        accessibilityRole="radio"
        accessibilityLabel={storeSubtypeDisplayLabel(type, language)}
        accessibilityState={{ selected: active }}
        style={[
          styles.pill,
          {
            backgroundColor: active ? palette.nearTint2 : palette.surface,
            borderColor: active ? palette.nearBorder : palette.line,
          },
        ]}>
        <View style={[styles.iconPill, { backgroundColor: active ? palette.nearTint : palette.surface2 }]}>
          <StoreSubtypeIcon type={type} color={active ? palette.nearText : palette.muted} size={15} />
        </View>
        <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
          {storeSubtypeDisplayLabel(type, language)}
        </Text>
      </Pressable>
    );
  };

  return (
    <FlatList
      horizontal
      data={subtypes}
      renderItem={renderSubtype}
      keyExtractor={type => type}
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
      style={styles.mask}
    />
  );
}

const styles = StyleSheet.create({
  mask: {
    marginRight: -spacing.page,
  },
  row: {
    gap: 8,
    paddingRight: spacing.page,
  },
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
  iconPill: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 13,
    fontFamily: fonts.families.medium,
    fontWeight: '500',
  },
});
