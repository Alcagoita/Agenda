# POI classification rules

Standing rules for turning any POI source into places the app can use.
Learned the expensive way during the Overture migration (KAN-431), mostly by
breaking them first. Read this before changing a category map, a subtype
list, or a name keyword.

The numbers quoted are from the KAN-431 pilot: Odivelas, Lisboa and
Alcobaça — 46,830 staged rows, 29,094 promoted, 12,157 pending, 5,579
rejected.

---

## 1. The source's type is the truth. Never collapse it

**If the source distinguishes two types, the app carries the distinction.**

Overture separates `pizza_restaurant` from `italian_restaurant`. Folding
them made Telepizza an Italian restaurant. The same mistake typed
`barbecue_restaurant` as `steak`, `japanese_restaurant` as `sushi`, and four
distinct Latin American categories as `mexican`.

131 food categories were being expressed as 10 cuisines, and 137 shopping
categories as 16 store kinds. Both are now one-to-one: **87 cuisines, 88
store kinds.**

Collapsing feels like tidying. It is data loss, and it is invisible
afterwards — nothing in the database says a distinction used to exist.

**More granularity is better than less.** A user who wants pizza is not
served by an Italian restaurant, and Telepizza is not Italian.

## 2. The app's vocabulary is not defined by any source

`foodSubtypeCategories.json` keyed every cuisine to a Foursquare
`category_id`. Six cuisines users can pick — asian, bbq, brazilian,
mediterranean, pizza, seafood — had been *dropped from the vocabulary*
because Foursquare could not express them, and a query-time hack was built
to paper over the hole.

That is backwards. The vocabulary describes what the app offers. A source
that cannot express one of its terms simply contributes nothing to it.

A subtype entry **does not need a source category id**. `category_ids.py`
has always guarded with `if 'category_id' in entry`; `classify_and_load`
had the same assumption baked in unguarded and crashed when the vocabulary
grew. Both are fixed. Expect a third.

## 3. Reachability is the bar for promotion, not classification

A promoted row that no search returns is worse than an unpromoted one: it
counts as coverage and answers nothing.

- **`store` requires a subtype.** A store task cannot be created without
  one, and the Worker matches the filter against the row's attributes, so a
  subtype-less `store` row matches no search that will ever be made. Leave
  it `pending` instead.
- **`restaurant` does NOT require a cuisine.** Cuisine is refinement. A
  restaurant with no cuisine is still found by anyone looking for a
  restaurant.
- **A second type must be reachable too.** It hides better — behind a
  primary type that works — but it is just as dead.

Every one of these has a test. Keep it that way.

## 4. `rejected` and `pending` are different answers

- **`pending`** — nobody has ruled on this yet. A backlog to work through.
- **`rejected`** — we have ruled. Recorded with its reason.

Leaving a settled question in `pending` keeps re-presenting it as open, and
someone re-derives the decision every time they look at the backlog.

Rejected so far: lodging, every `vehicle_dealer` leaf, the KAN-412 medical
set, professional services you hold an appointment with (lawyer, insurance,
psychologist), dance and driving schools, community/non-profit
organisations, and housing developments.

**A rejected category outranks the name.** A dentist named "Clínica
Farmácia Silva" is still a dentist. Letting a keyword rescue a ruled-out
category reopens the decision one row at a time.

## 5. A missing category is not a missing place

The most expensive mistake of the migration. Overture has no category for
clothing repair or phone repair, and it was written off as data we would
lose.

The **places were all there**. iServices, Worten and Fnac sit in the data as
electronics and phone shops; around thirty alterations shops sit under
`clothing_store` and even `craft_shop`.

Before declaring a type lost, **search for the places by name and by brand,
not for the category.** 155 phone_repair and 24 clothing_repair rows were
recovered this way, plus lottery going from 3 to 99.

## 6. The name is evidence about a place already known to exist

It may add a type the category could not supply. It is never grounds for
inventing a place.

Two deliberate exceptions, both narrow:

- **Where the category is a shrug, the name outranks it.** Overture files
  barbearias and cabeleireiros under `spas` and `beauty_salon`. Those are
  four distinct errands (KAN-401) and the category cannot tell them apart.
- **Brands, where the service is in neither the category nor any word of
  the name.** `iservices`, `worten`, `fnac` → phone_repair. Nothing else
  states it. Use this sparingly; the keyword map is for generic words.

## 7. Portuguese names are full of metaphor traps

Test a keyword against real names before trusting it. Every one of these
was caught only by looking at the rows:

| word | looks like | actually is |
|---|---|---|
| `alfaiate` | tailor | "Alfaiate da Web" is a web agency |
| `quiosque` | newsstand | overwhelmingly food and drink kiosks; one is a clothing chain |
| `academia` | gym | "Academia de Dança" is a dance school |
| `escola` | school | "escola de condução" is a driving school |
| `poço` | spring | a well — nobody relaxes there (KAN-421) |
| `hairstudio` | nothing | a hairdresser, and no keyword claimed it |

Prefer the noun that names the **shop** over the one that names the
**person or the format**: `alfaiataria` not `alfaiate`, `tabacaria` not
`quiosque`.

## 8. One category, two errands

A tabacaria is a tobacco shop *and* where you buy a lottery ticket. A phone
shop sells phones *and* repairs them.

`also_types` on a category map entry grants the second type. It ranks after
the category's own answer, so `primary_poi_type` — what the app shows —
never moves.

This is how lottery went from 3 rows to 99, against the 32 the old source
had.

## 9. Know which theme the data is in

Overture's **`places`** theme has businesses. Natural and scenic features —
viewpoints, waterfalls, islands, zoos, tourist attractions — live in its
**`base`** theme, which we do not import.

Those types are not "missing from Overture". They are somewhere else, and
for now OSM supplies them. Check the theme before concluding a type is
unavailable.

**And check the other direction too: a type we hold may be junk.** The old
source had 9 `tourist_attraction` rows in Lisboa against Overture's zero,
which looked like a loss until they were read: `Parque Infantil Serafina`
is a playground, `Gymboree` and `Space Radical Kids` are children's play
centres, `Mural Dos Fadistas` is a mural. It was a bucket for things the
classifier could not place. Overture types them correctly and separately,
so zero is the right answer, not a gap. Compare the ROWS, never the counts.

## 10. Re-promotion, when a rule changes

Promotion skips rows already marked `promoted`, so fixing a mapping does not
fix the rows it already produced. The pattern that works:

1. Set the affected candidates back to `promotion_status = 'pending'`
2. Delete their rows from the poi / type / attribute tables
3. Run one promotion pass over everything pending

**Never promote in stages while a load is still running** — it merges
against a half-loaded table.

After any such pass, check the invariants: promoted row count equals
`promotion_status = 'promoted'`, and zero rows lack a geohash, a type, or a
required subtype. A promoted row with no geohash is invisible to the hot
path.

## 11. Measure the tail before you trust a rule

Every rule above that survived was checked against real rows first; the ones
that died were killed by the same check.

`dance_school` was rejected only after searching all 120 rows for
ginásio/fitness/pilates/yoga/crossfit — a dance studio that is also a gym
would be a real errand. Zero matched, so the rejection was safe.

Volume never decides whether a type is included. It decides what to look at
first.


---

## 12. The promotion is a whitelist, and that is the standing risk

The extraction obeys "import everything, exclude a named few": it is an
exclude list, and 46,830 rows staged from three municipalities.

**The promotion does not.** `overtureCategories.json` is a whitelist, so a
category nobody thought to add stays `pending` in silence. Every gap found
during KAN-431 — toy shops, bicycle shops, liquor stores, kiosks, lottery,
fountains, palaces, stadiums, auditoriums — was found by someone guessing
what to search for. That does not scale to a country, and PT has 1,357
categories against the pilot's ~600.

So the promoter now writes **the entire unmapped backlog** to
`unmapped_categories.tsv` beside its SQL, not the top 20 it prints. That
file is the review list for a country run. Read it before declaring an
import finished.

### What is in the backlog, and why (measured on the pilot)

| rows | group | verdict |
|---|---|---|
| 3,474 | `services_and_business` | B2B and offices. Correctly out. |
| 2,153 | no category at all | Only names can resolve these. |
| 1,649 | `travel_and_transportation` | Mostly parking, taxis, vehicle work, and rail/air the app has no type for. |
| 1,124 | `health_care` | KAN-412's exclusions. |
| 924 | `community_and_government` | Embassies, police, courts — no app type. |
| 785 | `shopping` | The bare "a shop, kind unknown" leaves. |
| 498 | **real errands with no app type** | **See below.** |

### Categories that need a new PoiType

These are places a person genuinely runs an errand at, and the app has no
type for them. They stay pending rather than being folded into a
neighbouring type, because folding is rule 1's mistake:

`massage_therapy` 129 · `martial_arts_club` 97 · `laser_hair_removal` 45 ·
`pilates_studio` 43 · `pet_groomer` 29 · `skin_care` 28 · `health_spa` 18 ·
plus ~24 smaller ones — 498 rows, 31 categories.

A new type is not free: it needs a catalog entry, an icon, and `en` +
`pt-PT` copy before anyone can tag a task with it. That is why this is a
list to work through rather than a mapping change.

**Do not fold them in the meantime.** A massage, a laser hair removal, a
facial and a health spa are four errands, exactly as pizza and Italian are
two cuisines. `spa` was the wrong bag for all four, and putting them there
would have been invisible the moment it was done.


## 13. An uncertain match is a question, never a guess

**Prefer missing a place over holding it twice.** A gap is invisible and
harmless. A duplicate shows the same shop twice in the Nearby list and makes
the app look broken, which is the failure users actually notice.

So when two names are similar but not obviously the same place, escalate it
for a person to decide. Do not resolve it automatically in either
direction — a weak match must not silently add a duplicate, and it must not
silently retire a real place either.

This is not hypothetical. Measuring Vasco da Gama against its operator's
tenant list, single-token matching produced:

| tenant list says | matched to | verdict |
|---|---|---|
| `FEEL RIO` | "Ambientes do Rio \| Lisbon" | wrong — shares only `rio` |
| `LAS MUNS` | "La Casa de las Carcasas" | wrong — shares only `las` |
| `AMORINO – GELATO AL NATURALE` | "Amorino Gelato - Lisboa Vasco Da Gama" | right, and a stricter matcher MISSED it |

Both failure directions in one run. Loosen the matcher and it invents
matches; tighten it and it loses real ones. There is no threshold that gets
both, which is why the uncertain middle belongs to a human.

**Mall names need their own normalisation.** A venue inside a shopping
centre carries the mall, the city and the floor — "Lisboa Vasco Da Gama",
"(PISO 1)" — and none of that identifies the tenant. Strip it before
comparing: doing so moved measured recall from 41% to 51% without changing
a single row.

## 14. Correcting a place is two lists, not a merge

When an authority (an operator's tenant list) is used to correct a
footprint, the operation is exactly two lists applied separately:

1. **REMOVE** what we hold that the authority does not contain
2. **ADD** the named places we lack, and *only* those

Never replace a row we already hold with another source's version of it.
Never bulk-import everything the other source has inside the boundary. A
footprint is not a licence to re-import an area — "we are missing these
five" means five.

Removal goes through `poi_source_correction` with a reason, never a hard
delete, so a wrong call stays visible and reversible.
