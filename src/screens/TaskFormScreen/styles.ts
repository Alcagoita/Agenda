import { StyleSheet } from 'react-native';
import { fonts, radius, spacing } from '../../theme/tokens';

export const POI_TILE_WIDTH = 72;

export const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // Inner wrapper the screen lifts by the keyboard overlap (KAN-369) — kept
  // separate from root so it never fights KeyboardAvoidingView's own padding.
  lift: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },

  // ── Top bar ──
  topBar: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.page,
    paddingBottom:     14,
    borderBottomWidth:  1,
  },
  backBtn: {
    width:  40,
    height: 40,
    alignItems:     'flex-start',
    justifyContent: 'center',
  },
  backLabel: {
    fontSize:   24,
    fontFamily: 'Geist-Regular',
    lineHeight: 28,
  },
  topBarTitle: {
    fontSize:   17,
    fontWeight: '500',
    fontFamily: 'Geist-Medium',
  },
  topBarRight: {
    width:  40,
    height: 40,
    alignItems:     'flex-end',
    justifyContent: 'center',
  },

  // ── Scroll body ──
  scrollContent: {
    flexGrow:          1,
    paddingHorizontal: spacing.page,
    paddingTop:        20,
    gap:               28,
  },

  // ── Sections ──
  section: {
    gap: 12,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems:    'baseline',
  },
  sectionLabel: {
    fontSize:      11,
    fontWeight:    '500',
    fontFamily:    'Geist-SemiBold',
    letterSpacing:  1.76,
  },
  sectionLabelOptional: {
    fontSize:   11,
    fontFamily: 'Geist-Regular',
  },
  // Sentence-case conversational question labels (KAN-149) — matches the
  // New Task quick sheet's style (KAN-148) so both screens read as the
  // same conversation continuing.
  questionRow: {
    flexDirection: 'row',
    alignItems:    'baseline',
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

  // ── Birthday toggle row (KAN-248) ──
  birthdayToggleRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           12,
  },
  birthdayToggleText: {
    flex: 1,
    gap:  2,
  },
  birthdayToggleSublabel: {
    fontSize:   12,
    fontFamily: 'Geist-Regular',
  },

  // ── Title input ──
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
  // sit at — borderWidth(1) + padding(16/14), matching titleInput exactly.
  titlePlaceholder: {
    position: 'absolute',
    left:      17, // borderWidth(1) + paddingHorizontal(16)
    top:       15, // borderWidth(1) + paddingVertical(14)
    right:     17,
    fontSize:  16,
    fontFamily: 'Geist-Regular',
  },

  // ── Search field ──
  searchWrap: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               10,
    paddingHorizontal: 14,
    paddingVertical:   12,
    borderRadius:      12,
    borderWidth:        1,
  },
  searchInput: {
    flex:       1,
    fontSize:   15,
    fontFamily: 'Geist-Regular',
    padding:     0,
  },

  // ── Type suggestion dropdown ──
  dropdown: {
    borderRadius: 14,
    borderWidth:   1,
    overflow:     'hidden',
  },
  dropdownRow: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               10,
    paddingHorizontal: 14,
    paddingVertical:   11,
  },
  dropdownLabel: {
    flex:       1,
    fontSize:   14,
    fontFamily: 'Geist-Regular',
  },

  swipeHintRow: {
    alignItems: 'flex-end',
    marginTop:  -2,
  },
  quickPicksHint: {
    fontSize:   12,
    fontFamily: 'Geist-Regular',
  },
  poiRow: {
    flexDirection: 'row',
    gap:             10,
  },
  poiCarouselMask: {
    // Guess tile (outside the scroller) sits at the row's left edge already —
    // only bleed the trailing edge so the last catalog tile can scroll flush.
    marginRight:  -spacing.page,
    paddingRight:  spacing.page,
  },
  poiCarousel: {
    gap: 10,
    paddingRight: spacing.page,
  },
  poiTile: {
    width:          POI_TILE_WIDTH,
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
  poiTileSuggested: {
    borderStyle: 'dashed',
  },
  poiTileLabel: {
    fontSize:      11,
    fontFamily:    'Geist-Regular',
    textAlign:     'center',
    letterSpacing: 0.01,
  },
  poiTileHint: {
    fontSize:   9,
    fontFamily: fonts.families.regular,
    textAlign:  'center',
  },
  subtypeSection: {
    gap: 10,
    paddingTop: 2,
  },
  // ── Category ──
  categoryRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:            8,
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
    width:        7,
    height:       7,
    borderRadius: 4,
  },
  categoryLabel: {
    fontSize:   14,
    fontFamily: 'Geist-Regular',
  },
  newCatChip: {
    paddingHorizontal: 14,
    paddingVertical:    8,
    borderRadius:      9999,
    borderWidth:        1,
    borderStyle:       'dashed',
  },
  newCatChipLabel: {
    fontSize:   13,
    fontFamily: 'Geist-Medium',
    fontWeight: '500',
  },

  // ── Inline category editor ──
  catEditor: {
    borderRadius: 14,
    borderWidth:   1,
    padding:      16,
    gap:          14,
    marginTop:     4,
  },
  catEditorRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           10,
  },
  catColorPreview: {
    width:        22,
    height:       22,
    borderRadius: 11,
    flexShrink:    0,
  },
  catNameInput: {
    flex:       1,
    fontSize:   15,
    fontFamily: 'Geist-Regular',
    padding:     0,
  },
  swatchRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:            8,
  },
  swatch: {
    width:        26,
    height:       26,
    borderRadius: 13,
  },
  swatchSelected: {
    transform:   [{ scale: 1.2 }],
    borderWidth:  2,
  },
  catEditorActions: {
    flexDirection: 'row',
    gap:           8,
  },
  catActionBtn: {
    flex:              1,
    borderWidth:        1,
    borderRadius:      radius.ctaBtn,
    paddingVertical:   11,
    alignItems:        'center',
  },
  catActionBtnPrimary: {
    borderWidth: 0,
  },
  catActionLabel: {
    fontSize:   14,
    fontFamily: 'Geist-Medium',
    fontWeight: '500',
  },

  // ── Schedule ──
  scheduleRow: {
    flexDirection: 'row',
    gap:           10,
  },
  scheduleField: {
    flex:           1,
    flexDirection:  'row',
    alignItems:     'center',
    gap:             8,
    paddingHorizontal: 12,
    paddingVertical:   12,
    borderRadius:   12,
    borderWidth:     1,
  },
  scheduleInput: {
    flex:       1,
    fontSize:   14,
    fontFamily: 'Geist-Regular',
    padding:     0,
  },
  clearTimeBtn: {
    alignItems:     'center',
    justifyContent: 'center',
  },

  // ── Notes ──
  notesInput: {
    fontSize:          15,
    fontFamily:        'Geist-Regular',
    lineHeight:        22.5,
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderRadius:      12,
    borderWidth:        1,
    minHeight:         88,
    maxHeight:         140,
  },

  // ── Delete button ──
  deleteBtn: {
    alignItems:     'center',
    paddingVertical: 20,
  },
  deleteBtnLabel: {
    fontSize:   16,
    fontFamily: 'Geist-Regular',
  },

  // ── Sticky bottom CTA ──
  bottomCta: {
    position:          'absolute',
    bottom:             0,
    left:               0,
    right:              0,
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.page,
    paddingTop:        16,
    borderTopWidth:     1,
  },
  ctaHelper: {
    flex:       1,
    fontSize:   13,
    fontFamily: 'Geist-Regular',
    marginRight: 12,
  },
  ctaBtn: {
    paddingHorizontal: 24,
    paddingVertical:   14,
    borderRadius:      radius.ctaBtn,
    alignItems:        'center',
  },
  ctaBtnLabel: {
    fontSize:   15,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },
});
