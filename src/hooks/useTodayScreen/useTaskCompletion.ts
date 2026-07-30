/**
 * useTaskCompletion — KAN-59 / KAN-214
 *
 * Owns the task-done toggle: optimistic local update, Firestore persistence
 * (revert on failure), and the post-completion achievements/challenges side
 * effects (KAN-31 / KAN-32), deferred until interactions settle (KAN-157).
 */

import { useCallback } from 'react';
import { Platform, Vibration, InteractionManager } from 'react-native';
import { setTaskDone } from '../../services/firestore';
import { getActivePlaceContext } from '../../services/proximity';
import { completedTripIdFor } from '../../services/tripStamp';
import { checkAndFireAchievementNudge } from '../../services/achievements';
import { getActiveChallengesForUser, incrementCompletedCount } from '../../services/challenges';
import { cancelTaskReminder } from '../../services/notifications';
import type { NearbyPlace } from '../../services/maps';
import type { Task } from '../../types';
import { DEBUG_DISABLE_BACKGROUND } from './debugFlags';
import { processTaskCompletionRewards } from '../../services/rewardFunctions';

export function useTaskCompletion(
  uid: string | undefined,
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>,
  latestTasksRef: React.RefObject<Task[]>,
  nearbyPoiTypeRef: React.RefObject<string | null>,
  setTotalPoints: React.Dispatch<React.SetStateAction<number>>,
  nearbyPlaceRef: React.RefObject<NearbyPlace | null>,
) {
  const handleToggle = useCallback(async (taskId: string, done: boolean) => {
    if (!uid) { return; }

    Vibration.vibrate(Platform.OS === 'android' ? 18 : 1);

    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, done, pendingSync: true } : t));

    try {
      // Persist the hero/nearby place at brush time (KAN-226) — only when it
      // matches this task's own POI type, so we never tag a task with an
      // unrelated place the user happened to be near.
      const brushedTask = latestTasksRef.current.find(t => t.id === taskId);
      const nearbyPlace = nearbyPlaceRef.current;
      const completedPlace =
        done && brushedTask?.poi && brushedTask.poi === nearbyPoiTypeRef.current && nearbyPlace
          ? { placeId: nearbyPlace.placeId, name: nearbyPlace.name, poiType: brushedTask.poi }
          : undefined;

      // KAN-304 — stamp the active trip id when brushing inside a trip area.
      const completedTripId = completedTripIdFor(getActivePlaceContext(), done);

      await setTaskDone(uid, taskId, done, completedPlace, completedTripId);
      // Brushing cancels any pending time reminder for this task (KAN-280).
      // Best-effort — never let a notifee failure surface as a toggle failure.
      if (done) {
        cancelTaskReminder(taskId).catch(() => {});
      }
      // Only clear pendingSync if the row still reflects this write (same
      // optimistic done value) — a newer toggle that landed while this write
      // was in flight already owns the row's pendingSync state.
      setTasks(prev => prev.map(t =>
        t.id === taskId && t.done === done
          ? { ...t, pendingSync: false }
          : t,
      ));

      if (done) {
        // Read the latest tasks from the ref — NOT a captured `tasks` dep.
        // Depending on `tasks` here would give handleToggle a new identity on
        // every task change, defeating React.memo on every TaskRow and causing
        // a full-list re-render storm on each proximity tick (KAN-157 follow-up).
        const current = latestTasksRef.current;
        const task = current.find(t => t.id === taskId);
        // Birthday tasks (KAN-248) are unscored — excluded from the day-state
        // calc so brushing/missing one can never flip "all done" or the
        // remaining count, and never evaluated for achievements at all below.
        if (task && task.kind !== 'birthday' && !DEBUG_DISABLE_BACKGROUND) {
          // Defer achievement + challenge work until after the completion
          // animation / in-flight interactions settle (KAN-157). Previously the
          // heavy Firestore achievements transaction ran concurrently with the
          // completion re-render, saturating the JS thread (10s+ freeze, and a
          // Fabric ShadowTree commit crash). The screen never needs the full
          // achievements here — once the work lands we refresh only the points
          // total for the header badge.
          InteractionManager.runAfterInteractions(() => {
            processTaskCompletionRewards(taskId, new Date().getHours())
              .then(({ nudgeCandidate, totalPoints }) => {
                if (nudgeCandidate) {
                  checkAndFireAchievementNudge(uid, nudgeCandidate).catch(() => {});
                }
                setTotalPoints(totalPoints);
              })
              .catch(() => {});

            getActiveChallengesForUser(uid).then(challenges => {
              challenges.forEach(c =>
                incrementCompletedCount(c.id, uid, c).catch(() => {}),
              );
            }).catch(() => {});
          });
        }
      }
    } catch (err) {
      // Only revert if the row still reflects this failed write (done + pendingSync).
      // If the user toggled again before this rejected, that newer optimistic
      // update already owns the row — don't stomp it.
      setTasks(prev => prev.map(t =>
        t.id === taskId && t.done === done && t.pendingSync
          ? { ...t, done: !done, pendingSync: false }
          : t,
      ));
      console.warn('[useTodayScreen] toggle failed — reverting', err);
    }
  }, [uid, setTasks, latestTasksRef, nearbyPoiTypeRef, setTotalPoints, nearbyPlaceRef]);

  return { handleToggle };
}
