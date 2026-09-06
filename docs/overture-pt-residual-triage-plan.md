# Portugal Overture residual-store triage

## Problem

The generic-shopping audit has 4,712 remaining rows after all reviewed
promotions and exclusions. That is an audit failure, not credible evidence
that thousands of Portuguese businesses have no usable type: it tokenizes
names into isolated words and therefore loses chains and meaningful phrases.

The first full-name pass already finds overlapping candidate pools: 96 home
and household names, 86 hardware-like names, 78 clothing/textile names, 46
food-retail names, 23 electronics names, and 22 likely trade/professional
exclusions. These are leads, not batch counts: `têxteis lar`, for example,
must not be both clothing and home.

## Operating rule

Every decision remains source-scoped and exact-ID bounded. Never run a
country-wide `promotion_status = 'pending'` query to process a small batch.
Do not turn a weak word match into a product decision.

## Pipeline

### 1. Produce a phrase-and-chain review queue

Regenerate the local audit from the immutable PT source, excluding every ID
already present in `overtureCandidateOverrides.json`. For each remaining row,
derive, in priority order:

1. a known chain/brand cluster;
2. a normalized two-to-four-word retail phrase;
3. an exclusion phrase;
4. an unmatched residual bucket.

The queue must report: proposed action, candidate subtype or exclusion reason,
confidence, group count, representative names, exact IDs, locality, and the
source evidence used. It must be sorted by `confidence DESC, group_count DESC`.

### 2. Drain high-confidence retail groups

Start with explicit, customer-facing phrases where the product type is clear:

| Group | Initial evidence | Action |
| --- | --- | --- |
| Mini Mercado, minimarket, mercearia, frutaria | food retail | review for supermarket vs. butcher/fishmonger |
| Drogaria, ferragens, tintas | hardware retail | promote `store/hardware` where retail-facing |
| Bazar, artigos para o lar, decoração, têxteis lar | household retail | promote `store/home` |
| Moda, boutique, confecções | clothing retail | promote `store/clothing` |
| Informática, electrónica, fotografia | electronics retail | promote `store/electronics` |

Resolve overlaps with ordered rules, not multiple types: `têxteis lar` is
`home`; `indústria de confecções` is an exclusion candidate, not clothing.

### 3. Drain clear exclusions

Create reviewed rejection batches for businesses whose names explicitly show
they are not visitor-facing errands: wholesale, import/export, distribution,
manufacturing, industrial equipment, legal, accounting, consultancy, and real
estate. A factory, warehouse, construction-materials business, or wine name
is never bulk-rejected on one word alone; it needs the full-name evidence or
the legacy-source check below.

### 4. Resolve the ambiguous tail with legacy evidence

For every group still ambiguous after name clustering, match its exact IDs to
the preserved Foursquare/OSM backups using normalized name and a tight
coordinate threshold. Promote or reject only when old type and name evidence
agree. Put no-match and disagreement rows in a separate manual-review queue.

## Batch cadence and targets

1. Build the complete review queue locally.
2. Review the top 50 groups by affected rows; each must be labelled promote,
   reject, evidence-needed, or hold.
3. Apply consolidated exact-ID batches, grouped by subtype/decision.
4. Verify each batch using its exact IDs only.
5. Repeat until the residual is under 500; then manually review the remaining
   groups rather than creating broad rules.

The first target is a 50% reduction: at least 2,350 rows classified or
excluded through reviewed groups. The queue, rather than a national D1 scan,
is the progress tracker.
