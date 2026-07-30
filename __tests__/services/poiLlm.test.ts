/**
 * KAN-196 — on-device POI classifier (fast-tflite) + learn-back unit tests.
 *
 * react-native-fast-tflite is mocked — real inference runs on-device. The real
 * vocab.json / labels.json / tokenizer are exercised; the model output is faked.
 *
 * Covers:
 *   tokenize       — vocab ids, OOV, pad/truncate to MAXLEN
 *   validatePoi    — valid label, none/empty/off-list → null
 *   isLlmAvailable — model loads → true; load throws → false
 *   classifyPoi    — empty → null, valid → POI, below threshold → null,
 *                    "none" → null, inference throws → null, load fails → null
 *   learn-back     — registers into the dictionary learned layer + persists
 */

const mockLoad = jest.fn();
const mockRunSync = jest.fn();

jest.mock('react-native-fast-tflite', () => ({
  loadTensorflowModel: (...a: unknown[]) => mockLoad(...a),
}));

const mockPersist = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/firestore', () => ({
  persistLearnedKeyword: (...a: unknown[]) => mockPersist(...a),
}));

jest.mock('../../src/services/placesFunctions', () => ({
  getPlaceDetailsProxy: jest.fn(),
  placesAutocompleteProxy: jest.fn(),
  searchNearbyPlacesProxy: jest.fn(),
  searchPlaceTypesProxy: jest.fn(),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(() => ({
    execSync: jest.fn(),
    getFirstSync: jest.fn(),
    runSync: jest.fn(),
  })),
}));

import {
  tokenize,
  validatePoi,
  isLlmAvailable,
  classifyPoi,
  inferPoiForQuickAdd,
  learnPoiKeyword,
  learnFromClassification,
  learnFromUserEdit,
  CONFIDENCE_THRESHOLD,
  MODEL_LOAD_TIMEOUT_MS,
  __resetModelForTests,
} from '../../src/services/poiLlm';
import { inferPoiFromRules, registerLearnedKeyword, clearLearnedKeywords } from '../../src/services/poiInference';
import labels from '../../assets/poi-model/labels.json';

const LABELS = labels as string[];
const idxOf = (label: string) => LABELS.indexOf(label);

/** Build a fake softmax output peaking at class `idx`. */
function probs(idx: number, p = 0.9): Float32Array {
  const a = new Float32Array(LABELS.length).fill((1 - p) / (LABELS.length - 1));
  a[idx] = p;
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetModelForTests();
  clearLearnedKeywords();
  mockLoad.mockResolvedValue({ runSync: mockRunSync });
});

// ─── tokenize ─────────────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('maps known tokens to their vocab ids and right-pads with 0', () => {
    const ids = Array.from(tokenize('buy bread'));
    expect(ids.length).toBe(12);
    expect(ids[0]).toBeGreaterThan(1); // "buy" known
    expect(ids[1]).toBeGreaterThan(1); // "bread" known
    expect(ids.slice(2).every(x => x === 0)).toBe(true);
  });

  it('maps unknown tokens to OOV (1)', () => {
    const ids = Array.from(tokenize('zzzqqq'));
    expect(ids[0]).toBe(1);
  });

  it('accent-folds and lowercases before lookup (matches training)', () => {
    expect(Array.from(tokenize('Pão'))).toEqual(Array.from(tokenize('pao')));
  });

  it('truncates to 12 tokens', () => {
    const ids = tokenize('a b c d e f g h i j k l m n o p');
    expect(ids.length).toBe(12);
  });
});

// ─── validatePoi ──────────────────────────────────────────────────────────────

describe('validatePoi', () => {
  it('accepts a built-in POI label', () => {
    expect(validatePoi('pharmacy')).toBe('pharmacy');
    expect(validatePoi('  SALON ')).toBe('salon');
  });
  it('treats none/null/empty as no result', () => {
    expect(validatePoi('none')).toBeNull();
    expect(validatePoi('')).toBeNull();
    expect(validatePoi(null)).toBeNull();
  });
  it('rejects an off-list label', () => {
    expect(validatePoi('spaceship')).toBeNull();
  });
});

// ─── isLlmAvailable ───────────────────────────────────────────────────────────

describe('isLlmAvailable', () => {
  it('returns true when the model loads', async () => {
    await expect(isLlmAvailable()).resolves.toBe(true);
  });
  it('returns false (no throw) when the model fails to load', async () => {
    mockLoad.mockReset();
    mockLoad.mockRejectedValue(new Error('no tflite runtime'));
    await expect(isLlmAvailable()).resolves.toBe(false);
  });

  it('returns false when the model load exceeds the timeout', async () => {
    jest.useFakeTimers();
    mockLoad.mockReset();
    mockLoad.mockReturnValue(new Promise(() => {})); // never resolves
    const p = isLlmAvailable();
    await jest.advanceTimersByTimeAsync(MODEL_LOAD_TIMEOUT_MS + 1);
    await expect(p).resolves.toBe(false);
    jest.useRealTimers();
  });
});

// ─── classifyPoi ──────────────────────────────────────────────────────────────

describe('classifyPoi', () => {
  it('returns null for an empty title without loading the model', async () => {
    expect(await classifyPoi('   ', 'en')).toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('returns the top POI label above the confidence threshold', async () => {
    mockRunSync.mockReturnValue([probs(idxOf('pharmacy'), 0.92)]);
    expect(await classifyPoi('pick up amoxicillin', 'en')).toBe('pharmacy');
  });

  it('returns null when the top probability is below threshold', async () => {
    mockRunSync.mockReturnValue([probs(idxOf('pharmacy'), CONFIDENCE_THRESHOLD - 0.1)]);
    expect(await classifyPoi('something vague', 'en')).toBeNull();
  });

  it('returns null when the top class is "none"', async () => {
    mockRunSync.mockReturnValue([probs(idxOf('none'), 0.95)]);
    expect(await classifyPoi('call mom', 'en')).toBeNull();
  });

  it('returns null when inference throws', async () => {
    mockRunSync.mockImplementation(() => { throw new Error('inference failed'); });
    expect(await classifyPoi('buy milk', 'en')).toBeNull();
  });

  it('returns null when the model cannot load', async () => {
    mockLoad.mockReset();
    mockLoad.mockRejectedValue(new Error('no runtime'));
    expect(await classifyPoi('buy milk', 'en')).toBeNull();
  });
});

// ─── inferPoiForQuickAdd (KAN-232) ─────────────────────────────────────────────

describe('inferPoiForQuickAdd', () => {
  it('returns the rule match without calling the LLM classifier', async () => {
    expect(await inferPoiForQuickAdd('pick up prescription')).toBe('pharmacy');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('matches a pt-PT keyword when the EN dictionary misses', async () => {
    expect(await inferPoiForQuickAdd('ir à farmácia')).toBe('pharmacy');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('treats book-buying phrasing as book_store without calling the LLM classifier', async () => {
    expect(await inferPoiForQuickAdd('buy a book')).toBe('book_store');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('treats pt-PT book-buying phrasing as book_store without calling the LLM classifier', async () => {
    expect(await inferPoiForQuickAdd('comprar um livro')).toBe('book_store');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('uses the local dictionary for police phrasing without calling the LLM classifier', async () => {
    expect(await inferPoiForQuickAdd('visit police')).toBe('police');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('uses the built-in cafe for generic coffee phrasing without calling the LLM classifier', async () => {
    expect(await inferPoiForQuickAdd('go out for coffee')).toBe('cafe');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('keeps restaurant food intent on the broad restaurant type', async () => {
    expect(await inferPoiForQuickAdd('go out to sushi')).toBe('restaurant');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('keeps store subtype intent on the broad store type', async () => {
    expect(await inferPoiForQuickAdd('buy a t-shirt')).toBe('store');
    expect(await inferPoiForQuickAdd('comprar carregador')).toBe('store');
    expect(await inferPoiForQuickAdd('buy computer parts')).toBe('store');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('does not force ambiguous food shopping or preparation phrases to restaurant', async () => {
    await expect(inferPoiForQuickAdd('buy pasta')).resolves.not.toBe('restaurant');
    await expect(inferPoiForQuickAdd('buy meat')).resolves.not.toBe('restaurant');
    await expect(inferPoiForQuickAdd('make salad')).resolves.not.toBe('restaurant');
  });

  it('keeps coffee roastery when the title is explicit', async () => {
    expect(await inferPoiForQuickAdd('go to a coffee roastery')).toBe('coffee_roastery');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('falls back to the LLM classifier when no rule matches', async () => {
    mockRunSync.mockReturnValue([probs(idxOf('gym'), 0.9)]);
    expect(await inferPoiForQuickAdd('leg day')).toBe('gym');
    expect(mockLoad).toHaveBeenCalled();
  });

  it('returns null when neither the rules nor the LLM match', async () => {
    mockRunSync.mockReturnValue([probs(idxOf('none'), 0.95)]);
    expect(await inferPoiForQuickAdd('call mom')).toBeNull();
  });

  it('returns a non-catalog learned type when the local dictionary misses', async () => {
    registerLearnedKeyword('foobar', 'bakery', 'en');
    registerLearnedKeyword('foobar', 'pharmacy', 'pt-PT');

    expect(await inferPoiForQuickAdd('foobar')).toBe('bakery');
    expect(mockLoad).not.toHaveBeenCalled();
  });
});

// ─── learn-back ───────────────────────────────────────────────────────────────

describe('learn-back', () => {
  it('registers the title into the dictionary learned layer', async () => {
    expect(inferPoiFromRules('refill amoxicillin 500mg', 'en')).toBeNull();
    await learnPoiKeyword('uid-1', 'Refill amoxicillin 500mg', 'pharmacy', 'en', 'llm');
    expect(inferPoiFromRules('refill amoxicillin 500mg', 'en')).toBe('pharmacy');
  });

  it('persists an LLM classification with source "llm"', async () => {
    await learnFromClassification('uid-1', 'Buy guarana', 'supermarket', 'en');
    expect(mockPersist).toHaveBeenCalledWith('uid-1', {
      keyword: 'Buy guarana', poi: 'supermarket', lang: 'en', source: 'llm',
    });
  });

  it('persists a user edit with source "user"', async () => {
    await learnFromUserEdit('uid-1', 'Levar o carro a oficina', 'store', 'pt-PT');
    expect(mockPersist).toHaveBeenCalledWith('uid-1', {
      keyword: 'Levar o carro a oficina', poi: 'store', lang: 'pt-PT', source: 'user',
    });
  });

  it('still registers in-memory when persistence fails', async () => {
    mockPersist.mockRejectedValueOnce(new Error('offline'));
    await expect(
      learnPoiKeyword('uid-1', 'Walk the dog at the dog park', 'park', 'en', 'user'),
    ).resolves.toBeUndefined();
    expect(inferPoiFromRules('walk the dog at the dog park', 'en')).toBe('park');
  });
});
