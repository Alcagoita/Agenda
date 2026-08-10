/**
 * OnboardingScreen — KAN-140
 *
 * 5-stage guided first-run experience:
 *   Stage 1 (welcome)  — wordmark + tagline + "Let's begin"
 *   Stage 2 (empty)    — rotating nudges + "Add your first thing"
 *   Stage 3 (create)   — bottom sheet to capture first task
 *   Stage 4 (post)     — brush-away the task, earn Day 1 reward (+10 pts)
 *   Stage 5 (full)     — transition to the real app (AppNavigator)
 *
 * Light-mode only. All tokens are hardcoded to the light palette per spec.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScrRotatingNudge, { NudgeMessage } from '../components/ScrRotatingNudge';
import BrushStroke from '../components/BrushStroke';
import { addTask, ONBOARDING_BONUS_POINTS, upsertUser } from '../services/firestore';
import { awardOnboardingBonus } from '../services/rewardFunctions';
import { PoiIcon } from '../components/AppIcon';
import PoiChip from '../components/PoiChip';
import { categories, lightPalette, onboardingScrim } from '../theme/tokens';
import type { PoiType, Category } from '../types';
import { useTheme } from '../theme';
import { COPY } from '../constants/copy';

// ─── Design tokens (light-mode only per spec) ─────────────────────────────────
//
// Onboarding always renders the light palette regardless of device theme —
// referencing lightPalette directly (not useTheme()) keeps that intentional
// and avoids re-typing values that could drift from tokens.ts.

const T = lightPalette;

function chipFgColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.35 ? T.text : T.onAccent;
}

// ─── Onboarding message set (KAN-140 — 6 messages) ───────────────────────────
//
// Text is pulled live from COPY inside the component (buildOnboardingNudges /
// buildSuggestionChips below) instead of baked into a module-scope constant —
// COPY is language-dynamic (KAN-252) and a module-scope read would freeze
// this text in whatever language was active on first import.

type OnboardingNudgeId = 'bread' | 'coffeeOutside' | 'postOffice' | 'sportOutside' | 'pendingErrand' | 'fridgeReplacement';

const ONBOARDING_NUDGE_ORDER: OnboardingNudgeId[] = [
  'bread',
  'coffeeOutside',
  'postOffice',
  'sportOutside',
  'pendingErrand',
  'fridgeReplacement',
];

const NUDGE_META: Record<OnboardingNudgeId, { poi?: PoiType; color?: string }> = {
  bread:              { poi: 'supermarket', color: categories.errands.color },
  coffeeOutside:      { poi: 'cafe',        color: categories.personal.color },
  postOffice:         {},
  sportOutside:       {},
  pendingErrand:      {},
  fridgeReplacement:  { poi: 'supermarket', color: categories.errands.color },
};

function buildOnboardingNudges(): NudgeMessage[] {
  const texts = COPY.onboarding.nudgeTexts as Record<OnboardingNudgeId, string>;

  if (__DEV__) {
    const textCount = Object.keys(texts).length;
    if (textCount !== ONBOARDING_NUDGE_ORDER.length) {
      throw new Error(
        `[OnboardingScreen] nudgeTexts count (${textCount}) does not match meta count (${ONBOARDING_NUDGE_ORDER.length}).`,
      );
    }
  }

  return ONBOARDING_NUDGE_ORDER.map(id => ({
    text: texts[id],
    ...NUDGE_META[id],
  }));
}

interface SuggestionChip { label: string; poi: PoiType; category: Category; }

function buildSuggestionChips(): SuggestionChip[] {
  return [
    { label: COPY.onboarding.chipBuyBread,      poi: 'store',       category: 'errands'  },
    { label: COPY.onboarding.chipCoffeeOutside, poi: 'cafe',        category: 'personal' },
    { label: COPY.onboarding.chipGoForRun,      poi: 'park',        category: 'health'   },
    { label: COPY.onboarding.chipWithdrawCash,  poi: 'atm',         category: 'personal' },
    { label: COPY.onboarding.chipGroceries,     poi: 'supermarket', category: 'errands'  },
  ];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** "brus" + custom SVG "h" glyph + amber dot — matches the LoginScreen logo lockup. */
function BrushLogo({ size = 66 }: { size?: number }) {
  const sw     = size * 0.153;
  const dotSz  = Math.max(size * 0.113, 4);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
      <Text style={{
        fontFamily:         'Geist-SemiBold',
        fontSize:           size,
        fontWeight:         '600',
        color:              T.text,
        letterSpacing:      size * -0.06,
        lineHeight:         size * 1.1,
        includeFontPadding: false,
      }}>
        brus
      </Text>
      {/* Custom "h" glyph — same path as LoginScreen's CustomH */}
      <Svg
        width={size * 0.72}
        height={size}
        viewBox="0 0 72 100"
        style={{ overflow: 'visible', marginLeft: -(size * 0.085) }}>
        <Path
          d="M 9 6 L 9 76"
          stroke={T.text} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none"
        />
        <Path
          d="M 9 40 C 9 30 18 24 30 24 C 42 24 49 31 49 42 L 49 68 C 49 74.5 53.5 77 60 74 C 64 72 66.5 68.5 68 64"
          stroke={T.text} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none"
        />
      </Svg>
      {/* Amber dot */}
      <View
        style={{
          position:      'absolute',
          right:         -(size * 0.05),
          top:           size * 0.28,
          width:         dotSz,
          height:        dotSz,
          borderRadius:  dotSz / 2,
          backgroundColor: T.accent,
        }}
        pointerEvents="none"
      />
    </View>
  );
}

/** Amber flame icon for the reward card. */
function FlameIcon({ size = 24 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 2C12 2 8 7 8 11C8 13.21 9.79 15 12 15C14.21 15 16 13.21 16 11C16 7 12 2 12 2ZM12 13C10.9 13 10 12.1 10 11C10 9.17 11.23 7.14 12 5.84C12.77 7.14 14 9.17 14 11C14 12.1 13.1 13 12 13ZM5 19C5 16.24 7.35 14 10.27 14H13.73C16.65 14 19 16.24 19 19V22H5V19Z"
        fill={T.accent}
      />
    </Svg>
  );
}

/** Down-arrow bobbing hint. */
function BobbingArrow({ visible, reduceMotion }: { visible: boolean; reduceMotion: boolean }) {
  const bobY = useSharedValue(0);

  useEffect(() => {
    if (!visible || reduceMotion) { bobY.value = 0; return; }
    bobY.value = withRepeat(
      withSequence(
        withTiming( 4, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        withTiming(-4, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
  }, [visible, reduceMotion, bobY]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: reduceMotion ? 0 : bobY.value }],
  }));

  if (!visible) { return null; }

  return (
    <Animated.View style={[{ alignItems: 'center', marginTop: 12 }, style]}>
      <Svg width={20} height={20} viewBox="0 0 24 24">
        <Path d="M7 10L12 15L17 10H7Z" fill={T.muted} />
      </Svg>
    </Animated.View>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

interface Props {
  uid: string;
  onComplete: () => void;
}

type Stage = 'welcome' | 'empty' | 'create' | 'post' | 'full';

export default function OnboardingScreen({ uid, onComplete }: Props) {
  const insets = useSafeAreaInsets();
  const { language } = useTheme();
  const dateLocale = language === 'pt-PT' ? 'pt-PT' : 'en-US';
  const onboardingNudges = buildOnboardingNudges();
  const suggestionChips = buildSuggestionChips();
  const [stage, setStage]             = useState<Stage>('welcome');
  const [taskTitle, setTaskTitle]     = useState('');
  const [taskDone, setTaskDone]       = useState(false);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [titleWidth, setTitleWidth]   = useState(0);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [rewardVisible, setRewardVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  // ── Stage 1 entrance ───────────────────────────────────────────────────────
  const welcomeY   = useSharedValue(13);
  const welcomeOp  = useSharedValue(0);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => setReduceMotion(v))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (stage === 'welcome') {
      welcomeOp.value = withTiming(1, { duration: 500 });
      welcomeY.value  = withTiming(0, { duration: 500, easing: Easing.out(Easing.cubic) });
    }
  }, [stage, welcomeOp, welcomeY]);

  const welcomeStyle = useAnimatedStyle(() => ({
    opacity:   welcomeOp.value,
    transform: [{ translateY: reduceMotion ? 0 : welcomeY.value }],
  }));

  // ── Sheet slide ────────────────────────────────────────────────────────────
  const sheetY  = useSharedValue(800);
  const scrimOp = useSharedValue(0);

  const openSheet = useCallback(() => {
    setSheetVisible(true);
    scrimOp.value = withTiming(1, { duration: 250 });
    sheetY.value  = withTiming(0, {
      duration: 340,
      easing: Easing.bezier(0.32, 0.72, 0, 1),
    });
  }, [scrimOp, sheetY]);

  const closeSheet = useCallback(() => {
    Keyboard.dismiss();
    scrimOp.value = withTiming(0, { duration: 200 });
    sheetY.value  = withTiming(800, { duration: 280 }, () => {
      runOnJS(setSheetVisible)(false);
    });
  }, [scrimOp, sheetY]);

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sheetY.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOp.value }));

  // ── Brush-away sweep & stroke ──────────────────────────────────────────────
  const sweepProgress  = useSharedValue(0);
  const strokeScale    = useSharedValue(0);
  const fillProgress   = useSharedValue(0);
  const rowWidth       = useSharedValue(0);

  const sweepStyle = useAnimatedStyle(() => {
    const p     = sweepProgress.value;
    const scale = interpolate(p, [0, 0.58, 1], [0, 1, 1]);
    const w     = rowWidth.value;
    return {
      opacity:   interpolate(p, [0, 0.01, 0.58, 1], [0, 0.9, 0.9, 0]),
      transform: [{ translateX: -(w / 2) * (1 - scale) }, { scaleX: scale }],
    };
  });

  const strokeStyle = useAnimatedStyle(() => {
    const s = strokeScale.value;
    const w = titleWidth;
    return {
      opacity:   s,
      transform: [{ translateX: -(w / 2) * (1 - s) }, { scaleX: s }],
    };
  });

  const fillStyle = useAnimatedStyle(() => ({
    opacity:   fillProgress.value,
    transform: [{ scale: 0.55 + fillProgress.value * 0.1 }],
  }));

  // ── Reward card slide-up ───────────────────────────────────────────────────
  const rewardY  = useSharedValue(200);
  const rewardOp = useSharedValue(0);
  const flameS   = useSharedValue(0);

  const showReward = useCallback(() => {
    setRewardVisible(true);
    rewardOp.value = withTiming(1, { duration: 300 });
    rewardY.value  = withSpring(0, { damping: 18, stiffness: 120 });
    flameS.value   = withDelay(150, withSpring(1, { damping: 10, stiffness: 150 }));
  }, [rewardOp, rewardY, flameS]);

  const rewardCardStyle = useAnimatedStyle(() => ({
    opacity:   rewardOp.value,
    transform: [{ translateY: rewardY.value }],
  }));
  const flameStyle = useAnimatedStyle(() => ({ transform: [{ scale: flameS.value }] }));

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleAddTask = useCallback(async () => {
    if (!taskTitle.trim()) { return; }
    Keyboard.dismiss();
    closeSheet();

    try {
      const chip = suggestionChips.find(c => c.label === taskTitle.trim());

      const id = await addTask(uid, {
        title:    taskTitle.trim(),
        category: chip?.category ?? 'errands',
        poi:      chip?.poi ?? 'supermarket',
      });

      setCreatedTaskId(id);
    } catch {
      // Non-critical — onboarding proceeds even if Firestore write fails
    }

    setTimeout(() => setStage('post'), 350);
  }, [taskTitle, uid, closeSheet, suggestionChips]);

  const completeOnboardingTask = useCallback(() => {
    if (createdTaskId) {
      awardOnboardingBonus(createdTaskId).catch(() => {});
    }
  }, [createdTaskId]);

  const handleBrushAway = useCallback(() => {
    if (taskDone) { return; }

    if (reduceMotion) {
      setTaskDone(true);
      completeOnboardingTask();
      setTimeout(showReward, 200);
      return;
    }

    sweepProgress.value = 0;
    sweepProgress.value = withTiming(1, {
      duration: 660,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
    });

    setTimeout(() => {
      setTaskDone(true);
      fillProgress.value = withTiming(1, { duration: 200 });
      strokeScale.value  = withTiming(1, { duration: 380, easing: Easing.bezier(0.25, 0.1, 0.25, 1) });
    }, 120);

    setTimeout(() => {
      completeOnboardingTask();
      showReward();
    }, 640);
  }, [taskDone, reduceMotion, sweepProgress, fillProgress, strokeScale, showReward, completeOnboardingTask]);

  const handleComplete = useCallback(async () => {
    try {
      await upsertUser(uid, { onboardingDone: true });
    } catch {
      // Non-critical
    }
    onComplete();
  }, [uid, onComplete]);

  // ── Render helpers ─────────────────────────────────────────────────────────

  function renderStage1() {
    return (
      <View style={[styles.fill, { backgroundColor: T.bg, paddingTop: insets.top }]}>
        <View style={styles.centerContent}>
          <Animated.View style={[{ alignItems: 'center' }, welcomeStyle]}>
            <BrushLogo size={66} />
            <Text style={styles.eyebrow}>{COPY.onboarding.eyebrow}</Text>
            <Text style={styles.tagline}>
              {COPY.onboarding.welcomeTagline}
            </Text>
          </Animated.View>
        </View>

        <View style={[styles.bottomPad, { paddingBottom: insets.bottom + 24 }]}>
          <Pressable
            style={styles.inkBtn}
            onPress={() => setStage('empty')}
            accessibilityRole="button"
            accessibilityLabel={COPY.onboarding.letsBegin}>
            <Text style={styles.inkBtnText}>{COPY.onboarding.letsBegin}</Text>
          </Pressable>
          <Text style={styles.reassurance}>{COPY.onboarding.reassurance}</Text>
        </View>
      </View>
    );
  }

  function renderStage2() {
    return (
      <View style={[styles.fill, { backgroundColor: T.bg, paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.stage2Header}>
          <BrushLogo size={23} />
          <Text style={[styles.dateText, { fontVariant: ['tabular-nums'] }]}>
            {new Date().toLocaleDateString(dateLocale, { weekday: 'short', month: 'short', day: 'numeric' })}
          </Text>
        </View>

        {/* Rotating nudge */}
        <View style={styles.nudgeArea}>
          <ScrRotatingNudge messages={onboardingNudges} pace={5} showCategoryIcon />
        </View>

        {/* CTA */}
        <View style={[styles.bottomPad, { paddingBottom: insets.bottom + 24 }]}>
          <Pressable
            style={styles.accentBtn}
            onPress={openSheet}
            accessibilityRole="button"
            accessibilityLabel={COPY.onboarding.addFirstThingA11y}>
            <Text style={styles.accentBtnText}>{COPY.onboarding.addFirstThing}</Text>
          </Pressable>
          <Text style={styles.helperText}>
            {COPY.onboarding.emptyHelper}
          </Text>
        </View>

        {/* Bottom sheet + scrim */}
        {sheetVisible && (
          <>
            <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
              <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
            </Animated.View>
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
              <Animated.View
                style={[styles.sheet, { paddingBottom: insets.bottom + 16 }, sheetStyle]}>
                {/* Handle */}
                <View style={styles.sheetHandle} />

                <Text style={styles.sheetEyebrow}>{COPY.onboarding.sheetEyebrow}</Text>

                {/* Chip-only selection — no free text */}
                <FlatList
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.chipScroll}
                  contentContainerStyle={styles.chipRow}
                  data={suggestionChips}
                  keyExtractor={chip => chip.label}
                  renderItem={({ item: chip }) => {
                    const selected = taskTitle === chip.label;
                    const catColor = categories[chip.category as keyof typeof categories]?.color ?? T.muted;
                    const selectedFg = chipFgColor(catColor);
                    return (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected }}
                        style={({ pressed }) => [
                          styles.chip,
                          {
                            backgroundColor: selected ? catColor : catColor + '18',
                            borderColor:     selected ? catColor : catColor + '50',
                          },
                          { transform: [{ scale: pressed ? 0.97 : 1 }] },
                        ]}
                        onPress={() => setTaskTitle(prev => prev === chip.label ? '' : chip.label)}>
                        <PoiIcon
                          type={chip.poi}
                          color={selected ? selectedFg : catColor}
                          size={16}
                        />
                        <Text style={[styles.chipText, { color: selected ? selectedFg : catColor }]}>
                          {chip.label}
                        </Text>
                      </Pressable>
                    );
                  }}
                />

                {/* Footer */}
                <View style={styles.sheetFooter}>
                  <Text style={styles.sheetHelper}>
                    {COPY.onboarding.sheetHelper}
                  </Text>
                  <Pressable
                    style={[styles.addBtn, !taskTitle.trim() && styles.addBtnDisabled]}
                    onPress={handleAddTask}
                    disabled={!taskTitle.trim()}
                    accessibilityRole="button"
                    accessibilityLabel={COPY.onboarding.addTaskA11y}>
                    <Text style={[styles.addBtnText, !taskTitle.trim() && styles.addBtnTextDisabled]}>
                      {COPY.onboarding.addItButton}
                    </Text>
                  </Pressable>
                </View>
              </Animated.View>
            </View>
          </>
        )}
      </View>
    );
  }

  function renderStage4() {
    return (
      <View style={[styles.fill, { backgroundColor: T.bg, paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.stage4Header}>
          <View>
            <Text style={styles.greeting}>{COPY.onboarding.greeting}</Text>
            <Text style={[styles.dateHeading, { fontVariant: ['tabular-nums'] }]}>
              {new Date().toLocaleDateString(dateLocale, { weekday: 'long', month: 'long', day: 'numeric' })}
            </Text>
          </View>
          <BrushLogo size={23} />
        </View>

        {/* Section label */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionLabel}>{COPY.onboarding.todayLabel}</Text>
          <Text style={styles.sectionCount}>
            {taskDone ? COPY.onboarding.doneCountDone : COPY.onboarding.doneCountPending}
          </Text>
        </View>

        {/* Task row */}
        <View
          style={[styles.taskRow, { borderTopColor: T.line, borderBottomColor: T.line }]}
          onLayout={e => { rowWidth.value = e.nativeEvent.layout.width; }}>

          {/* Brush-away wash overlay */}
          <Animated.View
            style={[StyleSheet.absoluteFill, styles.washOverlay, sweepStyle]}
            pointerEvents="none"
          />

          <Pressable
            onPress={handleBrushAway}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: taskDone }}
            style={styles.checkboxTouchTarget}>
            <View style={[styles.checkbox, { borderColor: taskDone ? T.faint : T.text }]}>
              <Animated.View style={[styles.checkboxFill, fillStyle]} />
            </View>
          </Pressable>

          <View style={styles.taskBody}>
            <View
              style={styles.titleWrapper}
              onLayout={e => setTitleWidth(e.nativeEvent.layout.width)}>
              <Text style={[styles.taskTitle, { color: taskDone ? T.muted : T.text }]}>
                {taskTitle || COPY.onboarding.defaultTaskTitle}
              </Text>
              {titleWidth > 0 && (
                <Animated.View style={[StyleSheet.absoluteFill, strokeStyle]} pointerEvents="none">
                  <BrushStroke width={titleWidth} color={T.accent} />
                </Animated.View>
              )}
            </View>
            {(() => {
              const chip = suggestionChips.find(c => c.label === taskTitle);
              const cat  = categories[chip?.category as keyof typeof categories] ?? categories.errands;
              return (
                <View style={styles.chips}>
                  <View style={[styles.catChip, { backgroundColor: cat.color + '1a', borderColor: cat.color + '40' }]}>
                    <Text style={[styles.catLabel, { color: cat.color }]}>{cat.label}</Text>
                  </View>
                  {chip?.poi && <PoiChip poi={chip.poi} />}
                </View>
              );
            })()}
          </View>
        </View>

        {/* Bobbing hint */}
        {!taskDone && (
          <View style={styles.hintRow}>
            <BobbingArrow visible reduceMotion={reduceMotion} />
            <Text style={styles.hintText}>
              {COPY.onboarding.hintPrefix}<Text style={{ color: T.text, fontFamily: 'Geist-Medium' }}>{COPY.onboarding.hintBold}</Text>
            </Text>
          </View>
        )}

        {/* Reward card — flame row + CTA inside one card */}
        {rewardVisible && (
          <Animated.View
            style={[styles.rewardCard, { bottom: insets.bottom + 22 }, rewardCardStyle]}>
            {/* Soft bleed circle */}
            <View style={styles.rewardBleed} />

            {/* Top row: flame | text | +10 */}
            <View style={styles.rewardRow}>
              <Animated.View style={[styles.flameBox, flameStyle]}>
                <FlameIcon size={24} />
              </Animated.View>

              <View style={styles.rewardBody}>
                <Text style={styles.rewardHeadline}>{COPY.onboarding.rewardHeadline}</Text>
                <Text style={styles.rewardCaption}>
                  {COPY.onboarding.rewardCaption}
                </Text>
              </View>

              <View style={styles.pointsPill}>
                <Text style={[styles.pointsText, { fontVariant: ['tabular-nums'] }]}>{`+${ONBOARDING_BONUS_POINTS}`}</Text>
              </View>
            </View>

            {/* CTA button */}
            <Pressable
              style={[styles.inkBtn, { marginTop: 14 }]}
              onPress={handleComplete}
              accessibilityRole="button"
              accessibilityLabel={COPY.onboarding.seeFullDay}>
              <Text style={styles.inkBtnText}>{COPY.onboarding.seeFullDay}</Text>
            </Pressable>
          </Animated.View>
        )}
      </View>
    );
  }

  // ── Top-level render ───────────────────────────────────────────────────────

  if (stage === 'welcome') { return renderStage1(); }
  if (stage === 'empty' || stage === 'create') { return renderStage2(); }
  if (stage === 'post') { return renderStage4(); }

  // Stage 'full' — hand off to parent which will unmount this screen
  return null;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  fill:          { flex: 1 },
  centerContent: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  bottomPad:     { paddingHorizontal: 22 },

  eyebrow: {
    fontFamily:   'Geist-Medium',
    fontSize:     12.5,
    letterSpacing: 0.3 * 12.5,
    color:        T.muted,
    marginTop:    14,
    marginBottom: 18,
  },
  tagline: {
    fontFamily: 'Geist-Regular',
    fontSize:   17,
    color:      T.muted,
    maxWidth:   280,
    textAlign:  'center',
    marginTop:  18,
    lineHeight: 26,
  },
  reassurance: {
    fontFamily: 'Geist-Regular',
    fontSize:   13,
    color:      T.muted,
    textAlign:  'center',
    marginTop:  14,
  },

  inkBtn: {
    backgroundColor: T.text,
    borderRadius:    16,
    height:          54,
    alignItems:      'center',
    justifyContent:  'center',
  },
  inkBtnText: {
    fontFamily: 'Geist-SemiBold',
    fontSize:   16,
    color:      T.bg,
  },

  accentBtn: {
    backgroundColor: T.accent,
    borderRadius:    16,
    height:          54,
    alignItems:      'center',
    justifyContent:  'center',
  },
  accentBtnText: {
    fontFamily: 'Geist-SemiBold',
    fontSize:   16,
    color:      T.text,
  },
  helperText: {
    fontFamily: 'Geist-Regular',
    fontSize:   12.5,
    color:      T.faint,
    textAlign:  'center',
    marginTop:  12,
  },

  // Stage 2
  stage2Header: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
    paddingHorizontal: 22,
    paddingTop:     12,
    paddingBottom:  8,
  },
  dateText: {
    fontFamily: 'Geist-Regular',
    fontSize:   13,
    color:      T.muted,
  },
  nudgeArea: {
    flex: 1,
    justifyContent: 'center',
  },

  // Bottom sheet
  scrim: {
    backgroundColor: onboardingScrim,
    zIndex: 10,
  },
  sheet: {
    position:        'absolute',
    bottom:          0,
    left:            0,
    right:           0,
    backgroundColor: T.bg,
    borderTopLeftRadius:  26,
    borderTopRightRadius: 26,
    paddingHorizontal: 22,
    paddingTop:      14,
    zIndex:          20,
  },
  sheetHandle: {
    width:           38,
    height:          4,
    borderRadius:    2,
    backgroundColor: T.faint,
    alignSelf:       'center',
    marginBottom:    18,
  },
  sheetEyebrow: {
    fontFamily:    'Geist-Medium',
    fontSize:      22,
    color:         T.text,
    letterSpacing: 22 * -0.02,
    marginBottom:  18,
  },
  sheetInput: {
    fontFamily:    'Geist-Medium',
    fontSize:      24,
    color:         T.text,
    letterSpacing: 24 * -0.02,
    borderBottomWidth: 1.5,
    borderBottomColor: T.surface2,
    paddingVertical:   10,
    backgroundColor:   'transparent',
    marginBottom:      18,
  },
  chipScroll: { marginBottom: 18 },
  chipRow: {
    flexDirection: 'row',
    gap:           8,
    paddingHorizontal: 22,
  },
  chip: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             6,
    backgroundColor: T.surface,
    borderWidth:     1,
    borderColor:     T.line,
    borderRadius:    9999,
    paddingHorizontal: 16,
    paddingVertical:   9,
  },
  chipSelected: {
    backgroundColor: T.text,
    borderColor:     T.text,
  },
  chipText: {
    fontFamily: 'Geist-Medium',
    fontSize:   15,
    color:      T.text,
  },
  chipTextSelected: { color: T.bg },
  sheetFooter: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            12,
  },
  sheetHelper: {
    fontFamily: 'Geist-Regular',
    fontSize:   12.5,
    color:      T.faint,
    flex:       1,
  },
  addBtn: {
    backgroundColor: T.accent,
    borderRadius:    12,
    paddingHorizontal: 20,
    paddingVertical:   12,
    minWidth:        150,
    alignItems:      'center',
  },
  addBtnDisabled: { backgroundColor: T.surface2 },
  addBtnText: {
    fontFamily: 'Geist-SemiBold',
    fontSize:   15,
    color:      T.bg,
  },
  addBtnTextDisabled: { color: T.muted },

  // Stage 4
  stage4Header: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-end',
    paddingHorizontal: 22,
    paddingTop:     20,
    paddingBottom:  16,
  },
  greeting: {
    fontFamily: 'Geist-Regular',
    fontSize:   12,
    color:      T.muted,
  },
  dateHeading: {
    fontFamily:    'Geist-Medium',
    fontSize:      22,
    color:         T.text,
    letterSpacing: 22 * -0.02,
  },
  sectionRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingVertical:   10,
  },
  sectionLabel: {
    fontFamily:    'Geist-Medium',
    fontSize:      11,
    letterSpacing: 11 * 0.16,
    color:         T.muted,
    textTransform: 'uppercase',
  },
  sectionCount: {
    fontFamily: 'Geist-Regular',
    fontSize:   13,
    color:      T.muted,
    fontVariant: ['tabular-nums'],
  } as object,
  taskRow: {
    flexDirection:   'row',
    alignItems:      'center',
    paddingHorizontal: 22,
    paddingVertical:   14,
    borderTopWidth:    StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow:          'hidden',
  },
  checkboxTouchTarget: {
    width:          44,
    height:         44,
    marginRight:    6,
    alignItems:     'center',
    justifyContent: 'center',
  },
  checkbox: {
    width:        22,
    height:       22,
    borderRadius: 11,
    borderWidth:  1.5,
    alignItems:   'center',
    justifyContent: 'center',
    overflow:     'hidden',
  },
  checkboxFill: {
    width:           16,
    height:          16,
    borderRadius:    8,
    backgroundColor: T.faint,
  },
  taskBody:    { flex: 1 },
  titleWrapper: { position: 'relative', alignSelf: 'flex-start' },
  taskTitle: {
    fontFamily: 'Geist-Regular',
    fontSize:   16,
    lineHeight: 22,
    color:      T.text,
  },
  taskMeta: {
    fontFamily:  'Geist-Regular',
    fontSize:    12,
    color:       T.muted,
    marginTop:   4,
  },
  chips: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    alignItems:    'center',
    gap:           6,
    marginTop:     4,
  },
  catChip: {
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      9999,
    borderWidth:       StyleSheet.hairlineWidth,
  },
  catLabel: {
    fontSize:   11,
    fontFamily: 'Geist-SemiBold',
  },
  washOverlay: {
    borderRadius: 4,
    overflow:     'hidden',
    backgroundColor: T.nearTint2,
  },
  hintRow: {
    alignItems: 'center',
    marginTop:  20,
  },
  hintText: {
    fontFamily: 'Geist-Regular',
    fontSize:   14,
    color:      T.muted,
    marginTop:  8,
  },

  // Reward card
  rewardCard: {
    position:        'absolute',
    left:            18,
    right:           18,
    backgroundColor: T.nearTint,
    borderWidth:     1,
    borderColor:     T.nearBorder,
    borderRadius:    22,
    flexDirection:   'column',
    padding:         16,
    overflow:        'hidden',
  },
  rewardRow: {
    flexDirection: 'row',
    alignItems:    'center',
  },
  rewardBleed: {
    position:        'absolute',
    top:             -40,
    right:           -40,
    width:           120,
    height:          120,
    borderRadius:    60,
    backgroundColor: T.nearTint2,
    opacity:         0.6,
  },
  flameBox: {
    width:           46,
    height:          46,
    borderRadius:    12,
    backgroundColor: T.bg,
    borderWidth:     1,
    borderColor:     T.nearBorder,
    alignItems:      'center',
    justifyContent:  'center',
    marginRight:     12,
  },
  rewardBody:    { flex: 1 },
  rewardHeadline: {
    fontFamily:  'Geist-SemiBold',
    fontSize:    16,
    color:       T.text,
    marginBottom: 4,
  },
  rewardCaption: {
    fontFamily: 'Geist-Regular',
    fontSize:   13,
    color:      T.nearText,
    lineHeight: 18,
  },
  pointsPill: {
    backgroundColor: T.bg,
    borderWidth:     1,
    borderColor:     T.nearBorder,
    borderRadius:    9999,
    paddingHorizontal: 10,
    paddingVertical:   4,
    marginLeft:      10,
  },
  pointsText: {
    fontFamily:  'Geist-SemiBold',
    fontSize:    13,
    color:       T.nearText,
  },
});
