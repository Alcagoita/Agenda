/**
 * ContextChip — quiet header signal for the app's current context
 * (KAN-241 offline glyph; KAN-242 mall/trip place contexts).
 *
 * Exactly one of 4 states ever renders, in priority order:
 *   1. Mall   — inside the active mall snapshot's bounds.
 *   2. Trip   — inside an active trip's area AND today falls within its
 *               dates (dateless trips have no date constraint).
 *   3. Offline glyph — offline AND the habitat cache covers somewhere
 *      (KAN-241's original behaviour, unchanged).
 *   4. Nothing.
 * The mall/trip > offline priority, and the "never two chips" guarantee,
 * are resolved by the pure resolveContextChipView (src/utils/contextChip.ts)
 * — unit-tested there without needing to mock geolocation or Firestore.
 * Being offline while in a mall/trip context shows as a small muted dot on
 * that chip (a modifier, not its own indicator) rather than the old glyph.
 *
 * Tapping the chip opens a small sheet (Modal + Animated opacity/
 * translateY only — Fabric-safe, same pattern as ShareProfileSheet.tsx),
 * with content specific to the active state. The sheet stays mounted/
 * visible independent of the chip's own gating so it doesn't vanish
 * mid-interaction if connectivity or position flips while it's open.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { useTheme } from '../theme';
import { radius, spacing } from '../theme/tokens';
import { CloudOffIcon, CloseIcon, RefreshIcon } from './AppIcon';
import { useOfflineCoverage } from '../hooks/useOfflineCoverage';
import { getMostRecentHabitatUpdateAt, refreshHabitatCacheIfStale } from '../services/habitatCache';
import { getLastSearchCoords, getActiveOffGridWindow } from '../services/proximity';
import type { PlaceContext } from '../services/proximity';
import { refreshTripArea, getAreaDownloadPoiTypes } from '../services/tripDownload';
import { resolveContextChipView, ContextChipView } from '../utils/contextChip';
import { todayISO, formatLocalTime, formatDateShort } from '../utils/date';
import { useToastStore } from '../store/toastStore';
import { COPY } from '../constants/copy';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/AppNavigator';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** How often to re-check the off-grid window's active/expired state — it's time-based, not tied to a position fix like everything else this chip reflects. */
const OFFGRID_POLL_MS = 60_000;

function formatLearnedDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}


function chipA11yLabel(view: ContextChipView): string {
  switch (view.kind) {
    case 'mall':    return COPY.contextChip.mallChipA11y(view.name);
    case 'trip':    return COPY.contextChip.tripChipA11y(view.destination);
    case 'offgrid': return COPY.offGrid.chipA11y(formatLocalTime(view.expiresAt));
    case 'offline': return COPY.contextChip.offlineGlyphA11y;
    case 'none':    return '';
  }
}

function sheetTitleFor(view: ContextChipView): string {
  switch (view.kind) {
    case 'mall':    return COPY.contextChip.mallSheetTitle(view.name);
    case 'trip':    return COPY.contextChip.tripSheetTitle(view.destination);
    case 'offgrid': return COPY.offGrid.sheetTitle;
    default:        return COPY.contextChip.sheetTitle;
  }
}

export interface ContextChipProps {
  /** Mall/trip context for the last position fix (KAN-242), or null. Absent by default (offline-only behaviour). */
  placeContext?: PlaceContext;
}

export default function ContextChip({ placeContext = null }: ContextChipProps) {
  const { palette } = useTheme();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const { offline, hasCache } = useOfflineCoverage();

  const [sheetOpen, setSheetOpen]         = useState(false);
  const [modalVisible, setModalVisible]   = useState(false);
  const [refreshing, setRefreshing]       = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [offGridWindow, setOffGridWindow] = useState(() => getActiveOffGridWindow());

  const scrimOpacity    = useRef(new Animated.Value(0)).current;
  const sheetTranslateY = useRef(new Animated.Value(screenHeight)).current;

  // KAN-246 — the off-grid window is time-based, not tied to a position fix
  // (unlike placeContext/offline, which update on every proximity tick), so
  // it needs its own poll to notice a natural expiry without one.
  useEffect(() => {
    const timer = setInterval(() => setOffGridWindow(getActiveOffGridWindow()), OFFGRID_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const todayIso = todayISO();
  const view = useMemo(
    () => resolveContextChipView({ placeContext, todayIso, offline, hasCache, offGridWindow }),
    [placeContext, todayIso, offline, hasCache, offGridWindow],
  );

  // Frozen at the moment the sheet is opened, so a connectivity/position
  // update mid-interaction (which can change `view`/`placeContext` live)
  // doesn't yank the sheet's title/body out from under the user or flip it
  // to a different state — only the refresh button(s) react live to
  // `offline`/`refreshing`. The chip itself is unaffected and always
  // reflects the live `view`.
  const [openedSheet, setOpenedSheet] = useState<{ view: ContextChipView; placeContext: PlaceContext }>({
    view: { kind: 'none' },
    placeContext: null,
  });

  useEffect(() => {
    if (sheetOpen) {
      setModalVisible(true);
      setLastUpdatedAt(getMostRecentHabitatUpdateAt());
      scrimOpacity.setValue(0);
      sheetTranslateY.setValue(screenHeight);
      Animated.parallel([
        Animated.timing(scrimOpacity, { toValue: 1, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(sheetTranslateY, { toValue: 0, duration: 320, easing: Easing.bezier(0.32, 0.72, 0, 1), useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(scrimOpacity, { toValue: 0, duration: 200, easing: Easing.in(Easing.ease), useNativeDriver: true }),
        Animated.timing(sheetTranslateY, { toValue: screenHeight, duration: 200, easing: Easing.in(Easing.ease), useNativeDriver: true }),
      ]).start(({ finished }) => {
        if (finished) { setModalVisible(false); }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen, screenHeight]);

  const handleRefresh = useCallback(async () => {
    const coords = getLastSearchCoords();
    if (!coords) { return; }

    setRefreshing(true);
    try {
      const poiTypes = getAreaDownloadPoiTypes();
      await refreshHabitatCacheIfStale(coords.lat, coords.lng, poiTypes, true);
      setLastUpdatedAt(getMostRecentHabitatUpdateAt());
    } catch (err) {
      console.warn('[ContextChip] refresh failed', err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleTripRefresh = useCallback(async () => {
    if (placeContext?.kind !== 'trip') { return; }
    const trip = placeContext.trip;

    setRefreshing(true);
    try {
      const uid = getAuth().currentUser?.uid;
      if (!uid) { return; }
      await refreshTripArea(uid, trip);
    } catch (err) {
      console.warn('[ContextChip] trip refresh failed', err);
      useToastStore.getState().showToast(COPY.contextChip.placeRefreshErrorToast);
    } finally {
      setRefreshing(false);
    }
  }, [placeContext]);

  const showChip = view.kind !== 'none';

  return (
    <>
      {showChip && (
        <Pressable
          style={[
            view.kind === 'offline' ? styles.chip : styles.placeChip,
            { backgroundColor: palette.surface, borderColor: palette.line },
          ]}
          onPress={() => {
            setOpenedSheet({ view, placeContext });
            setSheetOpen(true);
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={chipA11yLabel(view)}>
          {view.kind === 'offline' ? (
            <CloudOffIcon color={palette.muted} size={14} />
          ) : view.kind === 'offgrid' ? (
            <>
              <CloudOffIcon color={palette.muted} size={12} />
              <Text style={[styles.placeChipText, { color: palette.muted }]} numberOfLines={1}>
                {`· ${formatLocalTime(view.expiresAt)}`}
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.placeChipText, { color: palette.muted }]} numberOfLines={1}>
                {`· ${view.kind === 'mall' ? view.name : view.destination}`}
              </Text>
              {view.offlineDot && (
                <View
                  style={[styles.placeChipDot, { backgroundColor: palette.muted }]}
                  accessibilityLabel={COPY.contextChip.offlineDotA11y}
                />
              )}
            </>
          )}
        </Pressable>
      )}

      {modalVisible && (
        <Modal visible={modalVisible} transparent animationType="none" onRequestClose={() => setSheetOpen(false)} statusBarTranslucent>
          <Animated.View style={[styles.scrim, { backgroundColor: palette.scrim, opacity: scrimOpacity }]} pointerEvents="box-none">
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={() => setSheetOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={COPY.contextChip.closeSheetA11y}
            />
          </Animated.View>

          <Animated.View
            style={[
              styles.sheet,
              {
                backgroundColor: palette.bg,
                borderTopColor:  palette.line,
                paddingBottom:   insets.bottom + 16,
                transform:       [{ translateY: sheetTranslateY }],
              },
            ]}>
            <View style={styles.handleRow}>
              <View style={[styles.handle, { backgroundColor: palette.surface2 }]} />
            </View>

            <View style={styles.headerRow}>
              <Text style={[styles.headerTitle, { color: palette.text }]}>{sheetTitleFor(openedSheet.view)}</Text>
              <Pressable
                style={[styles.closeBtn, { backgroundColor: palette.surface2 }]}
                onPress={() => setSheetOpen(false)}
                hitSlop={7}
                accessibilityRole="button"
                accessibilityLabel={COPY.contextChip.closeA11y}>
                <CloseIcon color={palette.muted} size={16} />
              </Pressable>
            </View>

            {openedSheet.view.kind === 'offline' && (
              <Text style={[styles.body, { color: palette.muted }]}>
                {COPY.contextChip.sheetBody(lastUpdatedAt != null ? formatLearnedDate(lastUpdatedAt) : undefined)}
              </Text>
            )}

            {openedSheet.view.kind === 'mall' && openedSheet.placeContext?.kind === 'mall' && (
              <Text style={[styles.body, { color: palette.muted }]}>
                {COPY.contextChip.placeSheetCoverageLine}
                {'\n'}
                {COPY.contextChip.mallSheetFreshnessLine(formatLearnedDate(openedSheet.placeContext.snapshot.createdAt.toMillis()))}
              </Text>
            )}

            {openedSheet.view.kind === 'trip' && (
              <>
                <Text style={[styles.body, { color: palette.muted }]}>
                  {openedSheet.view.startDate && openedSheet.view.endDate
                    ? COPY.tripPlanner.tripRowDates(formatDateShort(openedSheet.view.startDate), formatDateShort(openedSheet.view.endDate))
                    : COPY.tripPlanner.tripRowNoDates}
                  {'\n'}
                  {COPY.contextChip.placeSheetCoverageLine}
                  {openedSheet.view.endDate && `\n${COPY.tripPlanner.tripRowKnownUntil(formatDateShort(openedSheet.view.endDate))}`}
                </Text>
                <Pressable
                  style={[styles.refreshBtn, { backgroundColor: palette.surface2, opacity: refreshing || offline ? 0.6 : 1 }]}
                  onPress={handleTripRefresh}
                  disabled={refreshing || offline}
                  accessibilityRole="button"
                  accessibilityLabel={refreshing ? COPY.contextChip.refreshingLabel : COPY.contextChip.refreshButton}>
                  <RefreshIcon color={palette.text} size={16} />
                  <Text style={[styles.refreshLabel, { color: palette.text }]}>
                    {refreshing ? COPY.contextChip.refreshingLabel : COPY.contextChip.refreshButton}
                  </Text>
                </Pressable>
              </>
            )}

            {openedSheet.view.kind === 'offline' && !offline && (
              <Pressable
                style={[styles.refreshBtn, { backgroundColor: palette.surface2, opacity: refreshing ? 0.6 : 1 }]}
                onPress={handleRefresh}
                disabled={refreshing}
                accessibilityRole="button"
                accessibilityLabel={refreshing ? COPY.contextChip.refreshingLabel : COPY.contextChip.refreshButton}>
                <RefreshIcon color={palette.text} size={16} />
                <Text style={[styles.refreshLabel, { color: palette.text }]}>
                  {refreshing ? COPY.contextChip.refreshingLabel : COPY.contextChip.refreshButton}
                </Text>
              </Pressable>
            )}

            {openedSheet.view.kind === 'offgrid' && (
              <Text style={[styles.body, { color: palette.muted }]}>
                {COPY.offGrid.sheetBody(formatLocalTime(openedSheet.view.expiresAt))}
              </Text>
            )}

            {/* KAN-246 — entry point 2/2: offer it whenever the chip is visible, except from its own sheet. */}
            {openedSheet.view.kind !== 'offgrid' && (
              <Pressable
                style={[styles.refreshBtn, { backgroundColor: palette.surface2 }]}
                onPress={() => {
                  setSheetOpen(false);
                  navigation.navigate('OffGrid');
                }}
                accessibilityRole="button"
                accessibilityLabel={COPY.offGrid.profileRowA11y}>
                <CloudOffIcon color={palette.text} size={16} />
                <Text style={[styles.refreshLabel, { color: palette.text }]}>
                  {COPY.offGrid.profileRowLabel}
                </Text>
              </Pressable>
            )}
          </Animated.View>
        </Modal>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  chip: {
    width:          28,
    height:         28,
    borderRadius:   radius.chip,
    borderWidth:    1,
    alignItems:     'center',
    justifyContent: 'center',
  },

  placeChip: {
    flexDirection:     'row',
    alignItems:        'center',
    height:            22,
    maxWidth:          140,
    paddingHorizontal: 8,
    borderRadius:      radius.chip,
    borderWidth:       1,
    gap:               4,
  },
  placeChipText: {
    fontSize:   11,
    fontWeight: '500',
    fontFamily: 'Geist-Medium',
    flexShrink: 1,
  },
  placeChipDot: {
    width:        5,
    height:       5,
    borderRadius: radius.chip,
    flexShrink:   0,
  },

  scrim: {
    ...StyleSheet.absoluteFill,
  },
  sheet: {
    position:             'absolute',
    bottom:               0,
    left:                 0,
    right:                0,
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    borderTopWidth:       StyleSheet.hairlineWidth,
  },
  handleRow: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
  handle:    { width: 36, height: 4, borderRadius: 2 },

  headerRow: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: spacing.page,
    paddingTop:        16,
    paddingBottom:     14,
  },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  closeBtn:    { width: 30, height: 30, borderRadius: radius.chip, alignItems: 'center', justifyContent: 'center' },

  body: {
    fontSize:          14,
    fontFamily:        'Geist-Regular',
    paddingHorizontal: spacing.page,
    paddingBottom:     20,
  },

  refreshBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    gap:               8,
    height:            48,
    borderRadius:      radius.ctaBtn,
    marginHorizontal:  spacing.page,
  },
  refreshLabel: { fontSize: 15, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
});
