# Outings — a day, a place, and the things you want out of it

*Drafted 2026-08-25 with Olegário. Status: agreed in discussion, not yet ticketed.*
*Read this before speccing any Trip Planner or Places I know work.*

> **Naming.** The internal type is `Outing`. The word never appears in the UI, the same
> discipline the Lantern uses: the interface shows the occasion, not the category.
> A user reads "Belém", with the day underneath. They never read "outing", "plan",
> "planner" or "itinerary".

---

## 1. Why

Brush is only useful to someone already in motion. The app waits, which is the brand,
but waiting only pays off when the user happens to walk past the right door. A person
decides to go somewhere hours before they arrive, and Brush is absent from that moment
entirely. It is the one moment in the product where the user actively wants the app to
speak first.

Second reason, strategic. There are 222k typed POI rows behind a classification
pipeline that no competing to-do app has. Today that asset is invisible infrastructure.
An outing is the first surface where it becomes a product the user can see.

The Trip Planner is not that surface. It is a download utility wearing a feature's
clothes: four steps whose only job is to configure a cache, ending in a size estimate
the app invented (`POI_DENSITY_PER_KM2_PER_TYPE = 0.3`, blended over what its own
comment still calls "all 16 built-in types" when there are now 33).

---

## 2. What an outing is

**One place, one day, and the things you want out of it.**

| | Outing | Trip |
|---|---|---|
| Duration | Exactly one day | A range, arrive Friday leave Sunday |
| What it is | An occasion the user planned | An area the app learned |
| Owns | Its list, its memory | `cacheAreaId`, `expiresAt`, coverage |
| Visible as | A section on Today, a row in Places I know | Increasingly, not at all |

A week in Faro is not a seven-day outing. It is a place the app learned, with several
outings inside it. **If it spans more than one day it is not an outing**, and it goes
down the trip path instead.

That separation resolves what the trip becomes: the user stops configuring an area and
the app derives it from the outings placed in it. Two outings in Faro means the app
learns Faro once.

---

## 3. The rules that are not negotiable

These are the ones that will be argued with during implementation. They are settled.

**1. Never filter Nearby.** The list is *your things*, so the user may filter it. Nearby
is *the app speaking*, and its contract is "what you can solve right now". Filter it by
the outing and that sentence becomes false. Concretely: you are in Belém with the kids,
there is a pharmacy on Rua de Belém, you have "pick up the prescription" in your list,
and the app knows you are 80 metres away and says nothing. That is the app hiding
something true at the exact moment it exists to speak. Outing items may **sort first**
in Nearby. Nothing may be excluded.

**2. A section, not a mode.** The outing does not replace the task list, hide it, or
change what Today does. It is a section above the rest of the list, present while it is
true and gone when it is not, which is doctrine §3 and not a special case. This avoids
creating three problems that a mode would then need designing out of: an unexplained
subtractive change with nothing on screen to explain it, an exit affordance and an
expiry rule, and a blank main screen on a Saturday afternoon when everything is brushed
by four o'clock and the real list is hidden behind a filter. See the Lantern plan's
standing warning: a mode that silently disables the core loop is the most dangerous
thing we can ship, because the user will not file a bug, they will conclude the app
stopped working and leave.

**3. The app answers where, never what.** The user says what they want. The app says
where it can happen. It never proposes an afternoon, never curates, never ranks by
quality. Doctrine §1, and the banned words already cover it: best, optimal,
recommended. There are no pre-made plans and no template library: that is editorial
content, in two languages, that ages, that nobody owns, and that is a judgement about
how people should spend time with their children.

**4. No target on any count.** A keepsake tally has no denominator, which is exactly why
it is not the progress ring returning. It stays that way only if nothing ever supplies
one. No suggested number, no comparison to last time, no personal best, no streak of
outings. Someone will propose it, framed as motivating. The answer already exists.

**5. The window labels, it never bounds.** "Afternoon" is a word on a memory. If it is
allowed to end an outing, then at 18:00, mid-dinner, the section vanishes for a reason
the user cannot see, which is failure mode 2 by another route.

**6. Monetization line, stated before the feature exists.** This is the first surface
where the app shows a venue the user did not name, which is where sponsored placement
will eventually be proposed. Doctrine §10 holds unchanged: monetize fulfillment, never
placement; contained to "While you're there"; no commercial relationship may influence
detection, ranking, wording or frequency. Written down now, not after someone offers
money. This surface is a better vehicle for KAN-239 than a vacation planner, because an
afternoon in Belém happens fifty times more often than a holiday.

**7. Today stays an errands screen.** An outing is monthly, errands are daily. The
Lantern plan already caught this error once: the Lantern was going to be the door to
trips, and that was "optimising the main screen for the 5% case". The outing earns a
section while it is live, and nothing else on Today.

---

## 4. Creating one

Two questions. Where, and what.

**Where.** One destination field, the existing Nominatim autocomplete
(`searchDestinationAutocomplete`). This field also classifies the intent by itself: if
the place is where the user already is, they are starting now; if it is not, they are
planning ahead. Nothing else needs to ask.

**When.** A date, defaulted to today, one tap to change. **No end date** and no range,
that is what makes something a trip. No yes/no gate ("Are you going today?"): its "no"
leads to another question anyway, and a gate makes the user classify themselves before
saying anything useful.

**Around when.** Optional, and only offered when the user is not already there. Reuse
the new-task sheet's existing grammar verbatim: `COPY.newTaskSheet.timeQuestion` =
"Around when?" with `newTaskSheet.timePlaceholder` = "Anytime is fine" as the default
(the namespace is `newTaskSheet`, not `taskForm`). Morning / Afternoon /
Evening / All day, single select. **No clock anywhere in this flow.** `MiniTimePicker`
stays where it belongs, on an individual task, where an exact time is the user inviting
one calm reminder, which is a different job (doctrine §5, opt-in urgency).

**What.** A list the user writes. Same two-field weight as creating a task. Three kinds
of line, and the third only became possible on 2026-08-25:

| Line | Behaviour |
|---|---|
| An errand with a place type | Exactly like every other task. "Withdraw cash", `atm` |
| **A tourism task with a place type** | Also exactly like every other task. "See Jerónimos", `historical_landmark`. Taggable as of KAN-408 |
| A keepsake | No place, never brushed, never in the task list (§6) |

"Eat dinner" is a task, which is also the answer to "afternoon plus dinner": that
composite is not a longer window, it is an outing whose last item is dinner, and the
list already says so better than a label could.

**The tourism line does not become a pin.** There is only one Torre de Belém, so the
temptation to attach a place id to "see the Torre" is much stronger here than it ever
was for a supermarket. The answer is unchanged and permanent (KAN-353, restated in
KAN-408's own constraints): **the type matches, the title carries the specificity.** A
task titled "see Jerónimos" typed `historical_landmark` fires near any historical
landmark, and in Belém that is a very short list. That is the same arrangement as "buy
the shirt" typed `store` with a ZARA brand, and it is not a bug to be fixed by
reintroducing `poiPlaceId` under a new name.

**No radius, no size estimate, no download step.** Those appear only when the app does
not know the place, and then as one honest line, not a configuration step. Most outings
are in a place the habitat cache already holds, and asking a Lisbon resident to
configure a cache for Belém is the current flow's core mistake.

---

## 5. While it is happening

Today's vertical order is unchanged: Lantern, Nearby, list. The outing inserts one
section above the rest of the list, using the existing `sectionHeaderBlock` /
`sectionTitle` pattern in `src/screens/TodayScreen/index.tsx` (the same slot
`COPY.today.sectionTitlePrefix` = "WHAT I NEED" occupies, matching
`sectionTitleStyle`'s existing uppercase treatment rather than fighting it).

The header carries the explanation, on the thing that changed rather than far away from
it:

> **BELÉM**
> this afternoon

Proximity beats a badge. The caption explains the reorder at the point of the reorder.

**The Lantern does not get a new state and does not get a dot.** KAN-349 removed the
offline dot and its leftovers; reintroducing a floating modifier undoes that lesson.
There is also a happy accident: during a Belém outing the Lantern is already showing
"Belém", because that is the Outside state with the city name. It says the right word
for free.

**Nothing snaps.** The list reorder gets the same seconds-not-frames treatment as the
Lantern's state changes.

**Ending.** The outing ends when the user ends it, when they leave the area, or when the
day rolls over, whichever is first. Never because a named window closed. Ending is not
silent: the section becomes the memory, and that transition is the one moment the app
asks its single self-reported question.

---

## 6. Keepsakes

"Take some pictures" is not a task. It has no place type, it can never be brushed, and
it never resolves. It is the thing an outing leaves behind.

> **Keepsakes carry less weight than this section originally assumed.** When the doc was
> drafted, "see a landmark" had nowhere to go but here. KAN-408 made tourism types
> taggable, so that line is now a real task that brushes normally. What is left for a
> keepsake is only what genuinely has no place and no completion: photos, weather, the
> mood of the day. That is a smaller and cleaner set, and it is an argument for building
> KAN-416 last rather than first.

**It is a `Task` row with a new `kind`, and it never renders in the task list.** The
precedent is already in `src/types/index.ts`: `kind: 'birthday'` is documented as "a
semantic task kind, not a POI type", placeless and unscored. A keepsake has nearly the
same shape, so it reuses the same plumbing (the exclusion paths for placeless, unscored
tasks already exist) without diluting what a task means in the UI, because it only ever
appears inside the outing.

**No live counter, and no photo library permission.** The manual tap will not happen:
Belém, afternoon, two kids, sun on the screen, nobody takes a photo and then opens a
to-do app to log that they took a photo. The number would say 2 and a number that is
wrong is worse than no number. And reading the photo library trades the heaviest
remaining permission after location for a souvenir tally, on a product whose promise is
that it is not watching, which the Lantern plan wants observable rather than claimed.

**The memory writes itself from what the app already knows.**

> **Belém, Saturday afternoon.**
> You brushed 4 things. You were near the Torre, Jerónimos, and the playground on
> Afonso de Albuquerque.

Zero permissions, zero taps, entirely true. `Task.completedTripId` is already being
written by KAN-304 and its own comment calls it "groundwork for later 'things to do
where you've been', stored, never yet surfaced". The data is already accumulating.

The self-reported part is asked **once, at the end, never during**. One question, closer
to "anything else from today?" than to a running number.

---

## 7. Where it lives

**Places I know → Trips tab.** That tab already has the right shape from KAN-304:
"Where you're going" with a `Next up` flag, then "Where you've been" by year. Outings
take those slots. A future outing waits there, visibly, which matters: plan Saturday on
Wednesday and today nothing happens for three days, so the user reasonably assumes it
did not save and makes it again.

`Trip` does not disappear underneath. It stops being something the user configures.

---

## 8. Data shape

**A new `Outing` type, not `Trip.kind = 'outing'`.** `Trip` requires `areaRadius`,
`cacheAreaId`, `expiresAt` and `placeRef`, all four of which are download concerns. An
outing in the user's own city has none of them, and forcing the shape means writing
fake values into four required fields. (`Trip.kind = 'offgrid'` is precedent for
extending `Trip`, and it is precedent for the opposite conclusion too: off-grid needed
those fields, an outing does not.)

Tasks join by id. A task with no `outingId` behaves exactly as it does today.

---

## 9. Prerequisites

*Rewritten 2026-08-25, later the same day. An earlier version of this section is wrong
and is superseded entirely.*

| | Status |
|---|---|
| **KAN-407** | **Cleared.** Answered Option A and shipped, PR #380, merged as `fc0f6de` |
| **KAN-408** | Model tourism as two groups, Nature and Landmarks. 28 types |
| **KAN-410** | Promote the landmarks and culture candidates |
| **KAN-406** | `attraction` in `CLUSTER_LEISURE_TYPES` matches zero rows. Blocks the suggestion line |
| **KAN-419** | One authority for at-your-feet distance. Ahead of KAN-408, see §12 |

**Tourism types are taggable.** KAN-408 settled this: the 28 Nature and Landmarks types
join `PoiType` with full catalog treatment, catalog-only and never quick-actionable, the
same call KAN-412 made for its ten.

This supersedes the earlier claim in this document that the mention/tag split was
"load-bearing". It is not. The real split, and KAN-408 states it plainly, is **who
initiated it**:

| Path | Who | Verdict |
|---|---|---|
| The user writes "visitar o castelo" and tags it `castle` | The user | Correct that it reaches the Nearby hero. No different from "buy bread" |
| The app volunteers a castle nobody asked about | The app | Must never outrank an errand. Governed by `clusterLeisure`, not by tagging |

A tagged tourism task is a task the user chose to write. Tasks are dateless and
guilt-free, so a "visit the castle" that waits six months is the model working.

`playground` was already a `PoiType` before any of this, added by KAN-412, and `park` is
already quick-actionable. Neither is in KAN-408's 28.

---

## 10. Ticket breakdown

One epic, five tickets, one per branch, cut from `develop`.

| Ticket | Scope | Blocked by |
|---|---|---|
| **KAN-413** | Epic: Outings | KAN-407, KAN-408, KAN-410 |
| **KAN-414** | The `Outing` type, Firestore shape, and the two-question creation flow | prerequisites |
| **KAN-415** | The Today section: header, ordering, Nearby sorts without filtering, end conditions | KAN-414 |
| **KAN-416** | Keepsakes: `Task.kind`, never in the task list, no counter, no permission | KAN-414 |
| **KAN-417** | Places I know: outings take the Trips tab, `Trip` recedes to a cache concept | KAN-414, KAN-415 |
| **KAN-418** | The landmark line: extend `clusterLeisure.ts` to an outing's places | KAN-415, KAN-406 |

KAN-418 is smaller than it looks, and got smaller again. `src/services/clusterLeisure.ts`
already exists from KAN-293, and the copy is already approved: *"{Park} is right there,
fancy a walk while you're at it?"* and *"Keep it in mind."*

Two corrections to an earlier draft of this section:

- **Detection is cache-only, and has not been an Overpass request since KAN-366.** It
  reads rows the habitat cache already holds, and that prefetch now goes through
  `searchNearbyPlaces`, our POI API first and Overpass second. KAN-407 then let the two
  heritage types through a filter that had been dropping them. The module's own header
  says so; any acceptance criterion phrased as "rides in the same Overpass request" is
  wrong and must be phrased as "issues no request of its own".
- **Tourism types becoming taggable narrows this ticket.** Some of what it was going to
  suggest, the user can now simply write. What remains is only the unasked-for mention,
  which is the half that always needed the strictest rules anyway.

---

## 11. Open questions

- **Does an outing notify?** Saturday arrives and the user has not opened the app. A
  notification is the natural answer and it is also the first pressure the feature would
  add. Doctrine §5 says urgency is opt-in only, so probably not, but it is undecided.
- **Can two outings exist on one day?** Morning in Sintra, evening in Cascais. Allowed
  costs a section that can appear twice. Forbidden costs an error message. Undecided.
- **Does an outing's task survive the outing?** "Withdraw cash" not done in Belém.
  Tasks are persistent and dateless, so it should simply return to the list, but that
  needs saying, because the outing is over and the section that held it is gone.
- **Editing a live outing.** Adding a line mid-afternoon is obviously fine. Changing the
  place is not obviously anything.
- **`sectionTitlePrefix` is "WHAT I NEED", uppercase**, against CLAUDE.md's
  sentence-case rule but consistent with `sectionTitleStyle`. Not this feature's problem
  to fix, but the outing header must match whichever way it settles.

---

## 12. The radius collision

*Promoted 2026-08-25 from an incidental finding to a prerequisite.*

`HERO_RADIUS_M` is 100 m, "the task is at your feet", and it is declared **twice,
privately**: `src/services/proximity.ts:182` and `src/components/NearbyCard.tsx:58`,
neither exported. `NEARBY_RADIUS` is exported from `proximity.ts:185`.

Separately, KAN-408 records that 100 m is wrong for a beach, a hiking area or a nature
preserve, where the user can be 500 m from the recorded point and unambiguously there,
and asks for per-type values in `POI_GEOFENCE_RADIUS`.

Those two meet, and the meeting is why this is no longer incidental. Per-type
at-your-feet distances cannot land honestly while two uncoordinated private copies decide
the same thing: someone teaches the engine that a beach is 500 m and the card keeps
saying 100 m, and the two disagree with no test that can see it.

**The fix is not to merge the constants.** KAN-408 is right that `HERO_RADIUS_M`,
`NEARBY_RADIUS` and `POI_GEOFENCE_RADIUS` mean three different things. The fix is that
exactly one place answers "how close is at-your-feet for this type", and both the engine
and the card ask it.

**KAN-419**, ahead of KAN-408. No behaviour change, every type keeps 100 m; it only
removes the duplication so KAN-408 can change values in one place.

### Still incidental

- **`POI_DENSITY_PER_KM2_PER_TYPE` is module-private** in `tripDownload.ts:108`, so the
  invented size estimate cannot be asserted against from a test today. Relevant to
  KAN-417, which removes the surface that shows it.
