/**
 * src/services/sharing.ts — KAN-86 / KAN-87
 *
 * In-app task sharing: send a task to another Brush user.
 *
 * Send flow (KAN-86):
 *   1. findUserByEmail()   — exact-match email lookup in Firestore
 *   2. sendSharedTask()    — writes to sharedTasks/{recipientUid}/incoming
 *
 * Receive flow (KAN-87):
 *   subscribeToIncomingSharedTasks()   — real-time listener for the inbox
 *   acceptSharedTask()                 — copies task into recipient's collection
 *   declineSharedTask()                — removes from incoming
 *
 * Notification delivery (KAN-221):
 *   The onSharedTaskCreated Cloud Function (functions/src/onSharedTaskCreated.ts)
 *   writes a pendingNotifications/{recipientUid}/items/{id} document when the
 *   incoming record above is created. The recipient's device (KAN-87)
 *   subscribes to that collection and fires a local notifee notification when
 *   a new item arrives. Moving the write server-side closed a spoofing hole:
 *   previously the client wrote pendingNotifications directly, which let any
 *   authenticated user forge a notification into another user's mailbox with
 *   no real shared task behind it.
 */

import {
  getFirestore,
  collection,
  doc,
  addDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from '@react-native-firebase/firestore';
import { Task, SharedTask, PendingNotification } from '../types';
import { markTasksDirty } from './taskMutationSignal';

// ─── User lookup ──────────────────────────────────────────────────────────────

export interface UserSummary {
  uid:         string;
  displayName: string;
  email:       string;
}

/**
 * Find a Brush user by exact email address (case-insensitive via lowercase).
 * Returns null if no user is found.
 */
export async function findUserByEmail(email: string): Promise<UserSummary | null> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) { return null; }

  const snap = await getDocs(
    query(
      collection(getFirestore(), 'users'),
      where('email', '==', normalised),
    ),
  );

  if (snap.empty) { return null; }

  const data = snap.docs[0].data();
  return {
    uid:         snap.docs[0].id,
    displayName: data.displayName ?? 'Brush user',
    email:       data.email ?? normalised,
  };
}

// ─── Send ─────────────────────────────────────────────────────────────────────

export interface SendSharedTaskParams {
  senderUid:      string;
  senderName:     string;
  senderUsername?: string;   // @username — included in inbox row (KAN-101)
  recipientUid:   string;
  recipientName:  string;
  task:           Task;
}

/**
 * Write the shared task record and a pending notification document,
 * then atomically remove the task from the sender's own task list.
 * Returns the ID of the created incoming record.
 */
export async function sendSharedTask(params: SendSharedTaskParams): Promise<string> {
  const { senderUid, senderName, senderUsername, recipientUid, task } = params;

  if (senderUid === recipientUid) {
    throw new Error('CANNOT_SEND_TO_SELF');
  }

  const db = getFirestore();

  // Pre-allocate doc refs so they can go into a batch.
  const incomingDocRef  = doc(collection(db, 'sharedTasks', recipientUid, 'incoming'));
  const senderTaskRef   = doc(db, 'users', senderUid, 'tasks', task.id);

  const batch = writeBatch(db);

  // 1. Write shared task to recipient's inbox.
  batch.set(incomingDocRef, {
    taskId:          task.id,
    title:           task.title,
    category:        task.category,
    ...(task.poi ? { poi: task.poi } : {}),
    sentBy:          senderUid,
    sentByName:      senderName,
    ...(senderUsername ? { sentByUsername: senderUsername } : {}),
    sentAt:          serverTimestamp(),
    status:          'pending' as const,
  });

  // The pendingNotification for the recipient's device is written
  // server-side by the onSharedTaskCreated Cloud Function (KAN-221),
  // triggered off the incoming record above — the client no longer writes
  // directly to another user's pendingNotifications mailbox.

  // 2. Remove the task from the sender — only the recipient can complete it.
  batch.delete(senderTaskRef);

  await batch.commit();

  return incomingDocRef.id;
}

// ─── Receive (KAN-87) ─────────────────────────────────────────────────────────

/**
 * Real-time subscription to the recipient's shared-task inbox.
 * Returns an unsubscribe function.
 */
export function subscribeToIncomingSharedTasks(
  uid: string,
  onNext: (tasks: SharedTask[]) => void,
  onError: (err: Error) => void,
): () => void {
  return onSnapshot(
    query(
      collection(getFirestore(), 'sharedTasks', uid, 'incoming'),
      where('status', '==', 'pending'),
    ),
    { includeMetadataChanges: false },
    snap => {
      const tasks: SharedTask[] = snap.docs.map(d => ({
        id: d.id,
        ...(d.data() as Omit<SharedTask, 'id'>),
      }));
      onNext(tasks);
    },
    onError,
  );
}

/** One-shot fetch of pending incoming shared tasks. */
export async function getIncomingSharedTasks(uid: string): Promise<SharedTask[]> {
  const snap = await getDocs(
    query(
      collection(getFirestore(), 'sharedTasks', uid, 'incoming'),
      where('status', '==', 'pending'),
    ),
  );
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<SharedTask, 'id'>) }));
}

/** One-shot count of pending incoming shared tasks (for badge). */
export async function getIncomingSharedTasksCount(uid: string): Promise<number> {
  const snap = await getDocs(
    query(
      collection(getFirestore(), 'sharedTasks', uid, 'incoming'),
      where('status', '==', 'pending'),
    ),
  );
  return snap.size;
}

/**
 * Accept a shared task: copy it into the recipient's own task collection
 * and remove it from incoming.
 */
export async function acceptSharedTask(
  recipientUid: string,
  shared: SharedTask,
): Promise<void> {
  const db  = getFirestore();
  await addDoc(
    collection(db, 'users', recipientUid, 'tasks'),
    {
      title:     shared.title,
      category:  shared.category,
      ...(shared.poi ? { poi: shared.poi } : {}),
      done:      false,
      createdAt: serverTimestamp(),
    },
  );

  await deleteDoc(
    doc(db, 'sharedTasks', recipientUid, 'incoming', shared.id),
  );
  markTasksDirty();
}

/**
 * Decline a shared task: remove it from incoming with no further action.
 */
export async function declineSharedTask(
  recipientUid: string,
  sharedTaskId: string,
): Promise<void> {
  await deleteDoc(
    doc(getFirestore(), 'sharedTasks', recipientUid, 'incoming', sharedTaskId),
  );
}

/**
 * Subscribe to pending notifications for a user. Fires the callback with
 * each new notification document, then deletes it after delivery.
 * Returns an unsubscribe function.
 *
 * Called by KAN-87 to trigger local notifee notifications.
 */
export function subscribeToSharedTaskNotifications(
  uid: string,
  onNotification: (n: PendingNotification) => void,
): () => void {
  return onSnapshot(
    collection(getFirestore(), 'pendingNotifications', uid, 'items'),
    { includeMetadataChanges: false },
    snap => {
      if (!snap) { return; }
      snap.docChanges().forEach(change => {
        if (change.type === 'added') {
          const data = change.doc.data() as Omit<PendingNotification, 'id'>;
          onNotification({ id: change.doc.id, ...data });
          // Delete after delivery to avoid re-triggering on reconnect.
          deleteDoc(change.doc.ref).catch(() => {});
        }
      });
    },
  );
}
