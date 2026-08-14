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
import type { AreaNotice, LanternState } from '../utils/lantern';
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
  baseOpacity: number;
  breathe: { low: number; high: number };
  cycleMs: number;
}

/** Maps a resolved LanternState to its icon, halo tint, label and pill. Every
 *  kind renders (the Lantern is never empty); `locating`/`unavailable` reuse
 *  the unset state's neutral halo, differing only in the word. */
function getVisual(state: LanternState, palette: Palette): Visual {
  const lit = {
    baseOpacity: HALO_OPACITY_LIT,
    breathe: BREATHE_LIT,
    cycleMs: BREATHE_CYCLE_MS,
    isUnset: false,
  };
  const neutral = {
    Icon: CrosshairIcon, haloToken: palette.haloUnset, iconColor: palette.muted,
    isUnset: true,
    baseOpacity: HALO_OPACITY_UNSET, breathe: BREATHE_UNSET, cycleMs: BREATHE_CYCLE_MS_UNSET,
  } as const;
  const placesPill = COPY.tripPlanner.placesIKnowTitle;

  switch (state.kind) {
    case 'home':
      return {
        Icon: HomeIcon, haloToken: palette.haloHome, iconColor: palette.text,
        label: COPY.lantern.home, pillLabel: placesPill,
        pillA11y: COPY.lantern.placesPillA11y(COPY.lantern.home),
        ...lit,
      };
    case 'outside': {
      const label = state.cityName ?? COPY.lantern.outside;
      return {
        Icon: PinIcon, haloToken: palette.haloPlace, iconColor: palette.text,
        label, pillLabel: placesPill, pillA11y: COPY.lantern.placesPillA11y(label),
        ...lit,
      };
    }
    case 'mall':
      return {
        Icon: ShoppingBagIcon, haloToken: palette.haloPlace, iconColor: palette.text,
        label: state.name, pillLabel: placesPill, pillA11y: COPY.lantern.placesPillA11y(state.name),
        ...lit,
      };
    case 'trip':
      return {
        Icon: SuitcaseIcon, haloToken: palette.haloPlace, iconColor: palette.text,
        label: state.destination, pillLabel: placesPill, pillA11y: COPY.lantern.placesPillA11y(state.destination),
        ...lit,
      };
    case 'unset':
      return {
        ...neutral,
        label: COPY.lantern.whereIsHome, pillLabel: COPY.lantern.tellMe,
        pillA11y: COPY.lantern.setHomePillA11y,
      };
    case 'locating':
      return {
        ...neutral,
        label: COPY.lantern.lookingAround, pillLabel: placesPill,
        pillA11y: COPY.lantern.placesPillA11y(COPY.lantern.lookingAround),
      };
    case 'unavailable':
      return {
        ...neutral,
        label: COPY.lantern.cantFindYou, pillLabel: placesPill,
        pillA11y: COPY.lantern.placesPillA11y(COPY.lantern.cantFindYou),
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
  const s = expanded ? { text: 11.5, chev: 11 } : { text: 13, chev: 12 };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 40, bounciness: 0 }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 40, bounciness: 4 }).start()}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      // The rest-layout (expanded) pill is short by the visual spec (5px vertical
      // padding); a larger hitSlop lifts its effective touch target to ≥44px
      // without changing the visual. The compact pill is already tall enough.
      hitSlop={expanded ? 12 : 8}
      style={[
        styles.pillBase,
        expanded ? styles.pillExpanded : styles.pillCompact,
        { backgroundColor: palette.nearTint2, borderColor: palette.nearBorder, transform: [{ scale }] },
      ]}>
      <Text style={[styles.pillText, { fontSize: s.text, letterSpacing: -0.025 * s.text, color: palette.nearText }]}>
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
  /**
   * KAN-349 — what the app owes the user an explanation about here, or null for
   * the calm empty zone. Rendered in the rest layout only: the collapsed row has
   * no vertical room beside the icon/label/pill, and a quiet aside is not worth
   * displacing the place name for once the user has scrolled past it. The state
   * itself persists, so the line is there again at rest.
   */
  notice?: AreaNotice | null;
  /** Test override for reduce-motion. */
  reduceMotionOverride?: boolean;
}

export default function Lantern({
  state, notice = null, onPillPress, restStyle, collapsedStyle, collapsed = false, reduceMotionOverride,
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

  const noticeText = notice === 'building' ? COPY.lantern.buildingArea
    : notice === 'degraded' ? COPY.lantern.degradedArea
      : null;

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
      </View>
      <View style={styles.restPill}>
        <Pill label={v.pillLabel} expanded onPress={onPillPress} a11yLabel={v.pillA11y} palette={palette} />
      </View>
      {noticeText != null && (
        <Text style={[styles.notice, { color: palette.muted }]} numberOfLines={2} accessibilityRole="text">
          {noticeText}
        </Text>
      )}
    </>
  );

  // ── Collapsed layout — two zones. Left: icon stacked over its label, centred
  // (the label has the whole half to grow into, wrapping to two lines). Right:
  // the pill, left-aligned, so it sits at the midpoint and only visually shifts
  // when a long label fills the left zone. ──
  const collapsedContent = (
    <>
      <View style={styles.collapsedLeftZone}>
        <View style={styles.collapsedGroup}>
          <Halo
            token={v.haloToken} iconColor={v.iconColor} Icon={v.Icon}
            size={HALO_COLLAPSED} iconSize={ICON_COLLAPSED}
            baseOpacity={v.baseOpacity} breathe={v.breathe} cycleMs={v.cycleMs} reduceMotion={reduceMotion}
          />
          <View style={styles.collapsedLabelRow}>
            <Text style={[styles.collapsedLabel, { color: palette.text }]} numberOfLines={2}>
              {v.label}
            </Text>
          </View>
        </View>
      </View>
      <View style={styles.collapsedRightZone}>
        <Pill label={v.pillLabel} expanded={false} onPress={onPillPress} a11yLabel={v.pillA11y} palette={palette} />
      </View>
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
    marginTop: 10,
  },
  collapsedLayer: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: SECTION_H_COLLAPSED,
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: spacing.page,
  },
  // Two equal zones (KAN-301 revision). Left holds the centred icon+label; the
  // label has this whole half to grow into and wraps to two lines. Right holds
  // the pill, left-aligned, so it sits at the midpoint.
  collapsedLeftZone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  collapsedRightZone: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  // Icon stacked on top of its label, with breathing room between them.
  collapsedGroup: {
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  collapsedLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  collapsedLabel: {
    fontSize: 17,
    fontFamily: 'Geist-Medium',
    fontWeight: '500',
    letterSpacing: -0.425,       // -0.025em at 17
    lineHeight: 20,
    textAlign: 'center',
    flexShrink: 1,
  },
  // KAN-349 — a quiet aside on the background, below the pill. Muted text, no
  // icon, no warning colour, no surface of its own: it explains, it doesn't
  // alarm. Sized and capped so it lives inside the zone's existing slack and
  // never pushes Nearby down (see SECTION_H_REST).
  notice: {
    marginTop: 10,
    maxWidth: 260,
    fontSize: 13,
    fontFamily: 'Geist-Regular',
    fontWeight: '400',
    lineHeight: 17,
    textAlign: 'center',
  },
  // ── Pill (static layout; colours + press transform stay inline) ──
  pillBase: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
  },
  pillExpanded: {
    gap: 5,
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 11,
    paddingRight: 9,
  },
  pillCompact: {
    gap: 6,
    paddingTop: 9,
    paddingBottom: 9,
    paddingLeft: 15,
    paddingRight: 13,
  },
  pillText: {
    fontFamily: 'Geist-Medium',
    fontWeight: '500',
  },
});
