import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { COPY } from '../../src/constants/copy';
import TeachSheet from '../../src/components/TeachSheet';
import { restaurantFoodTypeFavouriteName } from '../../src/services/restaurantFoodTypes';
import { storeSubtypeFavouriteName } from '../../src/services/storeSubtypes';

jest.mock('../../src/theme', () => ({
  useTheme: () => ({
    palette: {
      bg: '#fff',
      surface: '#f6f5f1',
      text: '#000',
      muted: '#999',
      line: '#ddd',
      accent: '#e8a86a',
      onAccent: '#000',
      scrim: 'rgba(0,0,0,0.2)',
      nearTint: '#fdf7f0',
      nearText: '#7a4a20',
    },
    language: 'en',
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

jest.mock('../../src/components/AppIcon', () => ({
  CloseIcon: () => null,
  FoodTypeIcon: () => null,
  PoiIcon: () => null,
}));

describe('TeachSheet', () => {
  it('stores the canonical dictionary brand selected from suggestions', () => {
    const onSave = jest.fn();
    render(<TeachSheet visible onClose={jest.fn()} onSave={onSave} />);

    const input = screen.getByPlaceholderText(COPY.places.teachNamePlaceholder);
    fireEvent.press(screen.getByLabelText('Café'));
    fireEvent.changeText(input, 'star');
    fireEvent.press(screen.getByText('Starbucks'));
    fireEvent.press(screen.getByText(COPY.places.teachSaveAction));

    expect(onSave).toHaveBeenCalledWith('cafe', 'Starbucks');
    expect(input.props.value).toBe('');
  });

  it('does not save free text that is not in the bundled brand dictionary', () => {
    const onSave = jest.fn();
    render(<TeachSheet visible onClose={jest.fn()} onSave={onSave} />);

    fireEvent.press(screen.getByLabelText('Café'));
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.teachNamePlaceholder), 'Starbux');
    fireEvent.press(screen.getByText(COPY.places.teachSaveAction));

    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows brand suggestions only after the user types', () => {
    render(<TeachSheet visible onClose={jest.fn()} onSave={jest.fn()} />);

    const input = screen.getByPlaceholderText(COPY.places.teachNamePlaceholder);
    fireEvent.press(screen.getByLabelText('Café'));

    expect(screen.queryByText('Starbucks')).toBeNull();

    fireEvent.changeText(input, '   ');

    expect(screen.queryByText('Starbucks')).toBeNull();

    fireEvent.changeText(input, 's');

    expect(screen.queryByText('Starbucks')).toBeNull();

    fireEvent.changeText(input, 'star');

    expect(screen.getByText('Starbucks')).toBeTruthy();
  });

  it('requires choosing a suggestion instead of only typing an exact brand name', () => {
    const onSave = jest.fn();
    render(<TeachSheet visible onClose={jest.fn()} onSave={onSave} />);

    fireEvent.press(screen.getByLabelText('Café'));
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.teachNamePlaceholder), 'Starbucks');
    fireEvent.press(screen.getByText(COPY.places.teachSaveAction));

    expect(onSave).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText('Starbucks'));
    fireEvent.press(screen.getByText(COPY.places.teachSaveAction));

    expect(onSave).toHaveBeenCalledWith('cafe', 'Starbucks');
  });

  it('clears the selected suggestion when the brand input is edited', () => {
    const onSave = jest.fn();
    render(<TeachSheet visible onClose={jest.fn()} onSave={onSave} />);

    const input = screen.getByPlaceholderText(COPY.places.teachNamePlaceholder);
    fireEvent.press(screen.getByLabelText('Café'));
    fireEvent.changeText(input, 'star');
    fireEvent.press(screen.getByText('Starbucks'));
    fireEvent.changeText(input, 'Starbuck');
    fireEvent.press(screen.getByText(COPY.places.teachSaveAction));

    expect(onSave).not.toHaveBeenCalled();
  });

  it('resets the brand field when the POI type changes', () => {
    render(<TeachSheet visible onClose={jest.fn()} onSave={jest.fn()} />);

    const input = screen.getByPlaceholderText(COPY.places.teachNamePlaceholder);
    fireEvent.press(screen.getByLabelText('Café'));
    fireEvent.changeText(input, 'Starbucks');
    fireEvent.press(screen.getByLabelText('Market'));

    expect(input.props.value).toBe('');
  });

  it('saves a restaurant food type selected from suggestions', () => {
    const onSave = jest.fn();
    render(<TeachSheet visible onClose={jest.fn()} onSave={onSave} />);

    fireEvent.press(screen.getByLabelText(COPY.places.teachFoodType));
    expect(screen.queryByText('Sushi')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.teachFoodTypePlaceholder), '   ');
    expect(screen.queryByText('Sushi')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.teachFoodTypePlaceholder), 's');
    expect(screen.queryByText('Sushi')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.teachFoodTypePlaceholder), 'sush');
    fireEvent.press(screen.getByText('Sushi'));
    fireEvent.press(screen.getByText(COPY.places.teachSaveAction));

    expect(onSave).toHaveBeenCalledWith('restaurant', restaurantFoodTypeFavouriteName('sushi'));
  });

  it('saves a store subtype selected from suggestions', () => {
    const onSave = jest.fn();
    render(<TeachSheet visible onClose={jest.fn()} onSave={onSave} />);

    fireEvent.press(screen.getByLabelText(COPY.places.teachStoreType));
    expect(screen.queryByText('Clothing')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.teachStoreTypePlaceholder), 'c');
    expect(screen.queryByText('Clothing')).toBeNull();
    fireEvent.changeText(screen.getByPlaceholderText(COPY.places.teachStoreTypePlaceholder), 'cl');
    fireEvent.press(screen.getByText('Clothing'));
    fireEvent.press(screen.getByText(COPY.places.teachSaveAction));

    expect(onSave).toHaveBeenCalledWith('store', storeSubtypeFavouriteName('clothing'));
  });
});
