/**
 * achievements.ts — Achievement definitions and evaluation logic.
 *
 * KAN-129: Points are achievement-derived only.
 * Points come exclusively from achievements. Each achievement has a defined
 * point value. When an achievement is unlocked, its points are added to
 * user.totalPoints.
 *
 * The single entry point for evaluating achievements after a task completion
 * is `evaluateAchievements()`. It runs as a Firestore transaction and is
 * idempotent — calling it multiple times for the same task is safe.
 *
 * `awardChallengeWinnerAchievement` is kept for the social challenge flow
 * (KAN-104) and still uses the subcollection model until that flow is
 * migrated separately.
 */

import { Platform } from 'react-native';
import notifee, { AndroidImportance } from '@notifee/react-native';
import {
  getFirestore,
  runTransaction,
  serverTimestamp,
  increment,
} from '@react-native-firebase/firestore';
import { awardAchievement, hasAchievement, awardPointsAchievementBonus } from './firestore';
import type { Task, AchievementType, AchievementEntry, AchievementsMap, User } from '../types';
import { COPY } from '../constants/copy';

// ─── V1 achievement definitions ───────────────────────────────────────────────

const c = COPY.achievements.catalogue;

export interface AchievementDef {
  id:          AchievementType;
  label:       string;
  desc:        string;
  /** Icon key — maps to an AppIcon component in the UI layer. */
  icon:        'check' | 'sun' | 'flame' | 'pin' | 'star';
  /** Points awarded when this achievement is unlocked (or re-earned). */
  points:      number;
  /** Condition threshold — progress must reach this value to unlock. */
  target:      number;
  /**
   * Whether this achievement can be earned more than once.
   * Repeatable achievements re-award `points` each time they are earned.
   */
  repeatable:  boolean;
}

export const ACHIEVEMENT_DEFS: Record<string, AchievementDef> = {
  // ── Tin tier (KAN-150) — 50 pts total = Bronze threshold ─────────────────
  first_task:   { id: 'first_task',   label: c.firstTaskLabel,   desc: c.firstTaskCondition,   icon: 'check', points: 5,  target: 1,  repeatable: false },
  first_brush:  { id: 'first_brush',  label: c.firstBrushLabel,  desc: c.firstBrushCondition,  icon: 'check', points: 10, target: 1,  repeatable: false },
  right_place:  { id: 'right_place',  label: c.rightPlaceLabel,  desc: c.rightPlaceCondition,  icon: 'pin',   points: 10, target: 1,  repeatable: false },
  worth_wait:   { id: 'worth_wait',   label: c.worthWaitLabel,   desc: c.worthWaitCondition,   icon: 'flame', points: 10, target: 1,  repeatable: false },
  custom_cat:   { id: 'custom_cat',   label: c.customCatLabel,   desc: c.customCatCondition,   icon: 'star',  points: 5,  target: 1,  repeatable: false },
  out_about:    { id: 'out_about',    label: c.outAboutLabel,    desc: c.outAboutCondition,    icon: 'pin',   points: 10, target: 3,  repeatable: false },
  // ── Legacy V1 (kept for existing user data — no longer awarded to new users)
  early_bird:   { id: 'early_bird',   label: c.earlyBirdLabel,   desc: c.earlyBirdCondition,   icon: 'sun',   points: 10, target: 1,   repeatable: true  },
  day_complete: { id: 'day_complete', label: c.dayCompleteLabel, desc: c.dayCompleteCondition, icon: 'check', points: 15, target: 1,   repeatable: true  },
  on_a_roll:    { id: 'on_a_roll',    label: c.onARollLabel,    desc: c.onARollCondition,      icon: 'flame', points: 20, target: 3,   repeatable: true  },
  explorer:     { id: 'explorer',     label: c.explorerLabel,   desc: c.explorerCondition,     icon: 'pin',   points: 25, target: 10,  repeatable: false },
  centurion:    { id: 'centurion',    label: c.centurionLabel,  desc: c.centurionCondition,    icon: 'star',  points: 30, target: 100, repeatable: false },
} as const;

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// ─── evaluateAchievements ─────────────────────────────────────────────────────

/**
 * Called after every task completion. Evaluates all v1 achievement conditions
 * and atomically updates progress, awards achievements, and increments
 * totalPoints — all in a single Firestore transaction.
 *
 * @param uid          Firebase user ID
 * @param task         The task that was just completed
 * @param ctx.allTasksDone  True if every task for today is now done
 */
/**
 * Describes a "1 away" achievement that may trigger a nudge notification.
 * Returned by `evaluateAchievements` so the caller can decide whether to fire.
 */
export interface AchievementNudgeCandidate {
  achievementId: AchievementType;
  /** Completions / points still needed to unlock. */
  remaining: number;
}

export async function evaluateAchievements(
  uid:  string,
  task: Task,
  ctx:  { allTasksDone: boolean; remainingTaskCount?: number; isNearby?: boolean },
): Promise<{ nudgeCandidate: AchievementNudgeCandidate | null }> {
  const db = getFirestore();
  const userDocRef = db.collection('users').doc(uid);
  const completedHour = new Date().getHours();

  const nudgeCandidate = await runTransaction(db, async tx => {
    const snap = await tx.get(userDocRef);
    const data = snap.data() as (User & { achievements?: AchievementsMap }) | undefined;

    const map: AchievementsMap   = (data?.achievements ?? {}) as AchievementsMap;
    const currentPoints: number  = data?.totalPoints ?? 0;
    const currentStreak: number  = data?.currentStreak ?? 0;

    const updates: Record<string, unknown> = {};
    let pointsGained = 0;

    // Helper: write an achievement award or a progress-only update
    const tryAward = (id: AchievementType, newProgress: number) => {
      const def     = ACHIEVEMENT_DEFS[id];
      if (!def) { return; }
      const entry    = map[id];
      const earnCount = entry?.earnCount ?? 0;
      const alreadyEarned = earnCount > 0;
      const meetsTarget   = newProgress >= def.target;
      const shouldAward   = meetsTarget && (!alreadyEarned || def.repeatable);

      if (shouldAward) {
        pointsGained += def.points;
        updates[`achievements.${id}`] = {
          earnedAt:  serverTimestamp(),
          earnCount: earnCount + 1,
          progress:  newProgress,
          target:    def.target,
        };
      } else if (alreadyEarned) {
        // Keep earnedAt intact; only update progress
        updates[`achievements.${id}.progress`] = newProgress;
      } else {
        // Not yet earned — write progress & target for display
        updates[`achievements.${id}.progress`] = newProgress;
        updates[`achievements.${id}.target`]   = def.target;
        updates[`achievements.${id}.earnCount`] = 0;
        updates[`achievements.${id}.earnedAt`]  = null;
      }
    };

    // ── first_brush — any task completion, target 1, non-repeatable ──────────
    if (!(map['first_brush']?.earnCount ?? 0)) {
      tryAward('first_brush', 1);
    }

    // ── right_place — brushed while physically near the task's POI type ───────
    if (task.poi && ctx.isNearby && !(map['right_place']?.earnCount ?? 0)) {
      tryAward('right_place', 1);
    }

    // ── worth_wait — task created ≥ 3 days ago (KAN-150) ─────────────────────
    // Note: createdAt is bumped on rollover (KAN-146); for rolled-over tasks
    // this fires only if the task was created and completed in a single session
    // spanning ≥3 days without a rollover. Use originalCreatedAt if added later.
    if (task.createdAt && !(map['worth_wait']?.earnCount ?? 0)) {
      const ts = task.createdAt as unknown as { toMillis?(): number; seconds?: number };
      const createdAtMs = typeof ts.toMillis === 'function'
        ? ts.toMillis()
        : (ts.seconds ?? 0) * 1000;
      const ageMs = Date.now() - createdAtMs;
      if (ageMs >= THREE_DAYS_MS) {
        tryAward('worth_wait', 1);
      }
    }

    // ── out_about — brushed tasks at 3 distinct POI types ────────────────────
    if (task.poi && !(map['out_about']?.earnCount ?? 0)) {
      const existing: string[] = data?.brushedPoiTypes ?? [];
      const updated  = existing.includes(task.poi) ? existing : [...existing, task.poi];
      if (updated.length !== existing.length) {
        updates['brushedPoiTypes'] = updated;
      }
      tryAward('out_about', updated.length);
    }

    // ── early_bird — before 9 AM, repeatable ─────────────────────────────────
    if (completedHour < 9) {
      const prev = map['early_bird']?.progress ?? 0;
      tryAward('early_bird', prev + 1);
    }

    // ── day_complete — all tasks done today, repeatable ──────────────────────
    if (ctx.allTasksDone) {
      const prev = map['day_complete']?.progress ?? 0;
      tryAward('day_complete', prev + 1);
    }

    // ── on_a_roll — streak ≥ 3; re-awards when streak resets and rebuilds ────
    {
      const prevProgress = map['on_a_roll']?.progress ?? 0;
      if (currentStreak >= ACHIEVEMENT_DEFS['on_a_roll'].target) {
        // Award when crossing the threshold (covers initial earn and re-earn)
        if (prevProgress < ACHIEVEMENT_DEFS['on_a_roll'].target) {
          tryAward('on_a_roll', currentStreak);
        } else {
          updates['achievements.on_a_roll.progress'] = currentStreak;
        }
      } else {
        // Streak below target — just record progress for the bar
        updates['achievements.on_a_roll.progress'] = currentStreak;
        if (!map['on_a_roll']) {
          updates['achievements.on_a_roll.target']    = ACHIEVEMENT_DEFS['on_a_roll'].target;
          updates['achievements.on_a_roll.earnCount'] = 0;
          updates['achievements.on_a_roll.earnedAt']  = null;
        }
      }
    }

    // ── explorer — location task, target 10, non-repeatable ──────────────────
    if (task.poi) {
      const prev = map['explorer']?.progress ?? 0;
      tryAward('explorer', prev + 1);
    }

    // ── centurion — meta: totalPoints ≥ 100. Checked after other points. ─────
    {
      const projectedPoints = currentPoints + pointsGained;
      const centurionEntry  = map['centurion'];
      const alreadyEarned   = (centurionEntry?.earnCount ?? 0) > 0;
      if (projectedPoints >= ACHIEVEMENT_DEFS['centurion'].target && !alreadyEarned) {
        pointsGained += ACHIEVEMENT_DEFS['centurion'].points;
        updates[`achievements.centurion`] = {
          earnedAt:  serverTimestamp(),
          earnCount: 1,
          progress:  projectedPoints,
          target:    ACHIEVEMENT_DEFS['centurion'].target,
        };
      } else {
        updates['achievements.centurion.progress'] = projectedPoints;
        if (!centurionEntry) {
          updates['achievements.centurion.target']    = ACHIEVEMENT_DEFS['centurion'].target;
          updates['achievements.centurion.earnCount'] = 0;
          updates['achievements.centurion.earnedAt']  = null;
        }
      }
    }

    // ── Commit ────────────────────────────────────────────────────────────────
    if (pointsGained > 0) {
      updates['totalPoints'] = increment(pointsGained);
    }

    if (Object.keys(updates).length > 0) {
      tx.update(userDocRef, updates);
    }

    // ── "1 away" nudge detection (KAN-122) ────────────────────────────────────
    // Compute candidate AFTER all awards so projectedPoints is final.
    // Only considers achievements not awarded in this transaction.

    /** Returns true when the updates entry for an achievement is a full award object
     *  (i.e. written by `tryAward` during this transaction). */
    const wasAwardedInTx = (key: string): boolean => {
      const v = updates[`achievements.${key}`];
      return typeof v === 'object' && v !== null && 'earnCount' in v &&
        typeof (v as { earnCount: unknown }).earnCount === 'number' &&
        (v as { earnCount: number }).earnCount > 0;
    };

    const candidates: AchievementNudgeCandidate[] = [];

    // day_complete: 1 task left today (context-based, target=1 repeatable).
    // NOTE: ctx.remainingTaskCount comes from the caller's optimistic UI state —
    // it is not transactional. A concurrent completion could produce a stale
    // count — best-effort only (KAN-303 removed the nudge that consumed this).
    if (!ctx.allTasksDone && (ctx.remainingTaskCount ?? 0) === 1) {
      candidates.push({ achievementId: 'day_complete', remaining: 1 });
    }

    // early_bird: still before 9 AM (time-gated)
    if (completedHour < 9) {
      candidates.push({ achievementId: 'early_bird', remaining: 1 });
    }

    // on_a_roll: streak is 1 away from target (3-day), not yet earned
    {
      const onARollEarned = (map['on_a_roll']?.earnCount ?? 0) > 0;
      const awardedNow    = wasAwardedInTx('on_a_roll');
      const remaining     = ACHIEVEMENT_DEFS['on_a_roll'].target - currentStreak;
      if (!onARollEarned && !awardedNow && remaining === 1) {
        candidates.push({ achievementId: 'on_a_roll', remaining: 1 });
      }
    }

    // explorer: after this task, progress is 1 away from target (10)
    if (task.poi) {
      const newProgress   = (map['explorer']?.progress ?? 0) + 1;
      const explorerEarned  = (map['explorer']?.earnCount ?? 0) > 0;
      const awardedNow    = wasAwardedInTx('explorer');
      const remaining     = ACHIEVEMENT_DEFS['explorer'].target - newProgress;
      if (!explorerEarned && !awardedNow && remaining === 1) {
        candidates.push({ achievementId: 'explorer', remaining: 1 });
      }
    }

    // centurion: final projected points are 1 away from target (100)
    {
      const projectedFinal  = currentPoints + pointsGained;
      const centurionEarned = (map['centurion']?.earnCount ?? 0) > 0;
      const awardedNow      = wasAwardedInTx('centurion');
      const remaining       = ACHIEVEMENT_DEFS['centurion'].target - projectedFinal;
      if (!centurionEarned && !awardedNow && remaining === 1) {
        candidates.push({ achievementId: 'centurion', remaining: 1 });
      }
    }

    // Return the candidate with the smallest remaining gap (most attainable first)
    candidates.sort((a, b) => a.remaining - b.remaining);
    return candidates[0] ?? null;
  });

  return { nudgeCandidate: nudgeCandidate ?? null };
}

// KAN-303: the achievement-nudge notification ("1 away from a badge") was cut
// — it was performance nagging, against the app's no-guilt contract. The
// badge/achievement system itself is unchanged; only the push is gone, so
// checkAndFireAchievementNudge and fireAchievementNudge no longer exist.

// ─── Tin-tier non-completion triggers (KAN-150) ──────────────────────────────

/**
 * Call after a successful `addTask`. Awards `first_task` if the user
 * hasn't added a task before. Idempotent — safe to call on every add.
 */
export async function evaluateAddTaskAchievement(uid: string): Promise<void> {
  const db = getFirestore();
  const userDocRef = db.collection('users').doc(uid);

  await runTransaction(db, async tx => {
    const snap = await tx.get(userDocRef);
    const data = snap.data() as (User & { achievements?: AchievementsMap }) | undefined;
    const map: AchievementsMap = (data?.achievements ?? {}) as AchievementsMap;

    if ((map['first_task']?.earnCount ?? 0) > 0) { return; }

    const def = ACHIEVEMENT_DEFS['first_task'];
    tx.update(userDocRef, {
      [`achievements.first_task`]: {
        earnedAt:  serverTimestamp(),
        earnCount: 1,
        progress:  1,
        target:    def.target,
      },
      totalPoints: increment(def.points),
    });
  });
}

/**
 * Call after a custom category is successfully saved. Awards `custom_cat`
 * the first time. Idempotent.
 */
export async function evaluateCustomCatAchievement(uid: string): Promise<void> {
  const db = getFirestore();
  const userDocRef = db.collection('users').doc(uid);

  await runTransaction(db, async tx => {
    const snap = await tx.get(userDocRef);
    const data = snap.data() as (User & { achievements?: AchievementsMap }) | undefined;
    const map: AchievementsMap = (data?.achievements ?? {}) as AchievementsMap;

    if ((map['custom_cat']?.earnCount ?? 0) > 0) { return; }

    const def = ACHIEVEMENT_DEFS['custom_cat'];
    tx.update(userDocRef, {
      [`achievements.custom_cat`]: {
        earnedAt:  serverTimestamp(),
        earnCount: 1,
        progress:  1,
        target:    def.target,
      },
      totalPoints: increment(def.points),
    });
  });
}

// ─── One-time migration (KAN-129) ────────────────────────────────────────────

/**
 * Recomputes `user.totalPoints` from the `achievements` map and writes it
 * back to Firestore if it differs from the stored value.
 *
 * Must be called once on app startup after the user is authenticated.
 * Fixes accounts that accumulated per-task points under the old model before
 * KAN-129 switched to achievement-derived points only.
 *
 * The function is idempotent — calling it multiple times is safe.
 */
export async function migratePointsToAchievementDerived(uid: string): Promise<void> {
  const db = getFirestore();
  const userDocRef = db.collection('users').doc(uid);

  await runTransaction(db, async tx => {
    const snap = await tx.get(userDocRef);
    const data = snap.data() as (User & { achievements?: AchievementsMap }) | undefined;
    if (!data) { return; }

    const map: AchievementsMap = (data.achievements ?? {}) as AchievementsMap;

    let computedPoints = 0;
    for (const [type, entry] of Object.entries(map)) {
      if (!entry || entry.earnCount <= 0) { continue; }
      const def = ACHIEVEMENT_DEFS[type];
      if (def) { computedPoints += def.points * entry.earnCount; }
    }

    if ((data.totalPoints ?? 0) !== computedPoints) {
      tx.update(userDocRef, { totalPoints: computedPoints });
    }
  });
}

// ─── Challenge winner achievement (KAN-104) ───────────────────────────────────
// Uses the old subcollection model — migration is tracked separately.

const CHANNEL_ID             = 'achievements';
const CHALLENGE_WINNER_ID    = 'challenge_winner';
const CHALLENGE_WINNER_BONUS = 5;

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') { return; }
  await notifee.createChannel({
    id:         CHANNEL_ID,
    name:       'Achievements',
    importance: AndroidImportance.HIGH,
    sound:      'default',
  });
}

export async function awardChallengeWinnerAchievement(
  uid:         string,
  challengeId: string,
): Promise<void> {
  const achievementId = `${CHALLENGE_WINNER_ID}_${challengeId}`;
  const alreadyAwarded = await hasAchievement(uid, achievementId);
  if (alreadyAwarded) { return; }
  await awardAchievement(uid, achievementId, 'challenge_winner', { challengeId });
  await awardPointsAchievementBonus(uid, CHALLENGE_WINNER_ID, CHALLENGE_WINNER_BONUS);
  await ensureChannel();
  await notifee.displayNotification({
    title: COPY.achievement.challengeWonNotifTitle,
    body:  COPY.achievement.challengeWonBody,
    data:  { screen: 'ChallengeDetail', challengeId },
    android: { channelId: CHANNEL_ID, importance: AndroidImportance.HIGH, pressAction: { id: 'default' } },
    ios:     { sound: 'default' },
  });
}
