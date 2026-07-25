import { StyleSheet } from 'react-native';
import { spacing, radius } from '../../theme/tokens';
import {
  SECTION_H_REST,
  RING_LEFT_REST,
  RING_TOP_REST,
  RING_LEFT_COLLAPSED,
  RING_TOP_COLLAPSED,
  RING_COLLAPSED,
} from './constants';

export const styles = StyleSheet.create({
  root:         { flex: 1 },
  loadingOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    // backgroundColor applied at the call site via palette.scrim
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  stickyHeader: { zIndex: 3 },
  // scrollArea fills all space below the sticky header. The ring section
  // is absolutely positioned at top:0 of scrollArea (zIndex 2), and the
  // ScrollView is absoluteFill behind it with paddingTop = SECTION_H_REST.
  scrollArea:   { flex: 1 },
  scrollContent: {
    // paddingTop = SECTION_H_REST ensures content always starts exactly where
    // the ring section ends at rest. As the ring section collapses by
    // SCROLL_RANGE (= 90), content scrolls up the same distance → perfect sync.
    paddingTop: SECTION_H_REST,
  },
  ringSection: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SECTION_H_REST,
    zIndex: 2,
    overflow: 'visible',
  },
  // Inner background — position:absolute so its animated height never causes
  // the outer ringSection (fixed height) to remeasure or block touches.
  ringBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SECTION_H_REST,      // fixed; collapse is a scaleY transform
    transformOrigin: 'top',
  },
  ringWrap: {
    position: 'absolute',
    left: RING_LEFT_REST,        // fixed rest position; stage moves it via translate
    top: RING_TOP_REST,
    transformOrigin: 'top left', // scale shrinks toward the top-left corner
  },
  captionWrap: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0, right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captionLabel: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  captionDay: {
    fontSize: 72,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    fontVariant: ['tabular-nums'],
    letterSpacing: -2,
    lineHeight: 78,
  },
  captionSub: {
    fontSize: 12,
    fontFamily: 'Geist-Regular',
    marginTop: 2,
  },
  captionSubBold: {
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
  },
  // ── Compact ring caption (fades in when collapsed) ──
  ringCaption: {
    position: 'absolute',
    left: RING_LEFT_COLLAPSED,
    top:  RING_TOP_COLLAPSED,
    width:  RING_COLLAPSED,
    height: RING_COLLAPSED,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringCaptionDay3: {
    fontSize: 9,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    letterSpacing: 1.2,
  },
  ringCaptionNum: {
    fontSize: 32,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1.5,
    lineHeight: 36,
    marginTop: 1,
  },
  ringCaptionMonth: {
    fontSize: 9,
    fontFamily: 'Geist-Regular',
    marginTop: 1,
  },
  // ── Progress panel (fades in when collapsed) ──
  progressWrap: {
    position: 'absolute',
    left: RING_LEFT_COLLAPSED + RING_COLLAPSED + 16,
    top:  RING_TOP_COLLAPSED,
    height: RING_COLLAPSED,
    justifyContent: 'center',
  },
  progressLabel: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  fractionRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
  },
  counterDone: {
    fontSize: 28,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  counterSep: {
    fontSize: 20,
    fontFamily: 'Geist-Regular',
  },
  counterTotal: {
    fontSize: 20,
    fontFamily: 'Geist-Regular',
    fontVariant: ['tabular-nums'],
  },
  progressSub: {
    fontSize: 12,
    fontFamily: 'Geist-Regular',
    marginTop: 3,
  },
  sectionHeaderBlock: {
    marginTop: 24,
    paddingHorizontal: spacing.page,
    paddingTop: 20,
  },
  // Per-row horizontal padding — replaces the wrapping `section` View now that
  // rows are FlatList items rather than children of a single padded container.
  rowPad: {
    paddingHorizontal: spacing.page,
  },
  debugRowText: {
    paddingVertical: 14,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    letterSpacing: 1,
  },
  sectionTitleRight: {
    fontSize: 11,
    fontFamily: 'Geist-Regular',
    fontVariant: ['tabular-nums'],
  },
  empty: {
    fontSize: 14,
    fontFamily: 'Geist-Regular',
    paddingVertical: 8,
  },
  // ── Error retry (KAN-58) ──
  errorWrap: {
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
  locationErrorRow: {
    marginHorizontal: spacing.page,
    marginBottom:     12,
    paddingHorizontal: 14,
    paddingVertical:   12,
    borderRadius:     radius.card,
    borderWidth:      StyleSheet.hairlineWidth,
    flexDirection:    'row',
    alignItems:       'center',
    gap:              12,
  },
  locationErrorText: {
    flex:       1,
    fontSize:   13,
    fontFamily: 'Geist-Regular',
    lineHeight: 18,
  },
  locationRetryLabel: {
    fontSize:   13,
    fontFamily: 'Geist-SemiBold',
    fontWeight: '600',
  },
  // ── Skeleton ──
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  skeletonDot: {
    width: 8,
    height: 8,
    borderRadius: 9999,
  },
  skeletonLine: {
    flex: 1,
    height: 14,
    borderRadius: 7,
  },
  // Extra bottom padding ensures the user can always scroll SCROLL_RANGE (90px)
  // even with a short task list.
  // Clears the floating add-task FAB at the end of the list.
  bottomPad: { height: 96 },
  // ── "One trip for all of these" entry row (KAN-281) — same bordered-row
  // template as CalendarScreen's "Going somewhere?" (tripEntryRow). ──
  oneTripForAllRow: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               8,
    minHeight:         44,
    marginHorizontal:  spacing.page,
    marginTop:         10,
    paddingVertical:   10,
    paddingHorizontal: 12,
    borderRadius:      radius.ctaBtn,
    borderWidth:       1,
  },
  oneTripForAllLabel: {
    flex:       1,
    fontSize:   14,
    fontWeight: '500',
    fontFamily: 'Geist-Regular',
  },
  // ── Empty state CTA ──
  emptyCTAWrap: {
    paddingHorizontal: spacing.page,
    paddingBottom:     26,
  },
  emptyCTABtn: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'center',
    height:         54,
    borderRadius:   16,
    gap:            8,
  },
  emptyCTABtnPressed: {
    transform: [{ scale: 0.985 }],
  },
  emptyCTALabel: {
    fontSize:      16,
    fontWeight:    '600',
    fontFamily:    'Geist-SemiBold',
    letterSpacing: -0.16,
  },
  emptyCTAHelper: {
    fontSize:   12.5,
    fontFamily: 'Geist-Regular',
    textAlign:  'center',
    marginTop:  12,
  },
  // ── Add-task FAB ──
  fab: {
    position:     'absolute',
    right:         20,
    bottom:        20,
    zIndex:         5,
    width:          56,
    height:         56,
    borderRadius:   18,
    alignItems:     'center',
    justifyContent: 'center',
  },
  fabPressed: {
    transform: [{ scale: 0.96 }],
  },
});
