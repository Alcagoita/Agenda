/**
 * src/services/poiLlm.ts — KAN-196
 *
 * On-device POI classifier (second pass after the KAN-195 rule map), plus
 * dictionary learn-back. Titles the rule map returns `null` for are run through
 * a small TFLite average-word-embedding text classifier via
 * react-native-fast-tflite — free, offline, and cross-platform (Android + iOS,
 * no hardware gate, ~90 KB bundled model).
 *
 * Pipeline: normalize+tokenize the title (same `normalize()` the dictionary
 * uses) → int[MAXLEN] → model → softmax over the 17 classes (16 POI + "none").
 * Top class wins if its probability ≥ CONFIDENCE_THRESHOLD and it is a real POI;
 * otherwise `null`. `null` is a valid, expected result — callers treat it as
 * "no POI". Any failure (model can't load, inference throws) also degrades to
 * `null`, so POI inference never throws or blocks an import.
 *
 * Model artifacts (trained offline — see ml/poi-classifier/): the .tflite plus
 * vocab.json (token→id) and labels.json (class index→label). The JS tokenizer
 * here MUST match ml/poi-classifier/train_colab.py exactly.
 *
 * ── Learn-back ────────────────────────────────────────────────────────────
 * A confident classification (or a user edit, KAN-197) is fed back into the
 * dictionary's learned layer (KAN-195) AND persisted to Firestore, so next time
 * the rule map catches the title for free.
 */

import { loadTensorflowModel, type TensorflowModel } from 'react-native-fast-tflite';
import type { PoiType } from '../types';
import {
  isCatalogPoiType, isQuickActionablePoiType, POI_CATALOG,
  POI_GOOGLE_TYPES, QUICK_ACTIONABLE_POI_TYPES,
} from '../types';
import {
  inferPoiFromRules,
  listSeedPoiTargets,
  normalize,
  registerLearnedKeyword,
  type PoiResolution,
  type SupportedLang,
} from './poiInference';
import { persistLearnedKeyword } from './firestore';
import { isSuggestedPoiType, searchPlaceTypesLocal } from './poiTypeCache';
import { inferRestaurantFoodTypeForPoiInference } from './restaurantFoodTypes';
import { inferStoreSubtypeForPoiInference } from './storeSubtypes';
import { findBrandInText, findRequiredBrandInText } from './brandDictionary';
import vocabJson from '../../assets/poi-model/vocab.json';
import labelsJson from '../../assets/poi-model/labels.json';

const MODEL_ASSET = require('../../assets/poi-model/poi_classifier.tflite');

// Must match ml/poi-classifier/train_colab.py.
const MAXLEN = 12;
const PAD_ID = 0;
const OOV_ID = 1;

/** Minimum top-class probability to accept a classification. Below → null. */
export const CONFIDENCE_THRESHOLD = 0.5;

/** Hard cap on the native model load so a stalled load can't block an import. */
export const MODEL_LOAD_TIMEOUT_MS = 5_000;

const VOCAB = vocabJson as Record<string, number>;
const LABELS = labelsJson as string[];
const VALID_POI = new Set<string>(POI_CATALOG.map(c => c.type));

// ─── Model (lazy, cached) ─────────────────────────────────────────────────────

let modelPromise: Promise<TensorflowModel> | null = null;

function getModel(): Promise<TensorflowModel> {
  if (!modelPromise) {
    modelPromise = loadTensorflowModel(MODEL_ASSET, []); // [] = default CPU delegate
  }
  return modelPromise;
}

/** Test-only: drop the cached model so the next call reloads it. */
export function __resetModelForTests(): void {
  modelPromise = null;
}

/** Race a promise against a timeout; rejects if `ms` elapses first. Clears the
 *  timer once the race settles so it never leaks. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('model load timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Load the model with a hard timeout. On timeout/failure the cached promise is
 * cleared so a later call can retry instead of being stuck on a bad load.
 */
async function loadModelGuarded(): Promise<TensorflowModel> {
  try {
    return await withTimeout(getModel(), MODEL_LOAD_TIMEOUT_MS);
  } catch (err) {
    modelPromise = null;
    throw err;
  }
}

/**
 * Whether the classifier model can be used. Never throws — a load failure or
 * timeout resolves to `false` (and clears the cache so the next call retries).
 */
export async function isLlmAvailable(): Promise<boolean> {
  try {
    await loadModelGuarded();
    return true;
  } catch {
    return false;
  }
}

// ─── Tokenizer (must mirror train_colab.py) ──────────────────────────────────

/**
 * Title → fixed-length int token ids. Reuses `normalize()` (lowercase,
 * accent-fold, de-punctuate), splits on whitespace, maps each token to its
 * vocab id (OOV → 1), truncates to MAXLEN and right-pads with 0.
 */
export function tokenize(title: string): Int32Array {
  const ids = new Int32Array(MAXLEN); // zero-filled = PAD_ID
  ids.fill(PAD_ID);
  const tokens = normalize(title).split(' ').filter(Boolean);
  const n = Math.min(tokens.length, MAXLEN);
  for (let i = 0; i < n; i++) {
    ids[i] = VOCAB[tokens[i]] ?? OOV_ID;
  }
  return ids;
}

// ─── Output validation ────────────────────────────────────────────────────────

/**
 * Map a class label to a `PoiType` or `null`. "none"/empty/unknown → null;
 * never trust a label outside the built-in POI set.
 */
export function validatePoi(label: string | null | undefined): PoiType | null {
  if (!label) { return null; }
  const v = label.trim().toLowerCase();
  if (!v || v === 'none' || v === 'null') { return null; }
  return VALID_POI.has(v) ? (v as PoiType) : null;
}

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Classify a title into a POI type using the on-device model. Returns `null`
 * when the model is unavailable, errors, the top class is below
 * CONFIDENCE_THRESHOLD, or the predicted label is "none"/off-list.
 *
 * `lang` is accepted for API symmetry with the rule map; the model is bilingual
 * via a shared vocab and does not need it.
 */
export async function classifyPoi(
  title: string,
  _lang: SupportedLang,
): Promise<PoiType | null> {
  if (!title || !title.trim()) { return null; }

  let model: TensorflowModel;
  try {
    model = await loadModelGuarded();
  } catch {
    return null;
  }

  let probs: Float32Array;
  try {
    // runSync takes/returns ArrayBuffer[]; input is the int32 token tensor,
    // output is the float32 softmax over the classes.
    const outputs = model.runSync([tokenize(title).buffer as ArrayBuffer]);
    probs = new Float32Array(outputs[0]);
  } catch {
    return null;
  }
  if (!probs || probs.length === 0) { return null; }

  let bestIdx = 0;
  let bestP = -1;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > bestP) { bestP = probs[i]; bestIdx = i; }
  }
  if (bestP < CONFIDENCE_THRESHOLD) { return null; }
  return validatePoi(LABELS[bestIdx]);
}

// ─── Quick-add suggestion (KAN-232) ───────────────────────────────────────────

/**
 * Suggest a POI type for a title as the user types it (new-task quick-add
 * sheet): the offline rule dictionary first (EN, then pt-PT), falling back to
 * the on-device classifier only when the rules miss. Returns `null` when
 * neither pass matches — never throws, both underlying calls already degrade
 * to `null` on failure, so this works fully offline (airplane mode).
 */
export async function inferPoiForQuickAdd(title: string): Promise<PoiResolution | null> {
  // Gym and Bank tasks are brand-specific. A recognised chain is therefore
  // stronger than generic title keywords and lets the form preselect both
  // the type and its canonical brand (KAN-364).
  const requiredBrand = findRequiredBrandInText(title);
  if (requiredBrand) { return requiredBrand.poiType; }
  if (inferRestaurantFoodTypeForPoiInference(title)) { return 'restaurant'; }
  // Store brands are optional, but a recognised chain is still an unambiguous
  // Store signal. The form resolves the same canonical brand from the title
  // once this broad type is selected.
  if (findBrandInText('store', title)) { return 'store'; }

  const localSuggestion = searchPlaceTypesLocal(title)[0]?.type ?? null;
  if (localSuggestion) {
    return isQuickActionablePoiType(localSuggestion) ? localSuggestion : null;
  }

  if (inferStoreSubtypeForPoiInference(title)) { return 'store'; }

  const en = inferPoiFromRules(title, 'en');
  if (en) { return isQuickActionablePoiType(en) ? en : null; }

  const pt = inferPoiFromRules(title, 'pt-PT');
  if (pt) { return isQuickActionablePoiType(pt) ? pt : null; }

  const classification = await classifyPoi(title, 'en');
  return isQuickActionablePoiType(classification) ? classification : null;
}

/**
 * Returns static POI-inference targets that the suggestion dictionary cannot
 * represent. Built-in Brush IDs are compared through their external POI type
 * mapping, so `gas` correctly checks against `gas_station`, for example.
 */
export function getUnsuggestedPoiInferenceTypes(): string[] {
  const inferredTypes = new Set<string>([
    ...QUICK_ACTIONABLE_POI_TYPES,
    ...listSeedPoiTargets(),
  ]);

  return Array.from(inferredTypes)
    .filter(isQuickActionablePoiType)
    .map(type => isCatalogPoiType(type) ? POI_GOOGLE_TYPES[type] : type)
    .filter(type => !isSuggestedPoiType(type))
    .sort();
}

// ─── Learn-back ───────────────────────────────────────────────────────────────

/** Where a learned keyword came from. */
export type LearnSource = 'llm' | 'user';

/**
 * Record a confirmed title→POI signal: register it into the in-memory learned
 * layer immediately (so it works this session) and persist it to Firestore (so
 * it survives a restart). The whole normalized title is stored as a phrase
 * keyword — a safe, false-positive-free match for an identical future title.
 *
 * Best-effort: a persistence failure is swallowed so it never breaks an import.
 */
export async function learnPoiKeyword(
  uid: string,
  title: string,
  poi: PoiResolution,
  lang: SupportedLang,
  source: LearnSource,
): Promise<void> {
  registerLearnedKeyword(title, poi, lang);
  try {
    await persistLearnedKeyword(uid, { keyword: title, poi, lang, source });
  } catch {
    // non-fatal — the in-memory registration still stands for this session.
  }
}

/** Learn-back from a model classification (source = 'llm'). */
export function learnFromClassification(
  uid: string,
  title: string,
  poi: PoiResolution,
  lang: SupportedLang,
): Promise<void> {
  return learnPoiKeyword(uid, title, poi, lang, 'llm');
}

/** Learn-back from a manual user POI edit (source = 'user'; KAN-197 wires this). */
export function learnFromUserEdit(
  uid: string,
  title: string,
  poi: PoiResolution,
  lang: SupportedLang,
): Promise<void> {
  return learnPoiKeyword(uid, title, poi, lang, 'user');
}
