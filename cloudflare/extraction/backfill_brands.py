"""Emit an idempotent D1 backfill for canonical Gym and Bank brands.

Run after migrations/0010_brand_aware_nearby.sql, without re-importing the
country dataset:

  python3 cloudflare/extraction/backfill_brands.py > /tmp/brand-backfill.sql
  cd cloudflare && npx wrangler d1 execute brush-poi-registry --remote --file=/tmp/brand-backfill.sql

The canonical values and aliases come directly from the shared app/import/API
catalogue. A matching update always writes the canonical `name`; unmatched
Gym/Bank records become NULL, which is intentional and makes the script safe
to rerun after the catalogue grows.
"""
import json
import os
import string

from classify_and_load import normalize_text

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DICTIONARY_PATH = os.path.join(ROOT, 'src', 'constants', 'brandDictionary.json')


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


SQL_ACCENT_REPLACEMENTS = {
    'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
    'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
    'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
    'ò': 'o', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o',
    'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ç': 'c', 'ñ': 'n',
}
SQL_PUNCTUATION = string.punctuation + '–—“”‘’…\t\n\r'


def normalization_steps():
    """Return the importer-equivalent SQL transformations in shallow layers."""
    steps = [lambda expression: f"lower({expression})"]
    for source, target in SQL_ACCENT_REPLACEMENTS.items():
        steps.append(lambda expression, source=source, target=target: (
            f"replace({expression}, {sql_string(source.upper())}, {sql_string(target)})"
        ))
        steps.append(lambda expression, source=source, target=target: (
            f"replace({expression}, {sql_string(source)}, {sql_string(target)})"
        ))
    for character in SQL_PUNCTUATION:
        steps.append(lambda expression, character=character: (
            f"replace({expression}, {sql_string(character)}, ' ')"
        ))
    for _ in range(8):
        steps.append(lambda expression: f"replace({expression}, '  ', ' ')")
    steps.append(lambda expression: f"trim({expression})")
    return steps


def normalized_poi_ctes(identifier_column, identifier_name, name_column, source_table, where_clause):
    """Build shallow D1-compatible CTEs for the complete normalization rule.

    D1 rejects one expression with every replacement nested inside it, and its
    remote authorizer rejects TEMP tables. Each CTE therefore performs at most
    eight transformations while retaining the exact same value flow.
    """
    ctes = [
        f"normalized_0 AS (SELECT {identifier_column} AS {identifier_name}, coalesce({name_column}, '') AS normalized_name "
        f"FROM {source_table} WHERE {where_clause})",
    ]
    previous = 'normalized_0'
    steps = normalization_steps()
    for index, group_start in enumerate(range(0, len(steps), 8), start=1):
        expression = 'normalized_name'
        for step in steps[group_start:group_start + 8]:
            expression = step(expression)
        current = f'normalized_{index}'
        ctes.append(
            f"{current} AS (SELECT {identifier_name}, {expression} AS normalized_name FROM {previous})",
        )
        previous = current
    ctes.append(f"normalized_poi AS (SELECT {identifier_name}, normalized_name FROM {previous})")
    return ',\n'.join(ctes)


def brand_case(entries, normalized_column='normalized_name'):
    clauses = []
    for entry in entries:
        for alias in [entry['name'], *entry.get('aliases', [])]:
            normalized_alias = normalize_text(alias)
            if not normalized_alias:
                continue
            # Same padded word/phrase boundary used by find_brand: "BPI" must
            # not match inside a longer unrelated name, while "Banco BPI"
            # remains a valid phrase match after punctuation/accent folding.
            clauses.append(
                f"WHEN (' ' || {normalized_column} || ' ') LIKE "
                f"{sql_string('% ' + normalized_alias + ' %')} THEN {sql_string(entry['name'])}",
            )
    return '\n      '.join(clauses)


def emit_for_foursquare(poi_type, entries):
    where_clause = f"""EXISTS (
    SELECT 1 FROM poi_type
    WHERE poi_type.fsq_place_id = source.fsq_place_id
      AND poi_type.poi_type = {sql_string(poi_type)}
)"""
    print(f"""WITH {normalized_poi_ctes('source.fsq_place_id', 'fsq_place_id', 'source.name', 'poi AS source', where_clause)}
UPDATE poi AS target
SET brand = (
  SELECT CASE
      {brand_case(entries)}
      ELSE NULL
    END
  FROM normalized_poi
  WHERE normalized_poi.fsq_place_id = target.fsq_place_id
)
WHERE EXISTS (
  SELECT 1 FROM poi_type
  WHERE poi_type.fsq_place_id = target.fsq_place_id
    AND poi_type.poi_type = {sql_string(poi_type)}
);""")


def emit_for_curated(poi_type, entries):
    where_clause = f"source.primary_poi_type = {sql_string(poi_type)}"
    print(f"""WITH {normalized_poi_ctes('source.poi_id', 'poi_id', 'source.name', 'curated_poi AS source', where_clause)}
UPDATE curated_poi AS target
SET brand = (
  SELECT CASE
      {brand_case(entries)}
      ELSE NULL
    END
  FROM normalized_poi
  WHERE normalized_poi.poi_id = target.poi_id
)
WHERE target.primary_poi_type = {sql_string(poi_type)};""")


def main():
    with open(DICTIONARY_PATH) as source:
        dictionary = json.load(source)
    print('-- Generated by extraction/backfill_brands.py. Do not hand-edit.')
    for poi_type in ('gym', 'bank'):
        entries = dictionary[poi_type]
        emit_for_foursquare(poi_type, entries)
        emit_for_curated(poi_type, entries)
    print("""-- Backfill report: capture these result rows with the deployment record.
SELECT poi_type.poi_type, poi.brand, COUNT(*) AS places
FROM poi_type
JOIN poi ON poi.fsq_place_id = poi_type.fsq_place_id
WHERE poi_type.poi_type IN ('gym', 'bank')
GROUP BY poi_type.poi_type, poi.brand
ORDER BY poi_type.poi_type, places DESC, poi.brand;

SELECT primary_poi_type AS poi_type, brand, COUNT(*) AS places
FROM curated_poi
WHERE primary_poi_type IN ('gym', 'bank')
GROUP BY primary_poi_type, brand
ORDER BY primary_poi_type, places DESC, brand;""")


if __name__ == '__main__':
    main()
