/**
 * datedTaskHandoff — bridges dated-task Firestore state with local Notifee
 * triggers. The notification is device-local; Firestore remains the durable
 * source of truth and queues action writes while offline.
 */

import {
  getTask,
  getScheduledTasksForDate,
  resolveDatedTaskHandoff,
} from './firestore';
import {
  cancelDatedTaskHandoff,
  scheduleDatedTaskHandoff,
} from './notifications';
import { addLocalDays } from '../utils/date';

/** Rebuild the single 20:00 notification for one selected date. */
export async function refreshDatedTaskHandoff(uid: string, date: string): Promise<void> {
  const tasks = await getScheduledTasksForDate(uid, date);
  await scheduleDatedTaskHandoff({
    uid,
    date,
    tasks: tasks
      .filter(task => !task.done && task.scheduledDate === date)
      .map(task => ({ id: task.id, title: task.title })),
  });
}

export async function forgetDatedTask(
  uid: string,
  taskId: string,
  date: string,
): Promise<void> {
  const task = await getTask(uid, taskId);
  // A changed or brushed task must not be altered by an old notification.
  if (!task || task.done || task.scheduledDate !== date) { return; }
  await resolveDatedTaskHandoff(
    uid, taskId, date, 'forgotten', undefined, task.originalScheduledDate ?? date,
  );
  await cancelDatedTaskHandoff(date);
}

export async function moveDatedTaskToTomorrow(
  uid: string,
  taskId: string,
  date: string,
): Promise<void> {
  const task = await getTask(uid, taskId);
  if (!task || task.done || task.scheduledDate !== date) { return; }
  const tomorrow = addLocalDays(date, 1);
  if (!tomorrow) { return; }
  await resolveDatedTaskHandoff(
    uid, taskId, date, 'tomorrow', tomorrow, task.originalScheduledDate ?? date,
  );
  await Promise.all([
    cancelDatedTaskHandoff(date),
    refreshDatedTaskHandoff(uid, tomorrow),
  ]);
}
