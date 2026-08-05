/**
 * OnboardingScreen tests — KAN-140
 *
 * Covers: stage progression, task creation, brush-away, reward card,
 * onboarding completion flag written to Firestore.
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import OnboardingScreen from '../../src/screens/OnboardingScreen';
import { COPY } from '../../src/constants/copy';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    Path: () => null,
  };
});

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg:       '#fdfcfa',
      surface:  '#f4f2ed',
      surface2: '#ece9e2',
      text:     '#1f1c16',
      muted:    '#8b857a',
      faint:    '#c1bbac',
      line:     'rgba(31,28,22,0.08)',
      accent:   '#e8a86a',
    },
    language: 'en',
  }),
}));

const mockAddTask               = jest.fn().mockResolvedValue('task-123');
const mockAwardOnboardingBonus  = jest.fn().mockResolvedValue(undefined);
const mockUpsertUser            = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/firestore', () => ({
  addTask:                    (...args: unknown[]) => mockAddTask(...args),
  upsertUser:                 (...args: unknown[]) => mockUpsertUser(...args),
  ONBOARDING_BONUS_POINTS:    10,
}));

// KAN-271 — onboarding bonus moved server-side, behind this Cloud Function
// proxy (previously a direct client-side awardPointsOnboardingBonus write).
jest.mock('../../src/services/rewardFunctions', () => ({
  awardOnboardingBonus: (...args: unknown[]) => mockAwardOnboardingBonus(...args),
}));

jest.mock('../../src/utils/date', () => ({ todayISO: () => '2026-06-13' }));

const mockScrRotatingNudge = jest.fn(() => {
  const { Text } = require('react-native');
  return <Text>nudge</Text>;
});

jest.mock('../../src/components/ScrRotatingNudge', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockScrRotatingNudge(...args),
}));

jest.mock('../../src/components/BrushStroke', () => () => null);

jest.mock('../../src/components/AppIcon', () => ({
  PoiIcon:  () => null,
  FlameIcon: () => null,
}));


// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderScreen(onComplete = jest.fn()) {
  return render(<OnboardingScreen uid="uid-1" onComplete={onComplete} />);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OnboardingScreen — Stage 1 (Welcome)', () => {
  it('renders the tagline and CTA', () => {
    const { getByText } = renderScreen();
    expect(getByText(COPY.onboarding.welcomeTagline)).toBeTruthy();
    expect(getByText(COPY.onboarding.letsBegin)).toBeTruthy();
  });

  it("advances to Stage 2 when Let's begin is pressed", async () => {
    const { getByText } = renderScreen();
    fireEvent.press(getByText(COPY.onboarding.letsBegin));
    await waitFor(() => expect(getByText(COPY.onboarding.addFirstThing)).toBeTruthy());
  });
});

describe('OnboardingScreen — Stage 2 (Empty)', () => {
  async function getStage2(onComplete = jest.fn()) {
    const utils = renderScreen(onComplete);
    fireEvent.press(utils.getByText(COPY.onboarding.letsBegin));
    await waitFor(() => utils.getByText(COPY.onboarding.addFirstThing));
    return utils;
  }

  it('shows the rotating nudge component', async () => {
    const { getByText } = await getStage2();
    expect(getByText('nudge')).toBeTruthy();
  });

  it('builds six onboarding nudges', async () => {
    await getStage2();
    expect(mockScrRotatingNudge).toHaveBeenCalled();
    const lastCall = mockScrRotatingNudge.mock.calls[mockScrRotatingNudge.mock.calls.length - 1];
    const props = lastCall?.[0] as { messages?: unknown[] } | undefined;
    expect(props?.messages).toHaveLength(6);
  });

  it('opens the bottom sheet when CTA is pressed', async () => {
    const { getByText } = await getStage2();
    fireEvent.press(getByText(COPY.onboarding.addFirstThing));
    await waitFor(() => expect(getByText(COPY.onboarding.sheetEyebrow)).toBeTruthy());
  });

  it('"Add it" button is disabled when input is empty', async () => {
    mockAddTask.mockClear();
    const utils = await getStage2();
    fireEvent.press(utils.getByText(COPY.onboarding.addFirstThing));
    await waitFor(() => utils.getByText(COPY.onboarding.sheetEyebrow));
    // Press "Add it" with empty input — handler should be a no-op
    fireEvent.press(utils.getByText(COPY.onboarding.addItButton));
    expect(mockAddTask).not.toHaveBeenCalled();
  });

  it('fills input when a suggestion chip is tapped', async () => {
    const { getByText, getByRole } = await getStage2();
    fireEvent.press(getByText(COPY.onboarding.addFirstThing));
    await waitFor(() => getByText(COPY.onboarding.chipBuyBread));
    fireEvent.press(getByText(COPY.onboarding.chipBuyBread));
    expect(getByRole('checkbox', { name: COPY.onboarding.chipBuyBread }).props.accessibilityState.checked).toBe(true);
  });
});

describe('OnboardingScreen — Stage 3 → 4 (Create → Payoff)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function advanceToStage4(utils: ReturnType<typeof renderScreen>) {
    fireEvent.press(utils.getByText(COPY.onboarding.letsBegin));
    await waitFor(() => utils.getByText(COPY.onboarding.addFirstThing));
    fireEvent.press(utils.getByText(COPY.onboarding.addFirstThing));
    await waitFor(() => utils.getByText(COPY.onboarding.chipBuyBread));
    fireEvent.press(utils.getByText(COPY.onboarding.chipBuyBread));
    await act(async () => {
      fireEvent.press(utils.getByText(COPY.onboarding.addItButton));
      // Allow the addTask promise to resolve
      await Promise.resolve();
    });
    act(() => {
      // Advance the 350ms stage transition timer
      jest.advanceTimersByTime(400);
    });
    await waitFor(() => utils.getByText(COPY.onboarding.chipBuyBread));
  }

  it('creates a task in Firestore on submit', async () => {
    const utils = renderScreen();
    await advanceToStage4(utils);
    expect(mockAddTask).toHaveBeenCalledWith('uid-1', expect.objectContaining({
      title:    COPY.onboarding.chipBuyBread,
      category: 'errands',
      date:     '2026-06-13',
    }));
  });

  it('shows the task title in Stage 4', async () => {
    const utils = renderScreen();
    await advanceToStage4(utils);
    expect(utils.getByText(COPY.onboarding.chipBuyBread)).toBeTruthy();
  });

  it('shows the "Tap the circle" hint when task is not done', async () => {
    const utils = renderScreen();
    await advanceToStage4(utils);
    expect(utils.getByText(/brush it away/i)).toBeTruthy();
  });
});

describe('OnboardingScreen — completion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockAwardOnboardingBonus.mockClear();
    mockUpsertUser.mockClear();
  });
  afterEach(() => jest.useRealTimers());

  async function advanceToStage4Full(utils: ReturnType<typeof renderScreen>) {
    fireEvent.press(utils.getByText(COPY.onboarding.letsBegin));
    await waitFor(() => utils.getByText(COPY.onboarding.addFirstThing));
    fireEvent.press(utils.getByText(COPY.onboarding.addFirstThing));
    await waitFor(() => utils.getByText(COPY.onboarding.chipBuyBread));
    fireEvent.press(utils.getByText(COPY.onboarding.chipBuyBread));
    await act(async () => {
      fireEvent.press(utils.getByText(COPY.onboarding.addItButton));
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(400);
    });
    await waitFor(() => utils.getByText(COPY.onboarding.chipBuyBread));
  }

  it('animated path: awards onboarding bonus and calls onComplete', async () => {
    const onComplete = jest.fn();
    const utils = renderScreen(onComplete);
    await advanceToStage4Full(utils);

    // Brush away — animated path (reduceMotion = false)
    await act(async () => {
      fireEvent.press(utils.getAllByRole('checkbox')[0]);
      jest.advanceTimersByTime(700);
    });

    await waitFor(() => utils.getByText(COPY.onboarding.seeFullDay));
    await act(async () => { fireEvent.press(utils.getByText(COPY.onboarding.seeFullDay)); });

    expect(mockAwardOnboardingBonus).toHaveBeenCalledWith('task-123');
    expect(mockUpsertUser).toHaveBeenCalledWith('uid-1', { onboardingDone: true });
    expect(onComplete).toHaveBeenCalled();
  });

  it('reduce-motion path: awards onboarding bonus without animation', async () => {
    // Simulate reduce-motion by mocking AccessibilityInfo before render
    const AccessibilityInfo = require('react-native').AccessibilityInfo;
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);

    const utils = renderScreen();
    await advanceToStage4Full(utils);

    await act(async () => {
      fireEvent.press(utils.getAllByRole('checkbox')[0]);
      jest.advanceTimersByTime(300);
    });

    await waitFor(() => utils.getByText(COPY.onboarding.seeFullDay));

    expect(mockAwardOnboardingBonus).toHaveBeenCalledWith('task-123');

    jest.restoreAllMocks();
  });
});
