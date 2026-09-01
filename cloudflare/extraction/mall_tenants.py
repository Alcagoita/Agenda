"""
KAN-435. Compare a shopping centre's published tenant list against what we
hold inside its footprint, and produce three lists a person can act on.

WHY A SEPARATE MATCHER

The KAN-388 matcher (`name_similarity`, `single_identity_token_match`) is
the right basis and is reused here. What it does not know is that a venue
inside a mall carries the mall, the city and the floor in its own name:

    tenant list  AMORINO - GELATO AL NATURALE
    we hold      Amorino Gelato - Lisboa Vasco Da Gama

None of "Lisboa", "Vasco", "Gama" identifies the tenant, and leaving them in
costs real recall — measured at 41% before stripping them and 51% after, on
the same rows. So the mall's own name is stripped before comparing, per
mall, from the mall record rather than a hardcoded list.

THREE LISTS, NEVER TWO

  REMOVE    we hold it, the operator does not list it
  ADD       the operator lists it, OSM has it, we do not
  ESCALATE  too close to call, in either direction

The third is the point. Measured on Vasco da Gama, single-token matching
paired `FEEL RIO` with "Ambientes do Rio | Lisbon" and `LAS MUNS` with "La
Casa de las Carcasas" — both false, both would have been acted on. Loosen
the matcher and it invents matches; tighten it and it drops real ones
(AMORINO above). There is no threshold that gets both, so the uncertain
middle goes to a person.

**Prefer missing a place over holding it twice.** A gap is invisible; a
duplicate shows the same shop twice in Nearby and makes the app look broken.
So anything short of a confident match becomes ESCALATE, never a silent ADD.

This module DECIDES NOTHING and WRITES NOTHING. It reads, compares, and
prints. Applying the result is a separate, reviewed step.
"""
import argparse
import json
import os
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classify_and_load import normalize_text
from supplement_osm_pois import name_similarity

# Above this, two names are the same tenant. Below ESCALATE_THRESHOLD they
# are unrelated. Between the two, a person decides.
#
# 0.86 rather than a rounder number because `name_similarity` returns
# exactly 0.9 for its two structural cases (one name contained in the other,
# and normalized identity terms matching), and those should land as
# confident. Anything relying on raw SequenceMatcher ratio is softer
# evidence and belongs in the middle.
CONFIDENT_THRESHOLD = 0.86
# 0.55 was tried and produced 21 escalations for one mall, of which most
# were noise — `NOORI POTS` against "Sacoor Brothers", `O FORNO DO LEITAO DO
# ZE` against "Amorino Gelato". An escalation list a person will not read is
# the same as no escalation list, so the floor sits where the pairs still
# share something a human would recognise.
ESCALATE_THRESHOLD = 0.68

# The destructive direction is more cautious, deliberately.
#
# Missing a place is invisible; retiring a real one is not. So a row we hold
# escalates on weaker evidence than a tenant does — at 0.68 this still
# proposed removing "H3 Hamburguer Gourmet" (listed as "H3 - NEW
# HAMBURGOLOGY") and "SushiCorner" (listed as "SUSHI CORNER BY SUSHI CAFE").
# Both are real tenants. Neither should be decided by a threshold.
REMOVE_ESCALATE_THRESHOLD = 0.55

# A word this long is distinctive enough that two names sharing it are worth
# a human look before either is retired. Five characters keeps out `caffe`,
# `cafe`, `loja` and the other category words already in GENERIC_TOKENS,
# while catching `bertrand` — "Livraria Bertrand" against the listed
# "BERTRAND LIVREIROS" scored below every threshold and is the same shop.
DISTINCTIVE_TOKEN_LENGTH = 5

# A TENANT LIST IS AN AUTHORITY ONLY OVER WHAT IT COVERS.
#
# The two lists transcribed for this ticket are the operators' EATING PLACES
# pages — 68 and 65 names. Vasco da Gama has around 145 shops besides.
# Comparing the whole footprint against a food-only list proposed removing
# 91 rows: every clothing shop, Fnac, Worten and the pharmacy.
#
# So REMOVE is confined to the types the list is about. A list that covers
# the whole centre can pass a wider set, or none at all to mean everything.
FOOD_TYPES = frozenset({
    'restaurant', 'cafe', 'bar', 'bakery', 'ice_cream', 'juice', 'tea',
    'brewery', 'winery',
})

# Words that never identify a tenant. Floor markers, the city, and the
# corporate suffixes Portuguese registrations carry.
GENERIC_TOKENS = frozenset({
    'lisboa', 'lisbon', 'piso', 'loja', 'quiosque', 'kiosk', 'store',
    'portugal', 'lda', 'sa', 'unipessoal', 'the', 'by', 'de', 'da', 'do',
    'das', 'dos', 'e', 'a', 'o', 'as', 'os', 'em', 'no', 'na',
})


def strip_accents(value: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFKD', value or '')
                   if not unicodedata.combining(c))


def read_tenant_list(path):
    """An operator list as (name, floor) pairs, skipping what is not open.

    Format is `Name|Piso N`, with an optional third field. `|opening` marks
    a unit the operator has announced but not opened — five at Vasco da
    Gama. A shop that has not opened is a place that does not exist, so it
    must not be matched or added; the rule was written in decisions.md and
    enforced by hand, which is not enforcement.

    A blank floor (`Name|`) means the operator publishes none.
    """
    tenants = []
    for line in open(path):
        cells = [c.strip() for c in line.rstrip('\n').split('|')]
        name = cells[0].strip()
        if not name:
            continue
        if any(c.lower() == 'opening' for c in cells[2:]):
            continue
        floor = cells[1] if len(cells) > 1 else ''
        tenants.append((name, floor))
    return tenants


def confirmed_pairs(path=None, mall_name=None):
    """Pairs a person has already ruled the same shop.

    `compare` has no memory: it re-derives every match from scratch, so a
    pair scoring below the confident bar comes back as an open question
    however many times it has been answered. `5 À SEC` against `5àSec` was
    asked three times across three malls before this existed.

    Read from mall_lists/decisions.md — the table rows under "Confirmed
    matches", which is the file a reviewer actually maintains. Parsing the
    document rather than a second machine-readable copy keeps one source of
    truth; a drifting copy would be worse than none.

    Scoped by the table's third column. A ruling is about the shops in one
    centre, not a fact about the names: `LEROY MERLIN` is `AKI` rebranded at
    Colombo, and applying that anywhere else would merge two real shops that
    happen to share a chain. Pass `mall_name` to get only the rulings given
    for that centre plus the ones marked `both`; omit it to get all of them.
    """
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            'mall_lists', 'decisions.md')
    if not os.path.exists(path):
        return {}
    pairs, in_section = {}, False
    for line in open(path):
        if line.startswith('## '):
            in_section = line.strip().startswith('## Confirmed matches')
            continue
        if not in_section or not line.startswith('|'):
            continue
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) < 2 or cells[0].startswith('---') or cells[0] == 'operator directory':
            continue
        tenant, holding = cells[0].strip('`'), cells[1].strip('`')
        if not (tenant and holding):
            continue
        where = cells[2].lower() if len(cells) > 2 else ''
        if mall_name is not None and where and 'both' not in where:
            # The mall column names the centre in prose ("Colombo — rebrand,
            # renamed"), so match on the centre's own tokens rather than on
            # the cell reading as a bare name.
            if not (mall_tokens(mall_name) & set(normalize_text(where).split())):
                continue
        pairs.setdefault(normalize_text(tenant), set()).add(normalize_text(holding))
    return pairs


def mall_tokens(mall_name: str) -> frozenset:
    """The mall's own name, as tokens to remove from its tenants' names.

    Taken from the mall record rather than hardcoded, so adding a centre
    needs no code change. "Centro Comercial Colombo" contributes `centro`,
    `comercial` and `colombo` — and a tenant genuinely called Colombo would
    be indistinguishable from the mall anyway, which is a reason to escalate
    it rather than to keep the token.
    """
    return frozenset(normalize_text(strip_accents(mall_name)).split())


def tenant_key(name: str, mall: frozenset) -> str:
    """A tenant name reduced to what actually identifies it."""
    tokens = normalize_text(strip_accents(name)).split()
    # Single LETTERS go — `normalize_text` turns "McDonald's" into
    # "mcdonald s" and an initial in "Papelaria C. Roque" into "c", and
    # neither identifies anything (KAN-388).
    #
    # Single DIGITS stay, because in a mall they are frequently the whole
    # identity. "CAFÉ 3" reduced to `cafe`, which is contained in "Nosso
    # Café" — scoring 0.90 and confidently taking that unit's floor, which
    # is on a different level of Colombo.
    kept = [t for t in tokens
            if t not in mall and t not in GENERIC_TOKENS
            and (len(t) > 1 or t.isdigit())]
    # Everything was noise — fall back to the full normalized name rather
    # than an empty key, which would match every other empty key.
    return ' '.join(kept) if kept else ' '.join(tokens)


def best_match(target: str, candidates, mall: frozenset, key=lambda r: r['name']):
    """(candidate, score) for the closest candidate, or (None, 0.0)."""
    target_key = tenant_key(target, mall)
    best, best_score = None, 0.0
    for candidate in candidates:
        candidate_key = tenant_key(key(candidate), mall)
        score = name_similarity(target_key, candidate_key)
        # Run-together brand names are the same name: "SushiCorner" is
        # "Sushi Corner". Compare with spaces removed too, and keep the
        # better of the two — the length guard stops short fragments from
        # swallowing longer names.
        left, right = target_key.replace(' ', ''), candidate_key.replace(' ', '')
        if left and right and min(len(left), len(right)) >= 6:
            if left == right or left in right or right in left:
                score = max(score, 0.9)
        # Word order is not identity either. "Jeronymo Cafe" is "Cafe
        # Jeronymo" — we already held it in Colombo while the tenant list
        # was proposing to ADD it, which is the duplicate this ticket exists
        # to prevent. Compare the token sets, requiring the SAME set rather
        # than an overlap so "Cafe 3" still cannot become "Nosso Cafe".
        left_tokens, right_tokens = set(target_key.split()), set(candidate_key.split())
        if left_tokens and left_tokens == right_tokens:
            score = max(score, 0.95)
        if score > best_score:
            best, best_score = candidate, score
    return best, best_score


def _claim_held(claimed, row_name, tenant, confident, escalate, score):
    """Record `tenant` as the owner of `row_name`, or escalate the clash.

    Returns True when the claim stands. On a second claim the earlier
    confident pairing is withdrawn — it was never more trustworthy than the
    one now contesting it — and both units go to a person, because the row
    we hold may be either of them or a duplicate of one.
    """
    previous = claimed.get(row_name)
    if previous is None:
        claimed[row_name] = tenant
        confident.append((tenant, row_name, score))
        return True
    if previous == tenant:
        return True
    confident[:] = [c for c in confident if not (c[0] == previous and c[1] == row_name)]
    escalate.append(('two tenants, one held row',
                     f'{previous} / {tenant}', row_name, score))
    return True


def compare(tenants, held, osm, mall_name, covers=FOOD_TYPES):
    """The three lists, plus the confident pairings for reporting.

    `held` is what we serve inside the footprint; `osm` is what OSM has
    there. Neither is modified.

    `covers` is the set of poi types the tenant list speaks for. Only those
    rows are eligible for REMOVE — a food list says nothing about a shoe
    shop, and treating its silence as a verdict would retire the whole
    centre. Pass None to mean the list covers everything.
    """
    mall = mall_tokens(mall_name)
    matched_held, confident, escalate, add = set(), [], [], []
    claimed_osm = {}
    # One held row cannot be two tenants, for the same reason one OSM
    # element cannot: the directory lists a chain twice and both entries
    # match our single row, so the second silently takes a floor belonging
    # to the first. Neither is safe to pick, so both go to a person.
    claimed_held = {}
    ruled = confirmed_pairs(mall_name=mall_name)

    for tenant in tenants:
        # A ruling already given is not a question. Take it before scoring.
        known = ruled.get(normalize_text(tenant))
        if known:
            hit = next((r for r in held if normalize_text(r['name']) in known), None)
            if hit is not None:
                if _claim_held(claimed_held, hit['name'], tenant,
                               confident, escalate, 1.0):
                    matched_held.add(hit['name'])
                continue
        row, score = best_match(tenant, held, mall)
        if score >= CONFIDENT_THRESHOLD:
            if _claim_held(claimed_held, row['name'], tenant,
                           confident, escalate, score):
                matched_held.add(row['name'])
            continue
        if score >= ESCALATE_THRESHOLD:
            escalate.append(('tenant vs held', tenant, row['name'], score))
            matched_held.add(row['name'])   # do not also propose removing it
            continue
        # We do not hold it. Can OSM place it?
        osm_row, osm_score = best_match(tenant, osm, mall)
        if osm_score >= CONFIDENT_THRESHOLD:
            # One OSM element cannot be two tenants. "NOORI LAB" and "NOORI
            # POTS" are separate units that both resolve to a single element
            # named "Noori"; adding both would place the same point twice.
            # Neither is safe to pick automatically, so both go to a person.
            claimed_by = claimed_osm.get(id(osm_row))
            if claimed_by is not None:
                escalate.append(('two tenants, one OSM element',
                                 f'{claimed_by} / {tenant}', osm_row['name'],
                                 osm_score))
                add[:] = [(t, r) for t, r in add if t != claimed_by]
                continue
            claimed_osm[id(osm_row)] = tenant
            add.append((tenant, osm_row))
        elif osm_score >= ESCALATE_THRESHOLD:
            escalate.append(('tenant vs OSM', tenant, osm_row['name'], osm_score))
        else:
            add.append((tenant, None))      # nobody can place it

    # EVERY PROPOSED REMOVAL IS CHECKED THE OTHER WAY ROUND FIRST.
    #
    # Matching tenant -> best held row assigns each tenant ONE row, so a
    # second row belonging to the same tenant is left unclaimed and falls
    # into REMOVE. Measured on Colombo, that proposed retiring "Burger King
    # Centro Comercial Colombo", "H3 Hamburguer Gourmet", "SushiCorner",
    # "Cervejaria Portugalia", "Cafe3" and "Vitaminas & Companhia" — every
    # one of them on the operator's own list.
    #
    # Removal is the destructive direction, so it gets the second look: a
    # row that confidently matches ANY tenant is kept, and one that half
    # matches is escalated rather than retired.
    remove = []
    for row in held:
        if row['name'] in matched_held:
            continue
        if covers is not None and row.get('primary_poi_type') not in covers:
            continue
        tenant, score = best_match(row['name'], [{'name': t} for t in tenants],
                                   mall)
        if score >= CONFIDENT_THRESHOLD:
            confident.append((tenant['name'], row['name'], score))
            continue
        if score >= REMOVE_ESCALATE_THRESHOLD:
            escalate.append(('held vs tenant', row['name'], tenant['name'], score))
            continue
        # A shared DISTINCTIVE word is enough to stop a removal, even when
        # the similarity score is low. "Livraria Bertrand" against the
        # listed "BERTRAND LIVREIROS" scored under the floor because only
        # one of two words matches — and it is the same bookshop.
        #
        # Only for removals: a shared word is weak evidence, too weak to
        # merge two places on, but retiring a real shop is the worse error.
        row_core = {t for t in tenant_key(row['name'], mall).split()
                    if len(t) >= DISTINCTIVE_TOKEN_LENGTH}
        shares_a_word = False
        for candidate in tenants:
            shared = row_core & {t for t in tenant_key(candidate, mall).split()
                                 if len(t) >= DISTINCTIVE_TOKEN_LENGTH}
            if shared:
                escalate.append(('held vs tenant, shared word ' + '/'.join(sorted(shared)),
                                 row['name'], candidate, score))
                shares_a_word = True
                break
        if shares_a_word:
            continue
        remove.append(row)
    return {'confident': confident, 'escalate': escalate,
            'add': add, 'remove': remove}


def report(result, tenants, mall_name, handle=sys.stdout):
    n = len(tenants)
    confident, escalate = result['confident'], result['escalate']
    placeable = [t for t, row in result['add'] if row is not None]
    unplaceable = [t for t, row in result['add'] if row is None]

    print(f'\n===== {mall_name} — {n} tenants on the operator list =====\n',
          file=handle)
    print(f'  held and confidently matched : {len(confident)}', file=handle)
    print(f'  ESCALATE (a person decides)  : {len(escalate)}', file=handle)
    print(f'  ADD from OSM                 : {len(placeable)}', file=handle)
    print(f'  on the list, no source has it: {len(unplaceable)}', file=handle)
    print(f'  REMOVE (held, not listed)    : {len(result["remove"])}'
          '   [only types the list covers]', file=handle)

    if escalate:
        print('\n  --- ESCALATE: too close to call, nothing done ---', file=handle)
        for kind, tenant, other, score in sorted(escalate, key=lambda e: -e[3]):
            print(f'    [{score:.2f}] {kind:<14} {tenant}\n'
                  f'{"":>26} {other}', file=handle)
    if placeable:
        print('\n  --- ADD: listed, OSM can place it, we lack it ---', file=handle)
        for tenant, row in result['add']:
            if row is not None:
                print(f'    {tenant}\n{"":>6}-> OSM: {row["name"]}', file=handle)
    if unplaceable:
        print('\n  --- listed but no source can place it (no coordinates) ---',
              file=handle)
        for tenant in unplaceable:
            print(f'    {tenant}', file=handle)
    if result['remove']:
        print('\n  --- REMOVE: we hold it, the operator does not list it ---',
              file=handle)
        for row in sorted(result['remove'], key=lambda r: r['name']):
            print(f'    {row["name"]}  [{row.get("primary_poi_type","?")}]',
                  file=handle)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tenants', required=True, help='JSON list of names')
    parser.add_argument('--held', required=True, help='JSON rows we serve')
    parser.add_argument('--osm', required=True, help='JSON rows from OSM')
    parser.add_argument('--mall', required=True, help='the centre\'s own name')
    parser.add_argument('--covers', default='food',
                        choices=('food', 'all'),
                        help='what the tenant list is an authority over')
    args = parser.parse_args(argv)

    tenants = [t for t in json.load(open(args.tenants)) if t.strip()]
    held = json.load(open(args.held))
    osm = json.load(open(args.osm))
    covers = FOOD_TYPES if args.covers == 'food' else None
    report(compare(tenants, held, osm, args.mall, covers), tenants, args.mall)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
