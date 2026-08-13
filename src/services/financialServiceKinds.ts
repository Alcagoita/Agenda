import { normalize } from './poiInference';

type FinancialServiceKindDictionary = Record<string, {
  label: string;
  labelPt?: string;
  aliases: string[];
}>;

const FINANCIAL_SERVICE_KIND_DICTIONARY = require('../constants/financialServiceKindDictionary.json') as FinancialServiceKindDictionary;

export type FinancialServiceKind = keyof typeof FINANCIAL_SERVICE_KIND_DICTIONARY & string;

type FinancialServiceTaskLike = {
  poi?: string | null;
  title: string;
  financialServiceKind?: FinancialServiceKind | null;
};
type FinancialServicePlaceLike = {
  name: string;
  financialServiceKinds?: FinancialServiceKind[] | null;
};

function termMatches(haystack: string, term: string): boolean {
  const normalizedTerm = normalize(term);
  return normalizedTerm.length > 0 && ` ${haystack} `.includes(` ${normalizedTerm} `);
}

/** Best specific financial-service category inferred from a task title. */
export function inferFinancialServiceKind(title: string): FinancialServiceKind | null {
  const normalizedTitle = normalize(title);
  if (!normalizedTitle) return null;

  let best: { kind: FinancialServiceKind; length: number } | null = null;
  for (const [kind, entry] of Object.entries(FINANCIAL_SERVICE_KIND_DICTIONARY) as Array<[FinancialServiceKind, FinancialServiceKindDictionary[string]]>) {
    for (const alias of entry.aliases) {
      const normalizedAlias = normalize(alias);
      if (!termMatches(normalizedTitle, alias)) continue;
      if (!best || normalizedAlias.length > best.length) {
        best = { kind, length: normalizedAlias.length };
      }
    }
  }
  return best?.kind ?? null;
}

export function listFinancialServiceKinds(): FinancialServiceKind[] {
  return Object.keys(FINANCIAL_SERVICE_KIND_DICTIONARY) as FinancialServiceKind[];
}

export function financialServiceKindDisplayLabel(kind: FinancialServiceKind, language?: string): string {
  const entry = FINANCIAL_SERVICE_KIND_DICTIONARY[kind];
  return language === 'pt-PT' ? entry.labelPt ?? entry.label : entry.label;
}

export function financialServiceTaskKind(task: FinancialServiceTaskLike): FinancialServiceKind | null {
  return task.poi === 'financial_service'
    ? task.financialServiceKind ?? inferFinancialServiceKind(task.title)
    : null;
}

export function financialServiceTaskMatchesPlace(
  task: FinancialServiceTaskLike,
  place: FinancialServicePlaceLike,
): boolean {
  const kind = financialServiceTaskKind(task);
  return kind == null || place.financialServiceKinds?.includes(kind) === true;
}

export function filterFinancialServicePlacesForTasks<T extends FinancialServicePlaceLike>(
  poiType: string,
  places: T[],
  tasks: readonly FinancialServiceTaskLike[],
): T[] {
  if (poiType !== 'financial_service') return places;
  const financialTasks = tasks.filter(task => task.poi === 'financial_service');
  return places.filter(place => financialTasks.some(task => financialServiceTaskMatchesPlace(task, place)));
}
