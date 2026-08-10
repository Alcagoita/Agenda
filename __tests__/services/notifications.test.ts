/**
 * notifications.ts tests — restructured for KAN-303 (three channels).
 *
 * Covers:
 *  - scheduleEodReminder (Daily): no-op when disabled; schedules with the
 *    morning check-in copy; rolls forward when the time has passed; no count.
 *  - the Daily body carries no tally / banned words (AC6).
 *  - cancelRetiredNotifications cancels the cut streak + weekly triggers (AC4).
 *  - the cut schedulers (streak / weekly / achievement) no longer exist (AC3).
 *  - scheduleTaskReminder is unaffected (AC9).
 *  - exit prompt copy + firing (KAN-119).
 */

import {
  scheduleEodReminder,
  cancelEodReminder,
  cancelRetiredNotifications,
  buildExitBody,
  fireExitPrompt,
  registerExitPromptCategory,
  EXIT_ACTION_MARK_DONE,
  scheduleTaskReminder,
} from '../../src/services/notifications';
import * as notifications from '../../src/services/notifications';
import { COPY } from '../../src/constants/copy';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockCreateChannel              = jest.fn().mockResolvedValue(undefined);
const mockCreateTriggerNotification  = jest.fn().mockResolvedValue(undefined);
const mockCancelNotification         = jest.fn().mockResolvedValue(undefined);
const mockDisplayNotification        = jest.fn().mockResolvedValue(undefined);
const mockSetNotificationCategories  = jest.fn().mockResolvedValue(undefined);

jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    createChannel:              (...args: any[]) => mockCreateChannel(...args),
    createTriggerNotification:  (...args: any[]) => mockCreateTriggerNotification(...args),
    cancelNotification:          (...args: any[]) => mockCancelNotification(...args),
    displayNotification:         (...args: any[]) => mockDisplayNotification(...args),
    setNotificationCategories:   (...args: any[]) => mockSetNotificationCategories(...args),
  },
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  AndroidVisibility: { PUBLIC: 1 },
  TriggerType:       { TIMESTAMP: 0 },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function futureTime(): string {
  const safeHour = (new Date().getHours() + 2) % 24;
  return `${String(safeHour).padStart(2, '0')}:00`;
}

function pastTime(): string {
  const h = new Date().getHours();
  const safeHour = h === 0 ? 23 : h - 1;
  return `${String(safeHour).padStart(2, '0')}:00`;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function futureDateTime(hoursAhead = 2): { date: string; time: string } {
  const d = new Date(Date.now() + hoursAhead * 3600_000);
  return { date: ymd(d), time: hm(d) };
}
function pastDateTime(hoursBehind = 1): { date: string; time: string } {
  const d = new Date(Date.now() - hoursBehind * 3600_000);
  return { date: ymd(d), time: hm(d) };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Daily check-in (KAN-120 / KAN-303) ───────────────────────────────────────

describe('scheduleEodReminder', () => {
  it('cancels any existing check-in before scheduling', async () => {
    await scheduleEodReminder({ enabled: true, time: futureTime() });
    expect(mockCancelNotification).toHaveBeenCalledWith('eod-checkin');
  });

  it('does NOT schedule when disabled', async () => {
    await scheduleEodReminder({ enabled: false, time: futureTime() });
    expect(mockCreateTriggerNotification).not.toHaveBeenCalled();
  });

  it('schedules with the morning check-in copy — no count involved', async () => {
    await scheduleEodReminder({ enabled: true, time: futureTime() });
    expect(mockCreateTriggerNotification).toHaveBeenCalledTimes(1);
    const [notification] = mockCreateTriggerNotification.mock.calls[0];
    expect(notification.title).toBe(COPY.dailyCheckin.title);
    expect(notification.body).toBe(COPY.dailyCheckin.body);
    expect(notification.data).toEqual({ screen: 'Today' });
  });

  it('still schedules (rolls forward to tomorrow) when the time has already passed', async () => {
    await scheduleEodReminder({ enabled: true, time: pastTime() });
    expect(mockCreateTriggerNotification).toHaveBeenCalledTimes(1);
  });
});

describe('cancelEodReminder', () => {
  it('delegates to notifee.cancelNotification with the check-in id', async () => {
    await cancelEodReminder();
    expect(mockCancelNotification).toHaveBeenCalledWith('eod-checkin');
  });
});

describe('Daily check-in content (KAN-303, AC6)', () => {
  it('carries no count and none of the banned tally words', () => {
    expect(COPY.dailyCheckin.body).not.toMatch(/\d/);
    expect(COPY.dailyCheckin.body).not.toMatch(/\b(left|overdue|unfinished)\b/i);
  });
});

// ─── Migration: cancel the retired notifications (KAN-303, AC4) ────────────────

describe('cancelRetiredNotifications', () => {
  it('cancels the streak-at-risk and weekly-recap notifications', async () => {
    await cancelRetiredNotifications();
    expect(mockCancelNotification).toHaveBeenCalledWith('streak-at-risk');
    expect(mockCancelNotification).toHaveBeenCalledWith('weekly-recap');
  });
});

// ─── Absence: the cut schedulers are gone (KAN-303, AC3) ──────────────────────

describe('cut notification schedulers no longer exist', () => {
  it('exports no streak / weekly / achievement scheduling functions', () => {
    for (const name of [
      'scheduleStreakReminder', 'cancelStreakReminder', 'buildStreakBody',
      'scheduleWeeklyRecap', 'cancelWeeklyRecap', 'buildWeeklyBody', 'nextSundayAt7PM',
      'fireAchievementNudge', 'buildAchievementNudgeBody', 'buildEodBody',
    ]) {
      expect((notifications as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

// ─── Task reminders — untouched by KAN-303 (AC9) ──────────────────────────────

describe('scheduleTaskReminder', () => {
  it('schedules a trigger notification for a future task time', async () => {
    const { date, time } = futureDateTime();
    await scheduleTaskReminder({ taskId: 't1', taskTitle: 'Buy milk', date, time });
    expect(mockCreateTriggerNotification).toHaveBeenCalledTimes(1);
  });

  it('no-ops for a task time already in the past', async () => {
    const { date, time } = pastDateTime();
    await scheduleTaskReminder({ taskId: 't1', taskTitle: 'Buy milk', date, time });
    expect(mockCreateTriggerNotification).not.toHaveBeenCalled();
  });

  it('cancels the existing reminder for that task first', async () => {
    const { date, time } = futureDateTime();
    await scheduleTaskReminder({ taskId: 't1', taskTitle: 'Buy milk', date, time });
    expect(mockCancelNotification).toHaveBeenCalledWith('task-reminder-t1');
  });
});

// ─── Exit prompt (KAN-119) ────────────────────────────────────────────────────

describe('buildExitBody', () => {
  it('includes the store name when provided', () => {
    expect(buildExitBody('Pingo Doce')).toBe('Left Pingo Doce — did you brush it away?');
  });
  it('falls back to a generic body without a store name', () => {
    expect(buildExitBody()).toBe('Did you brush it away while you were there?');
  });
});

describe('fireExitPrompt', () => {
  it('displays a notification with the exit body and mark-done action', async () => {
    await fireExitPrompt({ taskId: 't9', taskTitle: 'Pick up parcel', storeName: 'CTT' });
    expect(mockDisplayNotification).toHaveBeenCalledTimes(1);
    const [notification] = mockDisplayNotification.mock.calls[0];
    expect(notification.body).toBe('Left CTT — did you brush it away?');
    expect(notification.android.actions[0].pressAction.id).toBe(EXIT_ACTION_MARK_DONE);
    expect(notification.data).toMatchObject({ screen: 'Today', taskId: 't9' });
  });
});

describe('registerExitPromptCategory', () => {
  it('registers the iOS exit-prompt category with the mark-done action', async () => {
    await registerExitPromptCategory();
    expect(mockSetNotificationCategories).toHaveBeenCalledTimes(1);
    const [[category]] = mockSetNotificationCategories.mock.calls[0];
    expect(category.id).toBe('exit_prompt');
    expect(category.actions[0].id).toBe(EXIT_ACTION_MARK_DONE);
  });
});
