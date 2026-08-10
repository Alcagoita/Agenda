/**
 * notifications.ts — Scheduled local notification helpers (Track B, Sprint 8).
 *
 * Each notification type owns:
 *   - A stable notification ID  (used to cancel / replace)
 *   - An Android channel ID
 *   - A schedule/cancel function pair
 *
 * All scheduling uses @notifee/react-native TriggerType.TIMESTAMP.
 * iOS doesn't use channels but Notifee handles that transparently.
 */

import notifee, {
  AndroidImportance,
  AndroidVisibility,
  TriggerType,
} from '@notifee/react-native';
import type { TimestampTrigger } from '@notifee/react-native';
import { COPY } from '../constants/copy';

// ─── Channel IDs ──────────────────────────────────────────────────────────────

export const CHANNEL_EOD         = 'eod-checkin';
export const CHANNEL_EXIT        = 'exit-prompt';
export const CHANNEL_DATED_TASK  = 'dated-task-handoff';

// ─── Notification IDs ─────────────────────────────────────────────────────────

const NOTIF_ID_EOD    = 'eod-checkin';

// ─── KAN-303: retire the cut notification types ───────────────────────────────
// Streak-at-risk and weekly-recap were scheduled TRIGGER notifications, so a
// user who had them enabled has one sitting pending on-device. Cancel them once
// on next launch (see App.tsx) so nothing keeps firing after their channels
// were removed. The achievement nudge and the 7-day lapse push were never
// scheduled triggers — one is an immediate display, the other a server-side FCM
// send — so there is nothing on-device to cancel for those.
const RETIRED_NOTIF_IDS = ['streak-at-risk', 'weekly-recap'];

export async function cancelRetiredNotifications(): Promise<void> {
  await Promise.all(RETIRED_NOTIF_IDS.map(id => notifee.cancelNotification(id)));
}

// ─── Channel creation (idempotent) ────────────────────────────────────────────

export async function createEodChannel(): Promise<void> {
  await notifee.createChannel({
    id:          CHANNEL_EOD,
    name:        'End-of-day check-in',
    importance:  AndroidImportance.DEFAULT,
    vibration:   false,
    visibility:  AndroidVisibility.PUBLIC,
  });
}

// ─── Daily check-in (KAN-120 / KAN-303) ───────────────────────────────────────

/**
 * Schedule (or re-schedule) the daily check-in.
 *
 * KAN-303: this is the morning "Daily" channel — intention, not a verdict. It
 * carries no count of unfinished tasks (that read as a tally / guilt), just the
 * app's own question. It fires at the user-set `time` (default morning) whether
 * or not anything is outstanding.
 *
 * Cancels any existing check-in first so repeated calls are idempotent. Silent
 * no-op when `enabled` is false. If the configured time has already passed
 * today, rolls forward to tomorrow.
 */
export async function scheduleEodReminder(options: {
  enabled: boolean;
  time:    string;   // "HH:MM"
}): Promise<void> {
  const { enabled, time } = options;

  // Reject a malformed time up front — an invalid "HH:MM" would otherwise
  // produce a NaN timestamp and a broken trigger. No cancel, no schedule.
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { return; }

  // Always cancel first so stale notifications are cleared.
  await cancelEodReminder();

  if (!enabled) { return; }

  const [hours, minutes] = time.split(':').map(Number);
  const fireAt = new Date();
  fireAt.setHours(hours, minutes, 0, 0);

  // If the time has already passed today, roll forward to tomorrow so the
  // user still gets the reminder (e.g. they change preferences after the time).
  if (fireAt.getTime() <= Date.now()) {
    fireAt.setDate(fireAt.getDate() + 1);
  }

  await createEodChannel();

  const trigger: TimestampTrigger = {
    type:      TriggerType.TIMESTAMP,
    timestamp: fireAt.getTime(),
  };

  await notifee.createTriggerNotification(
    {
      id:    NOTIF_ID_EOD,
      title: COPY.dailyCheckin.title,
      body:  COPY.dailyCheckin.body,
      android: {
        channelId:   CHANNEL_EOD,
        importance:  AndroidImportance.DEFAULT,
        pressAction: { id: 'default', launchActivity: 'default' },
        visibility:  AndroidVisibility.PUBLIC,
        smallIcon:   'ic_notification',
      },
      // `screen: Today` is read by the foreground/background notification
      // handler in App.tsx to route the user on tap.
      data: { screen: 'Today' },
    },
    trigger,
  );
}

/** Cancel any pending EOD check-in notification. */
export async function cancelEodReminder(): Promise<void> {
  await notifee.cancelNotification(NOTIF_ID_EOD);
}

// ─── Location exit prompt (KAN-119) ───────────────────────────────────────────

/** Stable action ID for the "Yes, brushed ✓" quick-action. */
export const EXIT_ACTION_MARK_DONE = 'exit_mark_done';
export const DATED_TASK_ACTION_FORGET = 'dated_task_forget';
export const DATED_TASK_ACTION_TOMORROW = 'dated_task_tomorrow';

export interface DatedTaskHandoffTask {
  id: string;
  title: string;
}

function datedTaskHandoffNotifId(date: string): string {
  return `dated-task-handoff-${date}`;
}

/** Cancel the one end-of-day handoff notification for a local calendar day. */
export async function cancelDatedTaskHandoff(date: string): Promise<void> {
  await notifee.cancelNotification(datedTaskHandoffNotifId(date));
}

/**
 * Schedules one local 20:00 handoff per selected date. Replacing the stable
 * date-based id means adding, editing, or deleting a task cannot create a
 * second notification. A single task offers unambiguous actions; several open
 * the in-app selector on tap instead.
 */
export async function scheduleDatedTaskHandoff(options: {
  uid: string;
  date: string;
  tasks: DatedTaskHandoffTask[];
}): Promise<void> {
  const { uid, date, tasks } = options;
  await cancelDatedTaskHandoff(date);
  if (tasks.length === 0) { return; }

  const [year, month, day] = date.split('-').map(Number);
  const fireAt = new Date(year, month - 1, day, 20, 0, 0, 0);
  if (fireAt.getTime() <= Date.now()) { return; }

  await notifee.createChannel({
    id:         CHANNEL_DATED_TASK,
    name:       'Dated task handoffs',
    importance: AndroidImportance.DEFAULT,
    vibration:  false,
    visibility: AndroidVisibility.PUBLIC,
  });

  const singleTask = tasks.length === 1 ? tasks[0] : null;
  const data = {
    screen: singleTask ? 'Today' : 'EndOfDayHandoff',
    uid,
    scheduledDate: date,
    taskIds: JSON.stringify(tasks.map(task => task.id)),
  };
  const trigger: TimestampTrigger = { type: TriggerType.TIMESTAMP, timestamp: fireAt.getTime() };

  await notifee.createTriggerNotification({
    id:    datedTaskHandoffNotifId(date),
    title: COPY.datedTaskHandoff.title,
    body:  singleTask
      ? COPY.datedTaskHandoff.body(singleTask.title)
      : COPY.datedTaskHandoff.multipleBody,
    android: {
      channelId:   CHANNEL_DATED_TASK,
      importance:  AndroidImportance.DEFAULT,
      pressAction: { id: 'default', launchActivity: 'default' },
      visibility:  AndroidVisibility.PUBLIC,
      smallIcon:   'ic_notification',
      ...(singleTask ? {
        actions: [
          { title: COPY.datedTaskHandoff.forget, pressAction: { id: DATED_TASK_ACTION_FORGET } },
          { title: COPY.datedTaskHandoff.tomorrow, pressAction: { id: DATED_TASK_ACTION_TOMORROW } },
        ],
      } : {}),
    },
    ios: singleTask ? { categoryId: 'dated_task_handoff_single' } : undefined,
    data,
  }, trigger);
}

/**
 * Returns the notification body for the exit prompt.
 *
 *   With store name:   "Left [Store Name] — did you brush it away?"
 *   Without:           "Did you brush it away while you were there?"
 */
export function buildExitBody(storeName?: string): string {
  if (storeName) {
    return `Left ${storeName} — did you brush it away?`;
  }
  return 'Did you brush it away while you were there?';
}

/**
 * Fire an immediate exit-prompt notification for the given task.
 *
 * Includes a "Yes, brushed ✓" quick-action that carries `taskId` in its
 * payload so App.tsx can mark the task complete directly from the lock screen.
 *
 * This is a fire-and-forget notification (not scheduled) — it displays
 * immediately. The deduplication guard (`exitPromptSeenDate`) must be checked
 * by the caller before invoking this function.
 */
/**
 * Register the iOS notification category for the exit prompt quick-action.
 *
 * Must be called once at app startup (App.tsx) before any exit prompt can fire.
 * Idempotent — safe to call on every launch.
 */
export async function registerExitPromptCategory(): Promise<void> {
  await notifee.setNotificationCategories([
    {
      id: 'exit_prompt',
      actions: [
        {
          id:    EXIT_ACTION_MARK_DONE,
          title: 'Yes, brushed ✓',
        },
      ],
    },
    {
      id: 'dated_task_handoff_single',
      actions: [
        { id: DATED_TASK_ACTION_FORGET, title: COPY.datedTaskHandoff.forget },
        { id: DATED_TASK_ACTION_TOMORROW, title: COPY.datedTaskHandoff.tomorrow },
      ],
    },
  ]);
}

export async function fireExitPrompt(options: {
  taskId:    string;
  taskTitle: string;
  storeName?: string;
}): Promise<void> {
  const { taskId, taskTitle, storeName } = options;

  await notifee.createChannel({
    id:         CHANNEL_EXIT,
    name:       'Location exit prompts',
    importance: AndroidImportance.DEFAULT,
    vibration:  true,
    visibility: AndroidVisibility.PUBLIC,
  });

  await notifee.displayNotification({
    title: 'Brush',
    body:  buildExitBody(storeName),
    android: {
      channelId:   CHANNEL_EXIT,
      importance:  AndroidImportance.DEFAULT,
      pressAction: { id: 'default', launchActivity: 'default' },
      visibility:  AndroidVisibility.PUBLIC,
      smallIcon:   'ic_notification',
      actions: [
        {
          title:       'Yes, brushed ✓',
          pressAction: { id: EXIT_ACTION_MARK_DONE },
        },
      ],
    },
    ios: {
      categoryId: 'exit_prompt',
    },
    // taskId is forwarded to the action handler in App.tsx.
    data: { screen: 'Today', taskId, taskTitle },
  });
}

// ─── KAN-280: user-set task time reminder ─────────────────────────────────────

export const CHANNEL_TASK_REMINDER = 'task-reminder';

function taskReminderNotifId(taskId: string): string {
  return `task-reminder-${taskId}`;
}

export async function createTaskReminderChannel(): Promise<void> {
  await notifee.createChannel({
    id:         CHANNEL_TASK_REMINDER,
    name:       'Task reminders',
    importance: AndroidImportance.DEFAULT,
    vibration:  false,
    visibility: AndroidVisibility.PUBLIC,
  });
}

/**
 * Schedule the single calm reminder for a task's user-set time.
 *
 * Cancels any existing reminder for this task first, so repeated calls
 * (e.g. re-saving the form) are idempotent. Silent no-op if `time` is empty
 * or the moment has already passed — this never rolls forward to tomorrow,
 * unlike scheduleEodReminder: a reminder that follows the task daily is the
 * banned nagging mechanic (KAN-280). Explicit time beats quiet hours, so
 * this intentionally does not check isQuietHours().
 */
export async function scheduleTaskReminder(options: {
  taskId:    string;
  taskTitle: string;
  date:      string; // "YYYY-MM-DD"
  time:      string; // "HH:MM"
}): Promise<void> {
  const { taskId, taskTitle, date, time } = options;

  await cancelTaskReminder(taskId);

  if (!time.trim()) { return; }

  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes]   = time.split(':').map(Number);
  const fireAt = new Date(year, month - 1, day, hours, minutes, 0, 0);

  if (fireAt.getTime() <= Date.now()) { return; }

  await createTaskReminderChannel();

  const trigger: TimestampTrigger = {
    type:      TriggerType.TIMESTAMP,
    timestamp: fireAt.getTime(),
  };

  await notifee.createTriggerNotification(
    {
      id:    taskReminderNotifId(taskId),
      title: COPY.taskReminder.title(time),
      body:  COPY.taskReminder.body(taskTitle),
      android: {
        channelId:   CHANNEL_TASK_REMINDER,
        importance:  AndroidImportance.DEFAULT,
        pressAction: { id: 'default', launchActivity: 'default' },
        visibility:  AndroidVisibility.PUBLIC,
        smallIcon:   'ic_notification',
      },
      data: { screen: 'Today', taskId },
    },
    trigger,
  );
}

/** Cancel any pending reminder for a task (brush, delete, time cleared/edited). */
export async function cancelTaskReminder(taskId: string): Promise<void> {
  await notifee.cancelNotification(taskReminderNotifId(taskId));
}
