"""Build a grouped local review queue for Portugal's generic-shopping tail.

This deliberately reads the immutable local audit rather than D1.  It is an
operator aid: no row is promoted or rejected here.  Decisions remain explicit
IDs in overtureCandidateOverrides.json after the group has been reviewed.
"""
import csv
import json
import os
import re
from collections import defaultdict


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE_KEY = 'overture-country-sources/PT/1ea48e22-9b0d-47a2-beb7-29f5203bc204.csv'
INVENTORY = os.path.join(ROOT, 'outputs', 'overture-generic-shopping-inventory.tsv')
OVERRIDES = os.path.join(ROOT, 'cloudflare', 'src', 'overtureCandidateOverrides.json')
OUTPUT = os.path.join(ROOT, 'outputs', 'overture-generic-shopping-review-queue.tsv')


# First match wins.  Specific customer-facing phrases precede broad vocabulary
# so `têxteis lar` is home rather than clothing and manufacturers stay out.
RULES = (
    ('exclude', 'professional_service', 'legal', r'\b(advogad[oa]s?|advocacia)\b'),
    ('exclude', 'professional_service', 'accounting', r'\b(contabil(?:idade|ista|istas)?)\b'),
    ('exclude', 'professional_service', 'consulting', r'\b(consultoria|consultores?)\b'),
    ('exclude', 'professional_service', 'real_estate', r'\b(imobili[aá]ria)\b'),
    ('exclude', 'trade_only', 'wholesale', r'\b(grossista|importa[cç][aã]o|exporta[cç][aã]o|distribui[cç][aã]o|representa[cç][aã]o)\b'),
    ('exclude', 'industrial_supplier', 'industrial_equipment', r'\b(equipamentos? industriais?|materiais? industriais?)\b'),
    ('promote', 'home', 'textiles_home', r'\b(t[eê]xteis? lar)\b'),
    ('promote', 'home', 'home_goods', r'\b(artigos para o lar|bazar|colchoaria|utilidades|home)\b'),
    ('promote', 'home', 'decoration', r'\b(decora[cç][aã]o)\b'),
    ('promote', 'hardware', 'drogaria', r'\b(drogaria)\b'),
    ('promote', 'hardware', 'paint', r'\b(tintas)\b'),
    ('promote', 'hardware', 'construction_materials', r'\b(materiais? de constru[cç][aã]o)\b'),
    ('promote', 'electronics', 'computing', r'\b(inform[aá]tica|computadores?)\b'),
    ('promote', 'electronics', 'electronics', r'\b(electr[oó]nica|eletr[oó]nica)\b'),
    ('promote', 'clothing', 'fashion', r'\b(modas?|boutique|confec[cç][oõ]es|vestu[aá]rio)\b'),
    ('review', 'food_retail', 'mini_market', r'\b(mini[ -]?(mercado|market))\b'),
    ('review', 'food_retail', 'produce', r'\b(mercearia|frutaria)\b'),
    ('review', 'food_retail', 'specialist_food', r'\b(peixaria|talho)\b'),
)


def normalized(value):
    return ' '.join((value or '').casefold().split())


def classified(name):
    text = normalized(name)
    for action, group, phrase, pattern in RULES:
        if re.search(pattern, text):
            return action, group, phrase
    return 'hold', 'unmatched', 'unmatched'


def reviewed_ids():
    with open(OVERRIDES) as handle:
        batches = json.load(handle).get(SOURCE_KEY, {})
    return {poi_id for batch in batches.values() for poi_id in batch}


def run():
    reviewed = reviewed_ids()
    groups = defaultdict(list)
    with open(INVENTORY, newline='') as handle:
        for row in csv.DictReader(handle, delimiter='\t'):
            if row['overture_id'] in reviewed:
                continue
            action, group, phrase = classified(row['name'])
            groups[(action, group, phrase)].append(row)

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, 'w', newline='') as handle:
        fields = ('action', 'group', 'phrase', 'count', 'representative_names', 'exact_ids')
        writer = csv.DictWriter(handle, fieldnames=fields, delimiter='\t')
        writer.writeheader()
        for (action, group, phrase), rows in sorted(groups.items(), key=lambda item: (-len(item[1]), item[0])):
            writer.writerow({
                'action': action,
                'group': group,
                'phrase': phrase,
                'count': len(rows),
                'representative_names': ' | '.join(row['name'] for row in rows[:8]),
                'exact_ids': ','.join(row['overture_id'] for row in rows),
            })
    print(f'{len(groups)} groups, {sum(map(len, groups.values()))} residual rows -> {OUTPUT}')


if __name__ == '__main__':
    run()
