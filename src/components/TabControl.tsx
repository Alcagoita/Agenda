/**
 * TabControl — KAN-304
 *
 * A row of equal-width pill tabs. No animated slider — the active pill simply
 * inverts (background P.text, label P.bg); inactive pills are transparent with a
 * 1px P.line border. New pattern with no precedent in the app; built to the
 * ticket's exact values.
 */
import React, { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
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
          lineColor={palette.line}
        />
      ))}
    </View>
  );
}

function TabPill({ label, icon: Icon, active, onPress, textColor, bgColor, lineColor }: {
  label: string; icon?: IconCmp; active: boolean; onPress: () => void;
  textColor: string; bgColor: string; lineColor: string;
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
        styles.pill,
        active
          ? { backgroundColor: textColor }
          : { backgroundColor: 'transparent', borderWidth: 1, borderColor: lineColor },
        { transform: [{ scale }] },
      ]}>
      {Icon && <Icon color={fg} size={18} />}
      <Text style={[styles.label, { color: fg }]}>{label}</Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  pill: { flex: 1, flexDirection: 'row', gap: 8, height: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 15, fontWeight: '500', fontFamily: 'Geist-Medium' },
});
