"""Report Overture records that the current rules cannot make reachable.

Runs on an archived Overture CSV before candidate SQL is produced. It makes
only the existing small type-relation lookup; the country-scale pass itself is
local and streaming, never a read of Overture rows from D1.
"""
import argparse
import csv
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyse_poi_candidates import reachable_types
from classify_and_load import load_brand_dictionary, load_financial_service_name_rules
from promote_overture_candidates import (
    category_map, decide, food_cuisine_alias_index, store_brand_index,
    store_kind_alias_index,
)


def unresolved_rows(csv_path):
    mapping, reachable, brands = category_map(), reachable_types(), load_brand_dictionary()
    store_kinds = store_kind_alias_index()
    food_cuisines = food_cuisine_alias_index()
    financial_rules = load_financial_service_name_rules()
    store_brands = store_brand_index()
    with open(csv_path, newline='') as handle:
        for row in csv.DictReader(handle):
            status, types, attributes, reason = decide(
                row, mapping, reachable, brands, store_kinds, food_cuisines,
                financial_rules, store_brands)
            if status != 'promoted':
                yield row, status, reason or 'no reachable type'


def write_report(csv_path, out_path):
    if os.path.realpath(csv_path) == os.path.realpath(out_path):
        raise ValueError('csv_path and out_path must be different files')
    counts = Counter()
    with open(out_path, 'w', newline='') as handle:
        writer = csv.writer(handle, delimiter='\t')
        writer.writerow(('status', 'reason', 'category', 'name', 'locality', 'overture_id'))
        for row, status, reason in unresolved_rows(csv_path):
            counts[(status, row.get('category') or '(none)')] += 1
            writer.writerow((status, reason, row.get('category') or '', row.get('name') or '',
                             row.get('locality') or '', row.get('overture_id') or ''))
    return counts


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv_path')
    parser.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    counts = write_report(args.csv_path, args.out)
    print(f'{sum(counts.values()):,} unresolved rows across {len(counts)} status/category groups', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
