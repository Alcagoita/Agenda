/**
 * HomeAddressScreen — KAN-247.
 *
 * Settings' "Home" flow: shows the currently-set address (if any) with
 * Change/Clear actions, or an address search (debounced autocomplete
 * dropdown, mirrors TripPlannerScreen's destination step) when unset or
 * mid-change. Selecting a suggestion resolves + saves immediately — no
 * separate "confirm" step, since this is a single field, not a multi-step flow.
 *
 * Copy is explicit-not-inferred, brand voice — never "detection"/"fill this"
 * form language (see constants/copy.ts's home section).
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../theme';
import { radius, spacing } from '../theme/tokens';
import { getScreenKeyboardAvoidingBehavior } from '../utils/keyboardAvoiding';
import { ChevronLeftIcon, HomeIcon } from '../components/AppIcon';
import LoadingDots from '../components/LoadingDots';
import { useHomeAddress } from '../hooks/useHomeAddress';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { COPY } from '../constants/copy';

type Nav = NativeStackNavigationProp<RootStackParamList, 'HomeAddress'>;

export default function HomeAddressScreen() {
  const { palette } = useTheme();
  const navigation  = useNavigation<Nav>();
  const insets      = useSafeAreaInsets();

  const {
    loading, home, query, setQuery, suggestions, searching,
    selectSuggestion, saving, error, clear,
  } = useHomeAddress();

  // Search mode is entered explicitly (tapping Change, or there's no home
  // yet) — showing the search box unconditionally whenever `home` is set
  // would make every screen visit look like an edit-in-progress.
  const [searchMode, setSearchMode] = useState(false);

  const handleClear = () => {
    Alert.alert(
      COPY.home.clearConfirmTitle,
      COPY.home.clearConfirmBody,
      [
        { text: COPY.home.clearCancelAction, style: 'cancel' },
        { text: COPY.home.clearConfirmAction, style: 'destructive', onPress: () => { clear(); } },
      ],
    );
  };

  const showSearch = searchMode || (!loading && !home);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.bg }]}
      behavior={getScreenKeyboardAvoidingBehavior()}>
      <View style={[styles.header, { paddingTop: insets.top + 12, borderBottomColor: palette.line }]}>
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.home.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: palette.text }]}>{COPY.home.screenTitle}</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={[styles.scrollView, { backgroundColor: palette.bg }]}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled">

        {loading ? (
          <ActivityIndicator color={palette.muted} accessibilityLabel={COPY.home.loadingA11y} />
        ) : showSearch ? (
          <View style={styles.searchSection}>
            <View style={[styles.searchWrap, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <HomeIcon color={palette.faint} size={16} />
              <TextInput
                style={[styles.searchInput, { color: palette.text }]}
                placeholder={COPY.home.searchPlaceholder}
                placeholderTextColor={palette.muted}
                value={query}
                onChangeText={setQuery}
                autoFocus
                returnKeyType="search"
              />
            </View>

            {searching && suggestions.length === 0 && (
              <View style={styles.searchLoadingWrap}>
                <LoadingDots color={palette.accent} size={6} />
              </View>
            )}

            {suggestions.length > 0 && (
              <View style={[styles.dropdown, { backgroundColor: palette.surface, borderColor: palette.line }]}>
                {suggestions.map((s, i) => (
                  <Pressable
                    key={s.placeId}
                    style={[
                      styles.dropdownRow,
                      i < suggestions.length - 1 && { borderBottomWidth: 1, borderBottomColor: palette.line },
                    ]}
                    onPress={async () => {
                      const success = await selectSuggestion(s);
                      // Stay in search mode on failure so saving/error stay visible.
                      if (success) { setSearchMode(false); }
                    }}>
                    <Text style={[styles.dropdownLabel, { color: palette.text }]}>{s.name}</Text>
                    {!!s.address && (
                      <Text style={[styles.dropdownSub, { color: palette.muted }]} numberOfLines={1}>{s.address}</Text>
                    )}
                  </Pressable>
                ))}
              </View>
            )}

            {saving && <ActivityIndicator color={palette.muted} accessibilityLabel={COPY.home.savingA11y} />}
            {!!error && <Text style={[styles.errorText, { color: palette.nearText }]}>{error}</Text>}

            {home && (
              <Pressable onPress={() => setSearchMode(false)} accessibilityRole="button">
                <Text style={[styles.cancelLink, { color: palette.muted }]}>{COPY.home.cancel}</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View style={styles.currentSection}>
            <View style={[styles.currentCard, { backgroundColor: palette.surface, borderColor: palette.line }]}>
              <View style={[styles.iconTile, { backgroundColor: palette.surface2 }]}>
                <HomeIcon color={palette.muted} size={20} />
              </View>
              <Text style={[styles.currentAddress, { color: palette.text }]}>{home?.address}</Text>
            </View>

            <View style={styles.actionsRow}>
              <Pressable
                style={[styles.actionBtn, { borderColor: palette.line }]}
                onPress={() => setSearchMode(true)}
                accessibilityRole="button"
                accessibilityLabel={COPY.home.changeButton}>
                <Text style={[styles.actionLabel, { color: palette.text }]}>{COPY.home.changeButton}</Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, { borderColor: palette.line }]}
                onPress={handleClear}
                accessibilityRole="button"
                accessibilityLabel={COPY.home.clearButton}>
                <Text style={[styles.actionLabel, { color: palette.nearText }]}>{COPY.home.clearButton}</Text>
              </Pressable>
            </View>

            {saving && <ActivityIndicator color={palette.muted} accessibilityLabel={COPY.home.savingA11y} />}
            {!!error && <Text style={[styles.errorText, { color: palette.nearText }]}>{error}</Text>}
          </View>
        )}

        <Text style={[styles.note, { color: palette.muted }]}>{COPY.home.note}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollView: { flex: 1 },
  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing[4],
    paddingBottom:     12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 17, fontFamily: 'Geist-SemiBold', fontWeight: '600' },

  content: {
    flexGrow:          1,
    paddingTop:        24,
    paddingHorizontal: spacing.page,
    gap:               20,
  },

  searchSection: { gap: 12 },
  searchWrap: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               8,
    borderWidth:       1,
    borderRadius:      radius.card,
    paddingHorizontal: 14,
    height:            48,
  },
  searchInput: { flex: 1, fontSize: 15, fontFamily: 'Geist-Regular' },
  searchLoadingWrap: { alignItems: 'center', paddingVertical: 14 },
  dropdown: {
    borderWidth:  1,
    borderRadius: radius.card,
    overflow:     'hidden',
  },
  dropdownRow: { paddingHorizontal: 14, paddingVertical: 12, gap: 2 },
  dropdownLabel: { fontSize: 15, fontFamily: 'Geist-Regular' },
  dropdownSub:   { fontSize: 12.5, fontFamily: 'Geist-Regular' },
  errorText:     { fontSize: 13, fontFamily: 'Geist-Regular' },
  cancelLink:    { fontSize: 14, fontFamily: 'Geist-Regular', textAlign: 'center' },

  currentSection: { gap: 12 },
  currentCard: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               12,
    borderWidth:       1,
    borderRadius:      radius.card,
    paddingHorizontal: 14,
    paddingVertical:   14,
  },
  iconTile: {
    width: 36, height: 36,
    borderRadius:   radius.listIcon,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  currentAddress: { flex: 1, fontSize: 15, fontFamily: 'Geist-Regular' },
  actionsRow: { flexDirection: 'row', gap: 10 },
  actionBtn: {
    flex:              1,
    alignItems:        'center',
    justifyContent:    'center',
    height:            44,
    borderWidth:       1,
    borderRadius:      radius.ctaBtn,
  },
  actionLabel: { fontSize: 14.5, fontWeight: '600', fontFamily: 'Geist-SemiBold' },

  note: { fontSize: 12.5, fontFamily: 'Geist-Regular', lineHeight: 18 },
});
