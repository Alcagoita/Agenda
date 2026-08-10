const mockGetScheduledTasksForDate = jest.fn();
const mockGetTask = jest.fn();
const mockResolveDatedTaskHandoff = jest.fn();
const mockScheduleDatedTaskHandoff = jest.fn();
const mockCancelDatedTaskHandoff = jest.fn();

jest.mock('../../src/services/firestore', () => ({
  getScheduledTasksForDate: (...args: unknown[]) => mockGetScheduledTasksForDate(...args),
  getTask: (...args: unknown[]) => mockGetTask(...args),
  resolveDatedTaskHandoff: (...args: unknown[]) => mockResolveDatedTaskHandoff(...args),
}));

jest.mock('../../src/services/notifications', () => ({
  scheduleDatedTaskHandoff: (...args: unknown[]) => mockScheduleDatedTaskHandoff(...args),
  cancelDatedTaskHandoff: (...args: unknown[]) => mockCancelDatedTaskHandoff(...args),
}));

import {
  forgetDatedTask,
  moveDatedTaskToTomorrow,
  refreshDatedTaskHandoff,
} from '../../src/services/datedTaskHandoff';

const DATE = '2026-08-10';

beforeEach(() => {
  jest.clearAllMocks();
  mockScheduleDatedTaskHandoff.mockResolvedValue(undefined);
  mockCancelDatedTaskHandoff.mockResolvedValue(undefined);
  mockResolveDatedTaskHandoff.mockResolvedValue(undefined);
});

describe('datedTaskHandoff', () => {
  it('builds the one date notification from unfinished tasks still scheduled for that date', async () => {
    mockGetScheduledTasksForDate.mockResolvedValue([
      { id: 'open', title: 'Buy milk', done: false, scheduledDate: DATE },
      { id: 'done', title: 'Call Ana', done: true, scheduledDate: DATE },
      { id: 'moved', title: 'Pick up book', done: false, scheduledDate: '2026-08-11' },
    ]);

    await refreshDatedTaskHandoff('uid-1', DATE);

    expect(mockScheduleDatedTaskHandoff).toHaveBeenCalledWith({
      uid: 'uid-1', date: DATE, tasks: [{ id: 'open', title: 'Buy milk' }],
    });
  });

  it('records Forget it without changing the selected date', async () => {
    mockGetTask.mockResolvedValue({ id: 't1', done: false, scheduledDate: DATE });

    await forgetDatedTask('uid-1', 't1', DATE);

    expect(mockResolveDatedTaskHandoff).toHaveBeenCalledWith(
      'uid-1', 't1', DATE, 'forgotten', undefined, DATE,
    );
    expect(mockCancelDatedTaskHandoff).toHaveBeenCalledWith(DATE);
  });

  it('moves a confirmed task exactly one local day forward and rebuilds tomorrow', async () => {
    mockGetTask.mockResolvedValue({ id: 't1', done: false, scheduledDate: DATE });
    mockGetScheduledTasksForDate.mockResolvedValue([]);

    await moveDatedTaskToTomorrow('uid-1', 't1', DATE);

    expect(mockResolveDatedTaskHandoff).toHaveBeenCalledWith(
      'uid-1', 't1', DATE, 'tomorrow', '2026-08-11', DATE,
    );
    expect(mockCancelDatedTaskHandoff).toHaveBeenCalledWith(DATE);
    expect(mockScheduleDatedTaskHandoff).toHaveBeenCalledWith({
      uid: 'uid-1', date: '2026-08-11', tasks: [],
    });
  });

  it('ignores an old notification after a task was brushed or moved', async () => {
    mockGetTask.mockResolvedValue({ id: 't1', done: true, scheduledDate: DATE });

    await forgetDatedTask('uid-1', 't1', DATE);

    expect(mockResolveDatedTaskHandoff).not.toHaveBeenCalled();
    expect(mockCancelDatedTaskHandoff).not.toHaveBeenCalled();
  });

  it('ignores a stale notification after an incomplete task was moved to another date', async () => {
    mockGetTask.mockResolvedValue({ id: 't1', done: false, scheduledDate: '2026-08-11' });

    await forgetDatedTask('uid-1', 't1', DATE);
    await moveDatedTaskToTomorrow('uid-1', 't1', DATE);

    expect(mockResolveDatedTaskHandoff).not.toHaveBeenCalled();
    expect(mockCancelDatedTaskHandoff).not.toHaveBeenCalled();
  });
});
