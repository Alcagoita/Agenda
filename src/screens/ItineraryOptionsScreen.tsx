/**
 * ItineraryOptionsScreen — KAN-281
 *
 * Resolves a destination for every open POI task, orders them into one
 * multi-stop route (greedy nearest-neighbor from the current position),
 * and presents it as a single card. Travel mode (walking/driving/etc.) is
 * picked by the user inside Maps, not pre-judged here.
 *
 * Doctrine: reveal facts freely, order stops on request only, judge/command
 * never. Cards state facts (stop names, distances) — never "best" /
 * "optimal" / "recommended". No route state is stored anywhere; tasks
 * complete only by brushing, same as always.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import { ChevronLeftIcon, PoiIcon, ShoppingBagIcon } from '../components/AppIcon';
import LoadingDots from '../components/LoadingDots';
import { COPY } from '../constants/copy';
import { ensureCurrentDay } from '../services/firestore';
import { getMallSnapshot } from '../services/mallSnapshots';
import { getPositionLowAccuracy } from '../services/geolocation';
import { getLastSearchCoords } from '../services/proximity';
import { refreshMallsIfDue } from '../services/habitatCache';
import { openMultiStopDirections, formatDistance } from '../services/maps';
import { resolveTripDestinations, planTrip, type TripPlan } from '../services/oneTripForAll';
import { findMallOption, type MallOption } from '../services/mallRoute';
import { useToastStore } from '../store/toastStore';
import type { RootStackParamList } from '../navigation/AppNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList, 'ItineraryOptions'>;

function stopLine(stop: TripPlan['stops'][number]): string {
  return stop.place.source === 'learned'
    ? COPY.itineraryOptionsScreen.destinationLearned(stop.place.name)
    : COPY.itineraryOptionsScreen.destinationWithDistance(stop.place.name, formatDistance(stop.place.distanceMeters));
}

export default function ItineraryOptionsScreen() {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [mallOption, setMallOption] = useState<MallOption | null>(null);
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    (async () => {
      const uid = getAuth().currentUser?.uid;
      if (!uid) { if (!cancelled) { setLoadError(true); setLoading(false); } return; }

      try {
        // A user-requested trip deserves the freshest position we can get —
        // the last proximity-engine fix (getLastSearchCoords) is only a
        // fallback if a fresh read fails (permission hiccup, GPS cold start).
        let coords: { lat: number; lng: number };
        try {
          coords = await getPositionLowAccuracy();
        } catch {
          const cached = getLastSearchCoords();
          if (!cached) { throw new Error('no position available'); }
          coords = cached;
        }

        const { tasks } = await ensureCurrentDay(uid);
        const { resolved, excludedCount } = await resolveTripDestinations(tasks, coords, uid);
        const tripPlan = planTrip(coords, resolved, excludedCount);
        // KAN-282 — opportunistic only: reads the user's mall snapshot and the
        // offline habitat cache, never a search of its own. Failure to fetch
        // the snapshot just means the snapshot tier is skipped.
        const snapshot = await getMallSnapshot(uid).catch(() => null);
        const mall = findMallOption(coords, tripPlan.stops, snapshot);
        if (!cancelled) { setPlan(tripPlan); setMallOption(mall); setOrigin(coords); }

        // KAN-282 — no qualifying mall can mean "none nearby" (fine, normal)
        // or "we have never swept this area for malls". Kick off a
        // fire-and-forget sweep so the next visit has the data, rather than
        // waiting on proximity's 200m-movement gate. Same background-cache
        // pattern proximity.ts already uses (Overpass, free — not a Places
        // call). refreshMallsIfDue carries its own cooldown, so this can't
        // fire on every screen open; it deliberately does NOT go through the
        // plain staleness check, which one cached small gallery would satisfy
        // for the whole area (see refreshMallsIfDue).
        if (!mall) {
          refreshMallsIfDue(coords.lat, coords.lng).catch(() => {});
        }
      } catch {
        if (!cancelled) { setLoadError(true); }
      } finally {
        if (!cancelled) { setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [retryCount]);

  const openCard = () => {
    if (!plan || plan.stops.length === 0 || !origin) { return; }
    openMultiStopDirections(origin, plan.stops.map(s => s.place)).catch(() => {
      useToastStore.getState().showToast(COPY.itineraryOptionsScreen.mapsOpenFailed);
    });
  };

  const openMallCard = () => {
    if (!mallOption || !origin) { return; }
    // Single destination, no waypoints/ordering — reuses the same
    // multi-stop opener with a one-element stops array.
    openMultiStopDirections(origin, [mallOption]).catch(() => {
      useToastStore.getState().showToast(COPY.itineraryOptionsScreen.mapsOpenFailed);
    });
  };

  const totalKm = plan ? (plan.totalDistanceMeters / 1000).toFixed(1) : '0.0';

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>
      <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
        <Pressable
          style={styles.navBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.itineraryOptionsScreen.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.itineraryOptionsScreen.screenTitle}</Text>
        <View style={styles.navBtn} />
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <LoadingDots color={palette.accent} />
          <Text style={[styles.loadingLabel, { color: palette.muted }]}>{COPY.itineraryOptionsScreen.loadingLabel}</Text>
        </View>
      ) : loadError ? (
        <View style={styles.loadingWrap}>
          <Text style={[styles.emptyText, { color: palette.muted }]}>{COPY.itineraryOptionsScreen.errorBody}</Text>
          <Pressable
            onPress={() => setRetryCount(c => c + 1)}
            accessibilityRole="button"
            accessibilityLabel={COPY.itineraryOptionsScreen.retryLabel}>
            <Text style={[styles.retryLabel, { color: palette.text }]}>{COPY.itineraryOptionsScreen.retryLabel}</Text>
          </Pressable>
        </View>
      ) : !plan || plan.stops.length === 0 ? (
        <View style={styles.loadingWrap}>
          <Text style={[styles.emptyText, { color: palette.muted }]}>{COPY.itineraryOptionsScreen.emptyStateBody}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
          <Pressable
            testID="itinerary-card"
            onPress={openCard}
            style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.line }]}
            accessibilityRole="button"
            accessibilityLabel={COPY.itineraryOptionsScreen.openInMapsA11y}>
            <View style={styles.cardHeader}>
              <Text style={[styles.cardTitle, { color: palette.text }]}>{COPY.itineraryOptionsScreen.cardLabel}</Text>
              <Text style={[styles.cardStopsCount, { color: palette.muted }]}>
                {COPY.itineraryOptionsScreen.stopsCount(plan.stops.length)}
              </Text>
            </View>

            {plan.stops.map((stop, i) => (
              <View key={stop.task.id} style={styles.stopRow}>
                <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
                  <PoiIcon type={stop.task.poi ?? ''} color={palette.muted} size={20} />
                </View>
                <Text style={[styles.stopLabel, { color: palette.text }]} numberOfLines={1}>
                  <Text style={styles.stopNumber}>{i + 1}.</Text> {stopLine(stop)}
                </Text>
              </View>
            ))}

            <Text style={[styles.totalDistance, { color: palette.muted }]}>
              {COPY.itineraryOptionsScreen.totalDistance(totalKm)}
            </Text>

            {plan.excludedCount > 0 && (
              <Text style={[styles.exclusionLine, { color: palette.faint }]}>
                {COPY.itineraryOptionsScreen.exclusionLine(plan.excludedCount)}
              </Text>
            )}
          </Pressable>

          {/* KAN-282 — mall card, only when a qualifying destination mall is
              in range. Always below the stop-by-stop card: tinted AND first
              would read as "recommended", which the doctrine bans. */}
          {mallOption && (
            <Pressable
              testID="mall-card"
              onPress={openMallCard}
              style={[styles.mallCard, { backgroundColor: palette.nearTint, borderColor: palette.nearBorder }]}
              accessibilityRole="button"
              accessibilityLabel={COPY.itineraryOptionsScreen.mallCardA11y(mallOption.name)}
              accessibilityHint={COPY.itineraryOptionsScreen.mallOpenInMapsA11y}>
              <View style={[styles.mallIconTile, { backgroundColor: palette.accent + '33' }]}>
                <ShoppingBagIcon color={palette.accent} size={22} />
              </View>
              <View style={styles.mallTextWrap}>
                {/* nearText is designed to pair with nearTint/nearBorder in
                    both palettes (see ContextChip) — no runtime contrast
                    check needed, the token pairing already guarantees it. */}
                <Text style={[styles.mallTitle, { color: palette.nearText }]}>
                  {COPY.itineraryOptionsScreen.mallCardTitle}
                </Text>
                <Text style={[styles.mallSubtitle, { color: palette.muted }]} numberOfLines={1}>
                  {COPY.itineraryOptionsScreen.mallCardSubtitle(mallOption.name)}
                </Text>
                <Text style={[styles.mallDistance, { color: palette.muted }]}>
                  {COPY.itineraryOptionsScreen.mallCardDistance(formatDistance(mallOption.distanceMeters))}
                </Text>
              </View>
            </Pressable>
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.page, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },

  // Absolutely positioned over the full screen (not just the area below
  // topBar) so it centers on the true screen middle — centering only within
  // the post-topBar flex space visibly sits low and reads as an error state.
  loadingWrap: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: spacing.page,
  },
  loadingLabel: { fontSize: 14, fontFamily: 'Geist-Regular' },
  emptyText: { fontSize: 14, fontFamily: 'Geist-Regular', textAlign: 'center' },
  retryLabel: { fontSize: 14, fontWeight: '600', fontFamily: 'Geist-SemiBold' },

  content: { paddingHorizontal: spacing.page, paddingTop: 16, gap: 12 },

  card: {
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  cardTitle: { fontSize: 16, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  cardStopsCount: { fontSize: 13, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },

  stopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconTile: { width: 36, height: 36, borderRadius: radii.listIcon, alignItems: 'center', justifyContent: 'center' },
  stopLabel: { flex: 1, fontSize: 14, fontFamily: 'Geist-Regular' },
  stopNumber: { fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },

  totalDistance: { fontSize: 13, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },
  exclusionLine: { fontSize: 12, fontFamily: 'Geist-Regular' },

  // ── Mall card (KAN-282) ──
  mallCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 16,
  },
  mallIconTile: {
    width: 46, height: 46, borderRadius: radii.heroIcon,
    alignItems: 'center', justifyContent: 'center',
  },
  mallTextWrap: { flex: 1, gap: 2 },
  mallTitle: { fontSize: 15, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  mallSubtitle: { fontSize: 13, fontFamily: 'Geist-Regular' },
  mallDistance: { fontSize: 12, fontFamily: 'Geist-Regular', fontVariant: ['tabular-nums'] },

  // ── TEMPORARY debug list (KAN-282) — remove once detection bug is fixed ──
});
