/**
 * CategoriesScreen — KAN-16
 *
 * Layout (top → bottom):
 *   1. Top bar      — back button + "Categories" title
 *   2. Category list
 *      BUILT-IN section  — 4 design-system rows (read-only)
 *      CUSTOM section    — user-created rows with edit (×) delete actions
 *   3. "Add category" button (bottom of custom section)
 *   4. Add/Edit bottom sheet (Modal)
 *      - Name text input
 *      - Color picker (18 swatches + hex input)
 *      - Save / Cancel
 *
 * Rules:
 *   - Built-in categories cannot be renamed, recoloured, or deleted.
 *   - Custom categories are stored in /users/{uid}/categories/{id}.
 *   - All colours via useTheme() — no hardcoded values.
 */

import React, { useEffect, useState } from 'react';
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import '@react-native-firebase/auth';
import { useTheme } from '../theme';
import {
  spacing,
  radius,
  categories as builtInMeta,
  categoryPickerColors,
  swatchSelectedRing,
} from '../theme/tokens';
import { Category } from '../types';
import { ChevronLeftIcon } from '../components/AppIcon';
import { useCategoriesScreen } from '../hooks/useCategoriesScreen';
import { COPY } from '../constants/copy';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * 18 preset colours arranged in 3 rows of 6.
 * The 4 original design-system colours are kept at their legacy positions.
 */
export const CATEGORY_COLORS = categoryPickerColors;

/**
 * The built-in categories derived from design tokens (never stored in
 * Firestore) — built by a function called inside the component instead of a
 * module-scope constant, since COPY/`categories` are language-dynamic
 * (KAN-252) and a module-scope read would freeze the text in whatever
 * language was active on first import.
 */
function buildBuiltInCategories(): Category[] {
  return [
    { id: 'work',     name: builtInMeta.work.label,     color: builtInMeta.work.color,     isBuiltIn: true },
    { id: 'health',   name: builtInMeta.health.label,    color: builtInMeta.health.color,   isBuiltIn: true },
    { id: 'errands',  name: builtInMeta.errands.label,   color: builtInMeta.errands.color,  isBuiltIn: true },
    { id: 'personal', name: builtInMeta.personal.label,  color: builtInMeta.personal.color, isBuiltIn: true },
  ];
}

// ─── CategoryRow ──────────────────────────────────────────────────────────────

interface CategoryRowProps {
  category: Category;
  onEdit:   (cat: Category) => void;
  onDelete: (cat: Category) => void;
}

function CategoryRow({ category, onEdit, onDelete }: CategoryRowProps) {
  const { palette } = useTheme();

  return (
    <View
      style={[styles.row, { borderBottomColor: palette.line }]}
      accessibilityLabel={COPY.categoriesScreen.rowA11y(category.name)}>
      {/* Colour dot */}
      <View style={[styles.colorDot, { backgroundColor: category.color }]} />

      {/* Name */}
      <View style={styles.rowContent}>
        <Text style={[styles.rowName, { color: palette.text }]}>{category.name}</Text>
      </View>

      {/* Edit + × delete — custom categories only */}
      {!category.isBuiltIn && (
        <View style={styles.rowActions}>
          <Pressable
            onPress={() => onEdit(category)}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={COPY.categoriesScreen.editA11y(category.name)}>
            <Text style={[styles.actionLabel, { color: palette.muted }]}>{COPY.categoriesScreen.editButton}</Text>
          </Pressable>
          <Pressable
            onPress={() => onDelete(category)}
            style={styles.deleteBtn}
            accessibilityRole="button"
            accessibilityLabel={COPY.categoriesScreen.deleteA11y(category.name)}>
            <Text style={[styles.deleteX, { color: palette.danger }]}>×</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ─── Add / Edit sheet ─────────────────────────────────────────────────────────

interface SheetProps {
  visible:  boolean;
  initial:  Partial<Category> | null; // null = add mode
  onSave:   (data: Omit<Category, 'id' | 'isBuiltIn'>) => void;
  onCancel: () => void;
}

function CategorySheet({ visible, initial, onSave, onCancel }: SheetProps) {
  const { palette, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const [name,         setName]         = useState('');
  const [color,        setColor]        = useState<string>(CATEGORY_COLORS[0]);
  const [hexInput,     setHexInput]     = useState<string>(CATEGORY_COLORS[0]);
  const [nameErr,      setNameErr]      = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Populate form when opening
  useEffect(() => {
    if (visible) {
      const initColor = initial?.color ?? CATEGORY_COLORS[0];
      setName(initial?.name  ?? '');
      setColor(initColor);
      setHexInput(initColor);
      setNameErr('');
    }
  }, [visible, initial]);

  useEffect(() => {
    if (!visible) {
      setKeyboardHeight(0);
      return undefined;
    }

    const showSub = Keyboard.addListener('keyboardDidShow', event => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [visible]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleSwatchPress = (c: string) => {
    setColor(c);
    setHexInput(c);
  };

  const handleHexChange = (text: string) => {
    const normalized = text.startsWith('#') ? text : '#' + text;
    setHexInput(normalized);
    if (/^#[0-9a-fA-F]{6}$/.test(normalized)) {
      setColor(normalized);
    }
  };

  const hexValid = /^#[0-9a-fA-F]{6}$/.test(hexInput);

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) { setNameErr(COPY.categoriesScreen.nameRequiredError); return; }
    onSave({ name: trimmed, color });
  };

  const isAdd = initial === null;
  const keyboardVisible = keyboardHeight > 0;
  const availableSheetHeight = Math.max(320, screenHeight - keyboardHeight - insets.top - 12);
  const sheetContentStyle = [
    styles.sheetContent,
    { paddingBottom: keyboardVisible ? 16 : insets.bottom + 16 },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}>
      <View style={[styles.sheetModal, { backgroundColor: dark ? palette.pullRefreshOverlay : palette.scrim }]}>
        <Pressable
          testID="category-sheet-overlay"
          accessibilityRole="button"
          accessibilityLabel={COPY.categoriesScreen.dismissSheetA11y}
          style={styles.scrim}
          onPress={onCancel}
        />
        <View
          testID="category-sheet-outer"
          style={[
            styles.sheetOuter,
            { maxHeight: availableSheetHeight },
          ]}>
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: palette.surface,
              maxHeight:       availableSheetHeight,
            },
          ]}>
          <ScrollView
            testID="category-sheet-scroll"
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
            showsVerticalScrollIndicator={false}
            contentContainerStyle={sheetContentStyle}>

          {/* Handle */}
          <View style={[styles.handle, { backgroundColor: palette.faint }]} />

          <Text style={[styles.sheetTitle, { color: palette.text }]}>
            {isAdd ? COPY.categoriesScreen.sheetTitleNew : COPY.categoriesScreen.sheetTitleEdit}
          </Text>

          {/* ── Name ── */}
          <Text style={[styles.fieldLabel, { color: palette.muted }]}>{COPY.categoriesScreen.nameFieldLabel}</Text>
          <View style={[
            styles.nameInputWrap,
            { backgroundColor: palette.surface2, borderColor: nameErr ? palette.danger : palette.line },
          ]}>
            <TextInput
              style={[styles.nameInput, { color: palette.text }]}
              placeholder={COPY.categoriesScreen.namePlaceholder}
              placeholderTextColor={palette.faint}
              value={name}
              onChangeText={v => { setName(v); if (nameErr) { setNameErr(''); } }}
              autoFocus={visible}
              returnKeyType="done"
              onSubmitEditing={handleSave}
              accessibilityLabel={COPY.categoriesScreen.nameA11y}
            />
          </View>
          {nameErr ? <Text style={[styles.nameErr, { color: palette.danger }]}>{nameErr}</Text> : null}

          {/* ── Colour ── */}
          <Text style={[styles.fieldLabel, { color: palette.muted }]}>{COPY.categoriesScreen.colorFieldLabel}</Text>

          {/* 18-colour grid */}
          <View style={styles.colorGrid}>
            {CATEGORY_COLORS.map(c => (
              <Pressable
                key={c}
                onPress={() => handleSwatchPress(c)}
                style={[
                  styles.colorSwatch,
                  { backgroundColor: c },
                  color === c && styles.colorSwatchSelected,
                ]}
                accessibilityRole="radio"
                accessibilityLabel={COPY.categoriesScreen.swatchA11y(c)}
                accessibilityState={{ checked: color === c }}
              />
            ))}
          </View>

          {/* Hex input row */}
          <View style={styles.hexRow}>
            <View
              style={[
                styles.hexPreview,
                {
                  backgroundColor: hexValid ? hexInput : color,
                  borderColor:     palette.line,
                },
              ]}
            />
            <View style={[
              styles.hexInputWrap,
              { backgroundColor: palette.surface2, borderColor: hexValid || hexInput === '' ? palette.line : palette.danger },
            ]}>
              <TextInput
                style={[styles.hexInput, { color: palette.text }]}
                value={hexInput}
                onChangeText={handleHexChange}
                placeholder={COPY.categoriesScreen.hexPlaceholder}
                placeholderTextColor={palette.faint}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={7}
                accessibilityLabel={COPY.categoriesScreen.hexA11y}
              />
            </View>
          </View>

          {/* ── Actions ── */}
          <View style={styles.sheetActions}>
            <Pressable
              onPress={onCancel}
              style={[styles.cancelBtn, { borderColor: palette.line }]}
              accessibilityRole="button"
              accessibilityLabel={COPY.categoriesScreen.cancel}>
              <Text style={[styles.cancelLabel, { color: palette.muted }]}>{COPY.categoriesScreen.cancel}</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              style={({ pressed }) => [
                styles.saveBtn,
                { backgroundColor: palette.text, opacity: pressed ? 0.8 : 1 },
              ]}
              accessibilityRole="button"
              accessibilityLabel={COPY.categoriesScreen.saveA11y}>
              <Text style={[styles.saveLabel, { color: palette.bg }]}>{COPY.categoriesScreen.save}</Text>
            </Pressable>
          </View>

          </ScrollView>
        </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function CategoriesScreen() {
  const { palette } = useTheme();
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation();
  const builtInCategories = buildBuiltInCategories();

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const uid = getAuth().currentUser?.uid ?? '';

  // ── ViewModel hook (KAN-59) ──────────────────────────────────────────────────
  const {
    categoriesState,
    setRetryKey,
    customCategories,
    sheetVisible,
    editing,
    handleAdd,
    handleEdit,
    handleDelete,
    handleSave,
    handleCloseSheet,
  } = useCategoriesScreen(uid);

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>

      {/* Top bar */}
      <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
        <Pressable
          style={styles.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.categoriesScreen.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.categoriesScreen.screenTitle}</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {/* ── Built-in ── */}
        <Text style={[styles.sectionLabel, { color: palette.muted }]}>{COPY.categoriesScreen.sectionBuiltIn}</Text>
        <View style={[styles.section, { borderColor: palette.line, backgroundColor: palette.surface }]}>
          {builtInCategories.map(cat => (
            <CategoryRow
              key={cat.id}
              category={cat}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </View>

        {/* ── Custom ── */}
        <Text style={[styles.sectionLabel, { color: palette.muted }]}>{COPY.categoriesScreen.sectionCustom}</Text>
        <View style={[styles.section, { borderColor: palette.line, backgroundColor: palette.surface }]}>
          {categoriesState.status === 'error' ? (
            // Error branch (KAN-58): show message + retry button
            <View style={styles.errorWrap}>
              <Text
                style={[styles.emptyText, { color: palette.muted }]}
                accessibilityRole="alert">
                {categoriesState.message || COPY.categoriesScreen.loadError}
              </Text>
              <Pressable
                onPress={() => setRetryKey(k => k + 1)}
                style={[styles.retryBtn, { borderColor: palette.line }]}
                accessibilityRole="button"
                accessibilityLabel={COPY.categoriesScreen.retry}>
                <Text style={[styles.retryLabel, { color: palette.text }]}>{COPY.categoriesScreen.retry}</Text>
              </Pressable>
            </View>
          ) : customCategories.length === 0 ? (
            <Text style={[styles.emptyText, { color: palette.muted }]}>
              {categoriesState.status === 'loading' ? COPY.categoriesScreen.loading : COPY.categoriesScreen.emptyCustom}
            </Text>
          ) : (
            customCategories.map(cat => (
              <CategoryRow
                key={cat.id}
                category={cat}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            ))
          )}

          {/* Add button */}
          <Pressable
            onPress={handleAdd}
            style={({ pressed }) => [
              styles.addBtn,
              { borderColor: palette.line, opacity: pressed ? 0.7 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={COPY.categoriesScreen.addCategoryA11y}>
            <Text style={[styles.addBtnLabel, { color: palette.accent }]}>{COPY.categoriesScreen.addCategory}</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* Add / Edit sheet */}
      <CategorySheet
        visible={sheetVisible}
        initial={editing}
        onSave={handleSave}
        onCancel={handleCloseSheet}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  // ── Top bar ──
  topBar: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.page,
    paddingVertical:   12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: {
    fontSize:   17,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },

  // ── List ──
  scroll: { flex: 1 },
  sectionLabel: {
    fontSize:         11,
    fontWeight:       '600',
    fontFamily:       'Geist-SemiBold',
    letterSpacing:     1.2,
    marginTop:         24,
    marginBottom:       8,
    marginHorizontal:  spacing.page,
  },
  section: {
    marginHorizontal: spacing.page,
    borderRadius:     radius.card,
    borderWidth:      StyleSheet.hairlineWidth,
    overflow:         'hidden',
  },

  // ── Row ──
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingHorizontal: 16,
    paddingVertical:   14,
    gap:               12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  colorDot: {
    width:        12,
    height:       12,
    borderRadius:  6,
    flexShrink:    0,
  },
  rowContent: {
    flex:          1,
    flexDirection: 'row',
    alignItems:    'center',
    gap:            8,
    flexWrap:      'wrap',
  },
  rowName: {
    fontSize:   15,
    fontFamily: 'Geist-Regular',
  },
  rowActions: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            4,
  },
  actionBtn: {
    paddingHorizontal: 8,
    paddingVertical:   4,
  },
  actionLabel: {
    fontSize:   13,
    fontFamily: 'Geist-Regular',
  },
  deleteBtn: {
    width:          32,
    height:         32,
    alignItems:     'center',
    justifyContent: 'center',
    borderRadius:    16,
  },
  deleteX: {
    fontSize:   20,
    lineHeight: 24,
    fontFamily: 'Geist-Regular',
  },

  // ── Error retry (KAN-58) ──
  errorWrap: {
    paddingHorizontal: 16,
    paddingVertical:   14,
    gap: 10,
  },
  retryBtn: {
    alignSelf:         'flex-start',
    paddingHorizontal: 14,
    paddingVertical:    8,
    borderRadius:       8,
    borderWidth:        1,
  },
  retryLabel: {
    fontSize:   14,
    fontFamily: 'Geist-Regular',
  },

  // ── Add button ──
  emptyText: {
    fontSize:          14,
    fontFamily:        'Geist-Regular',
    paddingHorizontal: 16,
    paddingVertical:   14,
  },
  addBtn: {
    paddingHorizontal: 16,
    paddingVertical:   14,
    borderTopWidth:    StyleSheet.hairlineWidth,
  },
  addBtnLabel: {
    fontSize:   15,
    fontWeight: '500',
    fontFamily: 'Geist-Regular',
  },

  // ── Sheet ──
  sheetModal: {
    flex: 1,
  },
  scrim: {
    flex: 1,
  },
  sheetOuter: {
    width: '100%',
  },
  sheet: {
    borderTopLeftRadius:  24,
    borderTopRightRadius: 24,
    paddingHorizontal:    spacing.page,
    paddingTop:           12,
  },
  sheetContent: {
    flexGrow: 1,
  },
  handle: {
    width:        40,
    height:        4,
    borderRadius:  2,
    alignSelf:    'center',
    marginBottom:  16,
  },
  sheetTitle: {
    fontSize:     17,
    fontWeight:   '600',
    fontFamily:   'Geist-SemiBold',
    marginBottom:  20,
  },
  fieldLabel: {
    fontSize:      11,
    fontWeight:    '600',
    fontFamily:    'Geist-SemiBold',
    letterSpacing:  1,
    marginBottom:   8,
  },
  nameInputWrap: {
    borderRadius:      radius.ctaBtn,
    borderWidth:       1,
    paddingHorizontal: 14,
    marginBottom:       4,
  },
  nameInput: {
    fontSize:        15,
    fontFamily:      'Geist-Regular',
    paddingVertical: 13,
  },
  nameErr: {
    fontSize:     12,
    fontFamily:   'Geist-Regular',
    marginBottom:  8,
  },

  // ── Colour grid ──
  colorGrid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:            10,
    marginBottom:   12,
  },
  colorSwatch: {
    width:        36,
    height:       36,
    borderRadius: 18,
  },
  colorSwatchSelected: {
    borderWidth: 3,
    borderColor: swatchSelectedRing,
  },

  // ── Hex input ──
  hexRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:            10,
    marginBottom:   20,
  },
  hexPreview: {
    width:        32,
    height:       32,
    borderRadius:  8,
    borderWidth:   1,
    flexShrink:    0,
  },
  hexInputWrap: {
    flex:              1,
    borderRadius:       8,
    borderWidth:        1,
    paddingHorizontal: 12,
  },
  hexInput: {
    fontSize:        13,
    fontFamily:      'Geist-Regular',
    paddingVertical:  8,
  },

  // ── Sheet actions ──
  sheetActions: {
    flexDirection: 'row',
    gap:            12,
    marginTop:       8,
  },
  cancelBtn: {
    flex:            1,
    borderRadius:    radius.ctaBtn,
    borderWidth:      1,
    paddingVertical: 14,
    alignItems:      'center',
  },
  cancelLabel: {
    fontSize:   15,
    fontFamily: 'Geist-Regular',
  },
  saveBtn: {
    flex:            2,
    borderRadius:    radius.ctaBtn,
    paddingVertical: 14,
    alignItems:      'center',
  },
  saveLabel: {
    fontSize:   15,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },
});
