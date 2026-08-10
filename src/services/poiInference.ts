/**
 * src/services/poiInference.ts — KAN-195
 *
 * Rule-based POI inference: map a task title to a POI type using an on-device,
 * offline keyword dictionary. This is the FIRST pass of POI inference on
 * imported tasks (wired into the import flow in KAN-197). No AI, no network —
 * the on-device LLM fallback for titles this misses lands in KAN-196.
 *
 * Output is a `PoiResolution` (a built-in `PoiType` or, for custom categories,
 * any Google Places type string) or `null`. `null` is a valid, expected result:
 * when no keyword matches we do NOT guess, and the caller simply leaves
 * `task.poi` unset. The seed covers all 19 built-in `PoiType`s in EN + pt-PT.
 *
 * ── Self-growing dictionary ───────────────────────────────────────────────
 * The dictionary has two layers:
 *   - SEED_DICTIONARY — hand-curated, checked in, never mutated at runtime.
 *   - learned layer   — keyword→POI pairs appended at runtime, fed by:
 *       • the on-device LLM (KAN-196) and user POI edits (KAN-197), and
 *       • custom categories the user adds — `registerCategoryKeywords` /
 *         `syncCategoryKeywords` turn a category's name (+ synonyms) into
 *         keywords pointing at its POI, so user-added POIs are inferable too.
 * Lookups consult the learned layer first, then the seed. This file owns the
 * in-memory structure only; durable persistence (local + Firestore) is wired
 * in KAN-196 — custom categories are re-synced from Firestore on load until then.
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

// ─── Runtime layers ──────────────────────────────────────────────────────────
//
// Two independent runtime layers sit on top of the seed:
//   - learned   — keyword→POI pairs confirmed by the on-device LLM (KAN-196)
//                 and user POI edits (KAN-197). Additive; grows over the session.
//   - category  — keywords derived from the user's custom categories. REBUILT
//                 wholesale by `replaceCategoryKeywords` so renamed/deleted
//                 categories never leave stale keywords behind.
//
// Lookup precedence (see lookupEntries): learned → category → seed, so an
// explicit user/LLM signal beats an auto-derived category term, which beats the
// built-in seed.

const learned: Record<SupportedLang, KeywordMap> = { en: {}, 'pt-PT': {} };
const category: Record<SupportedLang, KeywordMap> = { en: {}, 'pt-PT': {} };

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

/**
 * Register a custom category's wording into the category layer so future imports
 * infer its POI. This is the "user adds a new POI" hook: a custom category's
 * `name` (and any extra `synonyms`) become keywords pointing at its POI/Places
 * type.
 *
 * `lang` is **optional**: when omitted (the Firestore callers never know the
 * lookup language up front) the terms are registered under **every** supported
 * language, so a user category written in Portuguese still matches an EN lookup
 * and vice-versa. Pass `lang` to scope to a single language.
 *
 * No-op for categories without a POI (`poi == null`) or with an empty name.
 */
export function registerCategoryKeywords(
  cat: { name: string; poi: string | null; synonyms?: string[] },
  lang?: SupportedLang,
): void {
  if (!cat.poi) { return; }
  const langs = lang ? [lang] : ALL_LANGS;
  const terms = [cat.name, ...(cat.synonyms ?? [])];
  for (const l of langs) {
    for (const term of terms) {
      const key = normalize(term);
      if (key) { category[l][key] = cat.poi; }
    }
  }
}

/**
 * Rebuild the category layer from the current custom-category list. Clears the
 * existing category-derived keywords first (so renamed/deleted categories stop
 * matching), then re-registers every category. This is the Firestore reload hook
 * — call on app start / category load. Categories without a POI are skipped.
 *
 * `lang` optional: omit to rebuild all languages (default), or scope to one.
 */
export function replaceCategoryKeywords(
  categories: { name: string; poi: string | null; synonyms?: string[] }[],
  lang?: SupportedLang,
): void {
  const langs = lang ? [lang] : ALL_LANGS;
  for (const l of langs) { category[l] = {}; }
  for (const c of categories) { registerCategoryKeywords(c, lang); }
}

/** @deprecated Use {@link replaceCategoryKeywords}. Kept for back-compat; same replace semantics. */
export const syncCategoryKeywords = replaceCategoryKeywords;

/** Clear the runtime learned + category layers (one language or all). Primarily for tests. */
export function clearLearnedKeywords(lang?: SupportedLang): void {
  const langs = lang ? [lang] : ALL_LANGS;
  for (const l of langs) { learned[l] = {}; category[l] = {}; }
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
 * order: learned (user/LLM) → category (custom categories) → seed. Earlier
 * entries win on a length tie.
 */
function lookupEntries(lang: SupportedLang): [string, PoiResolution][] {
  return [
    ...(Object.entries(learned[lang]) as [string, PoiResolution][]),
    ...(Object.entries(category[lang]) as [string, PoiResolution][]),
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
