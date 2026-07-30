/**
 * PlacesScreen — KAN-304
 *
 * Behind the Lantern's "Places I know" pill (shares its name). Orchestration
 * only: theme/insets/navigation, usePlaces(), tab state, the top bar and
 * TabControl, and the teach sheet. The two tab bodies (PlacesTab, TripsTab) and
 * every row/card live in their own files; this screen just wires data and
 * handlers down.
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { spacing } from '../theme/tokens';
import { ChevronLeftIcon, PinIcon, TripMapIcon } from '../components/AppIcon';
import TabControl from '../components/TabControl';
import TeachSheet from '../components/TeachSheet';
import PlacesTab from './PlacesTab';
import TripsTab from './TripsTab';
import { usePlaces } from '../hooks/usePlaces';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { COPY } from '../constants/copy';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Places'>;

export default function PlacesScreen() {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {
    loading, favourites, usuals, activeTrips, pastTripGroups,
    addPlace, removePlace, removeUsual, forgetTrip,
  } = usePlaces();
  const [tab, setTab] = useState<'places' | 'trips'>('places');
  const [teaching, setTeaching] = useState(false);

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
        <Pressable style={styles.navBtn} onPress={() => navigation.goBack()} accessibilityRole="button" accessibilityLabel={COPY.places.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.places.screenTitle}</Text>
        <View style={styles.navBtn} />
      </View>

      <View style={styles.tabWrap}>
        <TabControl
          tabs={[
            { key: 'places', label: COPY.places.tabPlaces, icon: PinIcon },
            { key: 'trips', label: COPY.places.tabTrips, icon: TripMapIcon },
          ]}
          activeKey={tab}
          onChange={k => setTab(k as 'places' | 'trips')}
        />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}><ActivityIndicator color={palette.accent} /></View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
          {tab === 'places' ? (
            <PlacesTab
              palette={palette}
              favourites={favourites}
              usuals={usuals}
              onTeach={() => setTeaching(true)}
              onRemoveFavourite={removePlace}
              onRemoveUsual={removeUsual}
            />
          ) : (
            <TripsTab
              palette={palette}
              activeTrips={activeTrips}
              pastTripGroups={pastTripGroups}
              onForget={forgetTrip}
            />
          )}
        </ScrollView>
      )}

      <TeachSheet
        visible={teaching}
        onClose={() => setTeaching(false)}
        onSave={(poiType, name) => { addPlace(poiType, name); setTeaching(false); }}
      />
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
  tabWrap: { paddingHorizontal: spacing.page, marginTop: 12 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { paddingHorizontal: spacing.page, paddingTop: 12 },
});
