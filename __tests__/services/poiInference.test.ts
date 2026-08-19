/**
 * KAN-195 — rule-based POI inference unit tests.
 *
 * Covers:
 *   normalize
 *     - lowercases, accent-folds, strips punctuation, collapses whitespace
 *   inferPoiFromRules
 *     - EN matches for each of the four core POI types
 *     - pt-PT matches for each of the four core POI types
 *     - accent-insensitive matching (café / cafe, farmácia / farmacia)
 *     - case / punctuation insensitive
 *     - multi-word phrase keys (pastel de nata)
 *     - longest-keyword-wins on competing matches
 *     - no-match → null; empty / whitespace / garbage → null
 *   registerLearnedKeyword / clearLearnedKeywords
 *     - learned keyword is matched
 *     - learned layer takes precedence on ties
 *     - clear removes learned entries
 */

import {
  inferPoiFromRules,
  normalize,
  registerLearnedKeyword,
  registerPoiKeywords,
  clearLearnedKeywords,
  isSupportedLang,
} from '../../src/services/poiInference';

afterEach(() => { clearLearnedKeywords(); });

describe('isSupportedLang', () => {
  it('accepts the two supported languages', () => {
    expect(isSupportedLang('en')).toBe(true);
    expect(isSupportedLang('pt-PT')).toBe(true);
  });

  it('rejects anything else, including similar-looking or malformed values', () => {
    expect(isSupportedLang('es')).toBe(false);
    expect(isSupportedLang('pt')).toBe(false);
    expect(isSupportedLang(undefined)).toBe(false);
    expect(isSupportedLang(null)).toBe(false);
    expect(isSupportedLang(123)).toBe(false);
  });
});

// ─── normalize ────────────────────────────────────────────────────────────────

describe('normalize', () => {
  it('lowercases', () => {
    expect(normalize('BUY BREAD')).toBe('buy bread');
  });

  it('accent-folds diacritics', () => {
    expect(normalize('Café com Pão')).toBe('cafe com pao');
    expect(normalize('farmácia')).toBe('farmacia');
  });

  it('strips punctuation to spaces and collapses whitespace', () => {
    expect(normalize('  buy:  bread,  milk!  ')).toBe('buy bread milk');
  });

  it('returns empty string for punctuation-only input', () => {
    expect(normalize('!!! ...')).toBe('');
  });
});

// ─── inferPoiFromRules: English ────────────────────────────────────────────────

describe('inferPoiFromRules (en)', () => {
  it('maps "buy bread" to bakery', () => {
    expect(inferPoiFromRules('buy bread')).toBe('bakery');
  });

  it('maps a coffee task to cafe', () => {
    expect(inferPoiFromRules('grab a coffee')).toBe('cafe');
  });

  it('keeps the four hair and beauty errands apart', () => {
    expect(inferPoiFromRules('need a haircut')).toBe('hairdresser');
    expect(inferPoiFromRules('go to the barbershop')).toBe('barber');
    expect(inferPoiFromRules('book a manicure')).toBe('nail_salon');
  });

  it('maps a tattoo task to tattoo', () => {
    expect(inferPoiFromRules('book a tattoo')).toBe('tattoo');
    expect(inferPoiFromRules('get inked')).toBe('tattoo');
  });

  it('maps ice cream tasks to ice_cream, however they are written', () => {
    expect(inferPoiFromRules('buy ice cream')).toBe('ice_cream');
    expect(inferPoiFromRules('Gelato!')).toBe('ice_cream');
    // Punctuation and case are normalized away before matching.
    expect(inferPoiFromRules('ICE CREAM, please')).toBe('ice_cream');
  });

  it('maps a cash task to atm', () => {
    expect(inferPoiFromRules('withdraw cash')).toBe('atm');
  });

  it('maps a prescription task to pharmacy', () => {
    expect(inferPoiFromRules('pick up prescription')).toBe('pharmacy');
  });

  it('maps book-buying phrasing to store instead of library', () => {
    expect(inferPoiFromRules('buy a book')).toBe('store');
  });

  it('is case-insensitive', () => {
    expect(inferPoiFromRules('BUY MILK')).toBe('supermarket');
  });

  it('ignores surrounding punctuation', () => {
    expect(inferPoiFromRules('Groceries: milk, eggs!')).toBe('supermarket');
  });
});

// ─── inferPoiFromRules: Português de Portugal ──────────────────────────────────

describe('inferPoiFromRules (pt-PT)', () => {
  it('maps "comprar pão" to bakery', () => {
    expect(inferPoiFromRules('comprar pão', 'pt-PT')).toBe('bakery');
  });

  it('maps a café task to cafe', () => {
    expect(inferPoiFromRules('tomar um café', 'pt-PT')).toBe('cafe');
  });

  it('keeps barbearia, cabeleireiro and manicure apart', () => {
    expect(inferPoiFromRules('ir à barbearia', 'pt-PT')).toBe('barber');
    expect(inferPoiFromRules('cortar o cabelo', 'pt-PT')).toBe('hairdresser');
    expect(inferPoiFromRules('fazer as unhas', 'pt-PT')).toBe('nail_salon');
  });

  it('maps a tatuagem task to tattoo', () => {
    expect(inferPoiFromRules('fazer uma tatuagem', 'pt-PT')).toBe('tattoo');
    expect(inferPoiFromRules('marcar tatuagens', 'pt-PT')).toBe('tattoo');
  });

  it('maps both spellings of gelataria to ice_cream', () => {
    // Geladaria is the more correct spelling; gelataria is also current.
    expect(inferPoiFromRules('ir à geladaria', 'pt-PT')).toBe('ice_cream');
    expect(inferPoiFromRules('Gelataria do Cais', 'pt-PT')).toBe('ice_cream');
    expect(inferPoiFromRules('comprar um gelado', 'pt-PT')).toBe('ice_cream');
  });

  it('maps a multibanco task to atm', () => {
    expect(inferPoiFromRules('levantar dinheiro no multibanco', 'pt-PT')).toBe('atm');
  });

  it('maps a farmácia task to pharmacy', () => {
    expect(inferPoiFromRules('ir à farmácia', 'pt-PT')).toBe('pharmacy');
  });

  it('maps book-buying phrasing to store instead of library', () => {
    expect(inferPoiFromRules('comprar um livro', 'pt-PT')).toBe('store');
  });

  it('matches accent-folded input (cafe without accent)', () => {
    expect(inferPoiFromRules('beber um cafe', 'pt-PT')).toBe('cafe');
  });

  it('matches a multi-word phrase key (pastel de nata)', () => {
    expect(inferPoiFromRules('comprar pastel de nata', 'pt-PT')).toBe('cafe');
  });
});

// ─── All built-in POI types ────────────────────────────────────────────────────

describe('inferPoiFromRules: all built-in types (en)', () => {
  const cases: [string, string][] = [
    ['withdraw cash',            'atm'],
    ['grab a coffee',           'cafe'],
    ['buy bread',               'bakery'],
    ['pick up prescription',    'pharmacy'],
    ['fill up on petrol',       'gas'],
    ['morning workout',         'gym'],
    ['deposit cheque at bank',  'bank'],
    ['dinner reservation',      'restaurant'],
    ['meet for cocktails',      'bar'],
    ['walk in the park',        'park'],
    ['return book to library',  'library'],
    ['mail a parcel',           'post'],
    ['shop at the mall',        'store'],
    ['buy flowers',             'florist'],
    ['dentist checkup',         'clinic'],
    ['book a haircut',          'hairdresser'],
    ['catch the bus',           'bus'],
    ['pick up kids from school','school'],
    ['exchange money',          'currency_exchange'],
    ['send money with Western Union', 'money_transfer'],
    ['renew insurance',         'financial_service'],
  ];

  it.each(cases)('maps %p to %p', (title, expected) => {
    expect(inferPoiFromRules(title)).toBe(expected);
  });
});

describe('inferPoiFromRules: extended types (pt-PT)', () => {
  const cases: [string, string][] = [
    ['meter gasolina',           'gas'],
    ['ir ao ginásio',            'gym'],
    ['ir ao banco',              'bank'],
    ['comprar pão',              'bakery'],
    ['reserva no restaurante',   'restaurant'],
    ['beber cocktails',          'bar'],
    ['passear no parque',        'park'],
    ['devolver livro',           'library'],
    ['enviar encomenda',         'post'],
    ['comprar no centro comercial', 'store'],
    ['comprar flores',           'florist'],
    ['consulta no médico',       'clinic'],
    ['corte de cabelo',          'hairdresser'],
    ['apanhar o autocarro',      'bus'],
    ['reunião de pais',          'school'],
    ['trocar câmbio',            'currency_exchange'],
    ['transferir dinheiro',      'money_transfer'],
    ['pagar crédito',            'financial_service'],
  ];

  it.each(cases)('maps %p to %p', (title, expected) => {
    expect(inferPoiFromRules(title, 'pt-PT')).toBe(expected);
  });
});

// ─── No-match / edge cases ─────────────────────────────────────────────────────

describe('inferPoiFromRules: no match returns null', () => {
  it('returns null when no keyword matches', () => {
    expect(inferPoiFromRules('call mom')).toBeNull();
    expect(inferPoiFromRules('finish quarterly report')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(inferPoiFromRules('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(inferPoiFromRules('    ')).toBeNull();
  });

  it('returns null for punctuation-only input', () => {
    expect(inferPoiFromRules('!!!')).toBeNull();
  });

  it('does not match a keyword embedded inside another word', () => {
    // "teamwork" contains "tea" but must not match cafe (whole-word matching)
    expect(inferPoiFromRules('teamwork sync')).toBeNull();
  });
});

// ─── Longest-keyword-wins ──────────────────────────────────────────────────────

describe('inferPoiFromRules: specificity', () => {
  it('prefers the longest matching keyword', () => {
    // "food shopping" (supermarket) is longer than "tea" — but here ensure a
    // multi-word key wins over a shorter incidental one.
    expect(inferPoiFromRules('weekly food shopping')).toBe('supermarket');
  });
});

// ─── Learned layer ─────────────────────────────────────────────────────────────

describe('learned layer', () => {
  it('matches a keyword registered at runtime', () => {
    expect(inferPoiFromRules('refill propane')).toBeNull();
    registerLearnedKeyword('propane', 'gas');
    expect(inferPoiFromRules('refill propane')).toBe('gas');
  });

  it('normalizes learned keywords before storing', () => {
    registerLearnedKeyword('  Padaria!  ', 'supermarket', 'pt-PT');
    expect(inferPoiFromRules('ir à padaria', 'pt-PT')).toBe('supermarket');
  });

  it('ignores empty / whitespace keywords', () => {
    registerLearnedKeyword('   ', 'cafe');
    expect(inferPoiFromRules('   ')).toBeNull();
  });

  it('clearLearnedKeywords removes learned entries', () => {
    registerLearnedKeyword('propane', 'gas');
    expect(inferPoiFromRules('refill propane')).toBe('gas');
    clearLearnedKeywords();
    expect(inferPoiFromRules('refill propane')).toBeNull();
  });

  it('learned layer wins over seed on an equal-length tie', () => {
    // Seed maps "tea" → cafe. Register same-length "tea" → supermarket; learned
    // is consulted first so it wins on the length tie.
    registerLearnedKeyword('tea', 'supermarket');
    expect(inferPoiFromRules('buy tea')).toBe('supermarket');
  });

  it('registerPoiKeywords registers multiple synonyms for one POI', () => {
    registerPoiKeywords('gym', ['crossfit', 'spin class']);
    expect(inferPoiFromRules('crossfit session')).toBe('gym');
    expect(inferPoiFromRules('book a spin class')).toBe('gym');
  });
});
