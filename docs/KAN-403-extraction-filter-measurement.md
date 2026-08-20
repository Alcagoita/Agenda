# KAN-403 — What the extraction filter rejects (PT)

Measurement only. No pipeline change, no re-extraction, no new POI types —
those are KAN-404, KAN-396, KAN-400 and KAN-397, and this file is the evidence
they should be decided on.

## Provenance

| | |
|---|---|
| Source | Foursquare OS Places, `places.datasets.places_os` via the Iceberg REST catalog (`catalog.h3-hub.foursquare.com/iceberg`) |
| Dataset build | max `date_refreshed` / `date_created` for PT = **2026-08-10** |
| Run (UTC) | 2026-08-20 00:08 |
| Scope | `country = 'PT' AND date_closed IS NULL` |
| Filter measured | the 111 category ids `category_ids.py` generates from `poiTypeCategories.json` (90 ids) + `storeSubtypeCategories.json` (13) + `foodSubtypeCategories.json` (10) |
| Taxonomy size | 1,279 categories in `categories_os` |
| Tooling | `cloudflare/extraction/measure_rejected_categories.py`, DuckDB 1.5.5 |

Reproduce:

```bash
export FOURSQUARE_JWT='<datahub JWT — see cloudflare/README.md>'
python3 cloudflare/extraction/measure_rejected_categories.py PT
```

The filter is read from the mapping files at run time, so re-running this after
a mapping change measures the *new* filter, not the one measured here. The 111
ids already include Tattoo Parlor (KAN-402).

## Headline numbers

| | rows | share of open PT places |
|---|---:|---:|
| Open places in PT | 396,749 | 100% |
| Kept by the 111-id filter | 180,699 | 45.5% |
| **Rejected by the filter** | **188,438** | **47.5%** |
| Carry no category at all | 27,612 | 7.0% |

The three lower rows sum exactly to the total. The uncategorised 27,612 sit
outside both filter counts, because `list_has_any` returns NULL — not false —
on a NULL `fsq_category_ids`, so neither the filter's predicate nor its
negation is true for them. They are dropped by the extraction too; they are
just not lost *to the allowlist*, and no category widening can recover them.

Of the rows the filter actually judged, **51.0% were rejected** (188,438 of
369,137). Every one of them carries at least one category — this is purely a
taxonomy-coverage problem, not a data-quality one.

**870 distinct categories** appear on rejected rows — out of 1,279 in the whole
taxonomy. The tail is long: adding the top N unmapped categories would recover

| top N categories added | rejected rows recovered | % of rejected |
|---:|---:|---:|
| 10 | 49,173 | 26% |
| 20 | 70,507 | 37% |
| 50 | 110,309 | 59% |
| 100 | 140,993 | 75% |
| 200 | 165,783 | 88% |

## The surprising part: a third of the loss is *under* categories we already map

`list_has_any` matches category ids exactly. It does not descend the taxonomy.
So a place tagged with a **child** of a category we mapped is rejected as if we
had never heard of it.

- 533 categories in the 1,279-row taxonomy are unmapped descendants of a category already in our filter.
- **58,494 rejected PT rows (31% of all rejections) carry at least one such descendant.**

The clearest case: we map `Gym and Studio` (`4bf58dd8d48988d175941735`) for both
`gym` and `fitness_center`. Foursquare's `Sports and Recreation > Gym and Studio > Gym`
is a *different id* — **1,029 PT rows rejected**. The app has a Gym POI type, a
Gym brand requirement (KAN-364), and no gyms that Foursquare filed one level down.

This is the same failure mode as KAN-402's tattoo studios, and it is structural.
It means KAN-404's policy question is not only "which new categories do we want"
but "does the filter expand mapped categories to their descendants" — the second
recovers 58k PT rows without a single new POI type decision.

## Errand-relevant near misses

Categories high in the rejected ranking that map onto errands the app already
understands. Counts are rejected PT rows carrying that category.

| category | rejected rows | note |
|---|---:|---|
| Health and Medicine > Medical Center | 5,385 | we map Hospital, Doctor's Office, Medical Lab — not this |
| Retail > Food and Beverage Retail | 2,153 | parent of Butcher / Fish Market below |
| Dining and Drinking > Restaurant > Pizzeria | 2,117 | Restaurant + 7 cuisines mapped; the rest of the cuisine tree is not (KAN-344) |
| Dining and Drinking > Restaurant > BBQ Joint | 1,746 | same |
| Travel and Transportation > Lodging > Bed and Breakfast | 1,634 | we map Hotel only |
| Travel and Transportation > Lodging > Vacation Rental | 1,498 | same |
| Travel and Transportation > Lodging > Hostel | 1,461 | same |
| Retail > Drugstore | 1,478 | we map Pharmacy; in PT these are largely the same errand |
| Retail > Textiles Store | 1,477 | Store subtype candidate (KAN-368) |
| Business and Professional Services > Repair Service | 1,471 | we map Automotive Repair Shop only |
| Business and Professional Services > Health and Beauty Service | 1,459 | parent of the four hair/beauty errands split in KAN-401 |
| Dining and Drinking > Restaurant > Seafood Restaurant | 1,399 | cuisine tree |
| Sports and Recreation > Gym and Studio > Gym | 1,029 | see above |
| **Retail > Food and Beverage Retail > Butcher** | **1,077** | **direct evidence for KAN-396** |
| **Retail > Food and Beverage Retail > Fish Market** | **487** | **direct evidence for KAN-396** |
| Retail > Eyecare Store | 1,051 | optician errand, no POI type today |
| Business and Professional Services > Laundromat | 514 | errand-shaped, no POI type |
| Business and Professional Services > Health and Beauty Service > Barbershop | 270 | descendant of the KAN-401 split |
| Business and Professional Services > Shoe Repair Service | 149 | errand-shaped |
| Business and Professional Services > Health and Beauty Service > Dry Cleaner | 139 | errand-shaped |

KAN-396's butcher/fishmonger keep list is confirmed by volume: 1,077 and 487
rejected PT rows respectively, all of which the pipeline has been discarding.

## The other surprise: most of the top of the list is not errands at all

The single largest rejected categories are things the app must never surface:

`Business and Professional Services` (11,589) · `Retail > Construction Supplies Store` (6,829) ·
`Office` (6,297) · `Education` (4,973) · `Apartment or Condo` (3,947) ·
`Financial Service` (3,606) · `Legal Service` (3,560) · `Road` (3,509) ·
`Structure` (3,193) · `Factory` (2,802) · `Advertising Agency` (2,543) ·
`Housing Development` (1,969) · `Neighborhood` (1,856) · `City` (1,786)

Roads, structures, neighbourhoods, cities and housing developments are
geography, not places you run an errand at. Bare level-1 categories
(`Business and Professional Services`, `Arts and Entertainment`,
`Travel and Transportation`, `Sports and Recreation`) are places Foursquare
could not classify further.

So the filter is not simply too narrow — it is rejecting a lot that should stay
rejected. **KAN-404 cannot be resolved with a volume threshold.** "Add every
category above N rejected rows" would import 11,589 unclassified businesses and
3,509 roads before it reached the butchers. The two defensible policies the
numbers support are (a) expand mapped categories to their descendants — 58,494
rows, zero new type decisions — and (b) hand-pick from the ranked list below.

**KAN-404 has since gone further than either.** Both (a) and (b) are still
allowlists, and an allowlist cannot recover a venue Foursquare typed *wrongly* —
it lands in whatever subtree its wrong type belongs to. The decision there is to
stop filtering at extraction entirely and stage the rejected rows in a
`poi_candidate` table. The measurement below is unaffected; only the conclusion
drawn from it changed.

**And the threshold fails in the other direction too.** Volume is not a reason to
*exclude* either. `Restaurant > Australian Restaurant` has 8 rejected PT rows and
`Bar > Tiki Bar` has 8, but a place the user can walk into is worth surfacing
whether there are 8 of them or 8,000 — the count says how rare the cuisine is,
not whether the venue is an errand. Both are descendants of categories we already
map (`Restaurant` `4d4b7105d754a06374d81259`, `Bar` `4bf58dd8d48988d116941735`),
so **inheriting the nearest mapped ancestor gives them a type with no per-cuisine
decision at all**: Australian Restaurant becomes `restaurant`, Tiki Bar becomes
`bar`. That is what the 58,494-row descendant finding buys. A named cuisine
subtype on top of that is a separate, optional question — KAN-344's label-segment
grouping is the mechanism, and an 8-row cuisine does not earn its own group while
still appearing in the app as a restaurant.

Conversely, a junk parent does not make its children junk.
`Business and Professional Services > Lottery Retailer` (12 rows) sits under the
same bare parent listed above as non-errand, and it is a real errand: buying a
ticket needs no particular branch, exactly like an ATM. Judge the leaf, not the
subtree it hangs from.

## The Business and Professional Services subtree, measured

The section above names the bare `Business and Professional Services` parent as
non-errand, which is true of the parent and **misleading about the subtree**.
That parent is one category of 173:

| | categories | rejected rows |
|---|---:|---:|
| Bare `Business and Professional Services` (no leaf) | 1 | 11,589 |
| Leaves beneath it | 172 | 42,356 |

The leaves carry nearly four times the rows of the bare parent, and the errands
are concentrated in the **tail**: 113 of the 172 leaves have fewer than 100
rejected rows each and 2,720 rows between them. Ranking by volume puts offices,
legal services and advertising agencies on the first screen and buries these:

The 17 most obviously errand-shaped are listed below, but that selection is
itself a hand-picked sample and carries the same bias — **the complete list of
all 172 leaves is in the appendix at the end of this file**, so the keep/drop
decision is made against everything rather than against what one reader noticed.

```
 1,471  52f2ab2ebcbc57f1066b8b2f  Repair Service
   514  52f2ab2ebcbc57f1066b8b33  Laundromat
   356  4f4534884b9074f6e4fb0174  Funeral Home
   282  52f2ab2ebcbc57f1066b8b3c  Health and Beauty Service > Massage Clinic
   270  63be6904847c3692a84b9b49  Health and Beauty Service > Barbershop
   248  5032781d91d4c4b30a586d5b  Tailor
   239  5032897c91d4c4b30a586d69  Pet Service
   229  554a5e17498efabeda6cc559  Photography Service > Photography Studio
   222  4f4532974b9074f6e4fb0104  Child Care Service > Daycare
   220  63be6904847c3692a84b9b35  Computer Repair Service
   149  5ae95d208a6f17002ce792b2  Legal Service > Notary
   149  52f2ab2ebcbc57f1066b8b39  Shoe Repair Service
   139  52f2ab2ebcbc57f1066b8b1d  Health and Beauty Service > Dry Cleaner
    63  4f4531084b9074f6e4fb0101  Recycling Facility
    59  52f2ab2ebcbc57f1066b8b1e  Locksmith
    52  63be6904847c3692a84b9b93  Telecommunication Service
    12  52f2ab2ebcbc57f1066b8b38  Lottery Retailer
```

Every one of those is somewhere a person goes to get a specific thing done, and
`Barbershop` 270 is a straight descendant of the four-way hair split shipped in
KAN-401 — already a supported errand, rejected on an id mismatch.

**The consequence for KAN-404: a subtree may never be excluded wholesale, and a
"known-bad" list may only name bare parents and geography** (Road, Structure,
City, Neighborhood, Housing Development), never a branch of the taxonomy. Any
list derived from the top of a volume ranking will systematically miss the
errands, because errands are long-tail and infrastructure is not.

## Every parent has the same shape

The subtree above is not special. Grouping all 870 rejected categories by their
top-level parent, the long tail is everywhere:

| top-level parent | categories | rejected rows | leaves under 100 rows | rows in that tail |
|---|---:|---:|---:|---:|
| Business and Professional Services | 173 | 53,945 | 113 | 2,720 |
| Dining and Drinking | 173 | 26,968 | 116 | 2,551 |
| Retail | 117 | 34,507 | 64 | 1,744 |
| Community and Government | 95 | 26,385 | 60 | 1,602 |
| Landmarks and Outdoors | 70 | 20,936 | 44 | 1,303 |
| Sports and Recreation | 68 | 6,301 | 57 | 787 |
| Travel and Transportation | 56 | 19,057 | 30 | 1,012 |
| Arts and Entertainment | 56 | 6,436 | 42 | 1,070 |
| Health and Medicine | 46 | 7,452 | 38 | 766 |
| Event | 16 | 348 | 15 | 331 |

**579 of the 870 rejected categories are leaves with fewer than 100 rows each**,
and together they account for roughly 13,900 rows — about 7% of all rejections.
That is the entire cost of keeping the tail, and it is where the errands live:
Locksmith, Lottery Retailer and Telecommunication Service are all in it, as are
the Australian Restaurant and Tiki Bar cases above.

Ranking by volume is useful for seeing *what dominates*. It is actively
misleading for deciding *what to keep*, and no keep/drop list in KAN-400 or
KAN-404 should be built by reading down from the top of it.

## Not measured here: the OSM half

Everything above is Foursquare. The OSM side has the same shape of problem with
different mechanics, and it is **not** measured by this file or its script:
`supplement_osm_pois.py` asks Overpass for four selectors only (`amenity` in a
fixed 15-value list, `office=financial`, `leisure` in two values, and a blanket
`shop`), so whole vocabularies are never requested at all — `tourism=*` most
importantly, which costs us museums, hotels, attractions and guest houses.
`osm_poi` also retains no raw tags, so unlike the Foursquare side this cannot be
measured after the fact from our own data; it needs a fresh Overpass run.

One concrete defect found while checking: `amenity=ice_cream` was added to
`TAG_TYPES` by KAN-399 but never added to the Overpass selector, so those
elements are never fetched — sit-in gelatarias are invisible and only
`shop=ice_cream` arrives.

**KAN-405** owns the measurement and the fix.

## Full ranked list

Verbatim output of `python3 cloudflare/extraction/measure_rejected_categories.py PT`.
A rejected row is counted once per category it carries, so the column sums to
more than 188,438; a row with two unmapped categories is evidence for both. On a
rejected row every category is unmapped by definition — otherwise the row would
have passed `list_has_any`.

```
PT: 396,749 open places total
PT: 180,699 kept by the 111-id filter
PT: 188,438 rejected (47.5% of open places)
PT: 27,612 carry no category at all (outside both counts above — see the comment in measure())
PT: 870 distinct unmapped categories

  rejected  category_id                 category_label
    11,589  4d4b7105d754a06375d81259    Business and Professional Services
     6,829  5454144b498ec1f095bff2f2    Retail > Construction Supplies Store
     6,297  4bf58dd8d48988d124941735    Business and Professional Services > Office
     5,385  4bf58dd8d48988d104941735    Health and Medicine > Medical Center
     4,973  4bf58dd8d48988d13b941735    Community and Government > Education
     3,947  4d954b06a243a5684965b473    Community and Government > Residential Building > Apartment or Condo
     3,606  63be6904847c3692a84b9b3d    Business and Professional Services > Financial Service
     3,560  63be6904847c3692a84b9b6b    Business and Professional Services > Legal Service
     3,509  4bf58dd8d48988d1f9931735    Travel and Transportation > Road
     3,193  4bf58dd8d48988d130941735    Landmarks and Outdoors > Structure
     2,802  4eb1bea83b7b6f98df247e06    Business and Professional Services > Factory
     2,543  52e81612bcbc57f1066b7a3d    Business and Professional Services > Advertising Agency
     2,449  4bf58dd8d48988d1ff941735    Retail > Miscellaneous Store
     2,153  4bf58dd8d48988d1f9941735    Retail > Food and Beverage Retail
     2,117  4bf58dd8d48988d1ca941735    Dining and Drinking > Restaurant > Pizzeria
     2,077  4d4b7104d754a06370d81259    Arts and Entertainment
     2,016  4d4b7105d754a06372d81259    Community and Government > Education > College and University
     1,969  4f2a210c4b9023bd5841ed28    Community and Government > Housing Development
     1,932  4d4b7105d754a06379d81259    Travel and Transportation
     1,924  4bf58dd8d48988d15b941735    Landmarks and Outdoors > Farm
     1,896  4bf58dd8d48988d162941735    Landmarks and Outdoors > Other Great Outdoors
     1,884  5032885091d4c4b30a586d66    Business and Professional Services > Real Estate Service > Real Estate Agency
     1,856  4f2a25ac4b909258e854f55f    Landmarks and Outdoors > States and Municipalities > Neighborhood
     1,786  50aa9e094b90af0d42d5de0d    Landmarks and Outdoors > States and Municipalities > City
     1,746  4bf58dd8d48988d1df931735    Dining and Drinking > Restaurant > BBQ Joint
     1,634  4bf58dd8d48988d1f8931735    Travel and Transportation > Lodging > Bed and Breakfast
     1,507  50328a8e91d4c4b30a586d6c    Community and Government > Organization > Non-Profit Organization
     1,503  4bf58dd8d48988d165941735    Landmarks and Outdoors > Scenic Lookout
     1,498  56aa371be4b08b9a8d5734e1    Travel and Transportation > Lodging > Vacation Rental
     1,478  5745c2e4498e11e7bccabdbd    Retail > Drugstore
     1,477  52f2ab2ebcbc57f1066b8b26    Retail > Textiles Store
     1,471  52f2ab2ebcbc57f1066b8b2f    Business and Professional Services > Repair Service
     1,461  4bf58dd8d48988d1ee931735    Travel and Transportation > Lodging > Hostel
     1,459  54541900498ea6ccd0202697    Business and Professional Services > Health and Beauty Service
     1,399  4bf58dd8d48988d1ce941735    Dining and Drinking > Restaurant > Seafood Restaurant
     1,339  4bf58dd8d48988d1c7941735    Dining and Drinking > Snack Place
     1,277  4bf58dd8d48988d127951735    Retail > Arts and Crafts Store
     1,227  4bf58dd8d48988d125941735    Business and Professional Services > Office > Tech Startup
     1,223  4f04b08c2fb6e1c99f3db0bd    Travel and Transportation > Travel Agency
     1,214  4bf58dd8d48988d174941735    Business and Professional Services > Office > Coworking Space
     1,169  4bf58dd8d48988d1f7931735    Travel and Transportation > Transport Hub > Airport > Plane
     1,135  4cce455aebf7b749d5e191f5    Sports and Recreation > Soccer > Soccer Field
     1,125  52e81612bcbc57f1066b7a42    Community and Government > Education > Driving School
     1,111  4bf58dd8d48988d15e941735    Sports and Recreation > Water Sports > Swimming > Swimming Pool
     1,107  4bf58dd8d48988d164941735    Landmarks and Outdoors > Plaza
     1,099  4bf58dd8d48988d1ad941735    Community and Government > Education > Trade School
     1,086  4f4528bc4b90abdf24c9de85    Sports and Recreation
     1,077  4bf58dd8d48988d11d951735    Retail > Food and Beverage Retail > Butcher
     1,059  58daa1558bbb0b01f18ec1f1    Business and Professional Services > Insurance Agency
     1,056  4bf58dd8d48988d143941735    Dining and Drinking > Breakfast Spot
     1,052  5453de49498eade8af355881    Business and Professional Services > Business Service
     1,051  4d954afda243a5684865b473    Retail > Eyecare Store
     1,029  4bf58dd8d48988d176941735    Sports and Recreation > Gym and Studio > Gym
     1,021  4bf58dd8d48988d15f941735    Landmarks and Outdoors > Field
       938  4bf58dd8d48988d171941735    Business and Professional Services > Event Space
       932  4bf58dd8d48988d16e941735    Dining and Drinking > Restaurant > Fast Food Restaurant
       914  4bf58dd8d48988d1c0941735    Dining and Drinking > Restaurant > Mediterranean Restaurant
       906  52f2ab2ebcbc57f1066b8b4f    Travel and Transportation > Transport Hub > Bus Stop
       872  52f2ab2ebcbc57f1066b8b21    Retail > Stationery Store
       857  4bf58dd8d48988d1db931735    Dining and Drinking > Restaurant > Spanish Restaurant > Tapas Restaurant
       826  4bf58dd8d48988d15a941735    Landmarks and Outdoors > Garden
       782  4bf58dd8d48988d108951735    Retail > Fashion Retail > Women's Store
       769  4bf58dd8d48988d104951735    Retail > Boutique
       769  4bf58dd8d48988d121951735    Retail > Office Supply Store
       738  4bf58dd8d48988d128951735    Retail > Gift Store
       719  4bf58dd8d48988d13d941735    Community and Government > Education > Primary and Secondary School > High School
       700  4bf58dd8d48988d1a0941735    Community and Government > Education > College and University > College Classroom
       682  4bf58dd8d48988d11e941735    Dining and Drinking > Bar > Cocktail Bar
       671  4bf58dd8d48988d121941735    Dining and Drinking > Bar > Lounge
       631  4bf58dd8d48988d1f4941735    Business and Professional Services > Design Studio
       629  4bf58dd8d48988d102951735    Retail > Fashion Retail > Fashion Accessories Store
       603  4bf58dd8d48988d16b941735    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Brazilian Restaurant
       601  4bf58dd8d48988d1ab941735    Community and Government > Education > College and University > Student Center
       601  4bf58dd8d48988d123951735    Retail > Smoke Shop
       597  4bf58dd8d48988d123941735    Dining and Drinking > Bar > Wine Bar
       597  52f2ab2ebcbc57f1066b8b28    Retail > Print Store
       594  530e33ccbcbc57f1066bbff9    Landmarks and Outdoors > States and Municipalities > Village
       591  4bf58dd8d48988d12b951735    Travel and Transportation > Transportation Service > Public Transportation > Bus Line
       585  4bf58dd8d48988d1e5931735    Arts and Entertainment > Performing Arts Venue > Music Venue
       585  4bf58dd8d48988d12f951735    Travel and Transportation > Lodging > Resort
       577  63be6904847c3692a84b9b36    Business and Professional Services > Construction
       564  50be8ee891d4fa8dcc7199a7    Retail > Market
       547  4bf58dd8d48988d12d941735    Landmarks and Outdoors > Monument
       538  4bf58dd8d48988d145941735    Dining and Drinking > Restaurant > Asian Restaurant > Chinese Restaurant
       526  4bf58dd8d48988d1cb941735    Dining and Drinking > Food Truck
       523  4bf58dd8d48988d105951735    Retail > Fashion Retail > Children's Clothing Store
       514  52f2ab2ebcbc57f1066b8b33    Business and Professional Services > Laundromat
       496  4bf58dd8d48988d111941735    Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant
       493  4eb1c0253b7b52c0e1adc2e9    Retail > Garden Center
       492  4bf58dd8d48988d1c5941735    Dining and Drinking > Restaurant > Sandwich Spot
       489  4eb1bdde3b7b55596b4a7490    Business and Professional Services > Photography Service > Photography Lab
       487  4bf58dd8d48988d10e951735    Retail > Food and Beverage Retail > Fish Market
       485  4f4530164b9074f6e4fb00ff    Travel and Transportation > Tourist Information and Service
       468  52e81612bcbc57f1066b7a48    Community and Government > Education > Language School
       463  63be6904847c3692a84b9b26    Business and Professional Services > Agriculture and Forestry Service
       463  52e81612bcbc57f1066b7a00    Dining and Drinking > Restaurant > Comfort Food Restaurant
       460  4f04ad622fb6e1c99f3db0b9    Retail > Newsstand
       445  5032891291d4c4b30a586d68    Community and Government > Assisted Living
       437  4bf58dd8d48988d117941735    Dining and Drinking > Bar > Beer Garden
       426  4f04afc02fb6e1c99f3db0bc    Retail > Computers and Electronics Retail > Mobile Phone Store
       420  52e81612bcbc57f1066b7a45    Community and Government > Education > Preschool
       417  4bf58dd8d48988d142941735    Dining and Drinking > Restaurant > Asian Restaurant
       415  4bf58dd8d48988d147941735    Dining and Drinking > Restaurant > Diner
       414  4bf58dd8d48988d1dc931735    Dining and Drinking > Cafe, Coffee, and Tea House > Tea Room
       394  4bf58dd8d48988d109951735    Retail > Fashion Retail > Lingerie Store
       392  5032792091d4c4b30a586d5c    Arts and Entertainment > Performing Arts Venue > Concert Hall
       390  4bf58dd8d48988d1d0941735    Dining and Drinking > Dessert Shop
       389  52e81612bcbc57f1066b79f1    Dining and Drinking > Restaurant > Bistro
       386  4f4530a74b9074f6e4fb0100    Travel and Transportation > Lodging > Boarding House
       384  4bf58dd8d48988d146941735    Dining and Drinking > Restaurant > Deli
       382  5454152e498ef71e2b9132c6    Business and Professional Services > Event Service
       376  4e67e38e036454776db1fb3a    Community and Government > Residential Building
       367  4bf58dd8d48988d12a951735    Travel and Transportation > Train
       365  4bf58dd8d48988d119951735    Retail > Food and Beverage Retail > Wine Store
       362  4bf58dd8d48988d131941735    Community and Government > Spiritual Center
       360  5744ccdfe4b0c0459246b4e2    Dining and Drinking > Dessert Shop > Pastry Shop
       360  4eb1d4d54b900d56c88a45fc    Landmarks and Outdoors > Mountain
       359  4bf58dd8d48988d1a5941735    Community and Government > Education > College and University > College Lab
       358  4bf58dd8d48988d188941735    Arts and Entertainment > Stadium > Soccer Stadium
       356  4f4534884b9074f6e4fb0174    Business and Professional Services > Funeral Home
       354  52f2ab2ebcbc57f1066b8b3f    Business and Professional Services > Legal Service > Law Office
       353  522e32fae4b09b556e370f19    Health and Medicine > Optometrist
       349  4eb1d4dd4b900d56c88a45fd    Landmarks and Outdoors > River
       345  4bf58dd8d48988d1df941735    Landmarks and Outdoors > Bridge
       342  4f04b10d2fb6e1c99f3db0be    Community and Government > Education > Music School
       341  4bf58dd8d48988d128941735    Dining and Drinking > Cafeteria
       340  4bf58dd8d48988d1f6941735    Retail > Department Store
       334  4bf58dd8d48988d106951735    Retail > Fashion Retail > Men's Store
       332  63be6904847c3692a84b9baa    Community and Government > Organization
       329  4bf58dd8d48988d198941735    Community and Government > Education > College and University > College Academic Building
       325  63be6904847c3692a84b9b98    Business and Professional Services > Wholesaler
       322  4bf58dd8d48988d155941735    Dining and Drinking > Restaurant > Gastropub
       321  52f2ab2ebcbc57f1066b8b1f    Business and Professional Services > Shipping, Freight, and Material Transportation Service
       317  4bf58dd8d48988d1fb941735    Retail > Hobby Store
       313  4bf58dd8d48988d1e0941735    Landmarks and Outdoors > Harbor or Marina
       308  4bf58dd8d48988d179941735    Dining and Drinking > Bagel Shop
       308  530e33ccbcbc57f1066bbff3    Landmarks and Outdoors > States and Municipalities > Town
       305  4bf58dd8d48988d190941735    Arts and Entertainment > Museum > History Museum
       303  4bf58dd8d48988d137941735    Arts and Entertainment > Performing Arts Venue > Theater
       299  4bf58dd8d48988d11d941735    Dining and Drinking > Bar > Sports Bar
       295  52e81612bcbc57f1066b7a0d    Dining and Drinking > Bar > Beach Bar
       290  4bf58dd8d48988d161941735    Landmarks and Outdoors > Lake
       289  54541b70498ea6ccd0204bff    Travel and Transportation > Transportation Service
       287  4d4ae6fc7a7b7dea34424761    Dining and Drinking > Restaurant > Fried Chicken Joint
       285  4bf58dd8d48988d1af941735    Community and Government > Education > College and University > College Auditorium
       282  52f2ab2ebcbc57f1066b8b3c    Business and Professional Services > Health and Beauty Service > Massage Clinic
       279  4bf58dd8d48988d1d5941735    Dining and Drinking > Bar > Hotel Bar
       279  4bf58dd8d48988d117951735    Retail > Food and Beverage Retail > Candy Store
       276  4bf58dd8d48988d1f0931735    Travel and Transportation > Transport Hub > Airport > Airport Gate
       270  63be6904847c3692a84b9b49    Business and Professional Services > Health and Beauty Service > Barbershop
       262  52f2ab2ebcbc57f1066b8b1c    Retail > Food and Beverage Retail > Fruit and Vegetable Store
       261  4e52adeebd41615f56317744    Community and Government > Government Building > Military > Military Base
       256  4bf58dd8d48988d1fa941735    Retail > Food and Beverage Retail > Farmers Market
       254  4bf58dd8d48988d1f5941735    Retail > Food and Beverage Retail > Gourmet Store
       253  4bf58dd8d48988d1e3941735    Landmarks and Outdoors > Surf Spot
       252  63be6904847c3692a84b9c25    Travel and Transportation > Lodging
       248  5032781d91d4c4b30a586d5b    Business and Professional Services > Tailor
       246  4bf58dd8d48988d1de941735    Dining and Drinking > Vineyard
       243  63be6904847c3692a84b9b87    Business and Professional Services > Real Estate Service > Real Estate Appraiser
       243  4bf58dd8d48988d116951735    Retail > Antique Store
       240  507c8c4091d498d9fc8c67a9    Arts and Entertainment > Public Art
       240  56aa371ce4b08b9a8d57356c    Dining and Drinking > Bar > Beer Bar
       239  5032897c91d4c4b30a586d69    Business and Professional Services > Pet Service
       238  4bf58dd8d48988d173941735    Business and Professional Services > Auditorium
       234  4bf58dd8d48988d1f7941735    Retail > Flea Market
       233  52e81612bcbc57f1066b7a2e    Sports and Recreation > Sports Club
       233  4bf58dd8d48988d132951735    Travel and Transportation > Lodging > Hotel > Hotel Pool
       230  4bf58dd8d48988d1d6941735    Arts and Entertainment > Strip Club
       229  554a5e17498efabeda6cc559    Business and Professional Services > Photography Service > Photography Studio
       228  52f2ab2ebcbc57f1066b8b32    Retail > Baby Store
       225  52f2ab2ebcbc57f1066b8b1b    Retail > Souvenir Store
       222  4f4532974b9074f6e4fb0104    Business and Professional Services > Child Care Service > Daycare
       220  63be6904847c3692a84b9b35    Business and Professional Services > Computer Repair Service
       217  4bf58dd8d48988d1a1941735    Community and Government > Education > College and University > College Cafeteria
       210  56aa371be4b08b9a8d573517    Business and Professional Services > Business Center
       209  4bf58dd8d48988d1bd941735    Dining and Drinking > Restaurant > Salad Restaurant
       207  5283c7b4e4b094cb91ec88d7    Dining and Drinking > Restaurant > Kebab Restaurant
       207  4f4531504b9074f6e4fb0102    Travel and Transportation > Platform
       206  4bf58dd8d48988d1e5941735    Landmarks and Outdoors > Park > Dog Park
       204  4bf58dd8d48988d1a7941735    Community and Government > Education > College and University > College Library
       202  52e81612bcbc57f1066b79f2    Dining and Drinking > Creperie
       201  4d4b7105d754a06377d81259    Landmarks and Outdoors
       199  4bf58dd8d48988d120951735    Dining and Drinking > Food Court
       198  5fac002599ce226e27fe72e5    Business and Professional Services > Architecture Firm
       197  63be6904847c3692a84b9b73    Business and Professional Services > Metals Supplier
       196  63be6904847c3692a84b9b68    Business and Professional Services > Industrial Equipment Supplier
       190  4f4533814b9074f6e4fb0106    Community and Government > Education > Primary and Secondary School > Middle School
       189  4f4533814b9074f6e4fb0107    Community and Government > Education > Nursery School
       189  5032833091d4c4b30a586d60    Retail > Automotive Retail > Motorcycle Dealership
       186  4bf58dd8d48988d1a2941735    Community and Government > Education > College and University > Community College
       182  4bf58dd8d48988d1f2931735    Arts and Entertainment > Performing Arts Venue
       181  63be6904847c3692a84b9bb9    Health and Medicine
       181  4bf58dd8d48988d134941735    Sports and Recreation > Gym and Studio > Dance Studio
       180  4bf58dd8d48988d1d4941735    Dining and Drinking > Bar > Speakeasy
       176  63be6904847c3692a84b9bd3    Health and Medicine > Physician > Ophthalmologist
       171  4bf58dd8d48988d100941735    Business and Professional Services > Convention Center > Conference Room
       171  4bf58dd8d48988d101951735    Retail > Vintage and Thrift Store
       169  4bf58dd8d48988d127941735    Business and Professional Services > Office > Meeting Room
       169  52e81612bcbc57f1066b7a26    Sports and Recreation > Recreation Center
       167  52f2ab2ebcbc57f1066b8b36    Business and Professional Services > Technology Business > IT Service
       164  4bf58dd8d48988d1b2941735    Community and Government > Education > College and University > College Gym
       163  52e81612bcbc57f1066b7a41    Community and Government > Spiritual Center > Prayer Room
       161  4bf58dd8d48988d197941735    Community and Government > Education > College and University > College Administrative Building
       161  4bf58dd8d48988d101941735    Sports and Recreation > Martial Arts Dojo
       160  63be6904847c3692a84b9bc4    Health and Medicine > Nursing Home
       159  52e81612bcbc57f1066b79ed    Arts and Entertainment > Public Art > Outdoor Sculpture
       159  63be6904847c3692a84b9bf0    Retail > Food and Beverage Retail > Meat and Seafood Store
       158  63be6904847c3692a84b9bbe    Health and Medicine > Healthcare Clinic
       158  58daa1558bbb0b01f18ec206    Retail > Medical Supply Store
       158  63be6904847c3692a84b9bfc    Retail > Tobacco Store
       157  4eb1daf44b900d56c88a4600    Arts and Entertainment > Fair
       156  4e52d2d203646f7c19daa8ae    Community and Government > Animal Shelter
       156  4bf58dd8d48988d1fe941735    Retail > Music Store
       155  5032856091d4c4b30a586d63    Business and Professional Services > Radio Station
       155  4d954b16a243a5684b65b473    Travel and Transportation > Rest Area
       154  4bf58dd8d48988d118941735    Dining and Drinking > Bar > Dive Bar
       153  4bf58dd8d48988d120941735    Dining and Drinking > Bar > Karaoke Bar
       153  4eb1baf03b7b2c5b1d4306ca    Landmarks and Outdoors > Stable
       150  4bf58dd8d48988d1e3931735    Arts and Entertainment > Pool Hall
       149  52e81612bcbc57f1066b7a37    Business and Professional Services > Distribution Center
       149  5ae95d208a6f17002ce792b2    Business and Professional Services > Legal Service > Notary
       149  52f2ab2ebcbc57f1066b8b39    Business and Professional Services > Shoe Repair Service
       149  63be6904847c3692a84b9bf1    Retail > Furniture and Home Store > Home Appliance Store
       148  52f2ab2ebcbc57f1066b8b24    Retail > Framing Store
       148  56aa371be4b08b9a8d573520    Travel and Transportation > Tourist Information and Service > Tour Provider
       147  63be6904847c3692a84b9b28    Business and Professional Services > Art Restoration Service
       147  4bf58dd8d48988d130951735    Travel and Transportation > Transportation Service > Taxi
       145  4bf58dd8d48988d1f1941735    Retail > Board Store
       145  4bf58dd8d48988d1f4931735    Sports and Recreation > Race Track
       143  4f04b1572fb6e1c99f3db0bf    Business and Professional Services > Storage Facility
       143  50aaa49e4b90af0d42d5de11    Landmarks and Outdoors > Castle
       141  4edd64a0c7ddd24ca188df1a    Dining and Drinking > Restaurant > Fish and Chips Shop
       140  63be6904847c3692a84b9b32    Business and Professional Services > Office > Business and Strategy Consulting Office
       140  52f2ab2ebcbc57f1066b8b16    Retail > Sporting Goods Retail > Fishing Store
       139  4bf58dd8d48988d1ff931735    Business and Professional Services > Convention Center
       139  52f2ab2ebcbc57f1066b8b1d    Business and Professional Services > Health and Beauty Service > Dry Cleaner
       139  63be6904847c3692a84b9b4d    Business and Professional Services > Home Improvement Service > Carpenter
       138  52f2ab2ebcbc57f1066b8b31    Retail > Food and Beverage Retail > Chocolate Store
       137  4bf58dd8d48988d194941735    Health and Medicine > Emergency Service > Emergency Room
       137  52f2ab2ebcbc57f1066b8b49    Sports and Recreation > Gym and Studio > Cycle Studio
       136  63be6904847c3692a84b9b60    Business and Professional Services > Home Improvement Service > Professional Cleaning Service
       136  52e81612bcbc57f1066b7a35    Community and Government > Organization > Club House
       136  55a59bace4b013909087cb24    Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant > Ramen Restaurant
       136  4bf58dd8d48988d16f941735    Dining and Drinking > Restaurant > Hot Dog Joint
       136  52e81612bcbc57f1066b7a3c    Health and Medicine > Alternative Medicine Clinic
       136  52f2ab2ebcbc57f1066b8b42    Retail > Big Box Store
       135  52e81612bcbc57f1066b79f4    Dining and Drinking > Restaurant > Buffet
       134  4bf58dd8d48988d1bc941735    Dining and Drinking > Dessert Shop > Cupcake Shop
       134  52e81612bcbc57f1066b79f9    Dining and Drinking > Restaurant > Modern European Restaurant
       133  63be6904847c3692a84b9b7c    Business and Professional Services > Photography Service > Photographer
       133  4bf58dd8d48988d15d941735    Landmarks and Outdoors > Lighthouse
       132  4bf58dd8d48988d10b941735    Dining and Drinking > Restaurant > Falafel Restaurant
       130  56aa371be4b08b9a8d573550    Business and Professional Services > Food and Beverage Service
       130  4f2a23984b9023bd5841ed2c    Travel and Transportation > Moving Target
       129  4bf58dd8d48988d11a951735    Retail > Fashion Retail > Bridal Store
       128  63be6904847c3692a84b9be6    Retail > Automotive Retail > Car Parts and Accessories
       127  4bf58dd8d48988d1e1941735    Sports and Recreation > Basketball > Basketball Court
       124  4bf58dd8d48988d18f941735    Arts and Entertainment > Museum > Art Museum
       124  4bf58dd8d48988d11e951735    Retail > Food and Beverage Retail > Cheese Store
       123  63be6904847c3692a84b9b3a    Business and Professional Services > Engineer
       122  4bf58dd8d48988d1c8941735    Dining and Drinking > Restaurant > African Restaurant
       122  52e81612bcbc57f1066b7a25    Landmarks and Outdoors > Pedestrian Plaza
       122  5744ccdfe4b0c0459246b4e8    Travel and Transportation > Baggage Locker
       121  63be6904847c3692a84b9b4b    Business and Professional Services > Health and Beauty Service > Skin Care Clinic
       117  5bae9231bedf3950379f89cb    Travel and Transportation > Lodging > Inn
       116  4bf58dd8d48988d1a3941735    Community and Government > Education > College and University > College Residence Hall
       115  5f2c407c5b4c177b9a6dc536    Dining and Drinking > Dessert Shop > Gelato Shop
       114  4bf58dd8d48988d115941735    Dining and Drinking > Restaurant > Middle Eastern Restaurant
       113  4bf58dd8d48988d112941735    Dining and Drinking > Juice Bar
       112  55077a22498e5e9248869ba2    Travel and Transportation > Cruise
       111  4bf58dd8d48988d1fb931735    Travel and Transportation > Lodging > Motel
       110  63be6904847c3692a84b9b58    Business and Professional Services > Home Improvement Service
       110  63be6904847c3692a84b9bb6    Dining and Drinking > Cafe, Coffee, and Tea House
       108  52e81612bcbc57f1066b7a33    Community and Government > Social Club
       107  52e81612bcbc57f1066b7a36    Business and Professional Services > Warehouse
       107  4bf58dd8d48988d119941735    Dining and Drinking > Bar > Hookah Bar
       104  52e81612bcbc57f1066b79ee    Arts and Entertainment > Public Art > Street Art
       103  4bf58dd8d48988d1dd931735    Dining and Drinking > Restaurant > Soup Spot
       103  52e81612bcbc57f1066b7a13    Landmarks and Outdoors > Nature Preserve
       102  63be6904847c3692a84b9b56    Business and Professional Services > Home Improvement Service > Heating, Ventilating and Air Conditioning Contractor
       102  63be6904847c3692a84b9be3    Retail > Automotive Retail
       101  63be6904847c3692a84b9b29    Business and Professional Services > Audiovisual Service
       101  63be6904847c3692a84b9b83    Business and Professional Services > Real Estate Service
       101  52e81612bcbc57f1066b7a46    Community and Government > Education > Private School
       101  52e81612bcbc57f1066b7a28    Landmarks and Outdoors > Bathing Area
       101  4bf58dd8d48988d10d951735    Retail > Record Store
       100  4bf58dd8d48988d10c941735    Dining and Drinking > Restaurant > French Restaurant
       100  63be6904847c3692a84b9bf2    Retail > Furniture and Home Store > Housewares Store
        99  56aa371be4b08b9a8d57350b    Dining and Drinking > Food Stand
        98  56aa371be4b08b9a8d573560    Landmarks and Outdoors > Waterfall
        97  63be6904847c3692a84b9b2b    Business and Professional Services > Automotive Service
        95  4f04af1f2fb6e1c99f3db0bb    Dining and Drinking > Restaurant > Turkish Restaurant
        95  4e4c9077bd41f78e849722f9    Travel and Transportation > Bike Rental
        94  56aa371be4b08b9a8d573547    Landmarks and Outdoors > Fountain
        93  63be6904847c3692a84b9b52    Business and Professional Services > Home Improvement Service > Electrician
        92  4bf58dd8d48988d1d8941735    Dining and Drinking > Bar > Gay Bar
        91  5267e4d9e4b0ec79466e48c8    Event > Other Event
        91  63be6904847c3692a84b9bc6    Health and Medicine > Physician
        90  52e81612bcbc57f1066b7a3b    Health and Medicine > Acupuncture Clinic
        90  52f2ab2ebcbc57f1066b8b51    Travel and Transportation > Transport Hub > Tram Station
        89  4bf58dd8d48988d1e9931735    Arts and Entertainment > Performing Arts Venue > Music Venue > Rock Club
        89  56aa371be4b08b9a8d57352f    Travel and Transportation > Transport Hub > Airport > Airport Service
        88  4d1cf8421a97d635ce361c31    Business and Professional Services > Health and Beauty Service > Tanning Salon
        88  5032764e91d4c4b30a586d5a    Business and Professional Services > Office > Campaign Office
        88  52e81612bcbc57f1066b7a38    Community and Government > Town Hall
        88  56aa371be4b08b9a8d573538    Dining and Drinking > Restaurant > Theme Restaurant
        87  4bf58dd8d48988d18e941735    Arts and Entertainment > Comedy Club
        85  63be6904847c3692a84b9b86    Business and Professional Services > Real Estate Service > Property Management Office
        85  4eb1d80a4b900d56c88a45ff    Community and Government > Spiritual Center > Shrine
        85  4bf58dd8d48988d167941735    Sports and Recreation > Skating > Skate Park
        84  52e81612bcbc57f1066b7a0c    Dining and Drinking > Cafe, Coffee, and Tea House > Bubble Tea Shop
        84  4e74f6cabd41c4836eac4c31    Travel and Transportation > Pier
        83  4bf58dd8d48988d19b941735    Community and Government > Education > College and University > College Science Building
        83  4bf58dd8d48988d1b0941735    Community and Government > Education > College and University > Fraternity House
        83  5370f356bcbc57f1066c94c2    Retail > Food and Beverage Retail > Beer Store
        82  52f2ab2ebcbc57f1066b8b25    Retail > Knitting Store
        81  4bf58dd8d48988d1e1931735    Arts and Entertainment > Arcade
        81  56aa371be4b08b9a8d573532    Arts and Entertainment > Exhibit
        80  63be6904847c3692a84b9b5f    Business and Professional Services > Home Improvement Service > Plumber
        80  4bf58dd8d48988d1d1941735    Dining and Drinking > Restaurant > Asian Restaurant > Noodle Restaurant
        80  58daa1558bbb0b01f18ec1d0    Health and Medicine > Nutritionist
        80  52dea92d3cf9994f4e043dbb    Retail > Discount Store
        78  5294c7523cf9994f4e043a62    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Brazilian Restaurant > Acai House
        78  52939a643cf9994f4e043a33    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Brazilian Restaurant > Churrascaria
        77  63be6904847c3692a84b9bb4    Community and Government > Utility Company
        77  4bf58dd8d48988d160941735    Landmarks and Outdoors > Hot Spring
        76  58daa1558bbb0b01f18ec1d6    Business and Professional Services > Art Studio
        76  63be6904847c3692a84b9b67    Business and Professional Services > Import and Export Service
        76  4bf58dd8d48988d166941735    Landmarks and Outdoors > Sculpture Garden
        75  4bf58dd8d48988d14c941735    Dining and Drinking > Restaurant > Wings Joint
        75  52f2ab2ebcbc57f1066b8b23    Retail > Perfume Store
        74  4bf58dd8d48988d19e941735    Community and Government > Education > College and University > College Engineering Building
        74  4bf58dd8d48988d14e941735    Dining and Drinking > Restaurant > American Restaurant
        74  52e816a6bcbc57f1066b7a54    Retail > Warehouse or Wholesale Store
        73  52f2ab2ebcbc57f1066b8b57    Business and Professional Services > Employment Agency
        73  4fbc1be21983fc883593e321    Landmarks and Outdoors > Well
        72  52e81612bcbc57f1066b7a39    Health and Medicine > Mental Health Service > Mental Health Clinic
        71  4bf58dd8d48988d1f0941735    Arts and Entertainment > Internet Cafe
        71  63be6904847c3692a84b9b55    Business and Professional Services > Home Improvement Service > General Contractor
        71  5744ccdfe4b0c0459246b4d6    Business and Professional Services > Research Laboratory
        71  512e7cae91d4cbb4e5efe0af    Dining and Drinking > Dessert Shop > Frozen Yogurt Shop
        71  63be6904847c3692a84b9c26    Travel and Transportation > Lodging > Cabin
        70  4eb1bdf03b7b55596b4a7491    Retail > Computers and Electronics Retail > Camera Store
        69  4bf58dd8d48988d133951735    Landmarks and Outdoors > Roof Deck
        69  63be6904847c3692a84b9c27    Travel and Transportation > Lodging > Lodge
        68  4bf58dd8d48988d1aa941735    Community and Government > Education > College and University > College Quad
        68  4cae28ecbf23941eb1190695    Community and Government > Polling Place
        68  4bf58dd8d48988d105941735    Sports and Recreation > Gym and Studio > Gym Pool
        67  58daa1558bbb0b01f18ec1b4    Retail > Furniture and Home Store > Kitchen Supply Store
        66  63be6904847c3692a84b9b51    Business and Professional Services > Home Improvement Service > Doors and Windows Contractor
        66  4bf58dd8d48988d199941735    Community and Government > Education > College and University > College Arts Building
        65  545419b1498ea6ccd0202f58    Business and Professional Services > Home Improvement Service > Home Service
        65  5267e446e4b0ec79466e48c4    Retail > Adult Store
        64  63be6904847c3692a84b9b7e    Business and Professional Services > Plastics Supplier
        64  4bf58dd8d48988d150941735    Dining and Drinking > Restaurant > Spanish Restaurant
        64  50aaa5234b90af0d42d5de12    Retail > Sporting Goods Retail > Hunting Supply Store
        63  4f4531084b9074f6e4fb0101    Business and Professional Services > Recycling Facility
        63  4bf58dd8d48988d13a941735    Community and Government > Spiritual Center > Temple
        63  5744ccdfe4b0c0459246b4b2    Sports and Recreation > Gym and Studio > Pilates Studio
        62  4bf58dd8d48988d12a941735    Community and Government > Government Building > Capitol Building
        62  50aaa4314b90af0d42d5de10    Landmarks and Outdoors > Island
        60  52f2ab2ebcbc57f1066b8b37    Business and Professional Services > Recording Studio
        60  63be6904847c3692a84b9b8f    Business and Professional Services > Security and Safety
        60  4bf58dd8d48988d1b3941735    Community and Government > Education > College and University > Medical School
        60  5267e4d9e4b0ec79466e48c7    Event > Entertainment Event > Festival
        59  4bf58dd8d48988d17e941735    Arts and Entertainment > Movie Theater > Indie Movie Theater
        59  52f2ab2ebcbc57f1066b8b1e    Business and Professional Services > Locksmith
        59  4bf58dd8d48988d14a941735    Dining and Drinking > Restaurant > Asian Restaurant > Vietnamese Restaurant
        59  52e81612bcbc57f1066b7a23    Landmarks and Outdoors > Forest
        59  5744ccdfe4b0c0459246b4dc    Retail > Shopping Plaza
        58  4bf58dd8d48988d191941735    Arts and Entertainment > Museum > Science Museum
        57  63be6904847c3692a84b9b9a    Community and Government
        56  4e0e22f5a56208c4ea9a85a0    Dining and Drinking > Distillery
        56  52e81612bcbc57f1066b7a12    Landmarks and Outdoors > Dive Spot
        55  4bf58dd8d48988d151941735    Dining and Drinking > Restaurant > Mexican Restaurant > Taco Restaurant
        55  52f2ab2ebcbc57f1066b8b27    Retail > Furniture and Home Store > Mattress Store
        55  52e81612bcbc57f1066b7a11    Sports and Recreation > Gun Range
        54  63be6904847c3692a84b9ba2    Community and Government > Government Building > Government Department
        54  63be6904847c3692a84b9bec    Retail > Fashion Retail
        53  56aa371ce4b08b9a8d573570    Community and Government > Education > Adult Education
        53  4bf58dd8d48988d108941735    Dining and Drinking > Restaurant > Dumpling Restaurant
        53  4bf58dd8d48988d109941735    Dining and Drinking > Restaurant > Eastern European Restaurant
        53  5032829591d4c4b30a586d5e    Sports and Recreation > Paintball Field
        52  56aa371be4b08b9a8d57356a    Business and Professional Services > Outdoor Event Space
        52  63be6904847c3692a84b9b90    Business and Professional Services > Technology Business
        52  63be6904847c3692a84b9b93    Business and Professional Services > Telecommunication Service
        52  4bf58dd8d48988d10b951735    Retail > Computers and Electronics Retail > Video Games Store
        51  5744ccdfe4b0c0459246b4b5    Sports and Recreation > Indoor Play Area
        50  4bf58dd8d48988d107941735    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Argentinian Restaurant
        50  52e81612bcbc57f1066b7a14    Landmarks and Outdoors > Palace
        50  52f2ab2ebcbc57f1066b8b45    Retail > Food and Beverage Retail > Grocery Store > Organic Grocery
        49  4bf58dd8d48988d18d941735    Arts and Entertainment > Gaming Cafe
        49  4f04b25d2fb6e1c99f3db0c0    Travel and Transportation > Travel Lounge
        48  4bf58dd8d48988d113941735    Dining and Drinking > Restaurant > Asian Restaurant > Korean Restaurant
        48  5267e4d9e4b0ec79466e48d1    Event > Entertainment Event > Music Festival
        48  52f2ab2ebcbc57f1066b8b2e    Retail > Fashion Retail > Watch Store
        48  52f2ab2ebcbc57f1066b8b29    Retail > Luggage Store
        48  52f2ab2ebcbc57f1066b8b35    Retail > Outlet Store
        47  4bf58dd8d48988d1b1941735    Community and Government > Education > College and University > College Bookstore
        47  530e33ccbcbc57f1066bbfe4    Landmarks and Outdoors > States and Municipalities
        47  63be6904847c3692a84b9bf3    Retail > Packaging Supply Store
        46  4bf58dd8d48988d1a9941735    Community and Government > Education > College and University > College Rec Center
        46  52f2ab2ebcbc57f1066b8b55    Community and Government > Trailer Park
        46  5f2c224bb6d05514c70440a3    Dining and Drinking > Bar > Rooftop Bar
        46  5bae9231bedf3950379f89d4    Dining and Drinking > Restaurant > Hawaiian Restaurant > Poke Restaurant
        46  52f2ab2ebcbc57f1066b8b41    Dining and Drinking > Smoothie Shop
        45  50328a4b91d4c4b30a586d6b    Landmarks and Outdoors > Rock Climbing Spot
        44  4bf58dd8d48988d148941735    Dining and Drinking > Donut Shop
        44  63be6904847c3692a84b9bc2    Health and Medicine > Mental Health Service > Psychologist
        44  52f2ab2ebcbc57f1066b8b4c    Travel and Transportation > Road > Intersection
        44  60a674555c7917283bad6839    Travel and Transportation > Transport Hub > Airport > Airport Ticket Counter
        44  63be6904847c3692a84b9c2d    Travel and Transportation > Transportation Service > Public Transportation
        43  63be6904847c3692a84b9b59    Business and Professional Services > Home Improvement Service > Interior Designer
        43  56aa371be4b08b9a8d5734d7    Business and Professional Services > Industrial Estate
        43  52e81612bcbc57f1066b7a31    Business and Professional Services > TV Station
        43  63be6904847c3692a84b9bb1    Community and Government > Public and Social Service
        43  56aa371be4b08b9a8d573511    Landmarks and Outdoors > Cave
        43  5744ccdfe4b0c0459246b4c1    Travel and Transportation > Boat Rental
        42  52f2ab2ebcbc57f1066b8b20    Business and Professional Services > Health and Beauty Service > Body Piercing Shop
        42  52f2ab2ebcbc57f1066b8b48    Sports and Recreation > Gymnastics > Gymnastics Center
        41  63be6904847c3692a84b9b85    Business and Professional Services > Real Estate Service > Commercial Real Estate Developer
        41  5294cbda3cf9994f4e043a63    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Brazilian Restaurant > Pastelaria
        41  52e81612bcbc57f1066b7a3a    Health and Medicine > Chiropractor
        41  5e8f501a03c7a9000c1e2e88    Retail > Automotive Retail > Car Dealership > Used Car Dealership
        41  52f2ab2ebcbc57f1066b8b1a    Retail > Sporting Goods Retail > Dive Store
        40  52e81612bcbc57f1066b79ea    Arts and Entertainment > Go Kart Track
        40  52e81612bcbc57f1066b7a21    Landmarks and Outdoors > Park > National Park
        40  4bf58dd8d48988d1eb931735    Travel and Transportation > Transport Hub > Airport > Airport Terminal
        39  4bf58dd8d48988d19f941735    Community and Government > Education > College and University > College Technology Building
        39  52f2ab2ebcbc57f1066b8b4b    Travel and Transportation > Border Crossing
        38  4bf58dd8d48988d1e7931735    Arts and Entertainment > Performing Arts Venue > Music Venue > Jazz and Blues Venue
        38  63be6904847c3692a84b9b34    Business and Professional Services > Chemicals and Gasses Manufacturer
        38  56aa371be4b08b9a8d5734c3    Landmarks and Outdoors > Waterfront
        38  56aa371be4b08b9a8d57353e    Travel and Transportation > Port
        37  63be6904847c3692a84b9bea    Retail > Computers and Electronics Retail
        36  52939a8c3cf9994f4e043a35    Dining and Drinking > Restaurant > Latin American Restaurant > Empanada Restaurant
        36  52e81612bcbc57f1066b7a24    Landmarks and Outdoors > Tree
        36  52f2ab2ebcbc57f1066b8b40    Retail > Betting Shop
        35  5f2c2834b6d05514c704451e    Arts and Entertainment > Escape Room
        35  56aa371be4b08b9a8d5734db    Arts and Entertainment > Performing Arts Venue > Amphitheater
        35  63be6904847c3692a84b9b65    Business and Professional Services > Home Improvement Service > Upholstery Service
        35  4bf58dd8d48988d122941735    Dining and Drinking > Bar > Whisky Bar
        35  63be6904847c3692a84b9bda    Health and Medicine > Physician > Radiologist
        34  56aa371be4b08b9a8d5734c5    Business and Professional Services > Wedding Hall
        34  4bf58dd8d48988d10e941735    Dining and Drinking > Restaurant > Greek Restaurant
        34  4eb1bfa43b7b52c0e1adc2e8    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Peruvian Restaurant
        34  56aa371be4b08b9a8d57355c    Retail > Vape Store
        33  63be6904847c3692a84b9b4e    Business and Professional Services > Home Improvement Service > Carpet and Flooring Contractor
        32  4bf58dd8d48988d135941735    Arts and Entertainment > Performing Arts Venue > Indie Theater
        32  56aa371be4b08b9a8d57351d    Community and Government > Rehabilitation Center
        32  52e81612bcbc57f1066b7a06    Dining and Drinking > Bar > Irish Pub
        31  63be6904847c3692a84b9b5d    Business and Professional Services > Home Improvement Service > Painter
        31  5f2c3f6b5b4c177b9a6dc388    Dining and Drinking > Restaurant > Asian Restaurant > Korean Restaurant > Korean BBQ Restaurant
        31  52e81612bcbc57f1066b79ff    Dining and Drinking > Restaurant > Halal Restaurant
        30  63be6904847c3692a84b9bb5    Dining and Drinking
        30  52f2ab2ebcbc57f1066b8b2b    Retail > Leather Goods Store
        30  5f2c42335b4c177b9a6dc927    Travel and Transportation > Transport Hub > Airport > Airfield
        29  4e39a891bd410d7aed40cbc2    Arts and Entertainment > Stadium > Tennis Stadium
        29  4bf58dd8d48988d1a6941735    Community and Government > Education > College and University > Law School
        29  5642206c498e4bfca532186c    Landmarks and Outdoors > Memorial Site
        29  52f2ab2ebcbc57f1066b8b4a    Landmarks and Outdoors > Tunnel
        28  56aa371be4b08b9a8d573523    Business and Professional Services > Film Studio
        28  63be6904847c3692a84b9b70    Business and Professional Services > Manufacturer
        28  4bf58dd8d48988d1b7941735    Community and Government > Education > College and University > College Soccer Field
        28  4c2cd86ed066bed06c3c5209    Dining and Drinking > Restaurant > Gluten-Free Restaurant
        27  4bf58dd8d48988d18b941735    Arts and Entertainment > Stadium > Basketball Stadium
        27  4bf58dd8d48988d185941735    Arts and Entertainment > Stadium > Hockey Stadium
        27  5744ccdfe4b0c0459246b4c7    Business and Professional Services > Child Care Service
        27  4bf58dd8d48988d1c3941735    Dining and Drinking > Restaurant > Moroccan Restaurant
        27  58daa1558bbb0b01f18ec1f7    Health and Medicine > Hospital > Hospital Unit
        27  63be6904847c3692a84b9bd7    Health and Medicine > Physician > Pediatrician
        27  52e81612bcbc57f1066b7a0f    Sports and Recreation > Fishing Area
        26  52e81612bcbc57f1066b79e7    Arts and Entertainment > Circus
        26  52e81612bcbc57f1066b79eb    Arts and Entertainment > Mini Golf Course
        26  63be6904847c3692a84b9bc3    Health and Medicine > Nurse
        26  63be6904847c3692a84b9bd9    Health and Medicine > Physician > Psychiatrist
        26  5032848691d4c4b30a586d61    Landmarks and Outdoors > Volcano
        25  56aa371be4b08b9a8d573554    Business and Professional Services > Entertainment Service
        25  63be6904847c3692a84b9b5a    Business and Professional Services > Home Improvement Service > Kitchen Remodeler
        25  56aa371be4b08b9a8d573552    Business and Professional Services > Rental Service
        25  52e81612bcbc57f1066b7a10    Community and Government > Summer Camp
        25  4bf58dd8d48988d1cd941735    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant
        25  56aa371be4b08b9a8d573544    Landmarks and Outdoors > Bay
        25  52f2ab2ebcbc57f1066b8b50    Travel and Transportation > Cable Car
        24  54f4ba06498e2cf5561da814    Business and Professional Services > Office > Corporate Cafeteria
        24  58daa1558bbb0b01f18ec1b2    Business and Professional Services > Research Station
        24  58daa1558bbb0b01f18ec1ac    Business and Professional Services > Waste Management Service
        24  4bf58dd8d48988d1ac941735    Community and Government > Education > College and University > College Theater
        24  4bf58dd8d48988d106941735    Sports and Recreation > Running and Track > Track
        24  4eb1bf013b7b6f98df247e07    Sports and Recreation > Volleyball Court
        23  5310b8e5bcbc57f1066bcbf1    Community and Government > Prison
        23  52e81612bcbc57f1066b7a40    Community and Government > Spiritual Center > Monastery
        23  4bf58dd8d48988d1c2941735    Dining and Drinking > Restaurant > Molecular Gastronomy Restaurant
        23  52f2ab2ebcbc57f1066b8b2c    Retail > Food and Beverage Retail > Herbs and Spices Store
        23  52f2ab2ebcbc57f1066b8b22    Retail > Outdoor Supply Store
        23  52f2ab2ebcbc57f1066b8b34    Retail > Pawn Shop
        22  63be6904847c3692a84b9b24    Arts and Entertainment > Party Center
        22  63be6904847c3692a84b9b92    Business and Professional Services > Technology Business > Website Designer
        22  58daa1558bbb0b01f18ec200    Community and Government > Education > Culinary School
        22  58daa1558bbb0b01f18ec1cd    Dining and Drinking > Restaurant > Middle Eastern Restaurant > Lebanese Restaurant
        22  5fabfe3599ce226e27fe709a    Landmarks and Outdoors > Park > Picnic Area
        22  5bae9231bedf3950379f89c7    Landmarks and Outdoors > Windmill
        22  58daa1558bbb0b01f18ec1ca    Retail > Food and Beverage Retail > Dairy Store
        21  63be6904847c3692a84b9b2c    Business and Professional Services > Automotive Service > Motorcycle Repair Shop
        21  63be6904847c3692a84b9b5b    Business and Professional Services > Home Improvement Service > Landscaper and Gardener
        21  4bf58dd8d48988d11c941735    Dining and Drinking > Bar > Sake Bar
        21  52e81612bcbc57f1066b7a0a    Dining and Drinking > Dessert Shop > Pie Shop
        21  52e81612bcbc57f1066b79fe    Dining and Drinking > Restaurant > Hawaiian Restaurant
        21  5283c7b4e4b094cb91ec88d8    Dining and Drinking > Restaurant > Turkish Restaurant > Doner Restaurant
        21  52f2ab2ebcbc57f1066b8b3a    Retail > Fireworks Store
        21  52f2ab2ebcbc57f1066b8b3d    Retail > Pop-Up Store
        20  4bf58dd8d48988d19a941735    Community and Government > Education > College and University > College Communications Building
        20  5744ccdfe4b0c0459246b4c4    Community and Government > Public Bathroom
        20  4bf58dd8d48988d10d941735    Dining and Drinking > Restaurant > German Restaurant
        20  5267e4d8e4b0ec79466e48c5    Event > Marketplace > Street Fair
        20  63be6904847c3692a84b9bd5    Health and Medicine > Physician > Orthopedic Surgeon
        20  56aa371be4b08b9a8d573562    Landmarks and Outdoors > Canal
        20  55888a5a498e782e3303b43a    Retail > Furniture and Home Store > Lighting Store
        20  4f452cd44b9081a197eba860    Sports and Recreation > Hockey > Hockey Field
        19  52f2ab2ebcbc57f1066b8b43    Arts and Entertainment > Psychic and Astrologer
        19  4bf58dd8d48988d189941735    Arts and Entertainment > Stadium > Football Stadium
        19  63be6904847c3692a84b9b2a    Business and Professional Services > Automation and Control System
        19  4bf58dd8d48988d1e8931735    Dining and Drinking > Bar > Piano Bar
        19  52e81612bcbc57f1066b79fb    Dining and Drinking > Restaurant > Asian Restaurant > Himalayan Restaurant
        19  4bf58dd8d48988d1be941735    Dining and Drinking > Restaurant > Latin American Restaurant
        19  4bf58dd8d48988d152941735    Dining and Drinking > Restaurant > Latin American Restaurant > Arepa Restaurant
        19  5267e4d9e4b0ec79466e48c6    Event > Conference
        19  52e81612bcbc57f1066b7a30    Landmarks and Outdoors > Nudist Beach
        19  5bae9231bedf3950379f89d0    Landmarks and Outdoors > Park > State or Provincial Park
        19  58daa1558bbb0b01f18ec203    Sports and Recreation > Gym and Studio > Outdoor Gym
        19  4eb1bc533b7b2c5b1d4306cb    Travel and Transportation > Transport Hub > Airport > Airport Lounge
        18  63be6904847c3692a84b9b6d    Business and Professional Services > Logging Service
        18  63be6904847c3692a84b9b88    Business and Professional Services > Real Estate Service > Real Estate Development and Title Company
        18  63be6904847c3692a84b9bd1    Health and Medicine > Physician > Obstetrician Gynecologist (Ob-gyn)
        18  56aa371be4b08b9a8d57355e    Landmarks and Outdoors > Bike Trail
        18  63be6904847c3692a84b9be0    Landmarks and Outdoors > Park > Natural Park
        18  52f2ab2ebcbc57f1066b8b17    Retail > Costume Store
        18  52f2ab2ebcbc57f1066b8b2a    Retail > Furniture and Home Store > Carpet Store
        18  52f2ab2ebcbc57f1066b8b4e    Travel and Transportation > Toll Plaza
        17  52e81612bcbc57f1066b79ec    Arts and Entertainment > Salsa Club
        17  58daa1548bbb0b01f18ec1a9    Business and Professional Services > Power Plant
        17  53e510b7498ebcb1801b55d4    Dining and Drinking > Night Market
        17  4bf58dd8d48988d157941735    Dining and Drinking > Restaurant > American Restaurant > New American Restaurant
        17  4bf58dd8d48988d1f5931735    Dining and Drinking > Restaurant > Asian Restaurant > Chinese Restaurant > Dim Sum Restaurant
        17  4bf58dd8d48988d153941735    Dining and Drinking > Restaurant > Mexican Restaurant > Burrito Restaurant
        17  4d4b7105d754a06373d81259    Event
        17  53e0feef498e5aac066fd8a9    Event > Marketplace > Street Food Gathering
        17  63be6904847c3692a84b9bcf    Health and Medicine > Physician > Internal Medicine Doctor
        17  56aa371be4b08b9a8d573564    Retail > Food and Beverage Retail > Sausage Store
        17  503289d391d4c4b30a586d6a    Sports and Recreation > Gym and Studio > Climbing Gym
        16  63be6904847c3692a84b9b94    Business and Professional Services > Translation Service
        16  4bf58dd8d48988d141941735    Community and Government > Education > College and University > Sorority House
        16  52e81612bcbc57f1066b7a49    Community and Government > Education > Flight School
        16  56aa371be4b08b9a8d573558    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Venezuelan Restaurant
        16  63be6904847c3692a84b9bc8    Health and Medicine > Physician > Cardiologist
        16  63be6904847c3692a84b9bcc    Health and Medicine > Physician > Gastroenterologist
        16  5e8f50bd03c7a9000c1e2fbc    Retail > Automotive Retail > Car Dealership > New Car Dealership
        16  63be6904847c3692a84b9bf9    Retail > Sporting Goods Retail > Surf Store
        15  52e81612bcbc57f1066b79ef    Arts and Entertainment > Country Dance Club
        15  63be6904847c3692a84b9b48    Business and Professional Services > Geological Service
        15  63be6904847c3692a84b9b6e    Business and Professional Services > Machine Shop
        15  5665ef1d498ec706735f0e59    Business and Professional Services > Office > Corporate Amenity
        15  63be6904847c3692a84b9b8e    Business and Professional Services > Search Engine Marketing and Optimization Service
        15  63be6904847c3692a84b9be1    Landmarks and Outdoors > Park > Urban Park
        15  4bf58dd8d48988d168941735    Sports and Recreation > Skating > Skating Rink
        15  5744ccdfe4b0c0459246b4e5    Travel and Transportation > Transport Hub > Airport > Baggage Claim
        14  52e81612bcbc57f1066b79e6    Arts and Entertainment > Laser Tag Center
        14  63be6904847c3692a84b9b40    Business and Professional Services > Financial Service > Business Broker
        14  52e81612bcbc57f1066b7a27    Business and Professional Services > Health and Beauty Service > Bath House
        14  503288ae91d4c4b30a586d67    Dining and Drinking > Restaurant > Afghan Restaurant
        14  5bae9231bedf3950379f89c5    Event > Entertainment Event > Sporting Event
        14  56aa371be4b08b9a8d573541    Landmarks and Outdoors > Reservoir
        14  63be6904847c3692a84b9bed    Retail > Fashion Retail > Sunglasses Store
        14  4bf58dd8d48988d1e9941735    Sports and Recreation > Snow Sports > Ski Resort and Area
        14  63be6904847c3692a84b9c21    Sports and Recreation > Water Sports > Surfing
        13  63be6904847c3692a84b9b2f    Business and Professional Services > Automotive Service > Tire Repair Shop
        13  63be6904847c3692a84b9b96    Business and Professional Services > Water Treatment Service
        13  52af3a7c3cf9994f4e043bed    Dining and Drinking > Restaurant > Asian Restaurant > Chinese Restaurant > Cantonese Restaurant
        13  63be6904847c3692a84b9bb7    Event > Entertainment Event
        13  63be6904847c3692a84b9be9    Retail > Cannabis Store
        13  63be6904847c3692a84b9bf8    Retail > Sporting Goods Retail > Soccer Store
        13  52f2ab2ebcbc57f1066b8b4d    Travel and Transportation > Toll Booth
        12  58daa1558bbb0b01f18ec1fd    Arts and Entertainment > Zoo > Zoo Exhibit
        12  5f2c1e0db6d05514c70436d4    Business and Professional Services > Automotive Service > Vehicle Inspection Station
        12  63be6904847c3692a84b9b4a    Business and Professional Services > Health and Beauty Service > Hair Removal Service
        12  63be6904847c3692a84b9b50    Business and Professional Services > Home Improvement Service > Deck and Patio Contractor
        12  63be6904847c3692a84b9b5c    Business and Professional Services > Home Improvement Service > Mover
        12  52f2ab2ebcbc57f1066b8b38    Business and Professional Services > Lottery Retailer
        12  5665c7b9498e7d8a4f2c0f06    Business and Professional Services > Office > Corporate Coffee Shop
        12  63be6904847c3692a84b9b76    Business and Professional Services > Office > Office Building
        12  63be6904847c3692a84b9b78    Business and Professional Services > Paper Supplier
        12  5293a7d53cf9994f4e043a45    Dining and Drinking > Restaurant > Caucasian Restaurant
        12  54135bf5e4b08f3d2429dfdd    Dining and Drinking > Restaurant > Indian Restaurant > North Indian Restaurant
        12  4bf58dd8d48988d1c6941735    Dining and Drinking > Restaurant > Scandinavian Restaurant
        12  5fac018b99ce226e27fe7573    Landmarks and Outdoors > Dam
        12  5744ccdfe4b0c0459246b4cd    Retail > Supplement Store
        12  63be6904847c3692a84b9c10    Sports and Recreation > Racquet Sports > Racquet Sport Club
        12  63be6904847c3692a84b9c1b    Sports and Recreation > Soccer > Soccer Club
        11  52e81612bcbc57f1066b79e9    Arts and Entertainment > Roller Rink
        11  63be6904847c3692a84b9b66    Business and Professional Services > Human Resources Agency
        11  63be6904847c3692a84b9b8a    Business and Professional Services > Renewable Energy Service
        11  63be6904847c3692a84b9b91    Business and Professional Services > Technology Business > Software Company
        11  5744ccdfe4b0c0459246b4d9    Community and Government > Observatory
        11  4deefc054765f83613cdba6f    Dining and Drinking > Restaurant > Asian Restaurant > Indonesian Restaurant
        11  52e81612bcbc57f1066b7a02    Dining and Drinking > Restaurant > Belgian Restaurant
        11  52e81612bcbc57f1066b7a09    Dining and Drinking > Restaurant > Fondue Restaurant
        11  4bf58dd8d48988d14f941735    Dining and Drinking > Restaurant > Southern Food Restaurant
        11  52e928d0bcbc57f1066b7e96    Dining and Drinking > Restaurant > Ukrainian Restaurant
        11  62d587aeda6648532de2b88c    Event > Entertainment Event > Festival > Beer Festival
        11  63be6904847c3692a84b9bbd    Health and Medicine > Emergency Service > Ambulance Service
        11  63be6904847c3692a84b9bbf    Health and Medicine > Home Health Care Service
        11  63be6904847c3692a84b9be2    Retail > Auction House
        11  52f2ab2ebcbc57f1066b8b19    Retail > Sporting Goods Retail > Gun Store
        11  56aa371be4b08b9a8d573514    Sports and Recreation > Race Track > Racecourse
        11  63be6904847c3692a84b9c28    Travel and Transportation > Transport Hub
        10  4bf58dd8d48988d192941735    Arts and Entertainment > Planetarium
        10  63be6904847c3692a84b9b38    Business and Professional Services > Direct Mail and Email Marketing Service
        10  63be6904847c3692a84b9b6f    Business and Professional Services > Management Consultant
        10  63be6904847c3692a84b9b89    Business and Professional Services > Refrigeration and Ice Supplier
        10  4bf58dd8d48988d1b4941735    Community and Government > Education > College and University > College Stadium
        10  57558b36e4b065ecebd306b0    Dining and Drinking > Restaurant > French Restaurant > Brasserie
        10  54135bf5e4b08f3d2429dfde    Dining and Drinking > Restaurant > Indian Restaurant > South Indian Restaurant
        10  56aa371be4b08b9a8d5734ff    Health and Medicine > Maternity Clinic
        10  56aa371be4b08b9a8d57353b    Landmarks and Outdoors > Canal Lock
        10  52f2ab2ebcbc57f1066b8b30    Retail > Bookstore > Used Bookstore
        10  52e81612bcbc57f1066b7a29    Sports and Recreation > Water Sports > Rafting Spot
        10  69d41dd556ec6a4ded8e8258    Travel and Transportation > Lodging > Hotel > Hotel Gym
         9  4bf58dd8d48988d187941735    Arts and Entertainment > Stadium > Track Stadium
         9  5032850891d4c4b30a586d62    Business and Professional Services > Financial Service > Banking and Finance > Credit Union
         9  698b7b3e05512d4553149a5d    Business and Professional Services > Health and Beauty Service > Brow Bar
         9  63be6904847c3692a84b9b79    Business and Professional Services > Pet Service > Pet Grooming Service
         9  63be6904847c3692a84b9b7d    Business and Professional Services > Photography Service
         9  5bae9231bedf3950379f89e4    Dining and Drinking > Restaurant > Middle Eastern Restaurant > Shawarma Restaurant
         9  52f2ab2ebcbc57f1066b8b3b    Event > Marketplace > Christmas Market
         9  5bae9231bedf3950379f89cd    Landmarks and Outdoors > Hill
         9  56aa371be4b08b9a8d57354a    Retail > Mobility Store
         9  63be6904847c3692a84b9c1d    Sports and Recreation > Water Sports > Canoe and Kayak Rental
         8  63be6904847c3692a84b9b3f    Business and Professional Services > Financial Service > Banking and Finance
         8  63be6904847c3692a84b9b69    Business and Professional Services > Laboratory
         8  63be6904847c3692a84b9b72    Business and Professional Services > Media Agency
         8  63be6904847c3692a84b9b97    Business and Professional Services > Welding Service
         8  63be6904847c3692a84b9b9f    Community and Government > Education > Art School
         8  4bf58dd8d48988d19c941735    Community and Government > Education > College and University > College Math Building
         8  63be6904847c3692a84b9bb3    Community and Government > Senior Citizen Service
         8  56aa371be4b08b9a8d57354d    Dining and Drinking > Bar > Tiki Bar
         8  4bf58dd8d48988d169941735    Dining and Drinking > Restaurant > Australian Restaurant
         8  4bf58dd8d48988d144941735    Dining and Drinking > Restaurant > Caribbean Restaurant
         8  5744ccdfe4b0c0459246b4d0    Dining and Drinking > Restaurant > Dutch Restaurant
         8  52e81612bcbc57f1066b7a05    Dining and Drinking > Restaurant > English Restaurant
         8  4bf58dd8d48988d1bf941735    Dining and Drinking > Restaurant > Mac and Cheese Joint
         8  5bae9231bedf3950379f89da    Dining and Drinking > Restaurant > Middle Eastern Restaurant > Syrian Restaurant
         8  52e81612bcbc57f1066b79f8    Dining and Drinking > Restaurant > Pakistani Restaurant
         8  63be6904847c3692a84b9bb8    Event > Marketplace
         8  63be6904847c3692a84b9bc1    Health and Medicine > Mental Health Service
         8  63be6904847c3692a84b9bc5    Health and Medicine > Other Healthcare Professional
         8  63be6904847c3692a84b9bca    Health and Medicine > Physician > Ear, Nose and Throat Doctor
         8  63be6904847c3692a84b9bdd    Health and Medicine > Podiatrist
         8  56aa371be4b08b9a8d573526    Health and Medicine > Urgent Care Center
         8  59d79d6b2e268052fa2a3332    Retail > Automotive Retail > Motorsports Store
         8  589ddde98ae3635c072819ee    Retail > Duty-free Store
         8  56aa371be4b08b9a8d573505    Retail > Floating Market
         8  63be6904847c3692a84b9c08    Sports and Recreation > Golf
         8  63be6904847c3692a84b9c0e    Sports and Recreation > Personal Trainer
         8  63be6904847c3692a84b9c13    Sports and Recreation > Racquet Sports > Tennis > Tennis Club
         8  58daa1558bbb0b01f18ec1ae    Sports and Recreation > Sauna
         7  63be6904847c3692a84b9b3c    Business and Professional Services > Equipment Rental Service
         7  63be6904847c3692a84b9b7a    Business and Professional Services > Pet Service > Pet Sitting and Boarding Service
         7  63be6904847c3692a84b9b7b    Business and Professional Services > Petroleum Supplier
         7  63be6904847c3692a84b9b82    Business and Professional Services > Publisher
         7  63be6904847c3692a84b9b95    Business and Professional Services > Tutoring Service
         7  4bf58dd8d48988d19d941735    Community and Government > Education > College and University > College History Building
         7  5267e4d9e4b0ec79466e48c9    Event > Convention
         7  52741d85e4b0d5d1e3c6a6d9    Event > Entertainment Event > Parade
         7  63be6904847c3692a84b9bcd    Health and Medicine > Physician > General Surgeon
         7  63be6904847c3692a84b9bd8    Health and Medicine > Physician > Plastic Surgeon
         7  5fabfc8099ce226e27fe6b0d    Landmarks and Outdoors > Boat Launch
         7  5bae9231bedf3950379f89d2    Retail > Sporting Goods Retail > Skate Store
         7  4bf58dd8d48988d1e8941735    Sports and Recreation > Baseball > Baseball Field
         7  63be6904847c3692a84b9c07    Sports and Recreation > Football > Football Field
         7  52e81612bcbc57f1066b7a2d    Sports and Recreation > Racquet Sports > Squash Court
         7  52e81612bcbc57f1066b7a44    Sports and Recreation > Water Sports > Swimming > Swim School
         7  56aa371ce4b08b9a8d57356e    Travel and Transportation > Transport Hub > Heliport
         7  5f2c1af1b6d05514c704319d    Travel and Transportation > Transport Hub > Marine Terminal
         6  56aa371be4b08b9a8d5734cf    Business and Professional Services > Ballroom
         6  63be6904847c3692a84b9b39    Business and Professional Services > Electrical Equipment Supplier
         6  63be6904847c3692a84b9b43    Business and Professional Services > Financial Service > Financial Planner
         6  63be6904847c3692a84b9b47    Business and Professional Services > Food and Beverage Service > Food Distribution Center
         6  63be6904847c3692a84b9b4c    Business and Professional Services > Home Improvement Service > Bathroom Contractor
         6  4bf58dd8d48988d1b8941735    Community and Government > Education > College and University > College Football Field
         6  4bf58dd8d48988d1b6941735    Community and Government > Education > College and University > College Track
         6  63be6904847c3692a84b9ba3    Community and Government > Government Building > Law Enforcement and Public Safety
         6  4eb1bd1c3b7b55596b4a748f    Dining and Drinking > Restaurant > Asian Restaurant > Filipino Restaurant
         6  55a59bace4b013909087cb30    Dining and Drinking > Restaurant > Asian Restaurant > Japanese Restaurant > Japanese Curry Restaurant
         6  5e179ee74ae8e90006e9a746    Dining and Drinking > Restaurant > Bangladeshi Restaurant
         6  4bf58dd8d48988d154941735    Dining and Drinking > Restaurant > Caribbean Restaurant > Cuban Restaurant
         6  56aa371ae4b08b9a8d5734ba    Dining and Drinking > Restaurant > Mexican Restaurant > Tex-Mex Restaurant
         6  56aa371be4b08b9a8d573529    Dining and Drinking > Restaurant > Middle Eastern Restaurant > Israeli Restaurant
         6  5293a7563cf9994f4e043a44    Dining and Drinking > Restaurant > Russian Restaurant
         6  4bf58dd8d48988d158941735    Dining and Drinking > Restaurant > Swiss Restaurant
         6  63be6904847c3692a84b9bc7    Health and Medicine > Physician > Anesthesiologist
         6  5fac010d99ce226e27fe7467    Landmarks and Outdoors > Picnic Shelter
         6  56aa371be4b08b9a8d57352c    Sports and Recreation > Hockey > Hockey Rink
         5  4bf58dd8d48988d136941735    Arts and Entertainment > Performing Arts Venue > Opera House
         5  63be6904847c3692a84b9b54    Business and Professional Services > Home Improvement Service > Garage Door Supplier
         5  63be6904847c3692a84b9b8b    Business and Professional Services > Rubber Supplier
         5  63be6904847c3692a84b9ba0    Community and Government > Education > Computer Training School
         5  52e81612bcbc57f1066b7a47    Community and Government > Education > Religious School
         5  63be6904847c3692a84b9bab    Community and Government > Organization > Charity
         5  52e81612bcbc57f1066b7a3e    Community and Government > Spiritual Center > Buddhist Temple
         5  56aa371be4b08b9a8d573508    Dining and Drinking > Cafe, Coffee, and Tea House > Pet Café
         5  52af0bd33cf9994f4e043bdd    Dining and Drinking > Restaurant > Asian Restaurant > Hotpot Restaurant
         5  4bf58dd8d48988d17a941735    Dining and Drinking > Restaurant > Cajun and Creole Restaurant
         5  52e81612bcbc57f1066b79f7    Dining and Drinking > Restaurant > Middle Eastern Restaurant > Persian Restaurant
         5  5bae9231bedf3950379f89c3    Event > Marketplace > Trade Fair
         5  590a0744340a5803fd8508c3    Health and Medicine > Weight Loss Center
         5  5e18993feee47d000759b256    Retail > Food and Beverage Retail > Coffee Roaster
         5  5744ccdfe4b0c0459246b4df    Retail > Outlet Mall
         5  63be6904847c3692a84b9c06    Sports and Recreation > Football > Football Club
         5  52f2ab2ebcbc57f1066b8b47    Sports and Recreation > Gym and Studio > Boxing Gym
         5  63be6904847c3692a84b9c1a    Sports and Recreation > Soccer
         5  63be6904847c3692a84b9c1c    Sports and Recreation > Water Sports
         5  63be6904847c3692a84b9c29    Travel and Transportation > Transport Hub > Airport > International Airport
         4  63be6904847c3692a84b9b21    Arts and Entertainment > Carnival
         4  5f2c14a5b6d05514c7042eb7    Arts and Entertainment > VR Cafe
         4  63be6904847c3692a84b9b57    Business and Professional Services > Home Improvement Service > Home Inspection
         4  63be6904847c3692a84b9b77    Business and Professional Services > Online Advertising Service
         4  4bf58dd8d48988d1ba941735    Community and Government > Education > College and University > College Basketball Court
         4  52e81612bcbc57f1066b7a0e    Dining and Drinking > Bar > Champagne Bar
         4  4bf58dd8d48988d10a941735    Dining and Drinking > Restaurant > African Restaurant > Ethiopian Restaurant
         4  52af3b773cf9994f4e043c03    Dining and Drinking > Restaurant > Asian Restaurant > Chinese Restaurant > Szechuan Restaurant
         4  52af3b813cf9994f4e043c04    Dining and Drinking > Restaurant > Asian Restaurant > Chinese Restaurant > Taiwanese Restaurant
         4  4bf58dd8d48988d156941735    Dining and Drinking > Restaurant > Asian Restaurant > Malay Restaurant
         4  52af39fb3cf9994f4e043be9    Dining and Drinking > Restaurant > Asian Restaurant > Tibetan Restaurant
         4  5f2c1c31b6d05514c704334c    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Peruvian Restaurant > Peruvian Roast Chicken Joint
         4  4bf58dd8d48988d14d941735    Dining and Drinking > Restaurant > Spanish Restaurant > Paella Restaurant
         4  63be6904847c3692a84b9bc9    Health and Medicine > Physician > Dermatologist
         4  63be6904847c3692a84b9bdf    Health and Medicine > Women's Health Clinic
         4  63be6904847c3692a84b9bee    Retail > Fashion Retail > Swimwear Store
         4  5f2c41945b4c177b9a6dc7d6    Retail > Food and Beverage Retail > Imported Food Store
         4  63be6904847c3692a84b9c04    Sports and Recreation > Equestrian Facility
         4  63be6904847c3692a84b9c0f    Sports and Recreation > Racquet Sports
         4  63be6904847c3692a84b9c16    Sports and Recreation > Running and Track > Running Club
         4  4bf58dd8d48988d1ec941735    Sports and Recreation > Snow Sports > Ski Chalet
         4  4bf58dd8d48988d1eb941735    Sports and Recreation > Snow Sports > Ski Lodge
         4  4eb1c0f63b7b52c0e1adc2eb    Sports and Recreation > Snow Sports > Ski Resort and Area > Ski Trail
         4  4bf58dd8d48988d1ec931735    Travel and Transportation > Transport Hub > Airport > Airport Tram Station
         4  63be6904847c3692a84b9c2b    Travel and Transportation > Transportation Service > Charter Bus
         3  63be6904847c3692a84b9b22    Arts and Entertainment > Country Club
         3  4bf58dd8d48988d18c941735    Arts and Entertainment > Stadium > Baseball Stadium
         3  63be6904847c3692a84b9b25    Arts and Entertainment > Ticket Seller
         3  63be6904847c3692a84b9b30    Business and Professional Services > Automotive Service > Towing Service
         3  63be6904847c3692a84b9b37    Business and Professional Services > Creative Service
         3  52f2ab2ebcbc57f1066b8b2d    Business and Professional Services > Financial Service > Check Cashing Service
         3  63be6904847c3692a84b9b41    Business and Professional Services > Financial Service > Collections Service
         3  63be6904847c3692a84b9b5e    Business and Professional Services > Home Improvement Service > Pest Control Service
         3  63be6904847c3692a84b9bac    Community and Government > Organization > Environmental Organization
         3  62d5af45da6648532de303ee    Dining and Drinking > Dessert Shop > Waffle Shop
         3  52e81612bcbc57f1066b7a01    Dining and Drinking > Restaurant > Austrian Restaurant
         3  54135bf5e4b08f3d2429dfe4    Dining and Drinking > Restaurant > Indian Restaurant > Indian Sweet Shop
         3  58daa1558bbb0b01f18ec1f4    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Colombian Restaurant
         3  5f2c43a65b4c177b9a6dcc62    Health and Medicine > Blood Bank
         3  5f2c5b8b5b4c177b9a6ddf0b    Health and Medicine > Hospice
         3  55a5a1ebe4b013909087cb77    Landmarks and Outdoors > Mountain Hut
         3  69d41dd556ec6a4ded8e825b    Landmarks and Outdoors > Pass
         3  5345731ebcbc57f1066c39b2    Landmarks and Outdoors > States and Municipalities > County
         3  530e33ccbcbc57f1066bbff8    Landmarks and Outdoors > States and Municipalities > State
         3  63be6904847c3692a84b9be4    Retail > Automotive Retail > Car Dealership > Classic and Antique Car Dealership
         3  63be6904847c3692a84b9be5    Retail > Automotive Retail > Car Dealership > RV and Motorhome Dealership
         3  52f2ab2ebcbc57f1066b8b18    Retail > Comic Book Store
         3  63be6904847c3692a84b9bf6    Retail > Sporting Goods Retail > Golf Store
         3  63be6904847c3692a84b9bfa    Retail > Sporting Goods Retail > Tennis Store
         3  63be6904847c3692a84b9bfd    Sports and Recreation > Athletic Field
         3  52e81612bcbc57f1066b7a2c    Sports and Recreation > Rugby > Rugby Pitch
         3  63be6904847c3692a84b9c15    Sports and Recreation > Running and Track
         3  63be6904847c3692a84b9c18    Sports and Recreation > Skydiving Center
         2  63be6904847c3692a84b9b23    Arts and Entertainment > Dance Hall
         2  52e81612bcbc57f1066b79e8    Arts and Entertainment > Disc Golf
         2  63be6904847c3692a84b9b3b    Business and Professional Services > Entertainment Agency
         2  63be6904847c3692a84b9b46    Business and Professional Services > Food and Beverage Service > Caterer
         2  63be6904847c3692a84b9b4f    Business and Professional Services > Home Improvement Service > Chimney Sweep
         2  63be6904847c3692a84b9b62    Business and Professional Services > Home Improvement Service > Sewer Contractor
         2  63be6904847c3692a84b9b64    Business and Professional Services > Home Improvement Service > Tree Service
         2  63be6904847c3692a84b9b6a    Business and Professional Services > Leather Supplier
         2  63be6904847c3692a84b9b75    Business and Professional Services > Office > Corporate Housing Agency
         2  63be6904847c3692a84b9b7f    Business and Professional Services > Print, TV, Radio and Outdoor Advertising Service
         2  63be6904847c3692a84b9b8d    Business and Professional Services > Scientific Equipment Supplier
         2  52e81612bcbc57f1066b7a43    Community and Government > Education > Circus School
         2  4e39a9cebd410d7aed40cbc4    Community and Government > Education > College and University > College Tennis Court
         2  63be6904847c3692a84b9ba6    Community and Government > Government Building > Military
         2  63be6904847c3692a84b9ba8    Community and Government > Homeless Shelter
         2  63be6904847c3692a84b9ba9    Community and Government > Housing Authority
         2  63be6904847c3692a84b9baf    Community and Government > Organization > Social Services Organization
         2  63be6904847c3692a84b9bb0    Community and Government > Organization > Youth Organization
         2  5744ccdfe4b0c0459246b4ac    Community and Government > Spiritual Center > Kingdom Hall
         2  5f2c40f15b4c177b9a6dc684    Dining and Drinking > Bar > Ice Bar
         2  58daa1558bbb0b01f18ec1d3    Dining and Drinking > Restaurant > Asian Restaurant > Chinese Restaurant > Cha Chaan Teng
         2  4eb1d5724b900d56c88a45fe    Dining and Drinking > Restaurant > Asian Restaurant > Mongolian Restaurant
         2  5f2c430e5b4c177b9a6dcabd    Dining and Drinking > Restaurant > Asian Restaurant > Singaporean Restaurant
         2  54135bf5e4b08f3d2429dfdf    Dining and Drinking > Restaurant > Indian Chinese Restaurant
         2  54135bf5e4b08f3d2429dfe2    Dining and Drinking > Restaurant > Indian Restaurant > Chaat Place
         2  52e81612bcbc57f1066b79fc    Dining and Drinking > Restaurant > Jewish Restaurant > Kosher Restaurant
         2  5bae9231bedf3950379f89e1    Dining and Drinking > Restaurant > Middle Eastern Restaurant > Egyptian Restaurant
         2  52e81612bcbc57f1066b7a04    Dining and Drinking > Restaurant > Polish Restaurant
         2  5413605de4b0ae91d18581a9    Dining and Drinking > Restaurant > Sri Lankan Restaurant
         2  52f2ab2ebcbc57f1066b8b54    Event > Marketplace > Stoop Sale
         2  63be6904847c3692a84b9bcb    Health and Medicine > Physician > Family Medicine Doctor
         2  63be6904847c3692a84b9bd2    Health and Medicine > Physician > Oncologist
         2  63be6904847c3692a84b9bde    Health and Medicine > Sports Medicine Clinic
         2  69d41dd556ec6a4ded8e825a    Landmarks and Outdoors > Nature Trail
         2  69d41dd556ec6a4ded8e8265    Landmarks and Outdoors > Ruin
         2  63be6904847c3692a84b9bf4    Retail > Party Supply Store
         2  63be6904847c3692a84b9bfb    Retail > Swimming Pool Supply Store
         2  52e81612bcbc57f1066b7a2f    Sports and Recreation > Bowling Green
         2  56aa371be4b08b9a8d57351a    Sports and Recreation > Curling Ice
         2  63be6904847c3692a84b9c05    Sports and Recreation > Football
         2  58daa1558bbb0b01f18ec1b0    Sports and Recreation > Golf > Golf Driving Range
         2  63be6904847c3692a84b9c0a    Sports and Recreation > Gymnastics
         2  4eb1c0ed3b7b52c0e1adc2ea    Sports and Recreation > Snow Sports > Ski Resort and Area > Ski Chairlift
         2  63be6904847c3692a84b9c1f    Sports and Recreation > Water Sports > Sailing Club
         2  69d41dd556ec6a4ded8e8274    Travel and Transportation > Elevator
         2  4bf58dd8d48988d1ef931735    Travel and Transportation > Transport Hub > Airport > Airport Food Court
         1  63be6904847c3692a84b9b20    Arts and Entertainment > Bingo Center
         1  63be6904847c3692a84b9c03    Arts and Entertainment > Disc Golf Course
         1  4bf58dd8d48988d1f1931735    Arts and Entertainment > General Entertainment
         1  56aa371be4b08b9a8d5734de    Arts and Entertainment > Movie Theater > Drive-in Theater
         1  559acbe0498e472f1a53fa23    Arts and Entertainment > Museum > Erotic Museum
         1  56aa371be4b08b9a8d573556    Arts and Entertainment > Stadium > Rugby Stadium
         1  63be6904847c3692a84b9b27    Business and Professional Services > Appraiser
         1  63be6904847c3692a84b9b44    Business and Professional Services > Financial Service > Loans Agency
         1  63be6904847c3692a84b9b63    Business and Professional Services > Home Improvement Service > Swimming Pool Maintenance and Service
         1  63be6904847c3692a84b9b6c    Business and Professional Services > Legal Service > Immigration Attorney
         1  63be6904847c3692a84b9b71    Business and Professional Services > Market Research and Consulting Service
         1  63be6904847c3692a84b9b84    Business and Professional Services > Real Estate Service > Building and Land Surveyor
         1  63be6904847c3692a84b9b99    Business and Professional Services > Writing, Copywriting and Technical Writing Service
         1  63be6904847c3692a84b9b9c    Community and Government > Disabled Persons Service
         1  4bf58dd8d48988d1b5941735    Community and Government > Education > College and University > College Hockey Rink
         1  69d41dd556ec6a4ded8e8270    Community and Government > Education > Training Simulator
         1  69d41dd556ec6a4ded8e8276    Community and Government > Government Building > Post Office > Parcel Locker
         1  63be6904847c3692a84b9bb2    Community and Government > Retirement Home
         1  56aa371be4b08b9a8d5734f6    Community and Government > Spiritual Center > Terreiro
         1  5e189d71eee47d000759b7e2    Dining and Drinking > Meadery
         1  56aa371be4b08b9a8d57350e    Dining and Drinking > Restaurant > Asian Restaurant > Satay Restaurant
         1  5f2c2abab6d05514c70446e4    Dining and Drinking > Restaurant > Caribbean Restaurant > Puerto Rican Restaurant
         1  56aa371be4b08b9a8d5734f3    Dining and Drinking > Restaurant > Eastern European Restaurant > Bulgarian Restaurant
         1  52960bac3cf9994f4e043ac4    Dining and Drinking > Restaurant > Eastern European Restaurant > Romanian Restaurant
         1  53d6c1b0e4b02351e88a83d2    Dining and Drinking > Restaurant > Greek Restaurant > Taverna
         1  55a5a1ebe4b013909087cb79    Dining and Drinking > Restaurant > Italian Restaurant > Malga
         1  52e81612bcbc57f1066b79fd    Dining and Drinking > Restaurant > Jewish Restaurant
         1  52939aae3cf9994f4e043a37    Dining and Drinking > Restaurant > Latin American Restaurant > South American Restaurant > Brazilian Restaurant > Northeastern Brazilian Restaurant
         1  5283c7b4e4b094cb91ec88da    Dining and Drinking > Restaurant > Turkish Restaurant > Meyhane
         1  5283c7b4e4b094cb91ec88d4    Dining and Drinking > Restaurant > Turkish Restaurant > Turkish Home Cooking Restaurant
         1  63be6904847c3692a84b9bbb    Health and Medicine > Assisted Living Service
         1  63be6904847c3692a84b9bc0    Health and Medicine > Hospital > Children's Hospital
         1  63be6904847c3692a84b9bdb    Health and Medicine > Physician > Respiratory Doctor
         1  69d41dd556ec6a4ded8e8266    Landmarks and Outdoors > Garden > Community Garden
         1  69d41dd556ec6a4ded8e8272    Landmarks and Outdoors > Pond
         1  530e33ccbcbc57f1066bbff7    Landmarks and Outdoors > States and Municipalities > Country
         1  69d41dd556ec6a4ded8e8260    Landmarks and Outdoors > Tower
         1  63be6904847c3692a84b9be7    Retail > Automotive Retail > Moped Dealership
         1  63be6904847c3692a84b9be8    Retail > Automotive Retail > Motor Scooter Dealership
         1  63be6904847c3692a84b9beb    Retail > Dance Store
         1  63be6904847c3692a84b9bf5    Retail > Sporting Goods Retail > Baseball Store
         1  63be6904847c3692a84b9bf7    Retail > Sporting Goods Retail > Running Store
         1  63be6904847c3692a84b9bff    Sports and Recreation > Baseball > Baseball Club
         1  63be6904847c3692a84b9c12    Sports and Recreation > Racquet Sports > Tennis
         1  58daa1558bbb0b01f18ec1b9    Sports and Recreation > Skydiving Center > Skydiving Drop Zone
         1  63be6904847c3692a84b9c19    Sports and Recreation > Snow Sports
         1  63be6904847c3692a84b9c1e    Sports and Recreation > Water Sports > Rafting Outfitter
         1  63be6904847c3692a84b9c20    Sports and Recreation > Water Sports > Scuba Diving Instructor
         1  63be6904847c3692a84b9c2c    Travel and Transportation > Transportation Service > Limo Service
```

## Queries used

Totals:

```sql
-- open places
SELECT COUNT(*) FROM places.datasets.places_os
WHERE country = 'PT' AND date_closed IS NULL;

-- kept
SELECT COUNT(*) FROM places.datasets.places_os
WHERE country = 'PT' AND date_closed IS NULL
  AND list_has_any(fsq_category_ids, [<111 ids from category_ids.py>]);

-- rejected
SELECT COUNT(*) FROM places.datasets.places_os
WHERE country = 'PT' AND date_closed IS NULL
  AND NOT list_has_any(fsq_category_ids, [<111 ids>]);

-- no category at all (deliberately not under the rejected predicate: these
-- rows are NULL under both list_has_any and its negation)
SELECT COUNT(*) FROM places.datasets.places_os
WHERE country = 'PT' AND date_closed IS NULL
  AND (fsq_category_ids IS NULL OR len(fsq_category_ids) = 0);
```

Ranked breakdown:

```sql
SELECT category_id, any_value(category_label) AS category_label,
       COUNT(*) AS rejected_rows
FROM (
  SELECT unnest(fsq_category_ids) AS category_id,
         unnest(fsq_category_labels) AS category_label
  FROM places.datasets.places_os
  WHERE country = 'PT' AND date_closed IS NULL
    AND NOT list_has_any(fsq_category_ids, [<111 ids>])
)
GROUP BY category_id
ORDER BY rejected_rows DESC, category_label;
```

Recovery if the top N were added (N in 10, 20, 50, 100, 200):

```sql
SELECT COUNT(*) FROM places.datasets.places_os
WHERE country = 'PT' AND date_closed IS NULL
  AND NOT list_has_any(fsq_category_ids, [<111 ids>])
  AND list_has_any(fsq_category_ids, [<top N ids from the ranking above>]);
```

Unmapped descendants of mapped categories, and the rows they would recover:

```sql
SELECT category_id FROM places.datasets.categories_os
WHERE category_id NOT IN (SELECT unnest([<111 ids>]))
  AND (   level1_category_id IN (SELECT unnest([<111 ids>]))
       OR level2_category_id IN (SELECT unnest([<111 ids>]))
       OR level3_category_id IN (SELECT unnest([<111 ids>]))
       OR level4_category_id IN (SELECT unnest([<111 ids>]))
       OR level5_category_id IN (SELECT unnest([<111 ids>]))
       OR level6_category_id IN (SELECT unnest([<111 ids>])));   -- 533 rows

SELECT COUNT(*) FROM places.datasets.places_os
WHERE country = 'PT' AND date_closed IS NULL
  AND NOT list_has_any(fsq_category_ids, [<111 ids>])
  AND list_has_any(fsq_category_ids, [<those 533 ids>]);         -- 58,494
```

## Feeds into

- **KAN-404** — policy. A volume threshold is not viable; the descendant finding reframed the question, and KAN-404 has since dropped the allowlist altogether in favour of a `poi_candidate` staging table.
- **KAN-405** — the OSM half, unmeasured here. See the scope note above.
- **KAN-396** — butcher 1,077, fish market 487. Keep list confirmed.
- **KAN-400** — build the keep/drop list from the ranking above, not from inspection.
- **KAN-397** — the missing-category detector is the same query shape and should reuse `measure_rejected_categories.py`.

## Appendix — all 172 Business and Professional Services leaves

Complete, unfiltered, ranked by rejected rows. The parent prefix
`Business and Professional Services > ` is stripped from every line.

```
 6,297  4bf58dd8d48988d124941735  Office
 3,606  63be6904847c3692a84b9b3d  Financial Service
 3,560  63be6904847c3692a84b9b6b  Legal Service
 2,802  4eb1bea83b7b6f98df247e06  Factory
 2,543  52e81612bcbc57f1066b7a3d  Advertising Agency
 1,884  5032885091d4c4b30a586d66  Real Estate Service > Real Estate Agency
 1,471  52f2ab2ebcbc57f1066b8b2f  Repair Service
 1,459  54541900498ea6ccd0202697  Health and Beauty Service
 1,227  4bf58dd8d48988d125941735  Office > Tech Startup
 1,214  4bf58dd8d48988d174941735  Office > Coworking Space
 1,059  58daa1558bbb0b01f18ec1f1  Insurance Agency
 1,052  5453de49498eade8af355881  Business Service
   938  4bf58dd8d48988d171941735  Event Space
   631  4bf58dd8d48988d1f4941735  Design Studio
   577  63be6904847c3692a84b9b36  Construction
   514  52f2ab2ebcbc57f1066b8b33  Laundromat
   489  4eb1bdde3b7b55596b4a7490  Photography Service > Photography Lab
   463  63be6904847c3692a84b9b26  Agriculture and Forestry Service
   382  5454152e498ef71e2b9132c6  Event Service
   356  4f4534884b9074f6e4fb0174  Funeral Home
   354  52f2ab2ebcbc57f1066b8b3f  Legal Service > Law Office
   325  63be6904847c3692a84b9b98  Wholesaler
   321  52f2ab2ebcbc57f1066b8b1f  Shipping, Freight, and Material Transportation Service
   282  52f2ab2ebcbc57f1066b8b3c  Health and Beauty Service > Massage Clinic
   270  63be6904847c3692a84b9b49  Health and Beauty Service > Barbershop
   248  5032781d91d4c4b30a586d5b  Tailor
   243  63be6904847c3692a84b9b87  Real Estate Service > Real Estate Appraiser
   239  5032897c91d4c4b30a586d69  Pet Service
   238  4bf58dd8d48988d173941735  Auditorium
   229  554a5e17498efabeda6cc559  Photography Service > Photography Studio
   222  4f4532974b9074f6e4fb0104  Child Care Service > Daycare
   220  63be6904847c3692a84b9b35  Computer Repair Service
   210  56aa371be4b08b9a8d573517  Business Center
   198  5fac002599ce226e27fe72e5  Architecture Firm
   197  63be6904847c3692a84b9b73  Metals Supplier
   196  63be6904847c3692a84b9b68  Industrial Equipment Supplier
   171  4bf58dd8d48988d100941735  Convention Center > Conference Room
   169  4bf58dd8d48988d127941735  Office > Meeting Room
   167  52f2ab2ebcbc57f1066b8b36  Technology Business > IT Service
   155  5032856091d4c4b30a586d63  Radio Station
   149  52e81612bcbc57f1066b7a37  Distribution Center
   149  5ae95d208a6f17002ce792b2  Legal Service > Notary
   149  52f2ab2ebcbc57f1066b8b39  Shoe Repair Service
   147  63be6904847c3692a84b9b28  Art Restoration Service
   143  4f04b1572fb6e1c99f3db0bf  Storage Facility
   140  63be6904847c3692a84b9b32  Office > Business and Strategy Consulting Office
   139  4bf58dd8d48988d1ff931735  Convention Center
   139  52f2ab2ebcbc57f1066b8b1d  Health and Beauty Service > Dry Cleaner
   139  63be6904847c3692a84b9b4d  Home Improvement Service > Carpenter
   136  63be6904847c3692a84b9b60  Home Improvement Service > Professional Cleaning Service
   133  63be6904847c3692a84b9b7c  Photography Service > Photographer
   130  56aa371be4b08b9a8d573550  Food and Beverage Service
   123  63be6904847c3692a84b9b3a  Engineer
   121  63be6904847c3692a84b9b4b  Health and Beauty Service > Skin Care Clinic
   110  63be6904847c3692a84b9b58  Home Improvement Service
   107  52e81612bcbc57f1066b7a36  Warehouse
   102  63be6904847c3692a84b9b56  Home Improvement Service > Heating, Ventilating and Air Conditioning Contractor
   101  63be6904847c3692a84b9b29  Audiovisual Service
   101  63be6904847c3692a84b9b83  Real Estate Service
    97  63be6904847c3692a84b9b2b  Automotive Service
    93  63be6904847c3692a84b9b52  Home Improvement Service > Electrician
    88  4d1cf8421a97d635ce361c31  Health and Beauty Service > Tanning Salon
    88  5032764e91d4c4b30a586d5a  Office > Campaign Office
    85  63be6904847c3692a84b9b86  Real Estate Service > Property Management Office
    80  63be6904847c3692a84b9b5f  Home Improvement Service > Plumber
    76  58daa1558bbb0b01f18ec1d6  Art Studio
    76  63be6904847c3692a84b9b67  Import and Export Service
    73  52f2ab2ebcbc57f1066b8b57  Employment Agency
    71  63be6904847c3692a84b9b55  Home Improvement Service > General Contractor
    71  5744ccdfe4b0c0459246b4d6  Research Laboratory
    66  63be6904847c3692a84b9b51  Home Improvement Service > Doors and Windows Contractor
    65  545419b1498ea6ccd0202f58  Home Improvement Service > Home Service
    64  63be6904847c3692a84b9b7e  Plastics Supplier
    63  4f4531084b9074f6e4fb0101  Recycling Facility
    60  52f2ab2ebcbc57f1066b8b37  Recording Studio
    60  63be6904847c3692a84b9b8f  Security and Safety
    59  52f2ab2ebcbc57f1066b8b1e  Locksmith
    52  56aa371be4b08b9a8d57356a  Outdoor Event Space
    52  63be6904847c3692a84b9b90  Technology Business
    52  63be6904847c3692a84b9b93  Telecommunication Service
    43  63be6904847c3692a84b9b59  Home Improvement Service > Interior Designer
    43  56aa371be4b08b9a8d5734d7  Industrial Estate
    43  52e81612bcbc57f1066b7a31  TV Station
    42  52f2ab2ebcbc57f1066b8b20  Health and Beauty Service > Body Piercing Shop
    41  63be6904847c3692a84b9b85  Real Estate Service > Commercial Real Estate Developer
    38  63be6904847c3692a84b9b34  Chemicals and Gasses Manufacturer
    35  63be6904847c3692a84b9b65  Home Improvement Service > Upholstery Service
    34  56aa371be4b08b9a8d5734c5  Wedding Hall
    33  63be6904847c3692a84b9b4e  Home Improvement Service > Carpet and Flooring Contractor
    31  63be6904847c3692a84b9b5d  Home Improvement Service > Painter
    28  56aa371be4b08b9a8d573523  Film Studio
    28  63be6904847c3692a84b9b70  Manufacturer
    27  5744ccdfe4b0c0459246b4c7  Child Care Service
    25  56aa371be4b08b9a8d573554  Entertainment Service
    25  63be6904847c3692a84b9b5a  Home Improvement Service > Kitchen Remodeler
    25  56aa371be4b08b9a8d573552  Rental Service
    24  54f4ba06498e2cf5561da814  Office > Corporate Cafeteria
    24  58daa1558bbb0b01f18ec1b2  Research Station
    24  58daa1558bbb0b01f18ec1ac  Waste Management Service
    22  63be6904847c3692a84b9b92  Technology Business > Website Designer
    21  63be6904847c3692a84b9b2c  Automotive Service > Motorcycle Repair Shop
    21  63be6904847c3692a84b9b5b  Home Improvement Service > Landscaper and Gardener
    19  63be6904847c3692a84b9b2a  Automation and Control System
    18  63be6904847c3692a84b9b6d  Logging Service
    18  63be6904847c3692a84b9b88  Real Estate Service > Real Estate Development and Title Company
    17  58daa1548bbb0b01f18ec1a9  Power Plant
    16  63be6904847c3692a84b9b94  Translation Service
    15  63be6904847c3692a84b9b48  Geological Service
    15  63be6904847c3692a84b9b6e  Machine Shop
    15  5665ef1d498ec706735f0e59  Office > Corporate Amenity
    15  63be6904847c3692a84b9b8e  Search Engine Marketing and Optimization Service
    14  63be6904847c3692a84b9b40  Financial Service > Business Broker
    14  52e81612bcbc57f1066b7a27  Health and Beauty Service > Bath House
    13  63be6904847c3692a84b9b2f  Automotive Service > Tire Repair Shop
    13  63be6904847c3692a84b9b96  Water Treatment Service
    12  5f2c1e0db6d05514c70436d4  Automotive Service > Vehicle Inspection Station
    12  63be6904847c3692a84b9b4a  Health and Beauty Service > Hair Removal Service
    12  63be6904847c3692a84b9b50  Home Improvement Service > Deck and Patio Contractor
    12  63be6904847c3692a84b9b5c  Home Improvement Service > Mover
    12  52f2ab2ebcbc57f1066b8b38  Lottery Retailer
    12  5665c7b9498e7d8a4f2c0f06  Office > Corporate Coffee Shop
    12  63be6904847c3692a84b9b76  Office > Office Building
    12  63be6904847c3692a84b9b78  Paper Supplier
    11  63be6904847c3692a84b9b66  Human Resources Agency
    11  63be6904847c3692a84b9b8a  Renewable Energy Service
    11  63be6904847c3692a84b9b91  Technology Business > Software Company
    10  63be6904847c3692a84b9b38  Direct Mail and Email Marketing Service
    10  63be6904847c3692a84b9b6f  Management Consultant
    10  63be6904847c3692a84b9b89  Refrigeration and Ice Supplier
     9  5032850891d4c4b30a586d62  Financial Service > Banking and Finance > Credit Union
     9  698b7b3e05512d4553149a5d  Health and Beauty Service > Brow Bar
     9  63be6904847c3692a84b9b79  Pet Service > Pet Grooming Service
     9  63be6904847c3692a84b9b7d  Photography Service
     8  63be6904847c3692a84b9b3f  Financial Service > Banking and Finance
     8  63be6904847c3692a84b9b69  Laboratory
     8  63be6904847c3692a84b9b72  Media Agency
     8  63be6904847c3692a84b9b97  Welding Service
     7  63be6904847c3692a84b9b3c  Equipment Rental Service
     7  63be6904847c3692a84b9b7a  Pet Service > Pet Sitting and Boarding Service
     7  63be6904847c3692a84b9b7b  Petroleum Supplier
     7  63be6904847c3692a84b9b82  Publisher
     7  63be6904847c3692a84b9b95  Tutoring Service
     6  56aa371be4b08b9a8d5734cf  Ballroom
     6  63be6904847c3692a84b9b39  Electrical Equipment Supplier
     6  63be6904847c3692a84b9b43  Financial Service > Financial Planner
     6  63be6904847c3692a84b9b47  Food and Beverage Service > Food Distribution Center
     6  63be6904847c3692a84b9b4c  Home Improvement Service > Bathroom Contractor
     5  63be6904847c3692a84b9b54  Home Improvement Service > Garage Door Supplier
     5  63be6904847c3692a84b9b8b  Rubber Supplier
     4  63be6904847c3692a84b9b57  Home Improvement Service > Home Inspection
     4  63be6904847c3692a84b9b77  Online Advertising Service
     3  63be6904847c3692a84b9b30  Automotive Service > Towing Service
     3  63be6904847c3692a84b9b37  Creative Service
     3  52f2ab2ebcbc57f1066b8b2d  Financial Service > Check Cashing Service
     3  63be6904847c3692a84b9b41  Financial Service > Collections Service
     3  63be6904847c3692a84b9b5e  Home Improvement Service > Pest Control Service
     2  63be6904847c3692a84b9b3b  Entertainment Agency
     2  63be6904847c3692a84b9b46  Food and Beverage Service > Caterer
     2  63be6904847c3692a84b9b4f  Home Improvement Service > Chimney Sweep
     2  63be6904847c3692a84b9b62  Home Improvement Service > Sewer Contractor
     2  63be6904847c3692a84b9b64  Home Improvement Service > Tree Service
     2  63be6904847c3692a84b9b6a  Leather Supplier
     2  63be6904847c3692a84b9b75  Office > Corporate Housing Agency
     2  63be6904847c3692a84b9b7f  Print, TV, Radio and Outdoor Advertising Service
     2  63be6904847c3692a84b9b8d  Scientific Equipment Supplier
     1  63be6904847c3692a84b9b27  Appraiser
     1  63be6904847c3692a84b9b44  Financial Service > Loans Agency
     1  63be6904847c3692a84b9b63  Home Improvement Service > Swimming Pool Maintenance and Service
     1  63be6904847c3692a84b9b6c  Legal Service > Immigration Attorney
     1  63be6904847c3692a84b9b71  Market Research and Consulting Service
     1  63be6904847c3692a84b9b84  Real Estate Service > Building and Land Surveyor
     1  63be6904847c3692a84b9b99  Writing, Copywriting and Technical Writing Service
```
