/**
 * Unit tests for src/components/TaskRow.tsx — KAN-61 / KAN-109
 *
 * Covers:
 *   - Built-in category chip renders correctly
 *   - Custom category ID resolved from customCategories prop
 *   - Fallback 'Other' chip shown for orphaned/unknown category IDs
 *   - Built-in categories still work when customCategories prop is provided
 *   - No textDecorationLine strikethrough (replaced by BrushStroke in KAN-109)
 *   - BrushStroke rendered with measured width after onLayout fires
 *   - BrushStroke absent for undone tasks even after layout fires
 *   - strokeScale initialised to 1 for already-done tasks (no animation on mount)
 *   - onToggle callback fired on press
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import TaskRow from '../../src/components/TaskRow';
import type { Task, Category } from '../../src/types';
import { Timestamp } from '@react-native-firebase/firestore';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fdfdfb', surface: '#f6f5f1', surface2: '#efeeea',
      line: 'rgba(20,20,18,0.08)', text: '#1a1a18', muted: '#8a8a85',
      faint: '#bdbdb7', accent: '#e8a86a',
    },
  }),
}));

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

jest.mock('../../src/components/PoiChip', () => 'PoiChip');

// KAN-279 — mocked at the service boundary: openTakeMeThereMaps/getTakeMeThereA11yLabel
// live in services/takeMeThere.ts, which pulls in proximity.ts (notifee/NetInfo/
// expo-sqlite, unavailable under Jest).
const mockOpenTakeMeThereMaps = jest.fn().mockResolvedValue(undefined);
const mockGetTakeMeThereA11yLabel = jest.fn((poiType: string) => `Take me to a ${poiType}`);
jest.mock('../../src/services/takeMeThere', () => ({
  openTakeMeThereMaps:     (...args: unknown[]) => mockOpenTakeMeThereMaps(...args),
  getTakeMeThereA11yLabel: (...args: unknown[]) => mockGetTakeMeThereA11yLabel(...(args as [string])),
}));

// BrushStroke is mocked with a testID so tests can assert presence/absence
// and verify the width prop received. The real SVG component cannot render
// in the Jest/JSDOM environment.
jest.mock('../../src/components/BrushStroke', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ width, color }: { width: number; color: string }) =>
      width > 0 ? <View testID="brush-stroke" accessibilityLabel={`stroke-${width}`} /> : null,
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_TASK: Task = {
  id: 'task-1',
  title: 'Buy groceries',
  category: 'errands',
  done: false,
  createdAt: { toDate: () => new Date() } as unknown as Timestamp,
  date: '2026-05-31',
};

const CUSTOM_CATEGORIES: Category[] = [
  { id: 'custom-gym',    name: 'Gym',    color: '#ff6b6b', isBuiltIn: false },
  { id: 'custom-study',  name: 'Study',  color: '#4ecdc4', isBuiltIn: false },
];

const onToggle = jest.fn();

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks());

describe('TaskRow — category colour (KAN-60)', () => {
  it('applies the category brand colour to the chip label text', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    // Errands colour is #8b6bc4 (muted purple) per tokens.ts.
    const label = screen.getByText('Errands');
    const styles = [label.props.style].flat();
    const hasColor = styles.some((s: any) => s?.color === '#8b6bc4');
    expect(hasColor).toBe(true);
  });

  it('applies a different colour for a different category', () => {
    render(<TaskRow task={{ ...BASE_TASK, category: 'health' }} onToggle={onToggle} />);
    // Health colour is #5ba87a (sage) per tokens.ts.
    const label = screen.getByText('Health');
    const styles = [label.props.style].flat();
    const hasColor = styles.some((s: any) => s?.color === '#5ba87a');
    expect(hasColor).toBe(true);
  });
});

describe('TaskRow — built-in categories', () => {
  it('renders the task title', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    expect(screen.getByText('Buy groceries')).toBeTruthy();
  });

  it('renders the built-in category label', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    expect(screen.getByText('Errands')).toBeTruthy();
  });

  it('renders Work label for work category', () => {
    render(<TaskRow task={{ ...BASE_TASK, category: 'work' }} onToggle={onToggle} />);
    expect(screen.getByText('Work')).toBeTruthy();
  });

  it('renders Health label for health category', () => {
    render(<TaskRow task={{ ...BASE_TASK, category: 'health' }} onToggle={onToggle} />);
    expect(screen.getByText('Health')).toBeTruthy();
  });

  it('renders Personal label for personal category', () => {
    render(<TaskRow task={{ ...BASE_TASK, category: 'personal' }} onToggle={onToggle} />);
    expect(screen.getByText('Personal')).toBeTruthy();
  });
});

describe('TaskRow — subtype accessibility', () => {
  it('includes the rendered subtype in the editable row label', () => {
    const onPress = jest.fn();
    render(<TaskRow task={{ ...BASE_TASK, poi: 'restaurant', restaurantFoodType: 'vegetarian' }} onToggle={onToggle} onPress={onPress} />);
    expect(screen.getByLabelText(/Vegetarian/)).toBeTruthy();
  });
});

describe('TaskRow — birthday tasks (KAN-248)', () => {
  it('renders the cake glyph for a kind:birthday task', () => {
    render(<TaskRow task={{ ...BASE_TASK, category: 'personal', kind: 'birthday' }} onToggle={onToggle} />);
    expect(screen.getByTestId('birthday-cake-icon')).toBeTruthy();
  });

  it('does not render the cake glyph for a normal task', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    expect(screen.queryByTestId('birthday-cake-icon')).toBeNull();
  });
});

describe('TaskRow — custom categories (KAN-61)', () => {
  it('renders custom category name when ID matches customCategories prop', () => {
    render(
      <TaskRow
        task={{ ...BASE_TASK, category: 'custom-gym' }}
        onToggle={onToggle}
        customCategories={CUSTOM_CATEGORIES}
      />,
    );
    expect(screen.getByText('Gym')).toBeTruthy();
  });

  it('renders second custom category correctly', () => {
    render(
      <TaskRow
        task={{ ...BASE_TASK, category: 'custom-study' }}
        onToggle={onToggle}
        customCategories={CUSTOM_CATEGORIES}
      />,
    );
    expect(screen.getByText('Study')).toBeTruthy();
  });

  it('shows fallback "Other" chip for unknown/orphaned category ID', () => {
    render(
      <TaskRow
        task={{ ...BASE_TASK, category: 'deleted-category-id' }}
        onToggle={onToggle}
        customCategories={CUSTOM_CATEGORIES}
      />,
    );
    expect(screen.getByText('Other')).toBeTruthy();
  });

  it('shows fallback "Other" when customCategories is empty and category is unknown', () => {
    render(
      <TaskRow
        task={{ ...BASE_TASK, category: 'unknown-id' }}
        onToggle={onToggle}
        customCategories={[]}
      />,
    );
    expect(screen.getByText('Other')).toBeTruthy();
  });

  it('built-in categories still resolve correctly when customCategories prop is provided', () => {
    render(
      <TaskRow
        task={{ ...BASE_TASK, category: 'work' }}
        onToggle={onToggle}
        customCategories={CUSTOM_CATEGORIES}
      />,
    );
    expect(screen.getByText('Work')).toBeTruthy();
  });

  it('prefers built-in over custom if IDs collide', () => {
    const colliding: Category[] = [
      { id: 'work', name: 'My Work Override', color: '#000', isBuiltIn: false },
    ];
    render(
      <TaskRow
        task={{ ...BASE_TASK, category: 'work' }}
        onToggle={onToggle}
        customCategories={colliding}
      />,
    );
    // Built-in 'Work' takes priority
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.queryByText('My Work Override')).toBeNull();
  });
});

describe('TaskRow — done state (KAN-109: brushstroke replaces strikethrough)', () => {
  it('never applies textDecorationLine: line-through (brushstroke is used instead)', () => {
    render(<TaskRow task={{ ...BASE_TASK, done: true }} onToggle={onToggle} />);
    const title = screen.getByText('Buy groceries');
    const styles = [title.props.style].flat();
    const hasLineThrough = styles.some(
      (s: any) => s?.textDecorationLine === 'line-through',
    );
    expect(hasLineThrough).toBe(false);
  });

  it('does not apply textDecorationLine on undone tasks either', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    const title = screen.getByText('Buy groceries');
    const styles = [title.props.style].flat();
    const hasTextDecoration = styles.some(
      (s: any) => s?.textDecorationLine != null && s.textDecorationLine !== 'none',
    );
    expect(hasTextDecoration).toBe(false);
  });

  it('renders BrushStroke after onLayout fires on a done task', () => {
    render(<TaskRow task={{ ...BASE_TASK, done: true }} onToggle={onToggle} />);

    // No stroke visible yet — width not measured
    expect(screen.queryByTestId('brush-stroke')).toBeNull();

    // Simulate the layout measurement for the title Text
    const title = screen.getByText('Buy groceries');
    fireEvent(title, 'layout', { nativeEvent: { layout: { width: 180, height: 20 } } });

    // BrushStroke should now be present with the measured width
    expect(screen.getByTestId('brush-stroke')).toBeTruthy();
    expect(screen.getByLabelText('stroke-180')).toBeTruthy();
  });

  it('does not render BrushStroke for an undone task even after layout fires', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    const title = screen.getByText('Buy groceries');
    fireEvent(title, 'layout', { nativeEvent: { layout: { width: 180, height: 20 } } });

    // Width is measured but task is not done — BrushStroke should have width=0 and return null
    expect(screen.queryByTestId('brush-stroke')).toBeNull();
  });

  it('mutes title colour when task is done', () => {
    render(<TaskRow task={{ ...BASE_TASK, done: true }} onToggle={onToggle} />);
    const title = screen.getByText('Buy groceries');
    const styles = [title.props.style].flat();
    // palette.muted in the mock is '#8a8a85'
    const hasMuted = styles.some((s: any) => s?.color === '#8a8a85');
    expect(hasMuted).toBe(true);
  });

  it('uses text colour when task is not done', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    const title = screen.getByText('Buy groceries');
    const styles = [title.props.style].flat();
    // palette.text in the mock is '#1a1a18'
    const hasTextColor = styles.some((s: any) => s?.color === '#1a1a18');
    expect(hasTextColor).toBe(true);
  });
});

describe('TaskRow — interaction', () => {
  it('calls onToggle with taskId and toggled done value when pressed', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} />);
    // KAN-110: accessibility label uses "Brush away X" for undone tasks
    fireEvent.press(screen.getByRole('checkbox', { name: 'Brush away Buy groceries' }));
    expect(onToggle).toHaveBeenCalledWith('task-1', true);
  });

  it('calls onToggle with false when task is already done', () => {
    render(<TaskRow task={{ ...BASE_TASK, done: true }} onToggle={onToggle} />);
    // KAN-110: accessibility label uses "Unbrush X" for done tasks
    fireEvent.press(screen.getByRole('checkbox', { name: 'Unbrush Buy groceries' }));
    expect(onToggle).toHaveBeenCalledWith('task-1', false);
  });
});

describe('TaskRow — far-away indicator (KAN-279)', () => {
  it('does NOT render when isFar is false', () => {
    render(<TaskRow task={{ ...BASE_TASK, poi: 'pharmacy' }} onToggle={onToggle} isFar={false} />);
    expect(screen.queryByLabelText('Take me to a pharmacy')).toBeNull();
  });

  it('does NOT render when isFar is true but the task has no poi', () => {
    render(<TaskRow task={BASE_TASK} onToggle={onToggle} isFar />);
    expect(screen.queryByLabelText(/Take me to/)).toBeNull();
  });

  it('renders when isFar is true and the task has a poi', () => {
    render(<TaskRow task={{ ...BASE_TASK, poi: 'pharmacy' }} onToggle={onToggle} isFar />);
    expect(screen.getByLabelText('Take me to a pharmacy')).toBeTruthy();
    expect(mockGetTakeMeThereA11yLabel).toHaveBeenCalledWith('pharmacy');
  });

  it('tapping it opens a Maps search without triggering the row\'s onPress (edit)', () => {
    const onPress = jest.fn();
    render(<TaskRow task={{ ...BASE_TASK, poi: 'pharmacy' }} onToggle={onToggle} onPress={onPress} isFar />);

    fireEvent.press(screen.getByLabelText('Take me to a pharmacy'));

    expect(mockOpenTakeMeThereMaps).toHaveBeenCalledWith('pharmacy');
    expect(onPress).not.toHaveBeenCalled();
  });
});
