/**
 * TaskFormScreen — KAN-143 (create) / KAN-13 (edit)
 *
 * Full-screen task form. In create mode: POI-first, required POI + title before
 * "Add task" is enabled. In edit mode: pre-populated, same layout.
 *
 * POI sources are mutually exclusive:
 *   (a) Free-text POI type (e.g. "bakery", "florist") → becomes task.poi
 *   (b) 4-column quick-pick grid of built-in POI types
 * Choosing one clears the other.
 *
 * Layout: sticky top bar + scrollable body + sticky bottom CTA.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../theme';
import { categories as builtInCategories, categoryHues } from '../../theme/tokens';
import { getScreenKeyboardAvoidingBehavior } from '../../utils/keyboardAvoiding';
import { addTask, updateTask, deleteTask, getCategories, addCategory } from '../../services/firestore';
import { deleteField } from '@react-native-firebase/firestore';
import { inferPoiForQuickAdd, learnFromUserEdit } from '../../services/poiLlm';
import { CakeIcon, CalendarIcon, ClockIcon, CloseIcon, NavigateIcon, PoiIcon } from '../../components/AppIcon';
import type { Category, PoiType, Task } from '../../types';
import { logTap } from '../../services/analytics';
import { QUICK_ACTIONABLE_POI_TYPES, isCatalogPoiType, poiCatalogLabel } from '../../types';
import { todayISO, formatDateShort } from '../../utils/date';
import type { RootStackParamList } from '../../navigation/AppNavigator';
import { COPY } from '../../constants/copy';
import { useToastStore } from '../../store/toastStore';
import RotatingTitlePlaceholder from '../../components/RotatingTitlePlaceholder';
import MiniCalendar from '../../components/MiniCalendar';
import MiniTimePicker from '../../components/MiniTimePicker';
import FoodTypeSelector from '../../components/FoodTypeSelector';
import FinancialServiceKindSelector from '../../components/FinancialServiceKindSelector';
import { scheduleTaskReminder, cancelTaskReminder } from '../../services/notifications';
import { refreshDatedTaskHandoff } from '../../services/datedTaskHandoff';
import { isTaskPoiFarAway, openTakeMeThereMaps, getTakeMeThereA11yLabel } from '../../services/takeMeThere';
import { getTypeSuggestions } from './poiSuggestions';
import { PoiTile } from './PoiTile';
import { POI_TILE_WIDTH, styles } from './styles';
import { localPoiLabel } from '../../services/poiTypeCache';
import type { RestaurantFoodType } from '../../services/restaurantFoodTypes';
import StoreSubtypeSelector from '../../components/StoreSubtypeSelector';
import BrandSelector from '../../components/BrandSelector';
import {
  inferStoreSubtype,
  type StoreSubtype,
} from '../../services/storeSubtypes';
import { findBrandInText, isCanonicalBrandForType, poiTypeRequiresBrand } from '../../services/brandDictionary';
import { inferFinancialServiceKind, type FinancialServiceKind } from '../../services/financialServiceKinds';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskFormParams {
  uid: string;
  task?: Task;
  initialDate?: string;
  initialTitle?: string;
  initialCategory?: string;
  initialPoi?: string;
  initialRestaurantFoodType?: RestaurantFoodType;
  initialFinancialServiceKind?: FinancialServiceKind;
  initialStoreSubtype?: StoreSubtype;
  initialPoiBrand?: string;
  initialStoreSubtypeExplicitlySelected?: boolean;
  initialPoiExplicitlySelected?: boolean;
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function TaskFormScreen() {
  const { palette }  = useTheme();
  const navigation   = useNavigation();
  const insets       = useSafeAreaInsets();
  const route        = useRoute<RouteProp<RootStackParamList, 'TaskForm'>>();

  const { uid, task: existingTask, initialDate, initialTitle, initialCategory, initialPoi, initialRestaurantFoodType, initialFinancialServiceKind, initialStoreSubtype, initialPoiBrand, initialStoreSubtypeExplicitlySelected, initialPoiExplicitlySelected } = route.params;
  const isEdit = !!existingTask;
  const hasExplicitInitialPoi = Boolean(existingTask?.poi || initialPoiExplicitlySelected);

  // ── Form state ──────────────────────────────────────────────────────────────

  const [title,    setTitle]    = useState(existingTask?.title    ?? initialTitle ?? '');
  const [category, setCategory] = useState<string | null>(existingTask?.category ?? initialCategory ?? null);
  const [notes,    setNotes]    = useState(existingTask?.description ?? '');
  // Rotating title placeholder freezes permanently once the user taps the field (KAN-149).
  const [titleFocused, setTitleFocused] = useState(false);

  // Due date
  const [date, setDate] = useState<string | null>(() => {
    if (existingTask?.scheduledDate) { return existingTask.scheduledDate; }
    if (initialDate)        { return initialDate; }
    return null;
  });

  const [dateFieldOpen, setDateFieldOpen] = useState(false);

  // Time
  const [time, setTime] = useState<string>(existingTask?.time ?? '');
  const [timeFieldOpen, setTimeFieldOpen] = useState(false);

  // Birthday toggle (KAN-248) — edit-mode-only correction path for import
  // detection misses. Never shown/settable from the create flow.
  const [isBirthday, setIsBirthday] = useState(existingTask?.kind === 'birthday');

  const handleBirthdayToggle = useCallback((next: boolean) => {
    if (next) {
      Alert.alert(
        COPY.taskFormScreen.birthdayWarningTitle,
        COPY.taskFormScreen.birthdayWarningBody,
        [
          { text: COPY.taskFormScreen.cancel, style: 'cancel' },
          {
            text: COPY.taskFormScreen.birthdayWarningConfirm,
            onPress: () => {
              setIsBirthday(true);
              userTouchedPoiRef.current = true;
              setPoiKey(null);
              setCustomPoiType(null);
              setQuery('');
              setCategory('personal');
            },
          },
        ],
      );
    } else {
      Alert.alert(
        COPY.taskFormScreen.birthdayUnsetWarningTitle,
        COPY.taskFormScreen.birthdayUnsetWarningBody,
        [
          { text: COPY.taskFormScreen.cancel, style: 'cancel' },
          {
            text: COPY.taskFormScreen.birthdayUnsetWarningConfirm,
            style: 'destructive',
            onPress: () => setIsBirthday(false),
          },
        ],
      );
    }
  }, []);

  // POI — two mutually exclusive sources
  const [poiKey,   setPoiKey]   = useState<PoiType | null>(
    isCatalogPoiType(existingTask?.poi)
      ? existingTask!.poi
      : isCatalogPoiType(initialPoi)
        ? initialPoi
        : null,
  );

  // Free-text POI type — mutually exclusive with poiKey.
  // query    = display text in the input (friendly label after a suggestion is picked)
  // customPoiType = resolved type key to save (e.g. "bus_station"); null while still typing
  const [query,         setQuery]         = useState(() => {
    if (existingTask?.poi && !isCatalogPoiType(existingTask.poi)) { return localPoiLabel(existingTask.poi); }
    if (initialPoi && !isCatalogPoiType(initialPoi)) { return localPoiLabel(initialPoi); }
    return '';
  });
  const [customPoiType, setCustomPoiType] = useState<string | null>(() => {
    if (existingTask?.poi && !isCatalogPoiType(existingTask.poi)) { return existingTask.poi; }
    if (initialPoi && !isCatalogPoiType(initialPoi)) { return initialPoi; }
    return null;
  });
  const [restaurantFoodType, setRestaurantFoodType] = useState<RestaurantFoodType | null>(
    existingTask?.poi === 'restaurant'
      ? existingTask.restaurantFoodType ?? null
      : initialPoi === 'restaurant' ? initialRestaurantFoodType ?? null : null,
  );
  const [financialServiceKind, setFinancialServiceKind] = useState<FinancialServiceKind | null>(
    existingTask?.poi === 'financial_service'
      ? existingTask.financialServiceKind ?? null
      : initialPoi === 'financial_service' ? initialFinancialServiceKind ?? null : null,
  );
  const [storeSubtype, setStoreSubtype] = useState<StoreSubtype | null>(
    existingTask?.poi === 'store'
      ? existingTask.storeSubtype ?? null
      : initialPoi === 'store'
        ? initialStoreSubtype ?? null
        : null,
  );
  const [storeSubtypeTouched, setStoreSubtypeTouched] = useState(
    Boolean(existingTask?.storeSubtype || initialStoreSubtypeExplicitlySelected),
  );
  const [poiBrand, setPoiBrand] = useState<string | null>(() =>
    poiTypeRequiresBrand(existingTask?.poi) ? existingTask?.poiBrand ?? null
      : poiTypeRequiresBrand(initialPoi) ? initialPoiBrand ?? null : null,
  );
  const [poiBrandTouched, setPoiBrandTouched] = useState(Boolean(existingTask?.poiBrand || initialPoiBrand));
  const previousBrandPoiRef = useRef<string | null>(poiKey ?? customPoiType);
  const [focused,       setFocused]       = useState(false);
  const [suggestedPoi, setSuggestedPoi] = useState<string | null>(
    existingTask?.poi ?? (hasExplicitInitialPoi ? null : initialPoi ?? null),
  );
  const [suggestedTitle, setSuggestedTitle] = useState<string | null>(
    hasExplicitInitialPoi ? (existingTask?.title?.trim() || null) : (initialTitle?.trim() || existingTask?.title?.trim() || null),
  );
  const [poiTouched, setPoiTouched] = useState(hasExplicitInitialPoi);
  const userTouchedPoiRef = useRef(hasExplicitInitialPoi);
  const inferenceRequestIdRef = useRef(0);

  // Custom categories — one-shot fetch on mount (KAN-218). handleSaveNewCat
  // appends the newly created category locally rather than refetching.
  const [customCategories, setCustomCategories] = useState<Category[]>([]);
  useEffect(() => {
    getCategories(uid)
      .then(cats => setCustomCategories(cats.filter(c => !c.isBuiltIn)))
      .catch(err => console.warn('[TaskFormScreen] categories error', err));
  }, [uid]);

  // "Take me there" (KAN-279) — edit mode only. Only question the app asks
  // itself: is this task's POI type NOT the one currently on the Nearby
  // card? Synchronous, no location fetch — visibility never depends on a
  // permission/GPS round-trip. The actual position is only fetched at tap
  // time, right before opening Maps.
  const takeMeThereFar = isEdit && !!existingTask && !isBirthday
    && !!existingTask.poi && isTaskPoiFarAway(existingTask.poi);

  // Inline new-category editor
  const [addingCat,   setAddingCat]   = useState(false);
  const [newCatName,  setNewCatName]  = useState('');
  const [newCatColor, setNewCatColor] = useState<string>(categoryHues[0]);
  const [newCatSaving, setNewCatSaving] = useState(false);

  const handleOpenNewCat = useCallback(() => {
    setNewCatName('');
    setNewCatColor(categoryHues[0]);
    setNewCatSaving(false);
    setAddingCat(true);
  }, []);

  const handleSaveNewCat = useCallback(async () => {
    const trimmed = newCatName.trim();
    if (!trimmed) { return; }
    setNewCatSaving(true);
    try {
      const id = await addCategory(uid, { name: trimmed, color: newCatColor });
      // No live listener anymore (KAN-218) — append locally instead of refetching.
      setCustomCategories(prev => [...prev, { id, name: trimmed, color: newCatColor, isBuiltIn: false }]);
      setCategory(id);
      setAddingCat(false);
    } catch (err) {
      console.warn('[TaskFormScreen] addCategory error', err);
    } finally {
      setNewCatSaving(false);
    }
  }, [uid, newCatName, newCatColor]);

  // ── Submit ──────────────────────────────────────────────────────────────────

  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<TextInput>(null);

  // ── Keeping Notes above the keyboard (KAN-369) ──────────────────────────────
  //
  // Notes is the last section of the scroll content, so an opening keyboard
  // lands right on top of it, and nothing moves it on its own: Android's
  // KeyboardAvoidingView is deliberately a no-op (windowSoftInputMode
  // adjustResize is meant to own the resize — see
  // getScreenKeyboardAvoidingBehavior) and automaticallyAdjustKeyboardInsets
  // is iOS-only.
  //
  // Scrolling alone is not enough, because the resize cannot be relied on:
  // under edge-to-edge the window keeps its full height and the keyboard
  // simply covers it, so there is no extra scroll range to move Notes into.
  // NewTaskSheet hit the same wall and moves itself off the keyboard metrics
  // (see its kbOffset) — do the same here.
  //
  // Rather than assume either behaviour, derive the overlap: the screen's own
  // box runs from the top of the window down by its measured height, and
  // keyboardDidShow reports where the keyboard's top edge lands. Pad the
  // content by whatever the keyboard reaches into that box, then scroll Notes
  // into view inside the lifted viewport. When the OS did resize the window,
  // the box already ends at the keyboard, the overlap clamps to 0 and this
  // stays inert — the double-compensation bug the hotfix warned about cannot
  // come back.
  const scrollRef       = useRef<ScrollView>(null);
  const notesOffsetRef  = useRef<number | null>(null);
  const notesFocusedRef = useRef(false);
  // Height of everything this screen draws — i.e. the app window's height.
  const screenHeightRef = useRef(0);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const handleNotesLayout = useCallback((e: LayoutChangeEvent) => {
    notesOffsetRef.current = e.nativeEvent.layout.y;
  }, []);

  const handleLiftLayout = useCallback((e: LayoutChangeEvent) => {
    // Measured with the lift already applied, so add it back to recover the
    // unlifted height the next overlap calculation needs.
    screenHeightRef.current = e.nativeEvent.layout.height + keyboardInset;
  }, [keyboardInset]);

  const scrollNotesIntoView = useCallback(() => {
    const y = notesOffsetRef.current;
    if (y == null) { return; }
    // Leave the section label visible above the box.
    scrollRef.current?.scrollTo({ y: Math.max(y - 24, 0), animated: true });
  }, []);

  const handleNotesFocus = useCallback(() => {
    notesFocusedRef.current = true;
    scrollNotesIntoView();
  }, [scrollNotesIntoView]);

  const handleNotesBlur = useCallback(() => {
    notesFocusedRef.current = false;
  }, []);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', e => {
      // How far the keyboard reaches into the screen's own box. When the OS
      // resized the window, the box already ends at (or above) the keyboard
      // and this clamps to 0 — no double compensation.
      setKeyboardInset(Math.max(screenHeightRef.current - e.endCoordinates.screenY, 0));
      if (notesFocusedRef.current) { scrollNotesIntoView(); }
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardInset(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [scrollNotesIntoView]);

  useEffect(() => {
    const myRequestId = ++inferenceRequestIdRef.current;
    const trimmed = title.trim();

    if (!userTouchedPoiRef.current) {
      // Title edits invalidate any still-unconfirmed inferred POI immediately,
      // so a stale guess never remains active while the next debounce runs.
      setPoiKey(null);
      setCustomPoiType(null);
      setQuery('');
      setSuggestedPoi(null);
      setSuggestedTitle(trimmed || null);
    }

    if (!trimmed) { return; }

    const timer = setTimeout(() => {
      if (inferenceRequestIdRef.current !== myRequestId) { return; }

      inferPoiForQuickAdd(trimmed)
        .then(suggestion => {
          if (inferenceRequestIdRef.current !== myRequestId) { return; }

          if (!suggestion) {
            setSuggestedPoi(null);
            setSuggestedTitle(trimmed);
            if (!userTouchedPoiRef.current) {
              setPoiKey(null);
              setCustomPoiType(null);
              setQuery('');
            }
            return;
          }

          setSuggestedPoi(suggestion);
          setSuggestedTitle(trimmed);

          if (userTouchedPoiRef.current) { return; }

          if (isCatalogPoiType(suggestion)) {
            setPoiKey(suggestion);
            setCustomPoiType(null);
            setQuery('');
            return;
          }

          setPoiKey(null);
          setCustomPoiType(suggestion);
          setQuery(localPoiLabel(suggestion));
        })
        .catch(() => {
          if (userTouchedPoiRef.current || inferenceRequestIdRef.current !== myRequestId) { return; }
          setPoiKey(null);
          setCustomPoiType(null);
          setQuery('');
          setSuggestedPoi(null);
          setSuggestedTitle(trimmed);
        });
    }, 350);

    return () => clearTimeout(timer);
  }, [title]);

  // poi is required: quick-pick key → customPoiType (from suggestion) → raw query text
  const effectivePoi: string | null = poiKey ?? customPoiType ?? (query.trim() || null);

  useEffect(() => {
    if (effectivePoi !== 'restaurant') { setRestaurantFoodType(null); }
    if (effectivePoi !== 'financial_service') { setFinancialServiceKind(null); }
    if (effectivePoi !== 'store') {
      setStoreSubtype(null);
      setStoreSubtypeTouched(false);
    }
    if (previousBrandPoiRef.current !== effectivePoi || !poiTypeRequiresBrand(effectivePoi)) {
      setPoiBrand(null);
      setPoiBrandTouched(false);
    }
    previousBrandPoiRef.current = effectivePoi;
  }, [effectivePoi]);

  useEffect(() => {
    if (effectivePoi !== 'store' || storeSubtypeTouched) { return; }
    setStoreSubtype(inferStoreSubtype(title.trim()) ?? 'any');
  }, [effectivePoi, storeSubtypeTouched, title]);

  useEffect(() => {
    if (effectivePoi !== 'financial_service') return;
    setFinancialServiceKind(current => current ?? inferFinancialServiceKind(title.trim()));
  }, [effectivePoi, title]);

  const suggestedBrand = poiTypeRequiresBrand(effectivePoi) ? findBrandInText(effectivePoi, title) : null;
  useEffect(() => {
    if (!poiTypeRequiresBrand(effectivePoi) || poiBrandTouched) { return; }
    setPoiBrand(suggestedBrand);
  }, [effectivePoi, poiBrandTouched, suggestedBrand]);

  // Suggestions shown while the user is actively typing (hidden once a suggestion is selected)
  const suggestions = !customPoiType && query.trim() ? getTypeSuggestions(query) : [];
  // Birthday tasks are exempt from the POI requirement (KAN-248) — date-shaped, not place-shaped.
  const canSubmit = title.trim().length > 0 && (isBirthday || (
    effectivePoi !== null && (!poiTypeRequiresBrand(effectivePoi) || isCanonicalBrandForType(effectivePoi, poiBrand))
  ));
  const suggestionType = suggestedTitle === title.trim() ? suggestedPoi : null;
  const suggestionLabel = suggestionType
    ? (isCatalogPoiType(suggestionType) ? poiCatalogLabel(suggestionType) : localPoiLabel(suggestionType))
    : null;
  const suggestionSelected = suggestionType !== null && effectivePoi === suggestionType;
  const liveSuggestion = suggestionType !== null && (
    (suggestionSelected && !poiTouched)
    || (isEdit && !suggestionSelected && suggestionType !== existingTask?.poi)
  );
  const confirmedSuggestion = suggestionType !== null && suggestionSelected && poiTouched;
  const showSuggestionHint = liveSuggestion || suggestionType === null;
  const suggestionHighlighted = liveSuggestion || suggestionSelected;
  const suggestedStoreSubtype = effectivePoi === 'store' && storeSubtype && !storeSubtypeTouched && storeSubtype !== 'any'
    ? storeSubtype
    : null;

  const handleSave = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || (!isBirthday && (!effectivePoi || (poiTypeRequiresBrand(effectivePoi) && !isCanonicalBrandForType(effectivePoi, poiBrand))))) { return; }

    setSubmitting(true);
    try {
      const payload: Omit<Task, 'id' | 'createdAt' | 'completedAt'> = {
        title:    trimmed,
        category: isBirthday ? 'personal' : (category ?? 'personal'),
        done:     existingTask?.done ?? false,
        ...(date ? {
          scheduledDate: date,
          originalScheduledDate: existingTask?.originalScheduledDate ?? existingTask?.scheduledDate ?? date,
        } : {}),
        ...(time.trim() ? { time: time.trim() } : {}),
        ...(isBirthday ? { kind: 'birthday' as const } : { poi: effectivePoi! }),
        ...(!isBirthday && effectivePoi === 'store' ? { storeSubtype: storeSubtype ?? 'any' } : {}),
        ...(!isBirthday && effectivePoi === 'restaurant' && restaurantFoodType ? { restaurantFoodType } : {}),
        ...(!isBirthday && effectivePoi === 'financial_service' && financialServiceKind ? { financialServiceKind } : {}),
        ...(!isBirthday && poiTypeRequiresBrand(effectivePoi) && isCanonicalBrandForType(effectivePoi, poiBrand) ? { poiBrand } : {}),
      };

      if (notes.trim()) {
        // notes stored as description for backwards compat with task model
        (payload as any).description = notes.trim();
      }

      if (isEdit && existingTask) {
        // Toggling the birthday flag needs an explicit field delete on the
        // side that's turning off — updateDoc merges, it never clears a
        // field just because the new payload omits it.
        const updateData: Record<string, unknown> = { ...payload };
        if (isBirthday) {
          updateData.poi = deleteField();
          updateData.storeSubtype = deleteField();
          updateData.restaurantFoodType = deleteField();
          updateData.financialServiceKind = deleteField();
          updateData.poiBrand = deleteField();
        } else if (existingTask.kind === 'birthday') {
          updateData.kind = deleteField();
        }
        if (!isBirthday && effectivePoi !== 'store') {
          updateData.storeSubtype = deleteField();
        }
        if (!isBirthday && (effectivePoi !== 'restaurant' || !restaurantFoodType)) {
          updateData.restaurantFoodType = deleteField();
        }
        if (!isBirthday && (effectivePoi !== 'financial_service' || !financialServiceKind)) {
          updateData.financialServiceKind = deleteField();
        }
        if (!isBirthday && !poiTypeRequiresBrand(effectivePoi)) {
          updateData.poiBrand = deleteField();
        }
        if (!date) {
          updateData.scheduledDate = deleteField();
          updateData.originalScheduledDate = deleteField();
        }
        if (!time.trim()) {
          updateData.time = deleteField();
        }
        await updateTask(uid, existingTask.id, updateData as Partial<Task>);
        logTap('task_edit', { category: payload.category });
        // A time reminder is valid only when both a date and a time remain.
        // Clearing either one must cancel the prior trigger explicitly.
        if (date && time.trim()) {
          await scheduleTaskReminder({
            taskId:    existingTask.id,
            taskTitle: trimmed,
            date,
            time:      time.trim(),
          }).catch(() => {});
        } else {
          cancelTaskReminder(existingTask.id).catch(() => {});
        }
        await Promise.all([
          existingTask.scheduledDate
            ? refreshDatedTaskHandoff(uid, existingTask.scheduledDate)
            : Promise.resolve(),
          date && date !== existingTask.scheduledDate
            ? refreshDatedTaskHandoff(uid, date)
            : Promise.resolve(),
        ]).catch(() => {});
      } else {
        const newTaskId = await addTask(uid, payload);
        logTap('task_create', { category: payload.category });
        useToastStore.getState().showToast(COPY.newTaskSheet.confirmToast);
        if (date && time.trim()) {
          await scheduleTaskReminder({
            taskId:    newTaskId,
            taskTitle: trimmed,
            date,
            time:      time.trim(),
          }).catch(() => {});
        }
        if (date) {
          await refreshDatedTaskHandoff(uid, date).catch(() => {});
        }
      }

      // Feed the user's title→POI choice back into the inference dictionary
      // (KAN-197) so future imports recognise it. The user is the source of
      // truth. Best-effort and non-blocking — never affects the save.
      if (effectivePoi) {
        learnFromUserEdit(uid, trimmed, effectivePoi, 'en').catch(() => {});
      }

      navigation.goBack();
    } catch (err) {
      console.warn('[TaskFormScreen] save error', err);
    } finally {
      setSubmitting(false);
    }
  }, [title, category, effectivePoi, storeSubtype, restaurantFoodType, financialServiceKind, poiBrand, time, date, notes, uid, isEdit, existingTask, isBirthday, navigation]);

  // ── Delete (edit mode only) ─────────────────────────────────────────────────

  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(() => {
    if (!existingTask) { return; }
    Alert.alert(
      COPY.taskFormScreen.deleteConfirmTitle,
      existingTask.title,
      [
        { text: COPY.taskFormScreen.cancel, style: 'cancel' },
        {
          text: COPY.taskFormScreen.delete,
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteTask(uid, existingTask.id);
              // Best-effort — a notifee failure here must never block
              // navigation or be reported as a delete failure.
              cancelTaskReminder(existingTask.id).catch(() => {});
              if (existingTask.scheduledDate) {
                refreshDatedTaskHandoff(uid, existingTask.scheduledDate).catch(() => {});
              }
              logTap('task_delete', { category: existingTask.category });
              navigation.goBack();
            } catch (err) {
              console.warn('[TaskFormScreen] delete error', err);
              setDeleting(false);
            }
          },
        },
      ],
    );
  }, [uid, existingTask, navigation]);

  // ── Category list ───────────────────────────────────────────────────────────

  const allCategories: { id: string; label: string; color: string }[] = [
    ...Object.entries(builtInCategories).map(([key, val]) => ({
      id: key, label: val.label, color: val.color,
    })),
    ...customCategories.map(c => ({ id: c.id, label: c.name, color: c.color })),
  ];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.bg }]}
      behavior={getScreenKeyboardAvoidingBehavior()}>

      {/* Everything the screen draws, lifted clear of the keyboard when the
          window itself did not move (KAN-369). */}
      <View
        testID="task-form-lift"
        onLayout={handleLiftLayout}
        style={[styles.lift, { paddingBottom: keyboardInset }]}>

      {/* ── Sticky top bar ── */}
      <View style={[
        styles.topBar,
        {
          paddingTop:        insets.top + 8,
          borderBottomColor: palette.line,
          backgroundColor:   palette.bg,
        },
      ]}>
        <Pressable
          onPress={() => navigation.goBack()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={COPY.taskFormScreen.goBackA11y}
          style={styles.backBtn}>
          <Text style={[styles.backLabel, { color: palette.muted }]}>‹</Text>
        </Pressable>
        <Text style={[styles.topBarTitle, { color: palette.text }]}>
          {isEdit ? COPY.taskFormScreen.editTaskTitle : COPY.newTaskSheet.title}
        </Text>
        {takeMeThereFar ? (
          <Pressable
            onPress={() => { openTakeMeThereMaps(existingTask!.poi!).catch(() => {}); }}
            hitSlop={12}
            style={styles.topBarRight}
            accessibilityRole="button"
            accessibilityLabel={getTakeMeThereA11yLabel(existingTask!.poi!)}>
            <NavigateIcon color={palette.muted} size={20} />
          </Pressable>
        ) : (
          <View style={styles.topBarRight} />
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        testID="task-form-scroll"
        style={[styles.scrollView, { backgroundColor: palette.bg }]}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: insets.bottom + 120 },
        ]}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* ── Title — no section label (header + placeholder already ask it) ── */}
        <View style={styles.section}>
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
              returnKeyType="next"
              maxLength={200}
              accessibilityLabel={isEdit ? COPY.taskFormScreen.taskTitleA11y : COPY.newTaskSheet.title}
            />
            {/* Rotating example placeholder — same component as the quick sheet (KAN-148) */}
            {!isEdit && !titleFocused && title.length === 0 && (
              <RotatingTitlePlaceholder
                examples={COPY.newTaskSheet.titleExamples}
                active={!titleFocused}
                style={[styles.titlePlaceholder, { color: palette.muted }]}
              />
            )}
          </View>
        </View>

        {/* ── Birthday toggle (KAN-248, edit-mode-only correction path) ── */}
        {isEdit && (
          <View style={styles.section}>
            <Pressable
              onPress={() => handleBirthdayToggle(!isBirthday)}
              style={styles.birthdayToggleRow}
              accessibilityRole="switch"
              accessibilityState={{ checked: isBirthday }}
              accessibilityLabel={COPY.taskFormScreen.birthdayToggleA11y}>
              <CakeIcon color={palette.muted} size={18} />
              <View style={styles.birthdayToggleText}>
                <Text style={[styles.questionLabel, { color: palette.text }]}>
                  {COPY.taskFormScreen.birthdayToggleLabel}
                </Text>
                <Text style={[styles.birthdayToggleSublabel, { color: palette.muted }]}>
                  {COPY.taskFormScreen.birthdayToggleSublabel}
                </Text>
              </View>
              <Switch
                value={isBirthday}
                onValueChange={handleBirthdayToggle}
                trackColor={{ false: palette.surface2, true: palette.accent }}
                thumbColor={palette.bg}
              />
            </Pressable>
          </View>
        )}

        {/* ── Where does this happen? ── */}
        {!isBirthday && (
        <View style={styles.section}>
          <View style={styles.questionRow}>
            <Text style={[styles.questionLabel, { color: palette.text }]}>
              {COPY.newTaskSheet.poiQuestion}
            </Text>
          </View>

          {/* Search field */}
          <View style={[
            styles.searchWrap,
            {
              backgroundColor: palette.surface,
              borderColor:     focused ? palette.nearBorder : palette.line,
            },
          ]}>
            <PoiIcon type="store" color={palette.faint} size={16} />
            <TextInput
              style={[styles.searchInput, { color: palette.text }]}
              placeholder={COPY.newTaskSheet.poiSearchPlaceholder}
              placeholderTextColor={palette.muted}
              value={query}
              onChangeText={v => {
                userTouchedPoiRef.current = true;
                setQuery(v);
                setCustomPoiType(null); // user is typing freely again
                if (v) { setPoiKey(null); }
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              returnKeyType="done"
            />
            {!!query && (
              <Pressable
                onPress={() => { setQuery(''); setCustomPoiType(null); }}
                hitSlop={8}
                accessibilityLabel={COPY.taskFormScreen.clearSearchA11y}>
                <CloseIcon color={palette.muted} size={16} />
              </Pressable>
            )}
          </View>

          {/* Type suggestions dropdown */}
          {suggestions.length > 0 && (
            <View style={[styles.dropdown, { backgroundColor: palette.bg, borderColor: palette.line }]}>
              {suggestions.map((s, i) => (
                <Pressable
                  key={s.type}
                  style={[
                    styles.dropdownRow,
                    i < suggestions.length - 1 && { borderBottomWidth: 1, borderBottomColor: palette.line },
                  ]}
                  onPress={() => {
                    userTouchedPoiRef.current = true;
                    setQuery(s.label);
                    setCustomPoiType(s.type);
                    setPoiKey(null);
                  }}>
                  <PoiIcon type={s.type} color={palette.muted} size={18} />
                  <Text style={[styles.dropdownLabel, { color: palette.text }]}>{s.label}</Text>
                </Pressable>
              ))}
            </View>
          )}

          <View style={styles.swipeHintRow}>
            <Text style={[styles.quickPicksHint, { color: palette.faint }]}>
              {COPY.newTaskSheet.swipeHint}
            </Text>
          </View>

          <View style={styles.poiRow}>
            <Pressable
              onPress={() => {
                if (suggestionType === null) { return; }
                const isLiveGuess = !poiTouched && effectivePoi === suggestionType;
                userTouchedPoiRef.current = true;
                setPoiTouched(true);
                if (isLiveGuess) { return; }
                if (effectivePoi === suggestionType) {
                  setPoiKey(null);
                  setCustomPoiType(null);
                  setQuery('');
                  return;
                }
                if (isCatalogPoiType(suggestionType)) {
                  setPoiKey(suggestionType);
                  setCustomPoiType(null);
                  setQuery('');
                  logTap('poi_chip_tap', { poi_type: suggestionType });
                  return;
                }
                setPoiKey(null);
                setCustomPoiType(suggestionType);
                setQuery(localPoiLabel(suggestionType));
              }}
              disabled={suggestionType === null}
              accessibilityRole="radio"
              accessibilityLabel={
                !suggestionLabel
                  ? COPY.newTaskSheet.poiSuggestionHint
                  : showSuggestionHint
                    ? `${suggestionLabel}, ${COPY.newTaskSheet.poiSuggestionHint}`
                    : `${suggestionLabel} ${COPY.newTaskSheet.poiSuggestionConfirmedSuffix}`
              }
              accessibilityState={{ selected: suggestionSelected, disabled: suggestionType === null }}
              style={[
                styles.poiTile,
                (showSuggestionHint || confirmedSuggestion) && styles.poiTileSuggested,
                {
                  width: POI_TILE_WIDTH,
                  backgroundColor: liveSuggestion
                    ? palette.nearTint
                    : confirmedSuggestion
                      ? palette.nearTint2
                      : suggestionType
                        ? palette.surface
                        : palette.nearTint,
                  borderColor: liveSuggestion || confirmedSuggestion || suggestionType === null
                    ? palette.nearBorder
                    : palette.line,
                },
              ]}>
              {suggestionType !== null && suggestionLabel && (
                <>
                  <PoiIcon
                    type={suggestionType}
                    color={suggestionHighlighted ? palette.nearText : palette.muted}
                    size={22}
                  />
                  <Text
                    style={[
                      styles.poiTileLabel,
                      { color: suggestionHighlighted ? palette.nearText : palette.muted },
                    ]}
                    numberOfLines={1}
                    ellipsizeMode="tail">
                    {suggestionLabel}
                  </Text>
                </>
              )}
              {showSuggestionHint && (
                <Text
                  style={[styles.poiTileHint, { color: palette.nearText }]}
                  numberOfLines={1}>
                  {COPY.newTaskSheet.poiSuggestionHint}
                </Text>
              )}
            </Pressable>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.poiCarousel}
              snapToInterval={POI_TILE_WIDTH + 10}
              decelerationRate="fast"
              style={styles.poiCarouselMask}>
              {QUICK_ACTIONABLE_POI_TYPES.map(type => (
                <PoiTile
                  key={type}
                  type={type}
                  label={poiCatalogLabel(type)}
                  selected={poiKey === type}
                  onPress={() => {
                    userTouchedPoiRef.current = true;
                    setPoiTouched(true);
                    const next = poiKey === type ? null : type;
                    setPoiKey(next);
                    if (next) {
                      setQuery('');
                      setCustomPoiType(null);
                      logTap('poi_chip_tap', { poi_type: type });
                    }
                  }}
                  palette={palette}
                  width={POI_TILE_WIDTH}
                />
              ))}
            </ScrollView>
          </View>

          {effectivePoi === 'restaurant' && (
            <View style={styles.subtypeSection}>
              <View style={styles.questionRow}>
                <Text style={[styles.questionLabel, { color: palette.text }]}>
                  {COPY.newTaskSheet.subtypeQuestion}
                </Text>
                <Text style={[styles.questionOptional, { color: palette.faint }]}>
                  {COPY.newTaskSheet.catOptional}
                </Text>
              </View>
              <FoodTypeSelector
                selected={restaurantFoodType}
                onSelect={setRestaurantFoodType}
              />
            </View>
          )}

          {effectivePoi === 'store' && (
            <View style={styles.subtypeSection}>
              <View style={styles.questionRow}>
                <Text style={[styles.questionLabel, { color: palette.text }]}>
                  {COPY.newTaskSheet.subtypeQuestion}
                </Text>
              </View>
              <StoreSubtypeSelector
                selected={storeSubtype}
                suggested={suggestedStoreSubtype}
                onSelect={subtype => {
                  setStoreSubtypeTouched(true);
                  setStoreSubtype(subtype ?? 'any');
                }}
              />
            </View>
          )}

          {effectivePoi === 'financial_service' && (
            <View style={styles.subtypeSection}>
              <View style={styles.questionRow}>
                <Text style={[styles.questionLabel, { color: palette.text }]}>
                  {COPY.newTaskSheet.subtypeQuestion}
                </Text>
                <Text style={[styles.questionOptional, { color: palette.faint }]}>
                  {COPY.newTaskSheet.catOptional}
                </Text>
              </View>
              <FinancialServiceKindSelector selected={financialServiceKind} onSelect={setFinancialServiceKind} />
            </View>
          )}

          {poiTypeRequiresBrand(effectivePoi) && (
            <View style={styles.subtypeSection}>
              <View style={styles.questionRow}>
                <Text style={[styles.questionLabel, { color: palette.text }]}>
                  {COPY.newTaskSheet.brandQuestion}
                </Text>
              </View>
              <BrandSelector
                poiType={effectivePoi}
                selected={poiBrand}
                suggested={poiBrandTouched ? null : suggestedBrand}
                onSelect={brand => {
                  setPoiBrandTouched(true);
                  setPoiBrand(brand);
                }}
              />
            </View>
          )}
        </View>
        )}

        {/* ── Which part of your life? (optional) ── */}
        {!isBirthday && (
        <View style={styles.section}>
          <View style={styles.questionRow}>
            <Text style={[styles.questionLabel, { color: palette.text }]}>
              {COPY.newTaskSheet.catQuestion}
            </Text>
            <Text style={[styles.questionOptional, { color: palette.faint }]}>
              {COPY.newTaskSheet.catOptional}
            </Text>
          </View>
          <View style={styles.categoryRow}>
            {allCategories.map(cat => {
              const active = category === cat.id;
              return (
                <Pressable
                  key={cat.id}
                  onPress={() => setCategory(active ? null : cat.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={[
                    styles.categoryPill,
                    {
                      backgroundColor: active ? cat.color + '22' : palette.surface,
                      borderColor:     active ? cat.color       : palette.line,
                    },
                  ]}>
                  <View style={[styles.categoryDot, { backgroundColor: cat.color }]} />
                  <Text style={[styles.categoryLabel, { color: active ? cat.color : palette.text }]}>
                    {cat.label}
                  </Text>
                </Pressable>
              );
            })}

            {/* ＋ New chip */}
            {!addingCat && (
              <Pressable
                onPress={handleOpenNewCat}
                accessibilityRole="button"
                accessibilityLabel={COPY.taskFormScreen.createNewCategoryA11y}
                style={[styles.newCatChip, { borderColor: palette.line, backgroundColor: palette.surface }]}>
                <Text style={[styles.newCatChipLabel, { color: palette.muted }]}>＋ New</Text>
              </Pressable>
            )}
          </View>

          {/* Inline category editor */}
          {addingCat && (
            <View style={[styles.catEditor, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <View style={styles.catEditorRow}>
                <View style={[styles.catColorPreview, { backgroundColor: newCatColor }]} />
                <TextInput
                  style={[styles.catNameInput, { color: palette.text }]}
                  placeholder={COPY.taskFormScreen.categoryNamePlaceholder}
                  placeholderTextColor={palette.faint}
                  value={newCatName}
                  onChangeText={setNewCatName}
                  autoFocus
                  maxLength={40}
                />
              </View>
              <View style={styles.swatchRow}>
                {categoryHues.map(c => (
                  <Pressable
                    key={c}
                    onPress={() => setNewCatColor(c)}
                    style={[
                      styles.swatch,
                      { backgroundColor: c },
                      newCatColor === c && [styles.swatchSelected, { borderColor: palette.text }],
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: newCatColor === c }}
                  />
                ))}
              </View>
              <View style={styles.catEditorActions}>
                <Pressable
                  onPress={() => setAddingCat(false)}
                  style={[styles.catActionBtn, { borderColor: palette.line }]}
                  accessibilityRole="button">
                  <Text style={[styles.catActionLabel, { color: palette.muted }]}>{COPY.taskFormScreen.cancel}</Text>
                </Pressable>
                <Pressable
                  onPress={handleSaveNewCat}
                  disabled={!newCatName.trim() || newCatSaving}
                  style={[
                    styles.catActionBtn,
                    styles.catActionBtnPrimary,
                    { backgroundColor: newCatName.trim() ? palette.text : palette.surface2 },
                  ]}
                  accessibilityRole="button">
                  <Text style={[
                    styles.catActionLabel,
                    { color: newCatName.trim() ? palette.bg : palette.muted },
                  ]}>
                    {newCatSaving ? 'Saving…' : 'Add category'}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
        )}

        {/* ── Around when? (optional) ── */}
        <View style={styles.section}>
          <View style={styles.questionRow}>
            <Text style={[styles.questionLabel, { color: palette.text }]}>
              {COPY.newTaskSheet.timeQuestion}
            </Text>
            <Text style={[styles.questionOptional, { color: palette.faint }]}>
              {COPY.newTaskSheet.timeOptional}
            </Text>
          </View>
          <View style={styles.scheduleRow}>
            {/* Date */}
            <Pressable
              style={[
                styles.scheduleField,
                { backgroundColor: palette.surface, borderColor: dateFieldOpen ? palette.text : palette.line },
              ]}
              onPress={() => setDateFieldOpen(o => !o)}
              accessibilityRole="button"
              accessibilityLabel={COPY.newTaskSheet.timeQuestion}>
              <CalendarIcon color={palette.faint} size={16} />
              <Text style={[styles.scheduleInput, { color: date ? palette.text : palette.muted, fontVariant: ['tabular-nums'] }]}>
                {date
                  ? (date === todayISO() ? `Today · ${formatDateShort(date)}` : formatDateShort(date))
                  : COPY.newTaskSheet.datePlaceholder}
              </Text>
              {date && (
                <Pressable
                  onPress={(e) => { e.stopPropagation(); setDate(null); setDateFieldOpen(false); setTime(''); }}
                  style={styles.clearTimeBtn}
                  hitSlop={15}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.newTaskSheet.clearDateA11y}>
                  <CloseIcon color={palette.faint} size={14} />
                </Pressable>
              )}
            </Pressable>
            {/* Time */}
            <Pressable
              style={[
                styles.scheduleField,
                { backgroundColor: palette.surface, borderColor: timeFieldOpen ? palette.text : palette.line },
              ]}
              onPress={() => { if (date) { setTimeFieldOpen(o => !o); } }}
              disabled={!date}
              accessibilityRole="button"
              accessibilityLabel={COPY.newTaskSheet.timeQuestion}>
              <ClockIcon color={palette.faint} size={16} />
              <Text style={[
                styles.scheduleInput,
                { color: time ? palette.text : palette.muted, fontVariant: ['tabular-nums'] },
              ]}>
                {date ? (time || COPY.newTaskSheet.timePlaceholder) : COPY.newTaskSheet.datePlaceholder}
              </Text>
              {time.length > 0 && (
                <Pressable
                  onPress={(e) => { e.stopPropagation(); setTime(''); setTimeFieldOpen(false); }}
                  style={styles.clearTimeBtn}
                  hitSlop={15}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.newTaskSheet.clearTimeA11y}>
                  <CloseIcon color={palette.faint} size={14} />
                </Pressable>
              )}
            </Pressable>
          </View>
          {dateFieldOpen && (
            <MiniCalendar
              value={date ?? todayISO()}
              minimumDate={todayISO()}
              onChange={iso => { setDate(iso); setDateFieldOpen(false); }}
            />
          )}
          {timeFieldOpen && (
            <MiniTimePicker
              value={time || null}
              onChange={hhmm => setTime(hhmm)}
            />
          )}
        </View>

        {/* ── NOTES section ── */}
        <View style={styles.section} onLayout={handleNotesLayout}>
          <View style={styles.sectionLabelRow}>
            <Text style={[styles.sectionLabel, { color: palette.muted }]}>NOTES</Text>
            <Text style={[styles.sectionLabelOptional, { color: palette.faint }]}>
              {' '}(optional)
            </Text>
          </View>
          <TextInput
            testID="task-form-notes"
            style={[
              styles.notesInput,
              {
                backgroundColor: palette.surface,
                borderColor:     palette.line,
                color:           palette.text,
              },
            ]}
            placeholder={COPY.taskFormScreen.notesPlaceholder}
            placeholderTextColor={palette.muted}
            value={notes}
            onChangeText={setNotes}
            onFocus={handleNotesFocus}
            onBlur={handleNotesBlur}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            maxLength={2000}
          />
        </View>

        {/* ── Delete button (edit mode only) ── */}
        {isEdit && existingTask && (
          <Pressable
            onPress={handleDelete}
            disabled={deleting || submitting}
            style={({ pressed }) => [
              styles.deleteBtn,
              (deleting || pressed) && { opacity: 0.6 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={COPY.taskFormScreen.deleteTaskA11y}>
            <Text style={[styles.deleteBtnLabel, { color: palette.danger }]}>
              {deleting ? 'Deleting…' : 'Delete task'}
            </Text>
          </Pressable>
        )}
      </ScrollView>

      {/* ── Sticky bottom CTA ── */}
      <View
        testID="task-form-cta"
        style={[
          styles.bottomCta,
          {
            borderTopColor:    palette.line,
            backgroundColor:   palette.bg,
            // The home-indicator gap is the OS keyboard's own space once it is
            // open — keeping it would leave a dead strip above the keys.
            paddingBottom:     (keyboardInset > 0 ? 0 : insets.bottom) + 16,
          },
        ]}>
        <Text style={[styles.ctaHelper, { color: canSubmit ? palette.muted : palette.faint }]}>
          {isEdit
            ? (canSubmit ? 'Ready to save' : '')
            : (canSubmit ? 'Ready to add' : COPY.newTaskSheet.footerHint)}
        </Text>
        <Pressable
          onPress={handleSave}
          disabled={!canSubmit || submitting}
          style={[
            styles.ctaBtn,
            {
              backgroundColor: canSubmit && !submitting
                ? palette.text
                : palette.surface2,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={isEdit ? 'Save changes' : COPY.newTaskSheet.cta}
          accessibilityState={{ disabled: !canSubmit || submitting }}>
          <Text style={[
            styles.ctaBtnLabel,
            { color: canSubmit && !submitting ? palette.bg : palette.muted },
          ]}>
            {submitting
              ? (isEdit ? 'Saving…' : COPY.newTaskSheet.ctaSubmitting)
              : (isEdit ? 'Save changes' : COPY.newTaskSheet.cta)}
          </Text>
        </Pressable>
      </View>
      </View>
    </KeyboardAvoidingView>
  );
}
