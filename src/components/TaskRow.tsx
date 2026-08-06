/**
 * TaskRow — KAN-15 / KAN-13
 *
 * Layout:
 *   [checkbox 22×22] [title + chips]           [time]
 *
 * Interactions (KAN-13):
 *   - Tap the checkbox circle  → onToggle (marks done/undone)
 *   - Tap the title/chips area → onPress  (opens edit form)
 *
 * Checkbox states:
 *   unchecked — transparent fill, 1.5px text-colored border
 *   checked   — faint fill, no visible border
 */

import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { useTheme } from '../theme';
import { categories, fallbackCategoryColor } from '../theme/tokens';
import PoiChip from './PoiChip';
import BrushStroke from './BrushStroke';
import { CakeIcon, NavigateIcon } from './AppIcon';
import { COPY } from '../constants/copy';
import { Task, Category } from '../types';
import { logTap } from '../services/analytics';
import { openTakeMeThereMaps, getTakeMeThereA11yLabel } from '../services/takeMeThere';
import { storeSubtypeDisplayLabel } from '../services/storeSubtypes';
import { restaurantFoodTypeDisplayLabel } from '../services/restaurantFoodTypes';

interface TaskRowProps {
  task: Task;
  /** Currently active (nearby) POI type string — null until KAN-22 wires geolocation. */
  nearbyPoiType?: string | null;
  /** Tap on checkbox — toggles done state. */
  onToggle: (taskId: string, done: boolean) => void;
  /** Tap on row body — opens the edit form (KAN-13). Optional; row body is non-interactive if omitted. */
  onPress?: (task: Task) => void;
  /** Custom categories from Firestore — used to resolve non-built-in category IDs (KAN-61). */
  customCategories?: Category[];
  /** True when this task's POI is far from here (KAN-279) — shows a quiet
   *  nav-arrow indicator so the user knows "Take me there" is available. */
  isFar?: boolean;
}

/** Fallback for tasks whose category ID doesn't match any known category. */
const FALLBACK_CAT = { color: fallbackCategoryColor, label: 'Other' };

/** DEBUG — strip the react-native-svg pieces (BrushStroke overlay + brush-away
 *  sweep gradient) to test whether SVG-per-row is what locks the Today screen. */
const DEBUG_TASKROW_LIGHT = false;

function TaskRow({ task, nearbyPoiType = null, onToggle, onPress, customCategories = [], isFar = false }: TaskRowProps) {
  const { palette, language } = useTheme();
  const builtIn = categories[task.category as keyof typeof categories];
  const custom  = customCategories.find(c => c.id === task.category);
  const cat     = builtIn
    ? { color: builtIn.color, label: builtIn.label }
    : custom
    ? { color: custom.color,  label: custom.name }
    : FALLBACK_CAT;
  const subtypeLabel = task.poi === 'store' && task.storeSubtype && task.storeSubtype !== 'any'
    ? storeSubtypeDisplayLabel(task.storeSubtype, language)
    : task.poi === 'restaurant' && task.restaurantFoodType
      ? restaurantFoodTypeDisplayLabel(task.restaurantFoodType, language)
      : null;
  const bodyAccessibilityLabel = `${onPress ? COPY.taskRow.editA11y(task.title) : task.title}${subtypeLabel ? `, ${subtypeLabel}` : ''}`;

  // ── Checkbox fill animation ──
  const fillProgress = useSharedValue(task.done ? 1 : 0);
  useEffect(() => {
    fillProgress.value = withTiming(task.done ? 1 : 0, { duration: 200 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.done]);

  // ── Brushstroke animation (KAN-109) ──
  // titleDisplayWidth is regular React state so BrushStroke re-renders with the
  // correct SVG width after onLayout fires.
  // titleWidth is the same value as a shared value so the animated-style worklet
  // (which runs on the UI thread) can read it without JS ↔ UI thread crossing.
  const [titleDisplayWidth, setTitleDisplayWidth] = useState(0);
  const titleWidth  = useSharedValue(0);
  const strokeScale = useSharedValue(task.done ? 1 : 0);

  useEffect(() => {
    if (task.done) {
      strokeScale.value = withTiming(1, {
        duration: 380,
        easing:   Easing.bezier(0.25, 0.1, 0.25, 1),
      });
    } else {
      // Snap back instantly when un-completing a task
      strokeScale.value = 0;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.done]);

  // Simulates transformOrigin: 'left center' by compensating for RN's
  // centre-based scaleX with a matching translateX.
  //
  // Android note: scaleX: 0 at mount zeroes the GPU layer and can prevent
  // repaints during animation. Pairing with opacity: s avoids this — the
  // layer is invisible either way, but opacity keeps it repaint-eligible.
  const animatedStrokeStyle = useAnimatedStyle(() => {
    const s = strokeScale.value;
    const w = titleWidth.value;
    return {
      opacity: s,
      transform: [
        { translateX: -(w / 2) * (1 - s) },
        { scaleX: s },
      ],
    };
  });

  const fillStyle = useAnimatedStyle(() => ({
    opacity: fillProgress.value,
    transform: [{ scale: 0.55 + fillProgress.value * 0.1 }],
  }));

  // ── Brush-away wash animation (KAN-134) ──────────────────────────────────────
  // Fires only on false → true transition. Skipped if reduce-motion is on.
  const sweepProgress = useSharedValue(0);
  const rowWidth      = useSharedValue(0);
  const [sweeping, setSweeping] = useState(false);
  const prevDoneRef   = useRef(task.done);

  useEffect(() => {
    if (task.done && !prevDoneRef.current) {
      AccessibilityInfo.isReduceMotionEnabled()
        .then(reduced => {
          if (reduced) { return; }
          setSweeping(true);
          sweepProgress.value = 0;
          sweepProgress.value = withTiming(1, {
            duration: 660,
            easing: Easing.bezier(0.4, 0, 0.2, 1),
          }, (finished) => {
            if (finished) { runOnJS(setSweeping)(false); }
          });
        })
        .catch(() => {
          // If the accessibility API is unavailable, run the animation anyway.
          setSweeping(true);
          sweepProgress.value = 0;
          sweepProgress.value = withTiming(1, {
            duration: 660,
            easing: Easing.bezier(0.4, 0, 0.2, 1),
          }, (finished) => {
            if (finished) { runOnJS(setSweeping)(false); }
          });
        });
    }
    prevDoneRef.current = task.done;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.done]);

  // scaleX anchored to left edge via translateX compensation.
  const sweepStyle = useAnimatedStyle(() => {
    const p     = sweepProgress.value;
    const scale = interpolate(p, [0, 0.58, 1], [0, 1, 1]);
    const w     = rowWidth.value;
    return {
      opacity:   interpolate(p, [0, 0.01, 0.58, 1], [0, 0.9, 0.9, 0]),
      transform: [
        { translateX: -(w / 2) * (1 - scale) },
        { scaleX: scale },
      ],
    };
  });

  if (DEBUG_TASKROW_LIGHT) {
    // Fully static interactive row — Pressables wired, ZERO reanimated / onLayout.
    return (
      <View style={[styles.row, { borderBottomColor: palette.line }]}>
        <Pressable onPress={() => {
          if (!task.done) { logTap('task_complete', { category: task.category }); }
          onToggle(task.id, !task.done);
        }} hitSlop={8}
          accessibilityRole="checkbox" accessibilityState={{ checked: task.done }}>
          <View style={[styles.checkbox, { borderColor: task.done ? palette.faint : palette.text }]}>
            <Animated.View style={[styles.checkboxFill, { backgroundColor: palette.faint }, fillStyle]} />
          </View>
        </Pressable>
        <Pressable style={styles.body} onPress={onPress ? () => onPress(task) : undefined}>
          <View style={styles.content}>
            <Text style={[styles.title, { color: task.done ? palette.muted : palette.text }]} numberOfLines={2}>
              {task.title}
            </Text>
            <View style={styles.chips}>
              <View style={[styles.catChip, { backgroundColor: cat.color + '1a', borderColor: cat.color + '40' }]}>
                <Text style={[styles.catLabel, { color: cat.color }]}>{cat.label}</Text>
              </View>
              {task.poi && (
                <PoiChip poi={task.poi} isNearby={task.poi === nearbyPoiType} />
              )}
              {task.kind === 'birthday' && (
                <View
                  testID="birthday-cake-icon"
                  accessible
                  accessibilityLabel={COPY.taskFormScreen.birthdayToggleLabel}>
                  <CakeIcon color={cat.color} size={14} />
                </View>
              )}
            </View>
          </View>
          {(task.time || task.pendingSync || isFar) ? (
            <View style={styles.trailing}>
              {task.time ? <Text style={[styles.time, { color: palette.muted }]}>{task.time}</Text> : null}
              {isFar && task.poi ? (
                <Pressable
                  onPress={() => { openTakeMeThereMaps(task.poi!).catch(() => {}); }}
                  hitSlop={16}
                  style={styles.farAwayIcon}
                  accessibilityRole="button"
                  accessibilityLabel={getTakeMeThereA11yLabel(task.poi)}>
                  <NavigateIcon color={palette.muted} size={13} />
                </Pressable>
              ) : null}
              {task.pendingSync ? (
                <View
                  style={[styles.syncDot, { backgroundColor: palette.faint }]}
                  accessibilityLabel={COPY.taskRow.syncingA11y}
                  accessibilityRole="none"
                />
              ) : null}
            </View>
          ) : null}
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={[styles.row, { borderBottomColor: palette.line }]}
      onLayout={e => { rowWidth.value = e.nativeEvent.layout.width; }}>

      {/* ── Checkbox — toggles done ── */}
      <Pressable
        onPress={() => {
          if (!task.done) { logTap('task_complete', { category: task.category }); }
          onToggle(task.id, !task.done);
        }}
        hitSlop={8}
        accessibilityRole="checkbox"
        accessibilityLabel={task.done ? COPY.taskRow.unbrush(task.title) : COPY.taskRow.brushAway(task.title)}
        accessibilityState={{ checked: task.done }}
        style={({ pressed }) => [{ opacity: pressed ? 0.6 : 1 }]}>
        <View style={[styles.checkbox, { borderColor: task.done ? palette.faint : palette.text }]}>
          <Animated.View
            style={[styles.checkboxFill, { backgroundColor: palette.faint }, fillStyle]}
          />
        </View>
      </Pressable>

      {/* ── Body: title + chips + time — opens edit form ── */}
      <Pressable
        style={({ pressed }) => [styles.body, { opacity: pressed && onPress ? 0.65 : 1 }]}
        onPress={onPress ? () => onPress(task) : undefined}
        accessibilityRole={onPress ? 'button' : 'text'}
        accessibilityLabel={bodyAccessibilityLabel}>

        <View style={styles.content}>
          {/* Title + brushstroke overlay */}
          <View style={styles.titleWrapper}>
            <Text
              style={[styles.title, { color: task.done ? palette.muted : palette.text }]}
              numberOfLines={2}
              onLayout={(e) => {
                const w = e.nativeEvent.layout.width;
                titleWidth.value = w;
                setTitleDisplayWidth(w);
              }}>
              {task.title}
            </Text>
            {/* Animated brushstroke — replaces text-decoration: line-through.
                Only mounted when task.done so un-completing causes an instant
                unmount (no fade-out animation needed per spec). */}
            {task.done && !DEBUG_TASKROW_LIGHT && (
              <Animated.View
                pointerEvents="none"
                style={[styles.strokeOverlay, animatedStrokeStyle]}>
                <BrushStroke width={titleDisplayWidth} color={palette.accent} />
              </Animated.View>
            )}
          </View>

          <View style={styles.chips}>
            {/* Category chip */}
            <View
              style={[
                styles.catChip,
                {
                  backgroundColor: cat.color + '1a',
                  borderColor:     cat.color + '40',
                },
              ]}>
              <Text style={[styles.catLabel, { color: cat.color }]}>
                {cat.label}
              </Text>
            </View>

            {/* POI chip */}
            {task.poi && !DEBUG_TASKROW_LIGHT && (
              <PoiChip
                poi={task.poi}
                isNearby={task.poi === nearbyPoiType}
              />
            )}

            {task.poi === 'store' && task.storeSubtype && task.storeSubtype !== 'any' && (
              <View style={[styles.catChip, { backgroundColor: palette.surface2, borderColor: palette.line }]}>
                <Text style={[styles.catLabel, { color: palette.muted }]}>{storeSubtypeDisplayLabel(task.storeSubtype, language)}</Text>
              </View>
            )}
            {task.poi === 'restaurant' && task.restaurantFoodType && (
              <View style={[styles.catChip, { backgroundColor: palette.surface2, borderColor: palette.line }]}>
                <Text style={[styles.catLabel, { color: palette.muted }]}>{restaurantFoodTypeDisplayLabel(task.restaurantFoodType, language)}</Text>
              </View>
            )}

            {/* Birthday glyph (KAN-248) — quiet, no chip background, just the icon */}
            {task.kind === 'birthday' && (
              <View
                testID="birthday-cake-icon"
                accessible
                accessibilityLabel={COPY.taskFormScreen.birthdayToggleLabel}>
                <CakeIcon color={cat.color} size={14} />
              </View>
            )}

          </View>
        </View>

        {/* Trailing: scheduled time + far-away indicator + pending-sync dot */}
        {(task.time || task.pendingSync || isFar) ? (
          <View style={styles.trailing}>
            {task.time ? (
              <Text style={[styles.time, { color: palette.muted }]}>
                {task.time}
              </Text>
            ) : null}
            {isFar && task.poi ? (
              <Pressable
                onPress={() => { openTakeMeThereMaps(task.poi!).catch(() => {}); }}
                hitSlop={16}
                style={styles.farAwayIcon}
                accessibilityRole="button"
                accessibilityLabel={getTakeMeThereA11yLabel(task.poi)}>
                <NavigateIcon color={palette.muted} size={13} />
              </Pressable>
            ) : null}
            {task.pendingSync ? (
              <View
                style={[styles.syncDot, { backgroundColor: palette.faint }]}
                accessibilityLabel={COPY.taskRow.syncingA11y}
                accessibilityRole="none"
              />
            ) : null}
          </View>
        ) : null}
      </Pressable>

      {/* Brush-away wash — peach gradient sweep L→R on task completion (KAN-134) */}
      {sweeping && !DEBUG_TASKROW_LIGHT && (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { zIndex: 3 }, sweepStyle]}>
          <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none">
            <Defs>
              <SvgLinearGradient id={`brushSweep_${task.id}`} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0"   stopColor={palette.nearTint}  stopOpacity="1" />
                <Stop offset="0.6" stopColor={palette.nearTint2} stopOpacity="1" />
                <Stop offset="1"   stopColor={palette.accent}    stopOpacity="1" />
              </SvgLinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100%" height="100%" fill={`url(#brushSweep_${task.id})`} />
          </Svg>
        </Animated.View>
      )}
    </View>
  );
}

// Memoized: the Today list re-renders whenever proximity data (poiPlaces /
// nearbyPoiType) changes. Without memo, every row rebuilt its ~5 shared values
// and SVG on each of those updates (KAN-156 render storm). With stable props
// from TodayScreen, rows now only re-render when their own data changes.
export default React.memo(TaskRow);

const styles = StyleSheet.create({
  row: {
    flexDirection:  'row',
    alignItems:     'center',
    paddingVertical: 14,
    gap:            12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  checkbox: {
    width:          22,
    height:         22,
    borderRadius:   11,
    borderWidth:    1.5,
    alignItems:     'center',
    justifyContent: 'center',
  },
  checkboxFill: {
    width:        22,
    height:       22,
    borderRadius: 11,
  },
  body: {
    flex:          1,
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
  },
  content: {
    flex: 1,
    gap:  6,
  },
  titleWrapper: {
    position:  'relative',
    alignSelf: 'flex-start',
  },
  strokeOverlay: {
    position: 'absolute',
    top:      0,
    left:     0,
    right:    0,
    // No overflow: 'hidden' — on Android it clips incorrectly when combined
    // with scaleX/translateX transforms.
  },
  title: {
    fontSize:   15,
    fontFamily: 'Geist-Regular',
    lineHeight: 20,
  },
  chips: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    alignItems:    'center',
    gap:           6,
  },
  catChip: {
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      9999,
    borderWidth:       StyleSheet.hairlineWidth,
  },
  catLabel: {
    fontSize:   11,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },
  time: {
    fontSize:    12,
    fontFamily:  'Geist-Regular',
    fontVariant: ['tabular-nums'],
    alignSelf:   'flex-start',
    paddingTop:  1,
  },
  trailing: {
    alignItems: 'flex-end',
    gap:        4,
  },
  syncDot: {
    width:        5,
    height:       5,
    borderRadius: 9999,
    alignSelf:    'flex-end',
  },
  farAwayIcon: {
    marginRight: 4,
  },
});
