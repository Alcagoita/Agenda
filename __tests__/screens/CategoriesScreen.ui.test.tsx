/**
 * KAN-60 — CategoriesScreen UI-layer tests.
 *
 * Mocks useCategoriesScreen so we test the screen's rendering contract only.
 *
 * Covers:
 *   - Built-in categories always rendered regardless of state
 *   - Custom categories shown when status === 'success'
 *   - "Loading…" shown while fetching
 *   - Error message + "Try again" button shown on error
 *   - Pressing "Try again" calls setRetryKey
 *   - "Add Category" button calls handleAdd
 *   - Edit button visible only on custom rows
 *   - × (delete) button visible only on custom rows
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// ─── Mock useCategoriesScreen ─────────────────────────────────────────────────

const mockHandleAdd    = jest.fn();
const mockHandleEdit   = jest.fn();
const mockHandleDelete = jest.fn();
const mockSetRetryKey  = jest.fn();

const DEFAULT_HOOK_RETURN = {
  categoriesState:  { status: 'loading' as const },
  retryKey:         0,
  setRetryKey:      mockSetRetryKey,
  customCategories: [],
  sheetVisible:     false,
  editing:          null,
  handleAdd:        mockHandleAdd,
  handleEdit:       mockHandleEdit,
  handleDelete:     mockHandleDelete,
  handleSave:       jest.fn(),
  handleCloseSheet: jest.fn(),
};

jest.mock('../../src/hooks/useCategoriesScreen', () => ({
  useCategoriesScreen: () => mockHookReturn,
}));

let mockHookReturn = { ...DEFAULT_HOOK_RETURN };

// ─── Auth ─────────────────────────────────────────────────────────────────────

jest.mock('@react-native-firebase/auth/lib/modular', () => ({
  getAuth: () => ({ currentUser: { uid: 'u1' } }),
}));
jest.mock('@react-native-firebase/auth', () => ({}));

// ─── Navigation ───────────────────────────────────────────────────────────────

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

// ─── Theme ────────────────────────────────────────────────────────────────────

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff', surface: '#f6f5f1', surface2: '#efeeea',
      text: '#000', muted: '#999', faint: '#ccc',
      line: '#ddd', accent: '#e8a86a',
    },
  }),
}));

// ─── Safe area ────────────────────────────────────────────────────────────────

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));

// ─── Maps ─────────────────────────────────────────────────────────────────────

jest.mock('../../src/services/maps', () => ({
  placeTypeLabel: (t: string) => t,
}));

jest.mock('../../src/services/poiTypeCache', () => ({
  searchPlaceTypesCached: jest.fn().mockResolvedValue([]),
}));

// ─── AppIcon ──────────────────────────────────────────────────────────────────

jest.mock('../../src/components/AppIcon', () => ({
  ChevronLeftIcon: () => null,
}));

// ─── Import (after mocks) ─────────────────────────────────────────────────────

import CategoriesScreen from '../../src/screens/CategoriesScreen';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CUSTOM_CAT = {
  id: 'cat-gym', name: 'Gym', color: '#ff0000', isBuiltIn: false,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockHookReturn = { ...DEFAULT_HOOK_RETURN };
});

describe('CategoriesScreen UI — KAN-60 built-in categories', () => {
  it('always renders the 4 built-in categories', () => {
    render(<CategoriesScreen />);
    expect(screen.getByText('Work')).toBeTruthy();
    expect(screen.getByText('Health')).toBeTruthy();
    expect(screen.getByText('Errands')).toBeTruthy();
    expect(screen.getByText('Personal')).toBeTruthy();
  });

  it('built-in rows have no Edit button', () => {
    render(<CategoriesScreen />);
    expect(screen.queryByLabelText('Edit Work')).toBeNull();
  });

  it('built-in rows have no Delete button', () => {
    render(<CategoriesScreen />);
    expect(screen.queryByLabelText('Delete Work')).toBeNull();
  });
});

describe('CategoriesScreen UI — KAN-60 loading state', () => {
  it('shows "Loading…" text while fetching', () => {
    render(<CategoriesScreen />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('does not show custom category rows while loading', () => {
    render(<CategoriesScreen />);
    expect(screen.queryByLabelText('Gym category')).toBeNull();
  });
});

describe('CategoriesScreen UI — KAN-60 success state', () => {
  beforeEach(() => {
    mockHookReturn = {
      ...DEFAULT_HOOK_RETURN,
      categoriesState:  { status: 'success', categories: [CUSTOM_CAT] },
      customCategories: [CUSTOM_CAT],
    };
  });

  it('renders custom category name', () => {
    render(<CategoriesScreen />);
    expect(screen.getByText('Gym')).toBeTruthy();
  });

  it('shows Edit button on custom rows', () => {
    render(<CategoriesScreen />);
    expect(screen.getByLabelText('Edit Gym')).toBeTruthy();
  });

  it('shows × Delete button on custom rows', () => {
    render(<CategoriesScreen />);
    expect(screen.getByLabelText('Delete Gym')).toBeTruthy();
  });

  it('does NOT show "No custom categories yet" when categories exist', () => {
    render(<CategoriesScreen />);
    expect(screen.queryByText('No custom categories yet')).toBeNull();
  });
});

describe('CategoriesScreen UI — KAN-60 error state', () => {
  beforeEach(() => {
    mockHookReturn = {
      ...DEFAULT_HOOK_RETURN,
      categoriesState: {
        status:  'error',
        message: 'Could not load categories. Check your connection.',
      },
    };
  });

  it('renders the error message', () => {
    render(<CategoriesScreen />);
    expect(screen.getByText('Could not load categories. Check your connection.')).toBeTruthy();
  });

  it('renders "Try again" button', () => {
    render(<CategoriesScreen />);
    expect(screen.getByLabelText('Try again')).toBeTruthy();
  });

  it('calls setRetryKey when "Try again" is pressed', async () => {
    render(<CategoriesScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Try again'));
    });
    expect(mockSetRetryKey).toHaveBeenCalledTimes(1);
  });
});

describe('CategoriesScreen UI — KAN-60 interaction', () => {
  beforeEach(() => {
    mockHookReturn = {
      ...DEFAULT_HOOK_RETURN,
      categoriesState:  { status: 'success', categories: [CUSTOM_CAT] },
      customCategories: [CUSTOM_CAT],
    };
  });

  it('calls handleAdd when "Add Category" button is pressed', async () => {
    render(<CategoriesScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add category'));
    });
    expect(mockHandleAdd).toHaveBeenCalledTimes(1);
  });

  it('calls handleEdit with the category when Edit is pressed', async () => {
    render(<CategoriesScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Edit Gym'));
    });
    expect(mockHandleEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'cat-gym' }));
  });

  it('calls handleDelete with the category when × is pressed', async () => {
    render(<CategoriesScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Delete Gym'));
    });
    expect(mockHandleDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'cat-gym' }));
  });
});
