"""
KAN-397. Learns name->type keywords from the corpus instead of writing them
by hand.

KAN-391 recovered 10,296 type assignments from venue names, and every term
in it was hand-written after reading Portuguese data. That does not survive
the second country. Nobody here is going to hand-write the Japanese list.

But the mapping is a statistic, not an act of authorship: most records ARE
correctly tagged, and those records are the training signal for the ones
that are not. `pastelaria` appears in bakery-tagged rows far above the base
rate, which is exactly what earns it a place in the map. The same
computation over Japanese data surfaces Japanese terms, with nobody reading
the language.

## Method

  1. take rows that already carry a type from tags or categories
  2. tokenize normalized names into unigrams and bigrams, so multi-word
     terms like `snack bar` survive
  3. for each (token, type): support, P(type | token), and lift against the
     type's base rate
  4. keep what clears both thresholds
  5. rank and emit for review

## Guard rails, each earning its place

  * MIN_SUPPORT, or one oddly named venue becomes a rule.
  * MIN_LIFT, so a term must PREDICT a type rather than merely co-occur
    with a common one. `lisboa` appears beside every type in the country.
  * Brands are excluded. `Pingo Doce` predicts supermarket perfectly and is
    a brand, not a category — the brand dictionary already knows it, and
    learning it here would duplicate that with worse precision.
  * Stopwords: company-registration markers (`unipessoal`, `lda`, `sa`) and
    the geography that shows up in every Portuguese business name.

## What it does NOT do

It never writes to the classifier. The output is a ranked candidate list a
person accepts or rejects term by term, because the product call is not in
the data: the statistics would cheerfully map `snack bar` to `bar`, since
Portuguese snack-bars do carry bar-ish tags — and KAN-391 deliberately maps
it to `cafe`, because a snack-bar is a daytime eatery and answering "grab a
beer tonight" with one is wrong. `cervejaria` was excluded for the same
kind of reason.

Usage:
  python3 learn_name_keywords.py [--min-support 15] [--min-lift 4]
                                 [--min-precision 0.35] [--out <path.md>]
"""
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict

from analyse_poi_candidates import paged, reachable_types
from classify_and_load import (
    NAME_TYPE_KEYWORDS, load_brand_dictionary, normalize_text,
)

MIN_SUPPORT = 15
MIN_LIFT = 4.0
MIN_PRECISION = 0.35

# Tokens that appear across every type and predict nothing. Company-form
# markers, the words every Portuguese address carries, and the filler that
# survives normalization.
STOPWORDS = {
    'unipessoal', 'unip', 'lda', 'ldª', 'sa', 'sociedade', 'comercio',
    'servicos', 'servico', 'e', 'de', 'da', 'do', 'dos', 'das', 'a', 'o',
    'as', 'os', 'em', 'para', 'com', 'por', 'no', 'na', 'nos', 'nas',
    'rua', 'avenida', 'praca', 'largo', 'centro', 'comercial', 'shopping',
    'lisboa', 'porto', 'braga', 'coimbra', 'faro', 'aveiro', 'setubal',
    'norte', 'sul', 'novo', 'nova', 'grande', 'irmaos', 'filhos', 'filho',
    'group', 'grupo', 'the', 'and', 'ii', 'iii',
}

MIN_TOKEN_LENGTH = 3


def strip_accents(text):
    text = unicodedata.normalize('NFD', text)
    return ''.join(c for c in text if unicodedata.category(c) != 'Mn')


def tokens_of(name):
    """Unigrams plus adjacent bigrams. Bigrams matter: `snack bar` and
    `casa de cha` only mean anything whole."""
    words = [w for w in normalize_text(name or '').split() if len(w) >= MIN_TOKEN_LENGTH]
    useful = [w for w in words if w not in STOPWORDS]
    grams = set(useful)
    for a, b in zip(words, words[1:]):
        if a not in STOPWORDS or b not in STOPWORDS:
            grams.add(f'{a} {b}')
    return grams


def brand_tokens(brand_dictionary):
    """Brand phrases, and single words only when the word IS the whole brand.

    Excluding every constituent word of a multi-word brand is too blunt and
    silently destroys the best terms: `A Padaria Portuguesa` is a real
    bakery chain, and stripping its words removed `padaria` — the single
    strongest bakery term in Portuguese, 1,241 supporting rows — from the
    candidate list without a trace.

    So a one-word brand (`Worten`, `Continente`) is excluded, and a phrase
    is excluded whole, but the ordinary nouns inside a phrase survive.
    """
    out = set()
    for definitions in brand_dictionary.values():
        for brand in definitions:
            for candidate in [brand['name'], *brand.get('aliases', [])]:
                normalized = normalize_text(candidate)
                if not normalized:
                    continue
                out.add(normalized)
                words = normalized.split()
                if len(words) == 1 and len(words[0]) >= MIN_TOKEN_LENGTH:
                    out.add(words[0])
    return out


def drop_bigram_fragments(candidates):
    """Remove a unigram that is only ever a piece of a stronger bigram.

    `western union` predicts money_transfer; `western` and `union` then
    inherit it on the same rows and would fire on "União de Freguesias".
    A unigram survives only if it carries support beyond the bigram's.
    """
    by_token = {c['token']: c for c in candidates}
    fragments = set()
    for candidate in candidates:
        parts = candidate['token'].split()
        if len(parts) != 2:
            continue
        for part in parts:
            other = by_token.get(part)
            if (other and other['type'] == candidate['type']
                    and other['support'] <= candidate['support']):
                fragments.add(part)
    return [c for c in candidates if c['token'] not in fragments]


def collect(batch):
    """(token -> type -> count), type totals, and the row total.

    Reads `poi` joined to `poi_type`, so a place that is genuinely two
    things teaches both — the same reasoning that made multi-type
    assignment necessary in the first place.
    """
    token_type = defaultdict(Counter)
    type_totals = Counter()
    rows = 0
    for row in paged('poi p JOIN poi_type t ON t.fsq_place_id = p.fsq_place_id',
                     ['p.fsq_place_id AS fsq_place_id', 'p.name AS name',
                      't.poi_type AS poi_type'],
                     'p.fsq_place_id', batch):
        rows += 1
        if rows % 50000 == 0:
            print(f'  {rows:,}', file=sys.stderr)
        poi_type = row['poi_type']
        type_totals[poi_type] += 1
        for token in tokens_of(row['name']):
            token_type[token][poi_type] += 1
    return token_type, type_totals, rows


def score(token_type, type_totals, total, brands, min_support, min_lift, min_precision):
    """Ranked candidates. Precision is P(type | token); lift is that over
    the type's base rate, which is what separates a predictive term from one
    that merely rides on a common type."""
    candidates = []
    for token, types in token_type.items():
        if token in brands or any(w in brands for w in token.split()):
            continue
        occurrences = sum(types.values())
        if occurrences < min_support:
            continue
        poi_type, hits = types.most_common(1)[0]
        precision = hits / occurrences
        base = type_totals[poi_type] / total
        lift = precision / base if base else 0.0
        if hits >= min_support and precision >= min_precision and lift >= min_lift:
            candidates.append({
                'token': token, 'type': poi_type, 'support': hits,
                'occurrences': occurrences, 'precision': precision, 'lift': lift,
            })
    candidates.sort(key=lambda c: (-c['lift'], -c['support']))
    return drop_bigram_fragments(candidates)


def report(path, candidates, rows, thresholds):
    reachable = reachable_types()
    resolve = lambda t: reachable.get(t, t)
    known = {normalize_text(k): resolve(v) for k, v in NAME_TYPE_KEYWORDS.items()}
    for c in candidates:
        c['type'] = resolve(c['type'])
    found = {c['token'] for c in candidates}
    rediscovered = sorted(k for k in known if k in found)
    missed = sorted(k for k in known if k not in found)
    agreed = [c for c in candidates if c['token'] in known and known[c['token']] == c['type']]
    disagreed = [c for c in candidates if c['token'] in known and known[c['token']] != c['type']]
    novel = [c for c in candidates if c['token'] not in known]

    lines = ['# KAN-397 — learned name keywords (PT)\n']
    lines.append(f'Training rows: **{rows:,}** (`poi` joined to `poi_type`, so a place '
                 'that is two things teaches both).\n')
    lines.append(f"Thresholds: support >= {thresholds['support']}, "
                 f"lift >= {thresholds['lift']}, precision >= {thresholds['precision']}.\n")
    lines.append('## Does it rediscover the hand-written list?\n')
    lines.append('The validation that matters. If the method cannot re-find terms a '
                 'person already found in a language we read, it cannot be trusted '
                 'with one we do not.\n')
    lines.append(f'| | |\n|---|---:|')
    lines.append(f'| Hand-written terms (KAN-391) | {len(known)} |')
    lines.append(f'| Rediscovered | {len(rediscovered)} |')
    lines.append(f'| Missed | {len(missed)} |')
    lines.append(f'| Agreed on the type | {len(agreed)} |')
    lines.append(f'| **Disagreed on the type** | **{len(disagreed)}** |')
    lines.append(f'| New terms proposed | {len(novel)} |\n')

    if disagreed:
        lines.append('### Disagreements — read these first\n')
        lines.append('The method chose a different type than the person did. Each is '
                     'either a product call the data cannot see, or a hand-written '
                     'mistake.\n')
        lines.append('| token | hand-written | learned | support | precision | lift |')
        lines.append('|---|---|---|---:|---:|---:|')
        for c in disagreed:
            lines.append(f"| `{c['token']}` | {known[c['token']]} | {c['type']} | "
                         f"{c['support']} | {c['precision']:.2f} | {c['lift']:.1f} |")
        lines.append('')

    if missed:
        lines.append('### Missed by the method\n')
        lines.append('```')
        lines.append(', '.join(f'{k} -> {known[k]}' for k in missed))
        lines.append('```\n')

    app_types = set(reachable.values())
    usable = [c for c in novel if c['type'] in app_types]
    unusable = [c for c in novel if c['type'] not in app_types]

    def table(rows, limit):
        out = ['| token | type | support | occurrences | precision | lift |',
               '|---|---|---:|---:|---:|---:|']
        for c in rows[:limit]:
            out.append(f"| `{c['token']}` | {c['type']} | {c['support']} | "
                       f"{c['occurrences']} | {c['precision']:.2f} | {c['lift']:.1f} |")
        return out

    lines.append('## Proposed terms for types the app ships\n')
    lines.append(f'{len(usable)} terms. These are the actionable list — nothing is '
                 'applied, a person accepts or rejects each.\n')
    lines += table(usable, 120)
    lines.append('')

    lines.append('## Proposed terms for types the app has no PoiType for\n')
    lines.append(f'{len(unusable)} terms, kept separate so they do not consume review '
                 'time. A term here cannot be used until the type exists, so this is '
                 'evidence for KAN-400 rather than a list to approve. Strong signals '
                 'in here are an argument that the type is worth adding.\n')
    lines += table(unusable, 60)
    lines.append('')

    with open(path, 'w') as handle:
        handle.write('\n'.join(lines) + '\n')
    print(f'wrote {path}')
    return {'rediscovered': len(rediscovered), 'missed': len(missed),
            'disagreed': len(disagreed), 'novel': len(novel)}


def run(min_support, min_lift, min_precision, out_path, batch=10000):
    print('collecting...', file=sys.stderr)
    token_type, type_totals, rows = collect(batch)
    brands = brand_tokens(load_brand_dictionary())
    print(f'  {rows:,} rows, {len(token_type):,} distinct tokens, '
          f'{len(brands):,} brand tokens excluded', file=sys.stderr)
    candidates = score(token_type, type_totals, rows, brands,
                       min_support, min_lift, min_precision)
    print(f'  {len(candidates):,} candidates clear the thresholds', file=sys.stderr)
    return report(out_path, candidates, rows,
                  {'support': min_support, 'lift': min_lift, 'precision': min_precision})


if __name__ == '__main__':
    args = sys.argv[1:]

    def opt(flag, default, cast):
        return cast(args[args.index(flag) + 1]) if flag in args else default

    default_out = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        'docs', 'KAN-397-learned-name-keywords.md')
    run(opt('--min-support', MIN_SUPPORT, int),
        opt('--min-lift', MIN_LIFT, float),
        opt('--min-precision', MIN_PRECISION, float),
        opt('--out', default_out, str))
