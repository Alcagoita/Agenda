/**
 * KAN-221 — onSharedTaskCreated helpers unit tests
 *
 * Tests buildSharedTaskNotification in isolation. The Firestore trigger
 * itself (onSharedTaskCreated) is exercised against the Firebase emulator
 * in integration tests.
 */

import { buildSharedTaskNotification, shouldNotifyRecipient } from '../onSharedTaskCreated';

describe('shouldNotifyRecipient (KAN-303 From people gate)', () => {
  it('defaults on when the sharedTasks preference is unset', () => {
    expect(shouldNotifyRecipient({})).toBe(true);
  });

  it('stays on when sharedTasks is explicitly true', () => {
    expect(shouldNotifyRecipient({ sharedTasks: true })).toBe(true);
  });

  it('mutes shared-task notifications only on an explicit false', () => {
    expect(shouldNotifyRecipient({ sharedTasks: false })).toBe(false);
  });
});

describe('buildSharedTaskNotification', () => {
  it('uses @username as the handle when available', () => {
    const payload = buildSharedTaskNotification('uid-recipient', 'incoming-1', {
      title: 'Buy groceries', sentBy: 'uid-sender', sentByName: 'Bob', sentByUsername: 'bob',
    });
    expect(payload.title).toBe('@bob sent you a task');
  });

  it('falls back to sentByName when no username is set', () => {
    const payload = buildSharedTaskNotification('uid-recipient', 'incoming-1', {
      title: 'Buy groceries', sentBy: 'uid-sender', sentByName: 'Bob',
    });
    expect(payload.title).toBe('Bob sent you a task');
  });

  it('uses the task title as the body', () => {
    const payload = buildSharedTaskNotification('uid-recipient', 'incoming-1', {
      title: 'Buy groceries', sentBy: 'uid-sender', sentByName: 'Bob',
    });
    expect(payload.body).toBe('Buy groceries');
  });

  it('sets type=shared_task and sentBy from the incoming record', () => {
    const payload = buildSharedTaskNotification('uid-recipient', 'incoming-1', {
      title: 'Buy groceries', sentBy: 'uid-sender', sentByName: 'Bob',
    });
    expect(payload.type).toBe('shared_task');
    expect(payload.sentBy).toBe('uid-sender');
  });

  it('includes sharedTaskId, recipientUid and screen in data', () => {
    const payload = buildSharedTaskNotification('uid-recipient', 'incoming-1', {
      title: 'Buy groceries', sentBy: 'uid-sender', sentByName: 'Bob',
    });
    expect(payload.data).toEqual({
      type:         'shared_task',
      sharedTaskId: 'incoming-1',
      recipientUid: 'uid-recipient',
      screen:       'SharedTaskInbox',
    });
  });
});
