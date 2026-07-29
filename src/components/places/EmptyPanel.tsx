/** Per-section empty state — accent icon + line, optional add-action pill (KAN-304). */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { IconCmp, Palette } from './shared';

export default function EmptyPanel({ icon: Icon, line, palette, action }: {
  icon: IconCmp; line: string; palette: Palette; action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.emptyPanel}>
      <Icon color={palette.accent} size={24} />
      <Text style={[styles.emptyLine, { color: palette.text }]}>{line}</Text>
      {action && (
        <Pressable
          style={[styles.emptyActionPill, { borderColor: palette.line }]}
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}>
          <Text style={[styles.emptyActionLabel, { color: palette.text }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  emptyPanel: { alignItems: 'center', gap: 8, paddingVertical: 28, paddingHorizontal: 16, marginTop: 4 },
  emptyLine: { fontSize: 13, fontFamily: 'Geist-Regular', textAlign: 'center' },
  emptyActionPill: { marginTop: 4, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999, borderWidth: 1 },
  emptyActionLabel: { fontSize: 14, fontFamily: 'Geist-Medium', fontWeight: '500' },
});
