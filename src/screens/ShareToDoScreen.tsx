/**
 * ShareToDoScreen — KAN-101
 *
 * Step 1 of the share flow when no task is pre-selected (entry from Social Hub).
 * Shows the user's today + recent undone tasks. Tap a task → FriendPickerSheet opens.
 *
 * When a `taskId` route param is provided (entry from task detail), the matching
 * task is auto-selected and the FriendPickerSheet opens immediately.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getAuth } from '@react-native-firebase/auth/lib/modular';
import { useTheme } from '../theme';
import { spacing, radius as radii } from '../theme/tokens';
import { ChevronLeftIcon } from '../components/AppIcon';
import FriendPickerSheet from '../components/FriendPickerSheet';
import { ensureCurrentDay, getUser } from '../services/firestore';
import type { RootStackParamList } from '../navigation/AppNavigator';
import type { Task } from '../types';
import { COPY } from '../constants/copy';

type Nav   = NativeStackNavigationProp<RootStackParamList, 'ShareToDo'>;
type Route = RouteProp<RootStackParamList, 'ShareToDo'>;


export default function ShareToDoScreen() {
  const { palette }  = useTheme();
  const navigation   = useNavigation<Nav>();
  const route        = useRoute<Route>();
  const insets       = useSafeAreaInsets();

  const currentAuth = getAuth().currentUser;
  const uid         = currentAuth?.uid ?? '';
  const displayName = currentAuth?.displayName ?? '';

  const [tasks,            setTasks]            = useState<Task[]>([]);
  const [loading,          setLoading]          = useState(true);
  const [senderUsername,   setSenderUsername]   = useState('');
  const [selectedTask,     setSelectedTask]     = useState<Task | null>(null);
  const [pickerVisible,    setPickerVisible]    = useState(false);

  // Load current user's username once
  useEffect(() => {
    if (!uid) { return; }
    getUser(uid).then(u => setSenderUsername(u?.username ?? ''));
  }, [uid]);

  // Load every task that is currently active. An undated task stays active;
  // an explicitly dated task leaves only after its selected day passes.
  useEffect(() => {
    if (!uid) { return; }
    ensureCurrentDay(uid)
      .then(({ tasks: activeTasks }) => setTasks(activeTasks))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [uid]);

  // Auto-open picker if a specific task was passed from task detail
  useEffect(() => {
    if (!route.params?.taskId || tasks.length === 0) { return; }
    const match = tasks.find(t => t.id === route.params.taskId);
    if (match) { setSelectedTask(match); setPickerVisible(true); }
  }, [route.params?.taskId, tasks]);

  const handleSelectTask = (task: Task) => {
    setSelectedTask(task);
    setPickerVisible(true);
  };

  const renderItem = ({ item }: { item: Task }) => (
    <Pressable
      style={[styles.row, { backgroundColor: palette.surface2, borderColor: palette.line }]}
      onPress={() => handleSelectTask(item)}
      accessibilityRole="button"
      accessibilityLabel={COPY.shareToDo.shareA11y(item.title)}>
      <View style={styles.rowContent}>
        <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={[styles.rowCategory, { color: palette.muted }]}>
          {item.category}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: palette.faint }]}>›</Text>
    </Pressable>
  );

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top }]}>

      {/* Top bar */}
      <View style={[styles.topBar, { borderBottomColor: palette.line }]}>
        <Pressable
          style={styles.navBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={COPY.shareToDo.backA11y}>
          <ChevronLeftIcon color={palette.text} size={22} />
        </Pressable>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.share.screenTitle}</Text>
        <View style={styles.navBtn} />
      </View>

      <Text style={[styles.subtitle, { color: palette.muted }]}>
        {COPY.shareToDo.subtitle}
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={palette.accent} />
        </View>
      ) : tasks.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: palette.muted }]}>
            {COPY.shareToDo.noOpenTasks}
          </Text>
        </View>
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={t => t.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      )}

      {/* Friend picker sheet (step 2) */}
      {selectedTask && (
        <FriendPickerSheet
          visible={pickerVisible}
          onClose={() => { setPickerVisible(false); setSelectedTask(null); }}
          task={selectedTask}
          senderUid={uid}
          senderName={displayName}
          senderUsername={senderUsername}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.page, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  navBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title:    { fontSize: 17, fontWeight: '600', fontFamily: 'Geist-SemiBold' },
  subtitle: {
    paddingHorizontal: spacing.page, paddingTop: 16, paddingBottom: 8,
    fontSize: 13, fontFamily: 'Geist-Regular',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14, fontFamily: 'Geist-Regular', textAlign: 'center' },
  list: { paddingHorizontal: spacing.page, paddingTop: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    padding: 14, borderRadius: radii.card, borderWidth: 1,
  },
  rowContent: { flex: 1 },
  rowTitle:    { fontSize: 15, fontFamily: 'Geist-Medium', fontWeight: '500' },
  rowCategory: { fontSize: 12, fontFamily: 'Geist-Regular', marginTop: 2, textTransform: 'capitalize' },
  chevron:     { fontSize: 20, lineHeight: 22 },
});
