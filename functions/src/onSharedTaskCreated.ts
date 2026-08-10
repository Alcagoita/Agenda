/**
 * onSharedTaskCreated — KAN-221
 *
 * Firestore trigger that fires when a shared-task record is created under
 * sharedTasks/{recipientUid}/incoming/{docId} (written client-side by
 * sendSharedTask(), which is rules-guarded by sentBy == auth.uid). Writes the
 * corresponding pendingNotifications entry server-side so the recipient's
 * device fires a local notifee notification.
 *
 * This replaces the client's direct write to pendingNotifications/{recipientUid}
 * (KAN-86/87), which let any authenticated user drop an arbitrary "shared task"
 * notification into another user's mailbox without a real incoming record
 * behind it. This function only reacts to an incoming doc that already passed
 * the sharedTasks create rule, so the notification can no longer be forged.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';

export interface SharedTaskData {
  title:           string;
  sentBy:          string;
  sentByName:      string;
  sentByUsername?: string;
}

/**
 * "From people" channel gate (KAN-303). Shared-task notifications used to fire
 * unconditionally; now they respect the recipient's `sharedTasks` preference.
 * Defaults on — only an explicit `false` mutes them, so users who never touched
 * the setting keep getting them.
 */
export function shouldNotifyRecipient(prefs: { sharedTasks?: boolean }): boolean {
  return prefs.sharedTasks !== false;
}

/** Builds the pendingNotification payload for a new incoming shared task. */
export function buildSharedTaskNotification(
  recipientUid: string,
  sharedTaskId: string,
  data: SharedTaskData,
) {
  const handle = data.sentByUsername ? `@${data.sentByUsername}` : data.sentByName;
  return {
    type:   'shared_task' as const,
    sentBy: data.sentBy,
    title:  `${handle} sent you a task`,
    body:   data.title,
    data: {
      type:         'shared_task',
      sharedTaskId,
      recipientUid,
      screen:       'SharedTaskInbox',
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

export const onSharedTaskCreated = onDocumentCreated(
  'sharedTasks/{recipientUid}/incoming/{docId}',
  async (event) => {
    const data = event.data?.data() as SharedTaskData | undefined;
    if (!data) { return; }

    const recipientUid = event.params.recipientUid;
    const sharedTaskId = event.params.docId;
    const db = admin.firestore();

    // KAN-303 "From people": respect the recipient's sharedTasks preference.
    const prefsSnap = await db
      .collection('users').doc(recipientUid)
      .collection('userPreferences').doc('prefs')
      .get();
    if (!shouldNotifyRecipient(prefsSnap.data() ?? {})) { return; }

    // Reuse the incoming doc's ID for the notification doc — deterministic,
    // avoids duplicates on retry, and keeps the two records correlated.
    await db
      .collection('pendingNotifications').doc(recipientUid)
      .collection('items').doc(sharedTaskId)
      .set(buildSharedTaskNotification(recipientUid, sharedTaskId, data));
  },
);
