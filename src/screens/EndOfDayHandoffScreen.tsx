import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTask } from '../services/firestore';
import { forgetDatedTask, moveDatedTaskToTomorrow } from '../services/datedTaskHandoff';
import type { Task } from '../types';
import type { RootStackParamList } from '../navigation/AppNavigator';
import { useTheme } from '../theme';
import { COPY } from '../constants/copy';
import { radius, spacing } from '../theme/tokens';

/**
 * The explicit resolver for a multi-task 20:00 notification. There are no
 * bulk buttons because the user’s decision belongs to each task individually.
 */
export default function EndOfDayHandoffScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'EndOfDayHandoff'>>();
  const { uid, date, taskIds } = route.params;
  const taskIdsKey = JSON.stringify(taskIds);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [actingId, setActingId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const taskIdsForLoad: string[] = JSON.parse(taskIdsKey);
    setLoading(true);
    setLoadError(false);
    Promise.all(taskIdsForLoad.map(id => getTask(uid, id)))
      .then(found => {
        if (!mounted) { return; }
        setTasks(found.filter((task): task is Task =>
          !!task && !task.done && task.scheduledDate === date,
        ));
      })
      .catch(() => {
        if (mounted) { setLoadError(true); }
      })
      .finally(() => { if (mounted) { setLoading(false); } });
    return () => { mounted = false; };
  }, [uid, date, taskIdsKey, retryKey]);

  const act = async (taskId: string, action: 'forget' | 'tomorrow') => {
    setActingId(taskId);
    try {
      if (action === 'forget') {
        await forgetDatedTask(uid, taskId, date);
      } else {
        await moveDatedTaskToTomorrow(uid, taskId, date);
      }
      setTasks(current => current.filter(task => task.id !== taskId));
    } finally {
      setActingId(null);
    }
  };

  useEffect(() => {
    if (!loading && !loadError && tasks.length === 0) { navigation.goBack(); }
  }, [loading, loadError, tasks.length, navigation]);

  return (
    <View style={[styles.root, { backgroundColor: palette.bg, paddingTop: insets.top + 20 }]}>
      <View style={styles.header}>
        <Text style={[styles.kicker, { color: palette.accent }]}>BRUSH</Text>
        <Text style={[styles.title, { color: palette.text }]}>{COPY.datedTaskHandoff.sheetTitle}</Text>
      </View>
      {loading ? (
        <ActivityIndicator color={palette.muted} />
      ) : loadError ? (
        <View style={styles.errorState}>
          <Text style={[styles.errorText, { color: palette.muted }]}>{COPY.datedTaskHandoff.loadError}</Text>
          <Pressable
            onPress={() => setRetryKey(key => key + 1)}
            style={[styles.retryButton, { borderColor: palette.line }]}
            accessibilityRole="button"
            accessibilityLabel={COPY.datedTaskHandoff.tryAgain}>
            <Text style={[styles.buttonLabel, { color: palette.text }]}>{COPY.datedTaskHandoff.tryAgain}</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 28 }]}>
          {tasks.map(task => (
            <View key={task.id} style={[styles.card, { borderColor: palette.line, backgroundColor: palette.surface }]}>
              <Text style={[styles.taskTitle, { color: palette.text }]}>{task.title}</Text>
              <View style={styles.actions}>
                <Pressable
                  disabled={actingId === task.id}
                  onPress={() => { act(task.id, 'forget').catch(() => {}); }}
                  style={[styles.button, { borderColor: palette.line }]}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.datedTaskHandoff.forget}>
                  <Text style={[styles.buttonLabel, { color: palette.text }]}>{COPY.datedTaskHandoff.forget}</Text>
                </Pressable>
                <Pressable
                  disabled={actingId === task.id}
                  onPress={() => { act(task.id, 'tomorrow').catch(() => {}); }}
                  style={[styles.button, { backgroundColor: palette.text }]}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.datedTaskHandoff.tomorrow}>
                  <Text style={[styles.buttonLabel, { color: palette.bg }]}>{COPY.datedTaskHandoff.tomorrow}</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: spacing.page, gap: 8, paddingBottom: 24 },
  kicker: { fontFamily: 'Geist-SemiBold', fontSize: 11, letterSpacing: 2 },
  title: { fontFamily: 'Geist-SemiBold', fontSize: 28, letterSpacing: -0.7 },
  list: { paddingHorizontal: spacing.page, gap: 12 },
  card: { borderWidth: 1, borderRadius: radius.card, padding: 16, gap: 16 },
  taskTitle: { fontFamily: 'Geist-Medium', fontSize: 16 },
  actions: { flexDirection: 'row', gap: 8 },
  button: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: radius.ctaBtn, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  buttonLabel: { fontFamily: 'Geist-Medium', fontSize: 13, textAlign: 'center' },
  errorState: { paddingHorizontal: spacing.page, gap: 16, alignItems: 'flex-start' },
  errorText: { fontFamily: 'Geist-Regular', fontSize: 16 },
  retryButton: { minHeight: 44, borderWidth: 1, borderRadius: radius.ctaBtn, justifyContent: 'center', paddingHorizontal: 16 },
});
