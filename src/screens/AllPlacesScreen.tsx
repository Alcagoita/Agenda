/**
 * AllPlacesScreen — KAN-304
 *
 * The full brand directory, reached from the Places screen's "All N places"
 * overflow row. Every brand (taught + learned), searchable by name, where a
 * user with many places teaches or forgets them.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import { ChevronLeftIcon, FilledStarIcon, PoiIcon } from '../components/AppIcon';
import { usePlaces } from '../hooks/usePlaces';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { COPY } from '../constants/copy';

type Nav = NativeStackNavigationProp<RootStackParamList, 'AllPlaces'>;

export default function AllPlacesScreen() {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { loading, places, removePlace } = usePlaces();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) { return places; }
    return places.filter(p => p.name.toLowerCase().includes(q));
  }, [places, query]);

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
        <Pressable
          style={styles.navBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.places.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.places.directoryTitle}</Text>
        <View style={styles.navBtn} />
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          style={[styles.search, { color: palette.text, borderColor: palette.line, backgroundColor: palette.surface }]}
          placeholder={COPY.places.searchPlaceholder}
          placeholderTextColor={palette.muted}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}><ActivityIndicator color={palette.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
          {filtered.length === 0 ? (
            <Text style={[styles.emptyText, { color: palette.muted }]}>{COPY.places.directoryEmpty}</Text>
          ) : (
            filtered.map(place => (
              <View
                key={`${place.poiType} ${place.name}`}
                style={[styles.row, { backgroundColor: palette.surface, borderColor: palette.line }]}>
                <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
                  <PoiIcon type={place.poiType} color={palette.muted} size={20} />
                </View>
                <Text style={[styles.brandName, { color: palette.text }]} numberOfLines={1}>{place.name}</Text>
                {place.taught && (
                  <View accessibilityLabel={COPY.places.taughtMarkerA11y}>
                    <FilledStarIcon color={palette.accent} size={13} />
                  </View>
                )}
                {place.taught && place.id && (
                  <Pressable
                    onPress={() => removePlace(place.id!)}
                    hitSlop={8}
                    style={styles.removeBtn}
                    accessibilityRole="button"
                    accessibilityLabel={COPY.places.removeA11y(place.name)}>
                    <Text style={[styles.removeX, { color: palette.muted }]}>×</Text>
                  </Pressable>
                )}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.page, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  searchWrap: { paddingHorizontal: spacing.page, paddingTop: 12 },
  search: {
    height: 44, borderRadius: radii.ctaBtn, borderWidth: 1, paddingHorizontal: 14,
    fontSize: 15, fontFamily: 'Geist-Regular',
  },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: spacing.page, paddingTop: 12, gap: 10 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: radii.card, borderWidth: 1, padding: 12,
  },
  iconTile: { width: 36, height: 36, borderRadius: radii.listIcon, alignItems: 'center', justifyContent: 'center' },
  brandName: { flex: 1, fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  removeBtn: { paddingHorizontal: 4, paddingVertical: 4 },
  removeX: { fontSize: 22, lineHeight: 22 },
  emptyText: { fontSize: 14, fontFamily: 'Geist-Regular', textAlign: 'center', marginTop: 24 },
});
