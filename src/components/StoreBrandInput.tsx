import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { fonts, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme';
import { getBrandSuggestions } from '../services/brandDictionary';

interface StoreBrandInputProps {
  selected: string | null;
  placeholder: string;
  unmatchedLabel: string;
  onSelect: (brand: string) => void;
  onClear: () => void;
}

/**
 * Store has a deliberately compact brand picker: users search the curated
 * catalogue instead of scrolling an unbounded chain carousel.
 */
export default function StoreBrandInput({ selected, placeholder, unmatchedLabel, onSelect, onClear }: StoreBrandInputProps) {
  const { palette } = useTheme();
  const [query, setQuery] = useState(selected ?? '');
  const queryChangedByUser = React.useRef(false);

  useEffect(() => {
    // Clearing a selected brand is normally caused by the first edit in this
    // very field. Keep that typed query visible so the user can refine it.
    if (selected) {
      queryChangedByUser.current = false;
      setQuery(selected);
    } else if (!queryChangedByUser.current) {
      setQuery('');
    }
  }, [selected]);

  const suggestions = useMemo(
    () => query.trim() && query !== selected ? getBrandSuggestions('store', query) : [],
    [query, selected],
  );

  return (
    <View style={styles.wrap}>
      <TextInput
        value={query}
        onChangeText={value => {
          setQuery(value);
          queryChangedByUser.current = true;
          if (selected && value !== selected) onClear();
        }}
        placeholder={placeholder}
        placeholderTextColor={palette.faint}
        accessibilityLabel={placeholder}
        autoCapitalize="words"
        autoCorrect={false}
        style={[styles.input, { color: palette.text, borderColor: palette.line, backgroundColor: palette.surface }]}
      />
      {suggestions.length > 0 && (
        <View style={[styles.suggestions, { borderColor: palette.line, backgroundColor: palette.surface }]}>
          {suggestions.map(brand => (
            <Pressable
              key={brand}
              accessibilityRole="button"
              accessibilityLabel={brand}
              onPress={() => {
                setQuery(brand);
                onSelect(brand);
              }}
              style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: palette.surface2 }]}
            >
              <Text style={[styles.suggestionLabel, { color: palette.text }]}>{brand}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {query.trim().length > 0 && !selected && suggestions.length === 0 && (
        <Text accessibilityLiveRegion="polite" style={[styles.unmatched, { color: palette.muted }]}>
          {unmatchedLabel}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.ctaBtn,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: fonts.families.regular,
  },
  suggestions: {
    borderWidth: 1,
    borderRadius: radius.ctaBtn,
    overflow: 'hidden',
  },
  suggestion: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.page,
  },
  suggestionLabel: {
    fontSize: 14,
    fontFamily: fonts.families.regular,
  },
  unmatched: {
    fontSize: 13,
    fontFamily: fonts.families.regular,
    lineHeight: 18,
  },
});
