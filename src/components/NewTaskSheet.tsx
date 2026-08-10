/**
 * NewTaskSheet — KAN-143
 *
 * POI-first bottom sheet for creating a new task.
 * "Add task" is disabled until both title and POI are set.
 *
 * Animations (Reanimated):
 *   Open:  sheet translateY 105% → 0, 320ms cubic-bezier(0.32,0.72,0,1)
 *          scrim opacity 0 → 0.4, 250ms linear
 *   Close: reverse
 *
 * Dismiss: scrim tap · ✕ button · drag handle (>80 px or velocity >0.5)
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { categories, fonts } from '../theme/tokens';
import { PoiType, CategoryKey, Category, QUICK_ACTIONABLE_POI_TYPES, POI_CATALOG, poiCatalogLabel } from '../types';
import { addTask } from '../services/firestore';
import { inferPoiForQuickAdd, learnFromClassification, learnFromUserEdit } from '../services/poiLlm';
import { CloseIcon, PoiIcon } from './AppIcon';
import { navigateTo } from '../navigation/navigationRef';
import { COPY } from '../constants/copy';
import { useToastStore } from '../store/toastStore';
import RotatingTitlePlaceholder from './RotatingTitlePlaceholder';
import { localPoiLabel } from '../services/poiTypeCache';
import FoodTypeSelector from './FoodTypeSelector';
import type { RestaurantFoodType } from '../services/restaurantFoodTypes';
import StoreSubtypeSelector from './StoreSubtypeSelector';
import BrandSelector from './BrandSelector';
import {
  inferStoreSubtype,
  type StoreSubtype,
} from '../services/storeSubtypes';
import { findBrandInText, poiTypeRequiresBrand } from '../services/brandDictionary';

// ─── Constants ────────────────────────────────────────────────────────────────

const SCREEN_H = Dimensions.get('window').height;

const POI_TILE_WIDTH = 72;

/** Debounce before running POI inference on the title (KAN-232) — the rule
 *  pass is cheap but the TFLite fallback isn't, so we don't run either on
 *  every keystroke. */
const POI_INFERENCE_DEBOUNCE_MS = 350;

// ─── Imperative handle ────────────────────────────────────────────────────────

export interface NewTaskSheetHandle {
  hide: () => void;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface NewTaskSheetProps {
  visible: boolean;
  uid: string;
  onClose: () => void;
  onTaskAdded?: () => void;
  customCategories?: Category[];
}

// ─── POI Tile (shared within this module) ────────────────────────────────────

interface PoiTileProps {
  type: PoiType;
  label: string;
  selected: boolean;
  onPress: () => void;
  palette: ReturnType<typeof useTheme>['palette'];
}

function PoiTile({ type, label, selected, onPress, palette }: PoiTileProps) {
  const iconColor = selected ? palette.nearText : palette.muted;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={[
        styles.poiTile,
        {
          backgroundColor: selected ? palette.nearTint2  : palette.surface,
          borderColor:     selected ? palette.nearBorder : palette.line,
        },
      ]}>
      <PoiIcon type={type} color={iconColor} size={22} />
      <Text
        style={[styles.poiTileLabel, { color: iconColor }]}
        numberOfLines={1}
        ellipsizeMode="tail">
        {label}
      </Text>
    </Pressable>
  );
}

// ─── Suggestion tile (KAN-249) — dedicated leading carousel slot ─────────────
//
// Always the first item in the POI carousel, separate from the 16 catalog
// tiles (which stay exactly as they were pre-KAN-249). Once inference lands
// on a type, this tile keeps showing that guess's icon/label for the rest of
// the compose session — replacing it with a different catalog pick must NOT
// blank it back out, only change its look:
//   - never inferred yet → empty placeholder, no icon, just the "my guess?" hint.
//   - guess is live and untouched (poi === the guess) → dashed/suggested look + hint.
//   - the user accepted it (poi === the guess, carousel touched) → normal
//     confirmed look (solid border, no hint).
//   - the user picked something else instead (poi !== the guess) → plain
//     unselected look, same as an ordinary catalog tile — icon/label stay put.
// Tapping it re-selects the guess (same toggle rule as a catalog tile);
// inert only while there's no guess to act on.

interface SuggestionTileProps {
  /** The inferred guess — sticky once known, regardless of what's replaced it. */
  type: string | null;
  label: string | null;
  /** True when this guess is the current `poi` value (live or confirmed). */
  selected: boolean;
  /** True once the user has interacted with the carousel at all. */
  touched: boolean;
  onPress: () => void;
  palette: ReturnType<typeof useTheme>['palette'];
}

function SuggestionTile({ type, label, selected, touched, onPress, palette }: SuggestionTileProps) {
  const known     = type !== null;
  const live      = known && selected && !touched;
  const confirmed = known && selected && touched;
  // Dashed + hint whenever there's no accepted/rejected verdict yet: the
  // still-live guess, or the placeholder before anything has been inferred.
  const showHint  = live || !known;

  const iconColor = selected ? palette.nearText : palette.muted;

  // Mirrors the same three-way state the visual hint uses (showHint) instead
  // of just `known` — otherwise a screen reader keeps announcing "my guess?"
  // on the confirmed/rejected tile after the on-screen hint has disappeared.
  // Always keeps a "suggestion" qualifier (rather than collapsing to the bare
  // `label`) so this tile's accessibilityLabel never exactly matches the
  // separate catalog tile for the same type once both are on screen.
  const accessibilityLabel = !known
    ? COPY.newTaskSheet.poiSuggestionHint
    : showHint
      ? `${label}, ${COPY.newTaskSheet.poiSuggestionHint}`
      : `${label} ${COPY.newTaskSheet.poiSuggestionConfirmedSuffix}`;

  return (
    <Pressable
      onPress={onPress}
      disabled={!known}
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected, disabled: !known }}
      style={[
        styles.poiTile,
        (showHint || confirmed) && styles.poiTileSuggested,
        {
          backgroundColor: live ? palette.nearTint : confirmed ? palette.nearTint2 : known ? palette.surface : palette.nearTint,
          borderColor:     live || confirmed || !known ? palette.nearBorder : palette.line,
        },
      ]}>
      {known && <PoiIcon type={type} color={iconColor} size={22} />}
      {known && (
        <Text
          style={[styles.poiTileLabel, { color: iconColor }]}
          numberOfLines={1}
          ellipsizeMode="tail">
          {label}
        </Text>
      )}
      {showHint && (
        <Text
          style={[styles.poiTileHint, { color: palette.nearText }]}
          numberOfLines={1}>
          {COPY.newTaskSheet.poiSuggestionHint}
        </Text>
      )}
    </Pressable>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const NewTaskSheet = forwardRef<NewTaskSheetHandle, NewTaskSheetProps>(
  function NewTaskSheet({ visible, uid, onClose, onTaskAdded, customCategories = [] }, ref) {
    const { palette } = useTheme();
    const insets = useSafeAreaInsets();

    // Form state
    const [title,    setTitle]    = useState('');
    const [category, setCategory] = useState<string | null>(null);
    const [poi,      setPoi]      = useState<string | null>(null);
    const [restaurantFoodType, setRestaurantFoodType] = useState<RestaurantFoodType | null>(null);
    const [storeSubtype, setStoreSubtype] = useState<StoreSubtype | null>(null);
    const [storeSubtypeTouched, setStoreSubtypeTouched] = useState(false);
    const [poiBrand, setPoiBrand] = useState<string | null>(null);
    const [poiBrandTouched, setPoiBrandTouched] = useState(false);
    // KAN-249 — the raw inference result, frozen the moment the user touches
    // the carousel. Compared against `poi` at submit time to tell a Confirm
    // (poi === suggestedPoi) from a Replace (poi !== suggestedPoi); null means
    // no suggestion ever fired for this title, so no learn-back applies.
    const [suggestedPoi, setSuggestedPoi] = useState<string | null>(null);
    // The exact trimmed title the suggestion above was inferred for. Inference
    // is skipped once the carousel is touched, so a later title edit can leave
    // `suggestedPoi` stale relative to the title actually being submitted —
    // learn-back at submit time is only valid when this still matches.
    const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);
    // True once the user has tapped any POI tile — drives the suggested-vs-
    // confirmed visual (a ref alone wouldn't trigger a re-render).
    const [poiTouched, setPoiTouched] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    // Rotating title placeholder freezes permanently once the user taps the field (KAN-148).
    const [titleFocused, setTitleFocused] = useState(false);

    const titleRef = useRef<TextInput>(null);

    // KAN-232 — once the user manually touches the POI carousel, inference
    // never overwrites their choice again for this open sheet instance.
    const userTouchedPoiRef = useRef(false);
    // Guards a stale debounced/async inference result from landing after a
    // newer keystroke (or the sheet closing/resetting) has superseded it.
    const inferenceRequestIdRef = useRef(0);

    const onCloseRef      = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    const onTaskAddedRef  = useRef(onTaskAdded);
    useEffect(() => { onTaskAddedRef.current = onTaskAdded; }, [onTaskAdded]);

    // ── Reanimated ──
    const translateY   = useSharedValue(SCREEN_H);
    const scrimOpacity = useSharedValue(0);
    const dragOffset   = useSharedValue(0);
    // Android: KeyboardAvoidingView's `height` mode doesn't reliably reset
    // once the keyboard hides (known RN/Android quirk with flex-end
    // containers) — leaves a permanent gap. Driven explicitly off Keyboard
    // events instead, so hide always forces this back to 0.
    const kbOffset      = useSharedValue(0);

    const sheetStyle = useAnimatedStyle(() => ({
      transform: [{ translateY: translateY.value + dragOffset.value + kbOffset.value }],
    }));
    const scrimStyle = useAnimatedStyle(() => ({
      opacity: scrimOpacity.value,
    }));

    // Android only — iOS keeps KeyboardAvoidingView's `padding` behavior,
    // which resets correctly on its own.
    useEffect(() => {
      if (Platform.OS !== 'android') return;
      const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
        kbOffset.value = withTiming(-e.endCoordinates.height, { duration: 200 });
      });
      const hideSub = Keyboard.addListener('keyboardDidHide', () => {
        kbOffset.value = withTiming(0, { duration: 200 });
      });
      return () => {
        showSub.remove();
        hideSub.remove();
      };
    }, [kbOffset]);

    const resetForm = useCallback(() => {
      setTitle('');
      setCategory(null);
      setPoi(null);
      setRestaurantFoodType(null);
      setStoreSubtype(null);
      setStoreSubtypeTouched(false);
      setPoiBrand(null);
      setPoiBrandTouched(false);
      setSuggestedPoi(null);
      setSuggestedTitle(null);
      setPoiTouched(false);
      setSubmitting(false);
      setTitleFocused(false);
      dragOffset.value = 0;
      kbOffset.value = 0;
      userTouchedPoiRef.current = false;
      // Invalidate any in-flight (debounced or async) inference so a late
      // result can't repopulate `poi` after the sheet has been reset/closed.
      inferenceRequestIdRef.current++;
    }, [dragOffset, kbOffset]);

    // KAN-232 — auto-suggest a POI as the title is typed: cheap offline
    // keyword rules first, on-device TFLite classifier as fallback. The
    // guess itself (suggestedPoi/suggestedTitle) always keeps computing,
    // even after a manual pick — the submit-time learn-back comparison
    // (poi === suggestedPoi) needs it current. `userTouchedPoiRef` only
    // stops it from auto-overwriting the user's manual `poi` selection.
    // Skipped while closed so no timer/promise is scheduled against an
    // off-screen sheet.
    useEffect(() => {
      if (!visible) { return; }

      const myRequestId = ++inferenceRequestIdRef.current;
      const trimmed = title.trim();

      const timer = setTimeout(() => {
        if (inferenceRequestIdRef.current !== myRequestId) { return; }

        if (!trimmed) {
          setSuggestedPoi(null);
          setSuggestedTitle(null);
          if (!userTouchedPoiRef.current) { setPoi(null); }
          return;
        }

        inferPoiForQuickAdd(trimmed)
          .then(suggestion => {
            if (inferenceRequestIdRef.current !== myRequestId) { return; }
            setSuggestedPoi(suggestion);
            setSuggestedTitle(trimmed);
            if (!userTouchedPoiRef.current) { setPoi(suggestion); }
          })
          .catch(() => {});
      }, POI_INFERENCE_DEBOUNCE_MS);

      return () => clearTimeout(timer);
    }, [title, visible]);

    // Closing just tells the parent (store) to flip `visible` → the effect below
    // animates out. The sheet is NEVER unmounted, so its static tree (16 POI
    // tiles, inputs, pills) is built once on first mount, not rebuilt per open.
    const handleClose = useCallback(() => { onCloseRef.current(); }, []);

    useImperativeHandle(ref, () => ({
      hide: () => { onCloseRef.current(); },
    }), []);

    const openAnimation = useCallback(() => {
      dragOffset.value   = 0;
      translateY.value   = withTiming(0,   { duration: 320, easing: Easing.bezier(0.32, 0.72, 0, 1) });
      scrimOpacity.value = withTiming(0.4, { duration: 250, easing: Easing.linear });
    }, [translateY, scrimOpacity, dragOffset]);

    const closeAnimation = useCallback(() => {
      dragOffset.value   = 0;
      scrimOpacity.value = withTiming(0,        { duration: 250, easing: Easing.linear });
      translateY.value   = withTiming(SCREEN_H, { duration: 280, easing: Easing.bezier(0.32, 0.72, 0, 1) });
    }, [translateY, scrimOpacity, dragOffset]);

    // Drive the animation off `visible`. On the very first render (closed) we
    // only set the resting off-screen position — no animation, no form reset.
    const didMountRef = useRef(false);
    useEffect(() => {
      if (visible) {
        openAnimation();
      } else {
        closeAnimation();
        if (didMountRef.current) { resetForm(); }
      }
      didMountRef.current = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    // Android hardware back closes the sheet while it's open (Modal used to do this).
    useEffect(() => {
      if (!visible) { return; }
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        onCloseRef.current();
        return true;
      });
      return () => sub.remove();
    }, [visible]);

    const panResponder = useMemo(() => PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  (_, g) => g.dy > 3,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) dragOffset.value = g.dy;
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 80 || g.vy > 0.5) {
          onCloseRef.current();
        } else {
          dragOffset.value = withSpring(0, { stiffness: 300, damping: 30 });
        }
      },
      onPanResponderTerminate: () => {
        dragOffset.value = withSpring(0, { stiffness: 300, damping: 30 });
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }), []);

    const canSubmit = title.trim().length > 0 && poi !== null && (!poiTypeRequiresBrand(poi) || poiBrand !== null);

    useEffect(() => {
      if (poi !== 'restaurant') { setRestaurantFoodType(null); }
      if (poi !== 'store') {
        setStoreSubtype(null);
        setStoreSubtypeTouched(false);
      }
      if (!poiTypeRequiresBrand(poi)) {
        setPoiBrand(null);
        setPoiBrandTouched(false);
      }
    }, [poi]);

    useEffect(() => {
      if (poi !== 'store' || storeSubtypeTouched) { return; }
      setStoreSubtype(inferStoreSubtype(title.trim()) ?? 'any');
    }, [poi, storeSubtypeTouched, title]);

    const suggestedBrand = poiTypeRequiresBrand(poi) ? findBrandInText(poi, title) : null;
    useEffect(() => {
      if (!poiTypeRequiresBrand(poi) || poiBrandTouched) { return; }
      setPoiBrand(suggestedBrand);
    }, [poi, poiBrandTouched, suggestedBrand]);

    // KAN-249 — the leading suggestion tile's content. `suggestionType` is
    // sticky once inference lands on something: replacing it with a
    // different catalog pick must NOT blank the guess back out, it only
    // stops being the current `poi` value (handled inside SuggestionTile).
    const suggestionType     = suggestedPoi;
    const suggestionLabel    = suggestionType
      ? (POI_CATALOG.some(item => item.type === suggestionType)
        ? poiCatalogLabel(suggestionType as PoiType)
        : localPoiLabel(suggestionType))
      : null;
    const suggestionSelected = suggestionType !== null && poi === suggestionType;
    const suggestedStoreSubtype = poi === 'store' && storeSubtype && !storeSubtypeTouched && storeSubtype !== 'any'
      ? storeSubtype
      : null;

    const handleSubmit = useCallback(async () => {
      const trimmed = title.trim();
      if (!trimmed || !poi || !uid || submitting || (poiTypeRequiresBrand(poi) && !poiBrand)) { return; }

      setSubmitting(true);
      try {
        await addTask(uid, {
          title:    trimmed,
          category: category ?? 'personal',
          done:     false,
          poi,
          ...(poi === 'store' ? { storeSubtype: storeSubtype ?? 'any' } : {}),
          ...(poi === 'restaurant' && restaurantFoodType ? { restaurantFoodType } : {}),
          ...(poiTypeRequiresBrand(poi) && poiBrand ? { poiBrand } : {}),
        });
        // KAN-249 learn-back — only meaningful when a suggestion actually
        // fired for THIS title. Inference is skipped once the carousel is
        // touched, so a title edit after that point can leave `suggestedPoi`
        // referring to a now-unrelated title; `suggestedTitle` guards against
        // persisting a learned mapping for the wrong keyword.
        if (suggestedPoi && suggestedTitle === trimmed) {
          if (suggestedPoi === poi) {
            // Confirmed (tapped the suggested chip) or Ignored (saved
            // untouched) — both are a positive signal on the same mapping.
            learnFromClassification(uid, trimmed, poi, 'en').catch(() => {});
          } else {
            // Replaced — the user's pick corrects the suggestion.
            learnFromUserEdit(uid, trimmed, poi, 'en').catch(() => {});
          }
        }

        useToastStore.getState().showToast(COPY.newTaskSheet.confirmToast);
        // Close (store flips visible → effect animates out + resets the form).
        onCloseRef.current();
        onTaskAddedRef.current?.();
      } catch (err) {
        console.warn('[NewTaskSheet] addTask failed', err);
        setSubmitting(false);
      }
    }, [title, category, poi, storeSubtype, restaurantFoodType, poiBrand, suggestedPoi, suggestedTitle, uid, submitting]);

    const handleMoreDetails = useCallback(() => {
      handleClose();
      setTimeout(() => navigateTo('TaskForm', {
        uid,
        initialTitle: title.trim() || undefined,
        initialPoi:   poi ?? undefined,
        ...(poi === 'store' ? {
          initialStoreSubtype: storeSubtype ?? undefined,
          initialStoreSubtypeExplicitlySelected: storeSubtypeTouched,
        } : {}),
        ...(poi === 'restaurant' && restaurantFoodType ? {
          initialRestaurantFoodType: restaurantFoodType,
        } : {}),
        ...(poiTypeRequiresBrand(poi) && poiBrand ? { initialPoiBrand: poiBrand } : {}),
        initialPoiExplicitlySelected: poiTouched,
      }), 80);
    }, [handleClose, uid, title, poi, storeSubtype, storeSubtypeTouched, restaurantFoodType, poiBrand, poiTouched]);

    // Always mounted — built once, shown/hidden via transform. `pointerEvents`
    // goes inert when closed so the off-screen sheet never blocks the screen.
    return (
      <View
        style={[StyleSheet.absoluteFill, styles.host]}
        pointerEvents={visible ? 'box-none' : 'none'}>

        {/* ── Scrim ── */}
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: palette.scrim }, scrimStyle]}
          pointerEvents={visible ? 'box-only' : 'none'}>
          <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        </Animated.View>

        {/* ── Sheet ── */}
        <KeyboardAvoidingView
          style={styles.kavContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          enabled={Platform.OS === 'ios'}
          pointerEvents="box-none">

          <Animated.View
            style={[styles.sheet, { backgroundColor: palette.bg, borderTopColor: palette.line }, sheetStyle]}>

            {/* Drag handle */}
            <View style={styles.handleWrap} {...panResponder.panHandlers}>
              <View style={[styles.handle, { backgroundColor: palette.faint }]} />
            </View>

            {/* Header */}
            <View style={styles.header}>
              <Text style={[styles.headerTitle, { color: palette.text }]}>
                {COPY.newTaskSheet.title}
              </Text>
              <Pressable
                style={[styles.closeBtn, { backgroundColor: palette.surface }]}
                onPress={handleClose}
                accessibilityRole="button"
                accessibilityLabel={COPY.newTaskSheet2.closeA11y}>
                <CloseIcon color={palette.muted} />
              </Pressable>
            </View>

            <ScrollView
              style={styles.formScroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>

              {/* ── Title ── */}
              <View style={styles.fieldPad}>
                <View style={styles.titleInputWrap}>
                  <TextInput
                    ref={titleRef}
                    style={[
                      styles.titleInput,
                      {
                        backgroundColor: palette.surface,
                        borderColor:     palette.line,
                        color:           palette.text,
                      },
                    ]}
                    value={title}
                    onChangeText={setTitle}
                    onFocus={() => setTitleFocused(true)}
                    returnKeyType="default"
                    maxLength={200}
                    accessibilityLabel={COPY.newTaskSheet.title}
                  />
                  {/* Rotating example placeholder — hides once focused or once there's a value.
                      Gated by `visible` so the rotation timer doesn't run while the
                      always-mounted sheet is closed offscreen. */}
                  {visible && !titleFocused && title.length === 0 && (
                    <RotatingTitlePlaceholder
                      examples={COPY.newTaskSheet.titleExamples}
                      active={visible && !titleFocused}
                      style={[styles.titlePlaceholder, { color: palette.muted }]}
                    />
                  )}
                </View>
              </View>

              {/* ── POI question ── */}
              <View style={styles.questionRow}>
                <Text style={[styles.questionLabel, { color: palette.text }]}>
                  {COPY.newTaskSheet.poiQuestion}
                </Text>
              </View>

              {/* ── "Swipe for more" hint — right-aligned, no "Quick picks" sublabel ── */}
              <View style={styles.swipeHintRow}>
                <Text style={[styles.quickPicksHint, { color: palette.faint }]}>
                  {COPY.newTaskSheet.swipeHint}
                </Text>
              </View>

              {/* ── POI row: guess tile static, only the catalog scrolls ── */}
              <View style={styles.poiRow}>
                <SuggestionTile
                  type={suggestionType}
                  label={suggestionLabel}
                  selected={suggestionSelected}
                  touched={poiTouched}
                  onPress={() => {
                    // A no-op while there's no guess at all (Pressable is
                    // `disabled` in that case, but guard anyway).
                    if (suggestionType === null) { return; }
                    // First tap on a still-live guess confirms it in place —
                    // poi already equals suggestionType, so it must NOT fall
                    // into the toggle-off branch below. Any later tap (once
                    // touched) behaves like an ordinary catalog tile toggle.
                    const isLiveGuess = !poiTouched && poi === suggestionType;
                    userTouchedPoiRef.current = true;
                    setPoiTouched(true);
                    if (isLiveGuess) { return; }
                    setPoi(prev => prev === suggestionType ? null : suggestionType);
                  }}
                  palette={palette}
                />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.carousel}
                snapToInterval={POI_TILE_WIDTH + 10}
                decelerationRate="fast"
                style={styles.carouselMask}>
                {QUICK_ACTIONABLE_POI_TYPES.map(type => (
                  <PoiTile
                    key={type}
                    type={type}
                    label={poiCatalogLabel(type)}
                    selected={poi === type}
                    onPress={() => {
                      userTouchedPoiRef.current = true;
                      setPoiTouched(true);
                      setPoi(prev => prev === type ? null : type);
                    }}
                    palette={palette}
                  />
                ))}
              </ScrollView>
              </View>

              {poi === 'restaurant' && (
                <View style={styles.foodTypeSection}>
                  <View style={styles.questionRow}>
                    <Text style={[styles.questionLabel, { color: palette.text }]}>
                      {COPY.newTaskSheet.subtypeQuestion}
                    </Text>
                    <Text style={[styles.questionOptional, { color: palette.faint }]}>
                      {COPY.newTaskSheet.catOptional}
                    </Text>
                  </View>
                  <View style={styles.foodTypePad}>
                  <FoodTypeSelector
                    selected={restaurantFoodType}
                    onSelect={setRestaurantFoodType}
                  />
                  </View>
                </View>
              )}

              {poi === 'store' && (
                <View style={styles.foodTypeSection}>
                  <View style={styles.questionRow}>
                    <Text style={[styles.questionLabel, { color: palette.text }]}>
                      {COPY.newTaskSheet.subtypeQuestion}
                    </Text>
                  </View>
                  <View style={styles.foodTypePad}>
                    <StoreSubtypeSelector
                      selected={storeSubtype}
                      suggested={suggestedStoreSubtype}
                      onSelect={subtype => {
                        setStoreSubtypeTouched(true);
                        setStoreSubtype(subtype ?? 'any');
                      }}
                    />
                  </View>
                </View>
              )}

              {poiTypeRequiresBrand(poi) && (
                <View style={styles.foodTypeSection}>
                  <View style={styles.questionRow}>
                    <Text style={[styles.questionLabel, { color: palette.text }]}>
                      {COPY.newTaskSheet.brandQuestion}
                    </Text>
                  </View>
                  <View style={styles.foodTypePad}>
                    <BrandSelector
                      poiType={poi}
                      selected={poiBrand}
                      suggested={poiBrandTouched ? null : suggestedBrand}
                      onSelect={brand => {
                        setPoiBrandTouched(true);
                        setPoiBrand(brand);
                      }}
                    />
                  </View>
                </View>
              )}

              {/* ── Category question (optional) ── */}
              <View style={styles.questionRow}>
                <Text style={[styles.questionLabel, { color: palette.text }]}>
                  {COPY.newTaskSheet.catQuestion}
                </Text>
                <Text style={[styles.questionOptional, { color: palette.faint }]}>
                  {COPY.newTaskSheet.catOptional}
                </Text>
              </View>
              <View style={styles.categoryRow}>
                {(Object.keys(categories) as CategoryKey[]).map(key => {
                  const cat    = categories[key];
                  const active = category === key;
                  return (
                    <Pressable
                      key={key}
                      style={[
                        styles.categoryPill,
                        {
                          backgroundColor: active ? palette.text : palette.surface,
                          borderColor:     active ? palette.text : palette.line,
                        },
                      ]}
                      onPress={() => setCategory(active ? null : key)}
                      accessibilityRole="radio"
                      accessibilityLabel={cat.label}
                      accessibilityState={{ selected: active }}>
                      <View style={[styles.categoryDot, { backgroundColor: cat.color }]} />
                      <Text style={[styles.categoryLabel, { color: active ? palette.bg : palette.text }]}>
                        {cat.label}
                      </Text>
                    </Pressable>
                  );
                })}
                {customCategories.map(cat => {
                  const active = category === cat.id;
                  return (
                    <Pressable
                      key={cat.id}
                      style={[
                        styles.categoryPill,
                        {
                          backgroundColor: active ? palette.text : palette.surface,
                          borderColor:     active ? palette.text : palette.line,
                        },
                      ]}
                      onPress={() => setCategory(active ? null : cat.id)}
                      accessibilityRole="radio"
                      accessibilityLabel={cat.name}
                      accessibilityState={{ selected: active }}>
                      <View style={[styles.categoryDot, { backgroundColor: cat.color }]} />
                      <Text style={[styles.categoryLabel, { color: active ? palette.bg : palette.text }]}>
                        {cat.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* ── CTA row ── */}
              <View style={styles.ctaRow}>
                <Pressable
                  style={[styles.ctaGhost, { borderColor: palette.line }]}
                  onPress={handleMoreDetails}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.newTaskSheet2.moreDetailsA11y}>
                  <Text style={[styles.ctaGhostLabel, { color: palette.muted }]}>
                    {COPY.newTaskSheet.moreDetails}
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.ctaSubmit,
                    {
                      backgroundColor: canSubmit && !submitting
                        ? palette.text
                        : palette.surface2,
                    },
                  ]}
                  onPress={handleSubmit}
                  disabled={!canSubmit || submitting}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.newTaskSheet.cta}
                  accessibilityState={{ disabled: !canSubmit || submitting }}>
                  <Text style={[
                    styles.ctaSubmitLabel,
                    { color: canSubmit && !submitting ? palette.bg : palette.muted },
                  ]}>
                    {submitting ? COPY.newTaskSheet.ctaSubmitting : COPY.newTaskSheet.cta}
                  </Text>
                </Pressable>
              </View>

              <View style={[styles.bottomSpacer, { height: 28 + insets.bottom }]} />
            </ScrollView>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    );
  },
);

export default NewTaskSheet;

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Always-mounted overlay host — above TodayScreen (FAB zIndex 5). Inert when
  // closed via pointerEvents, so it never blocks the screen behind it.
  host: {
    zIndex: 50,
  },
  scrim: {
    zIndex: 10,
  },
  kavContainer: {
    flex: 1,
    justifyContent: 'flex-end',
    zIndex: 11,
  },
  sheet: {
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    maxHeight:            '90%',
    // No drop shadows (design spec) — a top border separates the sheet from
    // the scrim behind it instead. Color applied at the call site.
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  handleWrap: {
    alignItems:    'center',
    paddingTop:     8,
    paddingBottom:  4,
  },
  handle: {
    width:        36,
    height:        4,
    borderRadius:  2,
  },
  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: 22,
    paddingTop:         8,
    paddingBottom:     14,
  },
  headerTitle: {
    fontSize:      17,
    fontWeight:    '500',
    fontFamily:    'Geist-Medium',
    letterSpacing: -0.17,
  },
  closeBtn: {
    width:          32,
    height:         32,
    borderRadius:   16,
    alignItems:     'center',
    justifyContent: 'center',
  },
  formScroll: {
    flexGrow: 0,
  },
  fieldPad: {
    paddingHorizontal: 22,
  },
  titleInputWrap: {
    position: 'relative',
  },
  titleInput: {
    fontSize:          16,
    fontFamily:        'Geist-Regular',
    paddingHorizontal: 16,
    paddingVertical:   14,
    borderRadius:      12,
    borderWidth:        1,
  },
  // Overlays the TextInput at the same inset the native placeholder would
  // sit at — derived from titleInput's own borderWidth(1) + padding(16/14),
  // not arbitrary values. Using a rounder spacing-scale number here would
  // shift the overlay 1px off from where typed text actually starts.
  titlePlaceholder: {
    position:          'absolute',
    left:               17, // borderWidth(1) + paddingHorizontal(16)
    top:                15, // borderWidth(1) + paddingVertical(14)
    right:              17,
    fontSize:           16,
    fontFamily:        'Geist-Regular',
  },
  // Sentence-case conversational question labels (KAN-148) — replace the
  // old all-caps micro-labels now that fields read as questions, not forms.
  questionRow: {
    flexDirection:     'row',
    alignItems:        'baseline',
    paddingHorizontal: 22,
    paddingTop:        20,
    paddingBottom:     10,
  },
  questionLabel: {
    fontSize:      15,
    fontWeight:    '500',
    fontFamily:    'Geist-Medium',
    letterSpacing: -0.15,
  },
  questionOptional: {
    fontSize:   13,
    fontFamily: 'Geist-Regular',
  },
  swipeHintRow: {
    flexDirection:     'row',
    justifyContent:    'flex-end',
    paddingHorizontal: 22,
    marginBottom:       8,
  },
  quickPicksHint: {
    fontSize:   11,
    fontFamily: 'Geist-Regular',
  },
  poiRow: {
    flexDirection:     'row',
    paddingLeft:        22,
    paddingBottom:       4,
    gap:                10,
  },
  foodTypePad: {
    paddingLeft:   22,
    paddingTop:     8,
    paddingBottom:  2,
  },
  foodTypeSection: {
    paddingTop: 2,
  },
  carouselMask: {
    // Soft fade on the trailing edge via paddingRight on the content and overflow
  },
  carousel: {
    paddingRight: 22,
    gap:          10,
  },
  poiTile: {
    width:          POI_TILE_WIDTH,
    // Fixed height (fits the tallest variant: icon + label + hint) so a tile
    // never resizes when the "my guess?" hint appears/disappears on it, and
    // every tile in the row — suggestion or catalog — stays the same size.
    height:         84,
    borderRadius:   14,
    borderWidth:     1,
    alignItems:     'center',
    justifyContent: 'center',
    gap:             6,
    paddingTop:     12,
    paddingBottom:  10,
    paddingHorizontal: 4,
  },
  poiTileLabel: {
    fontSize:   11,
    fontFamily: 'Geist-Regular',
    textAlign:  'center',
    letterSpacing: 0.01,
  },
  // KAN-249 — dashed border marks a suggestion as distinct from a chosen POI.
  poiTileSuggested: {
    borderStyle: 'dashed',
  },
  poiTileHint: {
    fontSize:   9,
    fontFamily: fonts.families.regular,
    textAlign:  'center',
  },
  categoryRow: {
    flexDirection:     'row',
    flexWrap:          'wrap',
    gap:                8,
    paddingHorizontal: 22,
  },
  categoryPill: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:                6,
    paddingHorizontal: 12,
    paddingVertical:    8,
    borderRadius:      9999,
    borderWidth:        1,
  },
  categoryDot: {
    width:        8,
    height:       8,
    borderRadius: 4,
  },
  categoryLabel: {
    fontSize:   13,
    fontWeight: '500',
    fontFamily: 'Geist-Medium',
  },
  ctaRow: {
    flexDirection:     'row',
    gap:               10,
    paddingHorizontal: 22,
    paddingTop:        24,
  },
  ctaGhost: {
    paddingHorizontal: 20,
    paddingVertical:   14,
    borderRadius:      12,
    borderWidth:        1,
    alignItems:        'center',
    justifyContent:    'center',
  },
  ctaGhostLabel: {
    fontSize:   14,
    fontWeight: '500',
    fontFamily: 'Geist-Medium',
  },
  ctaSubmit: {
    flex:           1,
    paddingVertical: 14,
    borderRadius:   12,
    alignItems:     'center',
    justifyContent: 'center',
  },
  ctaSubmitLabel: {
    fontSize:   15,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },
  bottomSpacer: {
    height: 28,
  },
});
