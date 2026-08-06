/**
 * TodayScreen — KAN-45
 *
 * Pure rendering component (KAN-59). All data state, Firestore subscriptions,
 * proximity engine, and battery monitoring are owned by useTodayScreen.
 * This file contains only:
 *   - Auth / display-name derivation
 *   - Reanimated scroll/animation logic (see useCollapseAnimation)
 *   - JSX render
 *
 * Layout (top → bottom):
 *   1. Sticky Header (zIndex 3)           — avatar, greeting, bell
 *   2. Collapsible Ring Section (zIndex 2) — scroll-driven A→B collapse
 *   3. Nearby Card                        — KAN-46
 *   4. Task list                          — KAN-15
 *
 * Scroll collapse:  k = clamp(scrollY / 90, 0, 1)
 *
 * k=0 (rest)        k=1 (collapsed)
 * diameter  184     112
 * stroke     11      10
 * left       (screen–184)/2    22
 * height    240     150
 * caption   opaque  transparent   (fades over k 0→0.625)
 * counter   hidden   visible       (fades over k 0.45→0.91)
 *
 * Animation: react-native-reanimated — all interpolations run on the UI thread.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ChevronRightIcon, NavigateIcon, PlusIcon } from '../../components/AppIcon';
import ScrRotatingNudge from '../../components/ScrRotatingNudge';
import Animated from 'react-native-reanimated';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import Header from '../../components/Header';
import Lantern from '../../components/Lantern';
import TaskRow from '../../components/TaskRow';
import NearbyCard from '../../components/NearbyCard';
import ErrandBundleCard from '../../components/ErrandBundleCard';
import TripSuggestionCard from '../../components/TripSuggestionCard';
import NewTaskSheetHost from '../../components/NewTaskSheetHost';
import { useNewTaskSheetStore } from '../../store/newTaskSheetStore';
import StoreTuningPromptSheet from '../../components/StoreTuningPromptSheet';
import { RootStackParamList } from '../../navigation/AppNavigator';
import { useTodayScreen } from '../../hooks/useTodayScreen';
import { useLanternState } from '../../hooks/useLanternState';
import { consumeTasksDirty } from '../../services/taskMutationSignal';
import { COPY } from '../../constants/copy';
import { localDateISO } from '../../utils/date';
import { restaurantTaskMatchesAnyPlace } from '../../services/restaurantFoodTypes';
import type { PlacesMap } from '../../services/proximity';
import {
  SECTION_H_REST,
  buildEmptyMessages,
  DEBUG_SHOW_LIST,
  DEBUG_SHOW_NEARBY,
  DEBUG_SHOW_RING,
  DEBUG_SIMPLE_ROWS,
  DEBUG_MINIMAL,
} from './constants';
import { useCollapseAnimation } from './useCollapseAnimation';
import { SkeletonRow } from './SkeletonRow';
import { styles } from './styles';

type Nav = NativeStackNavigationProp<RootStackParamList, 'Today'>;

function taskHasNearbyPlace(task: { poi?: string | null; title: string }, places: PlacesMap): boolean {
  if (!task.poi) { return false; }
  const nearbyPlaces = places[task.poi];
  return !!nearbyPlaces?.length && restaurantTaskMatchesAnyPlace(task, nearbyPlaces);
}

export default function TodayScreen() {
  const { palette, language } = useTheme();
  const insets      = useSafeAreaInsets();
  const navigation  = useNavigation<Nav>();

  // ── Auth / display info ──────────────────────────────────────────────────────
  const user        = getAuth().currentUser;
  const uid         = user?.uid;
  const displayName = user?.displayName ?? user?.email?.split('@')[0] ?? 'there';

  // ── ViewModel hook (KAN-59) ──────────────────────────────────────────────────
  const {
    tasks,
    isLoading,
    isRefreshing,
    error,
    refresh,
    nearbyPoiType,
    poiPlaces,
    placeContext,
    coords,
    permissionGranted,
    storeTuningActive,
    showStoreTuningPrompt,
    onStoreTuningTurnOn,
    onStoreTuningNotNow,
    customCategories,
    inboxCount,
    socialUnreadCount,
    handleToggle,
    nearbyReady,
    refreshProximity,
    errandBundle,
    errandBundleLeisure,
    dismissErrandBundle,
    tripSuggestion,
    dismissTripSuggestion,
  } = useTodayScreen(uid);

  const [nearbyHasContent, setNearbyHasContent] = useState(false);

  // Refresh tasks on focus — but only when a real mutation happened
  // somewhere since the last load (a task edited/added/deleted, a shared
  // task accepted, an import, a toggle from CalendarScreen). Every task
  // write marks taskMutationSignal at its source (services/firestore/
  // tasks.ts, sharing.ts, import.ts); refresh() otherwise did 10 parallel
  // Firestore reads on every single return to this screen regardless of
  // whether anything had changed (KAN-285 follow-up).
  // Skip the very first focus — SplashScreen already preloaded data.
  const hasFocusedOnce = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!hasFocusedOnce.current) { hasFocusedOnce.current = true; return; }
    if (consumeTasksDirty()) { refresh(); }
  }, [refresh]));

  // ── New Task sheet open trigger ───────────────────────────────────────────────
  // Visibility lives in useNewTaskSheetStore, NOT screen state. `openSheet` is
  // read via getState() (no subscription) so opening never re-renders this
  // screen; the sheet itself is rendered by NewTaskSheetHost which subscribes.
  const openSheet = useCallback(() => useNewTaskSheetStore.getState().open(), []);

  // ── Scroll-driven header collapse (KAN-157) ───────────────────────────────────
  // Reused unmodified (KAN-301 AC12). captionStyle is the rest-layer opacity,
  // collapsedStyle the collapsed-layer opacity — fed straight to the Lantern's
  // two crossfade layers. ringWrapStyle (the old ring scale) is no longer used.
  const { scrollHandler, collapsed, bgStyle, captionStyle, collapsedStyle } = useCollapseAnimation();

  // ── Lantern — persistent place-familiarity header (KAN-301) ───────────────────
  const lanternState = useLanternState(placeContext, coords, permissionGranted);
  const onLanternPill = useCallback(() => {
    // Unset points at the home-address flow; every other state opens Places
    // (KAN-304).
    if (lanternState.kind === 'unset') { navigation.navigate('HomeAddress'); }
    else { navigation.navigate('Places'); }
  }, [lanternState.kind, navigation]);

  // ── Task display order: undone first, done at bottom ─────────────────────────
  // Memoized so a nearby-data change (which leaves `tasks` untouched) doesn't
  // produce a new array identity and re-render every memoized TaskRow (KAN-156).
  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => {
      if (a.done === b.done) { return 0; }
      return a.done ? 1 : -1;
    }),
    [tasks],
  );

  // ── "One trip for all of these" entry row (KAN-281) ───────────────────────────
  // Pure sync check against data already in memory — no Firestore, no network,
  // nothing async. Visible when there's more than one open POI task AND at
  // least one of them isn't already covered by the Nearby card (same
  // hero+grey `poiPlaces` set each row's `isFar` indicator checks). Tasks
  // that are all already nearby don't need a trip — that's what the Nearby
  // card is for.
  //
  // Gated on `nearbyReady`: before the Nearby list has actually been
  // computed, poiPlaces is just its {} default, which would make every POI
  // task read as "not nearby" — showing the button, then yanking it away
  // moments later once the real scan lands is worse than not showing it at
  // all, so it waits.
  const oneTripVisible = useMemo(() => {
    if (!nearbyReady) { return false; }
    const eligible = sortedTasks.filter(t => !t.done && t.kind !== 'birthday' && t.poi);
    if (eligible.length < 2) { return false; }
    return eligible.some(t => !taskHasNearbyPlace(t, poiPlaces));
  }, [nearbyReady, sortedTasks, poiPlaces]);

  // Stable row-press handler — an inline arrow here would change identity every
  // render and defeat React.memo on TaskRow.
  const handleTaskPress = useCallback(
    (t: typeof tasks[number]) => navigation.navigate('TaskForm', { uid: uid ?? '', task: t }),
    [navigation, uid],
  );

  // KAN-245 — acting on the trip suggestion resolves it, same as an explicit
  // dismiss: it shouldn't still be sitting there when the user comes back.
  const handleTripSuggestionPress = useCallback(() => {
    if (!tripSuggestion) { return; }
    navigation.push('TripPlanner', {
      prefillStartDate: localDateISO(new Date(tripSuggestion.dateISO)),
      prefillDestinationQuery: tripSuggestion.place,
    });
    dismissTripSuggestion();
  }, [navigation, tripSuggestion, dismissTripSuggestion]);

  // ── Empty state flag ──────────────────────────────────────────────────────────
  const isBusy = isLoading || isRefreshing;
  const isEmpty = !isBusy && !error && tasks.length === 0;

  // ── Virtualized task list (KAN-157 follow-up) ─────────────────────────────────
  // Post-rollover (KAN-146) the Today list can hold every undone task carried
  // forward from past days — potentially dozens. Rendering them all eagerly in a
  // .map() inside a ScrollView meant every proximity tick re-rendered the whole
  // animation-heavy list, saturating the JS thread (buttons dead). FlatList
  // virtualizes: only on-screen rows mount, and stable props keep React.memo
  // intact so a location update never re-renders rows it didn't change.
  const renderTask = useCallback(
    ({ item }: { item: typeof tasks[number] }) => (
      DEBUG_SIMPLE_ROWS ? (
        <View style={styles.rowPad}>
          <Text style={[styles.debugRowText, { color: palette.text }]}>{item.title}</Text>
        </View>
      ) : (
      <View style={styles.rowPad}>
        <TaskRow
          task={item}
          // Narrow the prop: only the matching row ever sees a non-null type, so
          // every other row keeps a stable `null` across location ticks and its
          // memo holds (no re-render).
          nearbyPoiType={item.poi && item.poi === nearbyPoiType ? nearbyPoiType : null}
          // KAN-279 — quiet nav-arrow indicator: this task's POI isn't in
          // the Nearby list at all (same hero+grey set NearbyCard renders
          // from poiPlaces), so "Take me there" is available for it. Gated
          // on nearbyReady — see oneTripVisible's comment above, same
          // "don't show it just to yank it away" reasoning.
          isFar={nearbyReady && !!item.poi && !taskHasNearbyPlace(item, poiPlaces)}
          onToggle={handleToggle}
          onPress={handleTaskPress}
          customCategories={customCategories}
        />
      </View>
      )
    ),
    [nearbyReady, nearbyPoiType, poiPlaces, handleToggle, handleTaskPress, customCategories, palette.text],
  );

  const keyExtractor = useCallback((t: typeof tasks[number]) => t.id, []);

  const listHeader = useMemo(() => (
    <>
      {/* ── Nearby card (KAN-46 / KAN-52 / KAN-74) ── */}
      {DEBUG_SHOW_NEARBY && (
      <NearbyCard
        tasks={sortedTasks}
        nearbyPoiType={nearbyPoiType}
        poiPlaces={poiPlaces}
        storeTuningActive={storeTuningActive}
        onRefreshLocation={refreshProximity}
        onHasContent={setNearbyHasContent}
      />
      )}

      {/* ── Errand bundle card (KAN-235) — absent by default ── */}
      {errandBundle && (
        <ErrandBundleCard
          bundle={errandBundle}
          onDismiss={dismissErrandBundle}
          leisure={errandBundleLeisure}
        />
      )}

      {/* ── Trip suggestion card (KAN-245 calendar signal) — absent by default ── */}
      {tripSuggestion && (
        <TripSuggestionCard
          suggestion={tripSuggestion}
          language={language}
          onPress={handleTripSuggestionPress}
          onDismiss={dismissTripSuggestion}
        />
      )}

      {/* ── Task list section header ── */}
      <View style={[styles.sectionHeaderBlock, (nearbyHasContent || !!errandBundle || !!tripSuggestion) && { marginTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line }]}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: palette.muted }]}>
            {COPY.today.sectionTitlePrefix}
          </Text>
        </View>
      </View>
    </>
  ), [
    sortedTasks, nearbyPoiType, poiPlaces, storeTuningActive,
    palette,
    nearbyHasContent, setNearbyHasContent,
    refreshProximity,
    errandBundle, dismissErrandBundle,
    errandBundleLeisure,
    tripSuggestion, dismissTripSuggestion, handleTripSuggestionPress, language,
  ]);

  const listFooter = useMemo(() => (
    <>
      {/* ── "One trip for all of these" (KAN-281) — quiet, absence-is-default,
          same bordered-row template as CalendarScreen's "Going somewhere?"
          entry row (tripEntryRow). ── */}
      {oneTripVisible && (
        <Pressable
          style={[styles.oneTripForAllRow, { borderColor: palette.line }]}
          hitSlop={4}
          onPress={() => navigation.navigate('ItineraryOptions')}
          accessibilityRole="button"
          accessibilityLabel={COPY.oneTripForAll.entryA11y}>
          <NavigateIcon color={palette.muted} size={16} />
          <Text style={[styles.oneTripForAllLabel, { color: palette.text }]}>
            {COPY.oneTripForAll.entryLabel}
          </Text>
          <ChevronRightIcon color={palette.faint} size={14} strokeWidth={1.8} />
        </Pressable>
      )}
      <View style={styles.bottomPad} />
    </>
  ), [oneTripVisible, navigation, palette]);

  const listEmpty = isBusy ? (
    <View style={styles.rowPad}>
      {[0, 1, 2].map(i => (
        <SkeletonRow key={i} index={i} faint={palette.faint} />
      ))}
    </View>
  ) : error ? (
    <View style={[styles.rowPad, styles.errorWrap]}>
      <Text
        style={[styles.empty, { color: palette.muted }]}
        accessibilityRole="alert">
        {error}
      </Text>
      <Pressable
        onPress={refresh}
        style={[styles.retryBtn, { borderColor: palette.line }]}
        accessibilityRole="button"
        accessibilityLabel={COPY.today.retry}>
        <Text style={[styles.retryLabel, { color: palette.text }]}>{COPY.today.retry}</Text>
      </Pressable>
    </View>
  ) : null;

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>

      {/* ── Sticky header (zIndex 3) ── */}
      <View style={styles.stickyHeader}>
        <Header
          displayName={displayName}
          photoURL={user?.photoURL}
          hasUnread={inboxCount > 0 || socialUnreadCount > 0}
          socialBadge={0}
          onAvatarPress={() => navigation.navigate('Profile')}
          onBellPress={() => navigation.navigate('SharedTaskInbox')}
          onPeoplePress={() => navigation.navigate('SocialHub')}
        />
      </View>

      {/* ── Scroll area — ring section overlaid on content ── */}
      {(DEBUG_SHOW_LIST || DEBUG_SHOW_RING) && (
      <View style={styles.scrollArea}>

        {DEBUG_SHOW_LIST && (isEmpty ? (
          /* ── Empty state body (KAN-139) — no scroll, nudge + CTA ── */
          <View style={[StyleSheet.absoluteFill, { paddingTop: SECTION_H_REST }]}>
            <ScrRotatingNudge
              messages={buildEmptyMessages(() => navigation.push('TripPlanner'))}
              pace={5}
              showCategoryIcon
            />
            <View style={styles.emptyCTAWrap}>
              <Pressable
                style={({ pressed }) => [
                  styles.emptyCTABtn,
                  { backgroundColor: palette.accent },
                  pressed && styles.emptyCTABtnPressed,
                ]}
                onPress={openSheet}
                accessibilityRole="button"
                accessibilityLabel={COPY.today.addSomething}>
                <PlusIcon color={palette.text} size={20} />
                <Text style={[styles.emptyCTALabel, { color: palette.text }]}>
                  {COPY.today.addSomething}
                </Text>
              </Pressable>
              <Text style={[styles.emptyCTAHelper, { color: palette.faint }]}>
                {COPY.today.addSomethingHelper}
              </Text>
            </View>
          </View>
        ) : (
          /*
            The ScrollView fills the entire scrollArea (absoluteFill).
            paddingTop = SECTION_H_REST means content always starts 240px down,
            directly below where the ring section sits at rest. As the ring
            section collapses by SCROLL_RANGE (90px), content scrolls up the
            same distance — they stay in perfect alignment throughout.
          */
          <Animated.FlatList
            style={StyleSheet.absoluteFill}
            contentContainerStyle={[
              styles.scrollContent,
              { backgroundColor: palette.bg },
            ]}
            data={isBusy ? [] : sortedTasks}
            renderItem={renderTask}
            keyExtractor={keyExtractor}
            ListHeaderComponent={listHeader}
            ListEmptyComponent={listEmpty}
            ListFooterComponent={listFooter}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={scrollHandler}
            removeClippedSubviews
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={7}
          />
        ))}

        {/* ── Collapsible Lantern section — absolutely positioned ON TOP of content (KAN-301) ── */}
        {/*                                                                         */}
        {/* Replaces the progress ring. The Lantern owns two static layouts (rest  */}
        {/* centred; collapsed = icon+label left, pill right) that cross-fade via   */}
        {/* captionStyle / collapsedStyle — nothing animates per frame, matching    */}
        {/* the KAN-157 doctrine. The breathing halo is a View, never SVG.          */}
        {/*                                                                         */}
        {/* pointerEvents="box-none" lets scroll gestures pass through to the       */}
        {/* FlatList while the Lantern's pill stays tappable.                       */}
        {DEBUG_SHOW_RING && (
        <View
          pointerEvents="box-none"
          style={styles.ringSection}>

          {/* Background fill + bottom border — collapses via scaleY (composite) */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.ringBg,
              bgStyle,
              { backgroundColor: palette.bg, borderBottomColor: palette.line, borderBottomWidth: nearbyHasContent ? StyleSheet.hairlineWidth : 0 },
            ]}
          />

          <Lantern
            state={lanternState}
            onPillPress={onLanternPill}
            restStyle={captionStyle}
            collapsedStyle={collapsedStyle}
            collapsed={collapsed}
          />
        </View>
        )}

      </View>
      )}

      {/* ── Add-task FAB (KAN-51) — hidden on empty state (CTA replaces it) ── */}
      {(!isEmpty || DEBUG_MINIMAL) && (
        <Pressable
          style={({ pressed }) => [
            styles.fab,
            { backgroundColor: palette.accent, bottom: 20 + insets.bottom },
            pressed && styles.fabPressed,
          ]}
          onPress={openSheet}
          accessibilityRole="button"
          accessibilityLabel={COPY.today.addTaskA11y}>
          <PlusIcon color={palette.onAccent} size={24} />
        </Pressable>
      )}

      {/* ── New-task bottom sheet (KAN-51) ── */}
      {/* Rendered through a store-subscribed host so open/close never re-renders
          TodayScreen — only the host re-renders on a visibility toggle. */}
      <NewTaskSheetHost
        uid={uid ?? ''}
        onTaskAdded={refresh}
        customCategories={customCategories}
      />

      {/* ── Store fine tuning opt-in prompt (KAN-74 / KAN-75) ── */}
      <StoreTuningPromptSheet
        visible={showStoreTuningPrompt}
        onTurnOn={onStoreTuningTurnOn}
        onNotNow={onStoreTuningNotNow}
      />

      {/* ── Loading overlay — blocks touches until initial fetch completes ── */}
      {isLoading && !DEBUG_MINIMAL && (
        <View
          style={[
            styles.loadingOverlay,
            { backgroundColor: palette.scrim },
          ]}
          pointerEvents="box-only">
          <ActivityIndicator size="large" color={palette.accent} />
        </View>
      )}
    </View>
  );
}
