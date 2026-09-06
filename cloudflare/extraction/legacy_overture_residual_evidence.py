"""Collect legacy corroboration for the reviewed Portugal Overture tail.

This is deliberately an *exact-ID* audit tool.  It starts from the immutable
country inventory, removes IDs already recorded in the source-scoped override
ledger, and asks D1 about only those remaining IDs.  It never scans a pending
country backlog.  A legacy row is evidence only when its normalized name agrees
and it is within ``MAX_DELTA_DEGREES`` of the Overture point.
"""
import argparse
import csv
import json
import os
import subprocess
import unicodedata


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE_KEY = 'overture-country-sources/PT/1ea48e22-9b0d-47a2-beb7-29f5203bc204.csv'
INVENTORY = os.path.join(ROOT, 'outputs', 'overture-generic-shopping-inventory.tsv')
OVERRIDES = os.path.join(ROOT, 'cloudflare', 'src', 'overtureCandidateOverrides.json')
MAX_IDS_PER_QUERY = 200
MAX_DELTA_DEGREES = 0.0003


def normalize(value):
    value = unicodedata.normalize('NFD', value or '')
    return ''.join(char for char in value.casefold() if unicodedata.category(char) != 'Mn').strip()


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


def reviewed_ids(overrides_path=OVERRIDES, source_key=SOURCE_KEY):
    with open(overrides_path) as handle:
        batches = json.load(handle).get(source_key, {})
    return {poi_id for batch in batches.values() for poi_id in batch}


def unresolved_ids(inventory_path=INVENTORY, overrides_path=OVERRIDES, source_key=SOURCE_KEY):
    reviewed = reviewed_ids(overrides_path, source_key)
    with open(inventory_path, newline='') as handle:
        return [row['overture_id'] for row in csv.DictReader(handle, delimiter='\t')
                if row['overture_id'] not in reviewed]


def query_for_ids(ids, source_key=SOURCE_KEY):
    """Return an exact-ID-only legacy corroboration query.

    ``lower`` is intentionally a prefilter.  Python normalizes the returned
    names again before accepting evidence, so SQLite's accent handling cannot
    broaden a match.
    """
    values = ','.join(sql_string(identifier) for identifier in ids)
    source = sql_string(source_key)
    delta = MAX_DELTA_DEGREES
    return f"""
SELECT c.overture_id, c.name AS overture_name, c.lat AS overture_lat,
       c.lng AS overture_lng, 'foursquare' AS legacy_source,
       p.fsq_place_id AS legacy_id, p.name AS legacy_name,
       p.primary_poi_type AS legacy_type, p.lat AS legacy_lat, p.lng AS legacy_lng
FROM overture_candidate c JOIN poi p
  ON lower(c.name) = lower(p.name)
 AND abs(c.lat - p.lat) <= {delta} AND abs(c.lng - p.lng) <= {delta}
WHERE c.country_source_r2_key = {source} AND c.overture_id IN ({values})
UNION ALL
SELECT c.overture_id, c.name AS overture_name, c.lat AS overture_lat,
       c.lng AS overture_lng, 'osm' AS legacy_source,
       p.osm_element_id AS legacy_id, p.name AS legacy_name,
       p.primary_poi_type AS legacy_type, p.lat AS legacy_lat, p.lng AS legacy_lng
FROM overture_candidate c JOIN osm_poi p
  ON lower(c.name) = lower(p.name)
 AND abs(c.lat - p.lat) <= {delta} AND abs(c.lng - p.lng) <= {delta}
WHERE c.country_source_r2_key = {source} AND c.overture_id IN ({values})
ORDER BY overture_id, legacy_source, legacy_id;
""".strip()


def parse_wrangler_output(stdout):
    start, end = stdout.find('['), stdout.rfind(']')
    if start < 0 or end < start:
        raise ValueError('Wrangler returned no JSON result')
    payload = json.loads(stdout[start:end + 1])
    return payload[0].get('results', [])


def corroborated(rows):
    return [row for row in rows
            if normalize(row['overture_name']) == normalize(row['legacy_name'])]


def collect(ids, runner):
    evidence = []
    for start in range(0, len(ids), MAX_IDS_PER_QUERY):
        evidence.extend(corroborated(runner(query_for_ids(ids[start:start + MAX_IDS_PER_QUERY]))))
    return evidence


def wrangler_runner(sql):
    completed = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'brush-poi-registry', '--remote', '--command', sql],
        cwd=os.path.join(ROOT, 'cloudflare'), text=True, capture_output=True)
    if completed.returncode:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip())
    return parse_wrangler_output(completed.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', default=INVENTORY)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    evidence = collect(unresolved_ids(args.inventory), wrangler_runner)
    with open(args.out, 'w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=(
            'overture_id', 'overture_name', 'legacy_source', 'legacy_id',
            'legacy_name', 'legacy_type', 'overture_lat', 'overture_lng',
            'legacy_lat', 'legacy_lng'), delimiter='\t')
        writer.writeheader()
        writer.writerows(evidence)
    print(f'{len(evidence)} corroborated legacy rows -> {args.out}')


if __name__ == '__main__':
    main()
