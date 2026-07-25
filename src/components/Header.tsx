/**
 * Header — sticky top bar (zIndex 3).
 *
 * Layout: [Avatar] [Greeting · Name]  [People] [Bell]
 *
 * The unread dot on the bell is peach (palette.accent).
 * Greeting adapts to the time of day.
 *
 * KAN-301 removed the points chip: it rendered unconditionally "to drive
 * engagement" even at 0, which contradicts KAN-262 (never lead with
 * tiers/medals/streaks — achievements are discovered, never displayed). It also
 * removed the ContextChip slot — the Lantern now owns place context, so a second
 * indicator here would break surface ownership.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { BellIcon, UsersIcon } from './AppIcon';
import Avatar from './Avatar';
import { COPY } from '../constants/copy';

interface Props {
  displayName: string;
  /** Firebase Auth photoURL — forwarded to Avatar (dot shown when absent). */
  photoURL?:    string | null;
  hasUnread?: boolean;
  /** Badge count on the people/social icon (KAN-100). */
  socialBadge?: number;
  onAvatarPress?: () => void;
  onBellPress?: () => void;
  onPeoplePress?: () => void;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return COPY.header.goodMorning;
  if (h >= 12 && h < 17) return COPY.header.goodAfternoon;
  if (h >= 17 && h < 22) return COPY.header.goodEvening;
  return COPY.header.goodNight;
}

export default function Header({
  displayName,
  photoURL,
  hasUnread = false,
  socialBadge = 0,
  onAvatarPress,
  onBellPress,
  onPeoplePress,
}: Props) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();

  // Re-evaluate the greeting every 60 s so it updates if the app stays open
  // across a time boundary (e.g. morning → afternoon).
  const [greet, setGreet] = useState(greeting);
  useEffect(() => {
    const id = setInterval(() => setGreet(greeting()), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + 12,
          backgroundColor: palette.bg,
          borderBottomColor: palette.line,
        },
      ]}>
      {/* Avatar — amber dot default (KAN-78); taps navigate to Profile */}
      <Avatar
        photoURL={photoURL}
        size={36}
        onPress={onAvatarPress}
        accessibilityLabel={COPY.header.openProfileA11y}
      />

      {/* Greeting + name row */}
      <View style={styles.greetingWrap}>
        <View style={styles.greetingRow}>
          <Text style={[styles.greeting, { color: palette.muted }]} numberOfLines={1}>
            {greet}
          </Text>
        </View>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
      </View>

      {/* People / Social hub */}
      <TouchableOpacity
        style={styles.iconBtn}
        onPress={onPeoplePress}
        accessibilityRole="button"
        accessibilityLabel={socialBadge > 0 ? COPY.header.socialA11y(socialBadge) : COPY.header.socialA11yNoBadge}>
        <UsersIcon color={palette.text} size={20} />
        {socialBadge > 0 && (
          <View style={[styles.dot, { backgroundColor: palette.accent, shadowColor: palette.bg }]} />
        )}
      </TouchableOpacity>

      {/* Bell */}
      <TouchableOpacity
        style={styles.iconBtn}
        onPress={onBellPress}
        accessibilityRole="button"
        accessibilityLabel={hasUnread ? COPY.header.notificationsA11yUnread : COPY.header.notificationsA11y}>
        <BellIcon color={palette.text} size={20} />
        {hasUnread && (
          <View style={[styles.dot, { backgroundColor: palette.accent, shadowColor: palette.bg }]} />
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingBottom: 8,
    zIndex: 3,
  },
  greetingWrap: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0,
  },
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  greeting: {
    fontSize: 11,
    fontFamily: 'Geist-Regular',
    letterSpacing: 0.2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'Geist-SemiBold',
    flexShrink: 1,
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: 7,
    right: 8,
    width: 7,
    height: 7,
    borderRadius: 9999,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 2,
    shadowOpacity: 1,
    elevation: 0,
  },
});
