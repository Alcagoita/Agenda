"""KAN-409. Strip brands that only matched because normalization ate the
character that distinguished them.

`find_brand` now refuses an ambiguous brand form unless it leads the name and,
for an ampersand brand, the name carries an ampersand too. That fixes every
FUTURE import and nothing already landed: the rows classified under the old
rule keep their wrong brand until something rewrites it.

This re-runs the CURRENT rule over every row carrying one of the affected
brands and clears the ones that no longer qualify. It only ever sets a brand
to NULL — it never assigns a different one. Working out what a
mis-branded row should have been instead needs its ranked types and is a
different job; leaving the row unbranded is already correct, since an
unbranded store is simply a store.

  python3 cloudflare/extraction/unbrand_false_positives.py > /tmp/unbrand.sql
  (cd cloudflare && npx wrangler d1 execute brush-poi-registry --remote --file=/tmp/unbrand.sql)

Safe to re-run: a row already cleared no longer matches the WHERE clause.
"""
import json
import os
import subprocess
import sys

from classify_and_load import load_brand_dictionary, normalize_text, brand_form_matches

CLOUDFLARE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_BATCH_SIZE = 200

# The brands whose normalized form is ambiguous. Derived, not hand-listed, so
# a brand added to the dictionary later is covered without editing this.
SOURCES = [
    ('poi', 'fsq_place_id'),
    ('osm_poi', 'osm_element_id'),
]


def run_d1_query(sql):
    result = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry',
         '--remote', '--json', '--command', sql],
        cwd=CLOUDFLARE_DIR, capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout[result.stdout.index('['):])[0]['results']


def ambiguous_brand_names(brand_dictionary):
    """Canonical names holding at least one ambiguous form -> ALL their forms.

    An ambiguous form is what makes a brand worth re-checking, but the check
    itself has to see every form the classifier sees. `C&A` carries the alias
    `C and A`, which is not ambiguous and matches by ordinary substring:
    testing only `c a` would decide a legitimately-matched row no longer
    qualifies and unbrand it. `brand_form_matches` already applies the right
    rule per form, so it is given all of them.
    """
    from classify_and_load import is_ambiguous_brand_form
    out = {}
    for brands in brand_dictionary.values():
        for brand in brands:
            forms = {
                normalized for normalized in (
                    normalize_text(candidate)
                    for candidate in [brand['name'], *brand.get('aliases', [])]
                ) if normalized
            }
            if any(is_ambiguous_brand_form(form) for form in forms):
                out.setdefault(brand['name'], set()).update(forms)
    return out


def sql_quote(value):
    return "'" + value.replace("'", "''") + "'"


def main():
    brand_dictionary = load_brand_dictionary()
    ambiguous = ambiguous_brand_names(brand_dictionary)
    if not ambiguous:
        print('-- no ambiguous brand forms in the dictionary', file=sys.stderr)
        return 0
    print(f'ambiguous brands: {", ".join(sorted(ambiguous))}', file=sys.stderr)

    quoted = ','.join(sql_quote(name) for name in sorted(ambiguous))
    total_cleared = 0

    for table, id_column in SOURCES:
        rows = run_d1_query(
            f'SELECT {id_column} AS id, name, brand FROM {table} '
            f'WHERE brand IN ({quoted})'
        )
        stale = []
        for row in rows:
            forms = ambiguous[row['brand']]
            normalized_name = normalize_text(row['name'])
            # Keeps the brand if ANY of its forms still qualifies — including a
            # non-ambiguous alias, which brand_form_matches handles itself.
            keeps = any(
                brand_form_matches(form, normalized_name, row['name'], row['brand'])
                for form in forms
            )
            if not keeps:
                stale.append(row)

        print(f'[{table}] {len(rows)} rows carry an ambiguous brand, '
              f'{len(stale)} no longer qualify', file=sys.stderr)
        for row in stale[:40]:
            print(f'    {row["brand"]:5} {row["name"][:64]}', file=sys.stderr)
        if len(stale) > 40:
            print(f'    ... +{len(stale) - 40} more', file=sys.stderr)

        # Grouped by the brand actually observed, and that brand is repeated in
        # the WHERE clause. This script PRINTS sql for an operator to apply
        # later, so there is a window in which a row could be re-branded
        # correctly by something else; without the predicate, applying a stale
        # statement would wipe that newer, correct value.
        by_brand = {}
        for row in stale:
            by_brand.setdefault(row['brand'], []).append(row['id'])
        for brand, row_ids in sorted(by_brand.items()):
            for start in range(0, len(row_ids), SQL_BATCH_SIZE):
                chunk = row_ids[start:start + SQL_BATCH_SIZE]
                ids = ','.join(sql_quote(row_id) for row_id in chunk)
                print(f'UPDATE {table} SET brand = NULL '
                      f'WHERE {id_column} IN ({ids}) AND brand = {sql_quote(brand)};')
        total_cleared += len(stale)

    print(f'total to unbrand: {total_cleared}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
