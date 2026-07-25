/**
 * Lantern.tsx — KAN-301
 *
 * The Today header's persistent place-familiarity object, in the slot the
 * progress ring used to occupy. It is NOT the "hero" (that name belongs to the
 * NearbyCard's <100 m proximity card). Anatomy, top to bottom:
 *
 *   icon on a soft circular halo  →  location label  →  pill button
 *
 * Only the pill is a tap target; the icon and label are inert (AC6).
 *
 * ── Division of labour (non-negotiable) ──
 * The WORD carries the information; the LIGHT carries the feeling. The label is
 * always present and always legible on the background — never inside the lit
 * area. Brightness alone would fail accessibility, so it is never load-bearing.
 *
 * ── Animation: halo only, never SVG (hard rule, KAN-157) ──
 * The breathing runs on the halo View (a plain background-colour View) via the
 * RN Animated `useNativeDriver` path. It is NEVER bound to the icon, which
 * renders through react-native-svg: animating svg props on the New Architecture
 * floods setNativeProps, the Fabric ShadowTree fails to converge, retries 1024×
 * and the app crashes. Every animated value here lives on a View.
 *
 * ── Two-state collapse ──
 * Reuses TodayScreen's `useCollapseAnimation` unmodified (AC12). This component
 * takes its two crossfade opacities as `restStyle` (visible at rest) and
 * `collapsedStyle` (visible when collapsed) and renders two static layouts that
 * cross-fade — nothing animates per frame, matching the KAN-157 doctrine.
 * Rendered without those props (unit tests) it shows the rest layout only.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import Reanimated, { type AnimatedStyle } from 'react-native-reanimated';
import { useTheme } from '../theme';
import { spacing } from '../theme/tokens';
import type { Palette } from '../theme/tokens';
import { SECTION_H_COLLAPSED } from '../screens/TodayScreen/constants';
import { COPY } from '../constants/copy';
import type { LanternState } from '../utils/lantern';
import {
  ChevronRightIcon,
  CrosshairIcon,
  HomeIcon,
  PinIcon,
  ShoppingBagIcon,
  SuitcaseIcon,
} from './AppIcon';
import type { IconProps } from './AppIcon/shared';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// ── Visual constants (from the KAN-301 visual spec) ────────────────────────────
const HALO_EXPANDED = 52;
const HALO_COLLAPSED = 46;
const ICON_EXPANDED = 27;
const ICON_COLLAPSED = 25;
const LABEL_MAX_W = 149;

const BREATHE_CYCLE_MS = 4500;
const BREATHE_CYCLE_MS_UNSET = 6000;
const HALO_OPACITY_LIT = 0.16;
const HALO_OPACITY_UNSET = 0.10;
const BREATHE_LIT = { low: 0.14, high: 0.24 };
const BREATHE_UNSET = { low: 0.07, high: 0.13 };
const BREATHE_SCALE = 1.18;

type IconCmp = (props: IconProps) => React.JSX.Element;

interface Visual {
  Icon: IconCmp;
  haloToken: string;
  iconColor: string;
  label: string;
  pillLabel: string;
  pillA11y: string;
  isUnset: boolean;
  offlineDot: boolean;
  baseOpacity: number;
  breathe: { low: number; high: number };
  cycleMs: number;
}

/** Maps a resolved LanternState to its icon, halo tint, label and pill — the
 *  same shape-the-view step ContextChip does for ContextChipView. */
function getVisual(state: LanternState, palette: Palette): Visual {
  const lit = {
    baseOpacity: HALO_OPACITY_LIT,
    breathe: BREATHE_LIT,
    cycleMs: BREATHE_CYCLE_MS,
    isUnset: false,
  };
  const placesPill = COPY.tripPlanner.placesIKnowTitle;

  switch (state.kind) {
    case 'home':
      return {
        Icon: HomeIcon, haloToken: palette.haloHome, iconColor: palette.text,
        label: COPY.lantern.home, pillLabel: placesPill,
        pillA11y: COPY.lantern.placesPillA11y(COPY.lantern.home),
        offlineDot: false, ...lit,
      };
    case 'outside': {
      const label = state.cityName ?? COPY.lantern.outside;
      return {
        Icon: PinIcon, haloToken: palette.haloPlace, iconColor: palette.text,
        label, pillLabel: placesPill, pillA11y: COPY.lantern.placesPillA11y(label),
        offlineDot: false, ...lit,
      };
    }
    case 'mall':
      return {
        Icon: ShoppingBagIcon, haloToken: palette.haloPlace, iconColor: palette.text,
        label: state.name, pillLabel: placesPill, pillA11y: COPY.lantern.placesPillA11y(state.name),
        offlineDot: state.offlineDot, ...lit,
      };
    case 'trip':
      return {
        Icon: SuitcaseIcon, haloToken: palette.haloPlace, iconColor: palette.text,
        label: state.destination, pillLabel: placesPill, pillA11y: COPY.lantern.placesPillA11y(state.destination),
        offlineDot: state.offlineDot, ...lit,
      };
    case 'unset':
      return {
        Icon: CrosshairIcon, haloToken: palette.haloUnset, iconColor: palette.muted,
        label: COPY.lantern.whereIsHome, pillLabel: COPY.lantern.tellMe,
        pillA11y: COPY.lantern.setHomePillA11y,
        isUnset: true, offlineDot: false,
        baseOpacity: HALO_OPACITY_UNSET, breathe: BREATHE_UNSET, cycleMs: BREATHE_CYCLE_MS_UNSET,
      };
  }
}

// ── Halo — the only animated element; a background-colour View, never SVG ──────
function Halo({
  token, iconColor, Icon, size, iconSize, baseOpacity, breathe, cycleMs, reduceMotion,
}: {
  token: string; iconColor: string; Icon: IconCmp; size: number; iconSize: number;
  baseOpacity: number; breathe: { low: number; high: number }; cycleMs: number; reduceMotion: boolean;
}) {
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) { t.setValue(0); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: cycleMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: cycleMs / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, cycleMs, t]);

  const scale = reduceMotion ? 1 : t.interpolate({ inputRange: [0, 1], outputRange: [1, BREATHE_SCALE] });
  const opacity = reduceMotion ? baseOpacity : t.interpolate({ inputRange: [0, 1], outputRange: [breathe.low, breathe.high] });

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: token,
          transform: [{ scale }],
          opacity,
        }}
      />
      <Icon color={iconColor} size={iconSize} />
    </View>
  );
}

// ── Pill — the sole tap target ─────────────────────────────────────────────────
function Pill({
  label, expanded, onPress, a11yLabel, palette,
}: {
  label: string; expanded: boolean; onPress?: () => void; a11yLabel: string; palette: Palette;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const s = expanded
    ? { text: 11.5, pv: 5, pl: 11, pr: 9, gap: 5, chev: 11 }
    : { text: 13, pv: 9, pl: 15, pr: 13, gap: 6, chev: 12 };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 40, bounciness: 0 }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 4 }).start()}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      hitSlop={8}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: s.gap,
        paddingTop: s.pv,
        paddingBottom: s.pv,
        paddingLeft: s.pl,
        paddingRight: s.pr,
        borderRadius: 999,
        borderWidth: 1,
        backgroundColor: palette.nearTint2,
        borderColor: palette.nearBorder,
        transform: [{ scale }],
      }}>
      <Text style={{ fontSize: s.text, fontFamily: 'Geist-Medium', fontWeight: '500', letterSpacing: -0.025 * s.text, color: palette.nearText }}>
        {label}
      </Text>
      <ChevronRightIcon color={palette.nearText} size={s.chev} strokeWidth={2.4} />
    </AnimatedPressable>
  );
}

export interface LanternProps {
  state: LanternState;
  /** Pill press handler. The unset state should navigate to HomeAddress; other
   *  states have no destination yet (KAN-304 wires them). */
  onPillPress?: () => void;
  /** Reanimated opacity style visible at rest (TodayScreen's captionStyle). */
  restStyle?: AnimatedStyle<ViewStyle>;
  /** Reanimated opacity style visible when collapsed (TodayScreen's collapsedStyle). */
  collapsedStyle?: AnimatedStyle<ViewStyle>;
  /** JS mirror of the collapse state — drives which layer receives touches. */
  collapsed?: boolean;
  /** Test override for reduce-motion. */
  reduceMotionOverride?: boolean;
}

export default function Lantern({
  state, onPillPress, restStyle, collapsedStyle, collapsed = false, reduceMotionOverride,
}: LanternProps) {
  const { palette } = useTheme();
  const [reduceMotion, setReduceMotion] = useState(reduceMotionOverride ?? false);

  useEffect(() => {
    if (reduceMotionOverride != null) { return; }
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, [reduceMotionOverride]);

  const v = getVisual(state, palette);

  const offlineDot = v.offlineDot ? (
    <View style={[styles.offlineDot, { backgroundColor: palette.muted }]} accessibilityLabel={COPY.contextChip.offlineDotA11y} />
  ) : null;

  // ── Rest layout — centred column ──
  const restContent = (
    <>
      <Halo
        token={v.haloToken} iconColor={v.iconColor} Icon={v.Icon}
        size={HALO_EXPANDED} iconSize={ICON_EXPANDED}
        baseOpacity={v.baseOpacity} breathe={v.breathe} cycleMs={v.cycleMs} reduceMotion={reduceMotion}
      />
      <View style={styles.restLabelRow}>
        <Text
          style={[styles.restLabel, { color: palette.text }]}
          numberOfLines={2}
          accessibilityRole="text">
          {v.label}
        </Text>
        {offlineDot}
      </View>
      <View style={styles.restPill}>
        <Pill label={v.pillLabel} expanded onPress={onPillPress} a11yLabel={v.pillA11y} palette={palette} />
      </View>
    </>
  );

  // ── Collapsed layout — one row: icon + label left, pill right ──
  const collapsedContent = (
    <>
      <View style={styles.collapsedLeft}>
        <Halo
          token={v.haloToken} iconColor={v.iconColor} Icon={v.Icon}
          size={HALO_COLLAPSED} iconSize={ICON_COLLAPSED}
          baseOpacity={v.baseOpacity} breathe={v.breathe} cycleMs={v.cycleMs} reduceMotion={reduceMotion}
        />
        <Text style={[styles.collapsedLabel, { color: palette.text }]} numberOfLines={1}>
          {v.label}
        </Text>
        {offlineDot}
      </View>
      <Pill label={v.pillLabel} expanded={false} onPress={onPillPress} a11yLabel={v.pillA11y} palette={palette} />
    </>
  );

  // Rendered standalone (unit tests): rest layout only, no crossfade.
  if (!restStyle && !collapsedStyle) {
    return (
      <View style={styles.restLayer} pointerEvents="box-none">
        {restContent}
      </View>
    );
  }

  return (
    <>
      <Reanimated.View style={[styles.restLayer, restStyle]} pointerEvents={collapsed ? 'none' : 'box-none'}>
        {restContent}
      </Reanimated.View>
      <Reanimated.View style={[styles.collapsedLayer, collapsedStyle]} pointerEvents={collapsed ? 'box-none' : 'none'}>
        {collapsedContent}
      </Reanimated.View>
    </>
  );
}

const styles = StyleSheet.create({
  restLayer: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0, right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  restLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 20,
    maxWidth: LABEL_MAX_W + 20,
  },
  restLabel: {
    fontSize: 32.4,
    fontFamily: 'Geist-Medium',
    fontWeight: '500',
    letterSpacing: -0.81,        // -0.025em at 32.4
    lineHeight: 34,              // 1.05
    maxWidth: LABEL_MAX_W,
    textAlign: 'center',
  },
  restPill: {
    marginTop: 3,
  },
  collapsedLayer: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: SECTION_H_COLLAPSED,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.page,
  },
  collapsedLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexShrink: 1,
    minWidth: 0,
  },
  collapsedLabel: {
    fontSize: 17,
    fontFamily: 'Geist-Medium',
    fontWeight: '500',
    letterSpacing: -0.425,       // -0.025em at 17
    flexShrink: 1,
  },
  offlineDot: {
    width: 6,
    height: 6,
    borderRadius: 9999,
  },
});
