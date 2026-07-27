/**
 * TabControl — KAN-304
 *
 * A row of equal-width tabs, styled to match the Social hub ("Friends") quick
 * actions so the two screens read as the same app: 52-tall rounded-rectangles,
 * active = inverted (P.text bg, P.bg label), inactive = P.surface2 grey.
 */
import React, { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { radius as radii } from '../theme/tokens';
import type { IconProps } from './AppIcon/shared';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type IconCmp = (props: IconProps) => React.JSX.Element;

export interface TabItem { key: string; label: string; icon?: IconCmp; }

export interface TabControlProps {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
}

export default function TabControl({ tabs, activeKey, onChange }: TabControlProps) {
  const { palette } = useTheme();
  return (
    <View style={styles.row}>
      {tabs.map(tab => (
        <TabPill
          key={tab.key}
          label={tab.label}
          icon={tab.icon}
          active={tab.key === activeKey}
          onPress={() => onChange(tab.key)}
          textColor={palette.text}
          bgColor={palette.bg}
          inactiveBg={palette.surface2}
        />
      ))}
    </View>
  );
}

function TabPill({ label, icon: Icon, active, onPress, textColor, bgColor, inactiveBg }: {
  label: string; icon?: IconCmp; active: boolean; onPress: () => void;
  textColor: string; bgColor: string; inactiveBg: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const fg = active ? bgColor : textColor;
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 40, bounciness: 0 }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 4 }).start()}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
      style={[
        styles.tab,
        { backgroundColor: active ? textColor : inactiveBg },
        { transform: [{ scale }] },
      ]}>
      {Icon && <Icon color={fg} size={18} />}
      <Text style={[styles.label, { color: fg }]}>{label}</Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  tab: { flex: 1, flexDirection: 'row', gap: 8, height: 52, borderRadius: radii.ctaBtn, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 14, fontWeight: '500', fontFamily: 'Geist-Medium' },
});
