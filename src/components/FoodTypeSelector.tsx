import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { S } from './AppIcon/shared';
import { fonts, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme';
import {
  listRestaurantFoodTypes,
  restaurantFoodTypeDisplayLabel,
  type RestaurantFoodType,
} from '../services/restaurantFoodTypes';

interface FoodTypeSelectorProps {
  selected: RestaurantFoodType | null;
  onSelect: (foodType: RestaurantFoodType | null) => void;
}

function FoodTypeIcon({ type, color, size = 16 }: { type: RestaurantFoodType; color: string; size?: number }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' };

  switch (type) {
    case 'vegetarian':
    case 'healthy':
      return (
        <Svg {...p}>
          <Path d="M5 13c5-8 12-8 15-8-1 7-5 12-12 12H5z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M5 19c3-4 6-6 11-9" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'italian':
      return (
        <Svg {...p}>
          <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="9" cy="10" r="1" fill={color} stroke="none" />
          <Circle cx="14" cy="14" r="1" fill={color} stroke="none" />
          <Path d="M15 8l2-2" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'burger':
      return (
        <Svg {...p}>
          <Path d="M5 11c1-4 13-4 14 0" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M4 14h16" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M6 17h12" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="10" cy="8" r="0.8" fill={color} stroke="none" />
          <Circle cx="14" cy="8" r="0.8" fill={color} stroke="none" />
        </Svg>
      );
    case 'sushi':
      return (
        <Svg {...p}>
          <Rect x="4" y="7" width="16" height="10" rx="5" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="12" cy="12" r="2.5" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'mexican':
      return (
        <Svg {...p}>
          <Path d="M5 15a7 7 0 0 1 14 0v2H5v-2z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M8 15c1-2 2-3 4-3s3 1 4 3" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'indian':
    case 'thai':
      return (
        <Svg {...p}>
          <Path d="M5 11h14l-1 6H6l-1-6z" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M8 8c1-1 1-2 0-3M12 8c1-1 1-2 0-3M16 8c1-1 1-2 0-3" stroke={color} strokeWidth={1.6} {...S} />
          <Path d="M4 19h16" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'steak':
      return (
        <Svg {...p}>
          <Path d="M7 8c3-5 12-2 11 5-1 6-10 8-13 3-2-3 0-6 2-8z" stroke={color} strokeWidth={1.6} {...S} />
          <Circle cx="11" cy="13" r="2" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
    case 'portuguese':
    default:
      return (
        <Svg {...p}>
          <Circle cx="12" cy="12" r="8" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="12" y1="4" x2="12" y2="20" stroke={color} strokeWidth={1.6} {...S} />
          <Line x1="4" y1="12" x2="20" y2="12" stroke={color} strokeWidth={1.6} {...S} />
        </Svg>
      );
  }
}

export default function FoodTypeSelector({ selected, onSelect }: FoodTypeSelectorProps) {
  const { palette, language } = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
      style={styles.mask}>
      {listRestaurantFoodTypes().map(type => {
        const active = selected === type;
        const fg = active ? palette.nearText : palette.text;
        return (
          <Pressable
            key={type}
            onPress={() => onSelect(active ? null : type)}
            accessibilityRole="radio"
            accessibilityLabel={restaurantFoodTypeDisplayLabel(type, language)}
            accessibilityState={{ selected: active }}
            style={[
              styles.pill,
              {
                backgroundColor: active ? palette.nearTint2 : palette.surface,
                borderColor: active ? palette.nearBorder : palette.line,
              },
            ]}>
            <View style={[styles.iconPill, { backgroundColor: active ? palette.nearTint : palette.surface2 }]}>
              <FoodTypeIcon type={type} color={active ? palette.nearText : palette.muted} size={15} />
            </View>
            <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
              {restaurantFoodTypeDisplayLabel(type, language)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
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
