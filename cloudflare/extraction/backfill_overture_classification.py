"""Emit a single-read, idempotent correction for already-promoted Overture POIs.

KAN-436 changes promotion rules, but promoted candidates are intentionally never
re-promoted. This script reads the pilot once, writes reviewable SQL, and does
not execute it. It is deliberately for the pilot only; the country import gets
the rules at promotion time and must not be read back row-by-row.
"""
import os
import sys
import argparse
import re

from analyse_poi_candidates import reachable_types
from backfill_name_types import run_d1_query, sql_string
from classify_and_load import load_brand_dictionary
from promote_overture_candidates import category_map, decide


def rows_for_backfill(imported_before):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', imported_before):
        raise ValueError('--imported-before must be an ISO-8601 timestamp')
    return run_d1_query(f'''
        SELECT p.overture_id, p.name, p.category, p.primary_poi_type,
               group_concat(DISTINCT t.poi_type) AS types,
               COALESCE(MAX(t.rank), -1) AS max_rank,
               group_concat(DISTINCT a.dimension || ':' || a.value) AS attributes
        FROM overture_poi p
        LEFT JOIN overture_poi_type t ON t.overture_id = p.overture_id
        LEFT JOIN overture_poi_attribute a ON a.overture_id = p.overture_id
        WHERE p.imported_at < {sql_string(imported_before)}
        GROUP BY p.overture_id
    ''')


def attributes_from(row):
    return {tuple(value.split(':', 1)) for value in (row['attributes'] or '').split(',') if ':' in value}


def statements(rows):
    mapping, reachable, brands = category_map(), reachable_types(), load_brand_dictionary()
    for row in rows:
        existing_types = set((row['types'] or '').split(',')) - {''}
        existing_attributes = attributes_from(row)
        candidate = {'name': row['name'], 'category': row['category']}
        status, types, attributes, reason = decide(candidate, mapping, reachable, brands)
        identifier = sql_string(row['overture_id'])
        if status == 'rejected' and reason == 'ATM reserved for official Multibanco source':
            yield (
                "INSERT INTO poi_source_correction (source, source_id, visible, review_note) VALUES "
                f"('overture',{identifier},0,'KAN-436: generic Overture ATM; official Multibanco source wins') "
                "ON CONFLICT(source, source_id) DO NOTHING;\n")
            continue
        if status != 'promoted':
            continue
        replacement = (existing_types == {'store'} and 'store' not in types
                       and ('store_kind' not in {dimension for dimension, _ in existing_attributes}))
        if replacement:
            yield (f"DELETE FROM overture_poi_type WHERE overture_id = {identifier} "
                   "AND poi_type = 'store' AND NOT EXISTS (SELECT 1 FROM overture_poi_attribute "
                   f"WHERE overture_id = {identifier} AND dimension = 'store_kind');\n")
            yield (f"UPDATE overture_poi SET primary_poi_type = {sql_string(types[0])} "
                   f"WHERE overture_id = {identifier} AND primary_poi_type = 'store';\n")
            rank = 0
        else:
            rank = int(row['max_rank']) + 1
        for poi_type in types:
            if poi_type not in existing_types:
                yield ("INSERT OR IGNORE INTO overture_poi_type (overture_id, poi_type, rank) VALUES "
                       f"({identifier},{sql_string(poi_type)},{rank});\n")
                rank += 1
        for dimension, value in attributes:
            if (dimension, value) not in existing_attributes:
                yield ("INSERT OR IGNORE INTO overture_poi_attribute (overture_id, dimension, value) VALUES "
                       f"({identifier},{sql_string(dimension)},{sql_string(value)});\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--imported-before', required=True,
                        help='exclusive ISO-8601 cutoff separating the pilot from the country import')
    args = parser.parse_args()
    for statement in statements(rows_for_backfill(args.imported_before)):
        print(statement, end='')


if __name__ == '__main__':
    main()
