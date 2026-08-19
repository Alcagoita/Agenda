/**
 * src/services/poiInference.ts — KAN-195
 *
 * Rule-based POI inference: map a task title to a POI type using an on-device,
 * offline keyword dictionary. This is the FIRST pass of POI inference on
 * imported tasks (wired into the import flow in KAN-197). No AI, no network —
 * the on-device LLM fallback for titles this misses lands in KAN-196.
 *
 * Output is a `PoiResolution` (a built-in `PoiType` or any place type string)
 * or `null`. `null` is a valid, expected result:
 * when no keyword matches we do NOT guess, and the caller simply leaves
 * `task.poi` unset. The seed covers all 19 built-in `PoiType`s in EN + pt-PT.
 *
 * ── Self-growing dictionary ───────────────────────────────────────────────
 * The dictionary has two layers:
 *   - SEED_DICTIONARY — hand-curated, checked in, never mutated at runtime.
 *   - learned layer   — keyword→POI pairs appended at runtime by the on-device
 *                       LLM (KAN-196) and user POI edits (KAN-197).
 * Lookups consult the learned layer first, then the seed. This file owns the
 * in-memory structure only; durable persistence (local + Firestore) is wired
 * in KAN-196.
 *
 * A third layer once derived keywords from custom categories' place types.
 * Categories no longer carry one (KAN-371), so it is gone.
 *
 * ── Adding a language ─────────────────────────────────────────────────────
 * Add a new `SupportedLang` literal and a matching entry in SEED_DICTIONARY.
 * Nothing else changes — matching is fully data-driven.
 */

import type { PoiType } from '../types';

/** Languages the dictionary currently ships keywords for. */
export type SupportedLang = 'en' | 'pt-PT';

/** Fallback language when a caller does not specify one. */
export const DEFAULT_LANG: SupportedLang = 'en';

/** Narrows an arbitrary value (e.g. a Firestore doc field) to SupportedLang — registerLearnedKeyword indexes `learned[lang]` directly, so an unsupported value would throw rather than silently no-op. */
export function isSupportedLang(value: unknown): value is SupportedLang {
  return value === 'en' || value === 'pt-PT';
}

/**
 * What a keyword can resolve to: one of the built-in `PoiType`s, or — for
 * dynamically registered custom categories — any Google Places type string
 * (e.g. "bakery", "stadium"). The `string & {}` keeps `PoiType` autocomplete
 * while still accepting arbitrary place types.
 */
export type PoiResolution = PoiType | (string & {});

/** keyword (human-readable, may contain accents) → POI/Places type. */
type KeywordMap = Record<string, PoiResolution>;

// ─── Seed dictionary ──────────────────────────────────────────────────────────
//
// Keys are written naturally (accents, casing) for readability; they are
// normalized (accent-folded, lowercased, de-punctuated) before matching, so
// "Café" here matches a title containing "cafe" and vice-versa. Multi-word
// keys ("pastel de nata") are supported and matched as a whole phrase.

const SEED_DICTIONARY: Record<SupportedLang, KeywordMap> = {
  en: {
    // ── atm ──
    atm: 'atm', cash: 'atm', withdraw: 'atm', withdrawal: 'atm', 'cash machine': 'atm',
    // ── cafe ──
    coffee: 'cafe', latte: 'cafe', espresso: 'cafe', cappuccino: 'cafe',
    cafe: 'cafe', tea: 'cafe', 'flat white': 'cafe',
    // ── supermarket ──
    groceries: 'supermarket', grocery: 'supermarket', supermarket: 'supermarket',
    market: 'supermarket', 'food shopping': 'supermarket',
    bread: 'supermarket', milk: 'supermarket', eggs: 'supermarket',
    butter: 'supermarket', vegetables: 'supermarket', veggies: 'supermarket',
    fruit: 'supermarket',
    // ── bakery ──
    bakery: 'bakery', 'buy bread': 'bakery', 'pick up bread': 'bakery',
    'bread shop': 'bakery', pastry: 'bakery', croissant: 'bakery',
    // ── ice cream ──
    'ice cream': 'ice_cream', icecream: 'ice_cream', gelato: 'ice_cream',
    sorbet: 'ice_cream', 'ice lolly': 'ice_cream',
    // ── tattoo ──
    tattoo: 'tattoo', 'tattoo studio': 'tattoo', 'get inked': 'tattoo',
    piercing: 'tattoo',
    // ── pharmacy ──
    pharmacy: 'pharmacy', drugstore: 'pharmacy', prescription: 'pharmacy',
    meds: 'pharmacy', medicine: 'pharmacy', medication: 'pharmacy',
    pills: 'pharmacy', vitamins: 'pharmacy',
    // ── gas ──
    gas: 'gas', 'gas station': 'gas', fuel: 'gas', petrol: 'gas',
    diesel: 'gas', 'fill up': 'gas', 'fill the tank': 'gas',
    // ── gym ──
    gym: 'gym', workout: 'gym', 'work out': 'gym', exercise: 'gym',
    fitness: 'gym', training: 'gym',
    // ── bank ──
    bank: 'bank', deposit: 'bank', 'bank branch': 'bank', cheque: 'bank',
    // ── financial services ──
    'currency exchange': 'currency_exchange', 'bureau de change': 'currency_exchange',
    'exchange money': 'currency_exchange',
    'money transfer': 'money_transfer', 'send money': 'money_transfer', remittance: 'money_transfer',
    'western union': 'money_transfer', moneygram: 'money_transfer',
    'financial service': 'financial_service', credit: 'financial_service', insurance: 'financial_service',
    leasing: 'financial_service', factoring: 'financial_service',
    // ── restaurant ──
    restaurant: 'restaurant', lunch: 'restaurant', dinner: 'restaurant',
    'eat out': 'restaurant', 'dine out': 'restaurant', reservation: 'restaurant',
    // ── bar ──
    bar: 'bar', pub: 'bar', drinks: 'bar', cocktail: 'bar', cocktails: 'bar',
    // ── park ──
    park: 'park', walk: 'park', playground: 'park', picnic: 'park',
    // ── library ──
    library: 'library', 'return book': 'library', 'borrow book': 'library',
    'library book': 'library',
    // ── post ──
    'post office': 'post', mail: 'post', parcel: 'post', package: 'post',
    stamp: 'post', stamps: 'post', 'ship package': 'post',
    // ── store ──
    store: 'store', shop: 'store', mall: 'store', 'shopping mall': 'store',
    'book store': 'store', bookstore: 'store', bookshop: 'store',
    'buy book': 'store', 'buy a book': 'store', 'purchase a book': 'store',
    // ── florist ──
    florist: 'florist', flower: 'florist', flowers: 'florist', bouquet: 'florist',
    'buy flowers': 'florist',
    // ── clinic ──
    clinic: 'clinic', doctor: 'clinic', 'doctor appointment': 'clinic',
    checkup: 'clinic', dentist: 'clinic', 'medical appointment': 'clinic',
    // ── salon ──
    salon: 'salon', haircut: 'salon', barber: 'salon', 'hair appointment': 'salon',
    nails: 'salon', manicure: 'salon',
    // ── bus ──
    bus: 'bus', 'bus stop': 'bus', 'bus station': 'bus', 'catch the bus': 'bus',
    // ── school ──
    school: 'school', class: 'school', 'pick up kids': 'school',
    'parent meeting': 'school', 'drop off kids': 'school',
  },
  'pt-PT': {
    // ── atm ──
    multibanco: 'atm', dinheiro: 'atm', levantar: 'atm', levantamento: 'atm',
    // ── cafe ──
    'café': 'cafe', galão: 'cafe', bica: 'cafe', 'chá': 'cafe',
    'pastel de nata': 'cafe', 'pequeno almoço': 'cafe',
    // ── supermarket ──
    compras: 'supermarket', supermercado: 'supermarket', mercearia: 'supermarket',
    mercado: 'supermarket', 'pão': 'supermarket', leite: 'supermarket',
    ovos: 'supermarket', fruta: 'supermarket', legumes: 'supermarket',
    // ── bakery ──
    padaria: 'bakery', 'comprar pão': 'bakery', 'ir buscar pão': 'bakery',
    pastelaria: 'bakery', croissant: 'bakery',
    // ── ice cream ──
    // Both spellings are current in Portugal; geladaria is the more correct.
    geladaria: 'ice_cream', gelataria: 'ice_cream', gelado: 'ice_cream',
    gelados: 'ice_cream', 'gelataria artesanal': 'ice_cream',
    // ── tattoo ──
    tatuagem: 'tattoo', tatuagens: 'tattoo', tatuador: 'tattoo',
    'fazer uma tatuagem': 'tattoo', piercing: 'tattoo',
    // ── pharmacy ──
    'farmácia': 'pharmacy', receita: 'pharmacy', medicamentos: 'pharmacy',
    'remédios': 'pharmacy', comprimidos: 'pharmacy',
    // ── gas ──
    gasolina: 'gas', 'combustível': 'gas', 'gasóleo': 'gas',
    abastecer: 'gas', 'meter gasolina': 'gas', 'bomba de gasolina': 'gas',
    // ── gym ──
    'ginásio': 'gym', treino: 'gym', 'exercício': 'gym', 'musculação': 'gym',
    // ── bank ──
    banco: 'bank', 'depósito': 'bank', 'balcão': 'bank',
    // ── financial services ──
    'câmbio': 'currency_exchange', 'casa de câmbio': 'currency_exchange', 'trocar moeda': 'currency_exchange',
    'transferência de dinheiro': 'money_transfer', 'transferir dinheiro': 'money_transfer', remessa: 'money_transfer',
    'western union': 'money_transfer', moneygram: 'money_transfer',
    'serviço financeiro': 'financial_service', crédito: 'financial_service', seguros: 'financial_service',
    leasing: 'financial_service', factoring: 'financial_service', finanças: 'financial_service',
    // ── restaurant ──
    restaurante: 'restaurant', 'almoço': 'restaurant', jantar: 'restaurant',
    reserva: 'restaurant', 'refeição': 'restaurant',
    // ── bar ──
    bar: 'bar', pub: 'bar', bebidas: 'bar', cocktail: 'bar', cocktails: 'bar',
    // ── park ──
    parque: 'park', passear: 'park', jardim: 'park', piquenique: 'park',
    // ── library ──
    biblioteca: 'library', 'devolver livro': 'library', 'requisitar livro': 'library',
    // ── post ──
    correios: 'post', carta: 'post', encomenda: 'post', selo: 'post',
    'enviar encomenda': 'post',
    // ── store ──
    loja: 'store', 'centro comercial': 'store', shopping: 'store',
    livraria: 'store', 'comprar livro': 'store', 'comprar um livro': 'store',
    // ── florist ──
    florista: 'florist', flor: 'florist', flores: 'florist', ramo: 'florist',
    'comprar flores': 'florist',
    // ── clinic ──
    'clínica': 'clinic', 'médico': 'clinic', consulta: 'clinic',
    dentista: 'clinic', exame: 'clinic',
    // ── salon ──
    cabeleireiro: 'salon', 'corte de cabelo': 'salon', barbeiro: 'salon',
    unhas: 'salon', manicure: 'salon',
    // ── bus ──
    autocarro: 'bus', paragem: 'bus', 'apanhar o autocarro': 'bus',
    // ── school ──
    escola: 'school', aula: 'school', 'buscar os miúdos': 'school',
    'reunião de pais': 'school',
  },
};

/** All static POI targets emitted by the built-in title-rule dictionary. */
export function listSeedPoiTargets(): PoiResolution[] {
  return Array.from(new Set(
    Object.values(SEED_DICTIONARY).flatMap(dictionary => Object.values(dictionary)),
  ));
}

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalize text for matching:
 *   - lowercase
 *   - accent-fold (NFD decomposition + strip combining marks) so "café" → "cafe"
 *   - replace punctuation with spaces
 *   - collapse runs of whitespace
 *
 * Applied to both task titles and dictionary keys so matching is
 * accent- and punctuation-insensitive.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Runtime layer ───────────────────────────────────────────────────────────
//
// One runtime layer sits on top of the seed:
//   - learned   — keyword→POI pairs confirmed by the on-device LLM (KAN-196)
//                 and user POI edits (KAN-197). Additive; grows over the session.
//
// Lookup precedence (see lookupEntries): learned → seed, so an explicit
// user/LLM signal beats the built-in seed.

const learned: Record<SupportedLang, KeywordMap> = { en: {}, 'pt-PT': {} };

const ALL_LANGS: SupportedLang[] = ['en', 'pt-PT'];

/**
 * Append a confirmed keyword→POI pair to the runtime learned layer for `lang`.
 * Called by the on-device LLM (KAN-196) and by user POI edits (KAN-197).
 * Keywords are normalized before storage; empty/whitespace keywords are ignored.
 *
 * Note: this only updates the in-memory layer. Durable persistence is added in
 * KAN-196 — until then, learned entries live for the app session.
 */
export function registerLearnedKeyword(
  keyword: string,
  poi: PoiResolution,
  lang: SupportedLang = DEFAULT_LANG,
): void {
  const key = normalize(keyword);
  if (!key) { return; }
  learned[lang][key] = poi;
}

/** Bulk variant of {@link registerLearnedKeyword} — register many synonyms for one POI. */
export function registerPoiKeywords(
  poi: PoiResolution,
  keywords: string[],
  lang: SupportedLang = DEFAULT_LANG,
): void {
  for (const kw of keywords) { registerLearnedKeyword(kw, poi, lang); }
}

/** Clear the runtime learned layer (one language or all). Primarily for tests. */
export function clearLearnedKeywords(lang?: SupportedLang): void {
  const langs = lang ? [lang] : ALL_LANGS;
  for (const l of langs) { learned[l] = {}; }
}

// ─── Normalized-entry cache ───────────────────────────────────────────────────

/** Cache of normalized seed entries per language (seed never changes). */
const seedCache: Partial<Record<SupportedLang, [string, PoiResolution][]>> = {};

function normalizedSeed(lang: SupportedLang): [string, PoiResolution][] {
  const cached = seedCache[lang];
  if (cached) { return cached; }
  const entries = Object.entries(SEED_DICTIONARY[lang])
    .map(([kw, poi]) => [normalize(kw), poi] as [string, PoiResolution])
    .filter(([kw]) => kw.length > 0);
  seedCache[lang] = entries;
  return entries;
}

/**
 * All candidate [normalizedKeyword, poi] entries for a language, in precedence
 * order: learned (user/LLM) → seed. Earlier entries win on a length tie.
 */
function lookupEntries(lang: SupportedLang): [string, PoiResolution][] {
  return [
    ...(Object.entries(learned[lang]) as [string, PoiResolution][]),
    ...normalizedSeed(lang),
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Infer a POI type from a task title using the keyword dictionary.
 *
 * Matching is whole-word/phrase against the normalized title. When multiple
 * keywords match, the longest keyword wins (most specific); ties resolve to the
 * learned layer over the seed. Returns `null` when nothing matches — callers
 * must treat `null` as "no POI", never as an error.
 */
export function inferPoiFromRules(
  title: string,
  lang: SupportedLang = DEFAULT_LANG,
): PoiResolution | null {
  if (!title) { return null; }
  const normalized = normalize(title);
  if (!normalized) { return null; }
  const haystack = ` ${normalized} `;

  let best: { kw: string; poi: PoiResolution } | null = null;
  for (const [kw, poi] of lookupEntries(lang)) {
    if (haystack.includes(` ${kw} `)) {
      if (!best || kw.length > best.kw.length) { best = { kw, poi }; }
    }
  }
  return best ? best.poi : null;
}
