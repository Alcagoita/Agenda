# Today screen — the Lantern

*Drafted 2026-07-25 with Olegário. Status: agreed in discussion, not yet ticketed.*
*Supersedes the progress ring. Read this before speccing any Today-screen work.*

> **Naming — "hero" is taken.** `hero` already means the NearbyCard's <100 m state (`HERO_RADIUS_M`, `nearbyPoiType`, the orange card). The new header object is the **Lantern** and is never called a hero. In this document and in all tickets:
> - **Nearby hero** — the existing <100 m proximity card. Unchanged.
> - **Lantern** — the new persistent header object. `Lantern.tsx`, `LanternState`, `useLanternState`.
>
> The word "Lantern" is internal only. The UI never shows it — it shows the word for the current state (Home, Colombo, New to me).

---

## 1. Why

The task model changed: **tasks are persistent and dateless unless the user sets a date explicitly.** Nothing expires, nothing rolls, nothing belongs to a day.

That breaks the current progress ring. `done / total` has no denominator when the set is open-ended — 3/5 of what? And a progress ring is Apple-Fitness grammar (close it, keep the streak, don't break the chain), which is a guilt device on a screen whose contract is *no guilt, no urgency, no pressure*. The largest object on the main screen is currently arguing against the product.

Target user: **someone who knows what they want at the start of the day and forgets along the way.** Not the hyper-organised. The screen must feel warm, calm and unhurried — and warmth here is not a palette problem (`#fdfcfa` + amber is already warm). It's cold because it's *evaluative*.

---

## 2. What replaces it

**A soft amber light in the slot the ring occupies now, with one word beneath it.**

The metaphor is **light as familiarity**: well-lit is where the app knows its way around, dusk is where it doesn't. It reuses the existing ring geometry — the scorekeeper is retired into a lamp.

### Division of labour (non-negotiable)

> **The word carries the information. The light carries the feeling.**

Never swap those. Brightness alone fails accessibility, is invisible in daylight, and inverts badly in dark mode. The word is always present and always legible.

### States

*As shipped in KAN-301. Five states; offline is a modifier, not a state.*

| State | Word | Light | Source of truth |
|---|---|---|---|
| Mall | The mall's name (offline-safe from the snapshot) | Enclosed, settled — rhymes with Home | `PlaceContext.kind === 'mall'` (proximity.ts) |
| Trip | The trip's destination | Warm, awake | active trip, `isTodayWithinTripDates` |
| Home | "Home" — *not the neighbourhood name* | Warm, steady | `services/home.ts` `isNearHome(coords)` true |
| Outside | The city / area name when online; **"Outside"** when offline | Warm, awake | `isNearHome(coords)` false |
| No home set | "Where's home?" | Unlit | `isNearHome(coords)` returns `null` |

There is also a transient **`locating`** held state (home set, no fix yet): it renders nothing rather than guessing Outside, so there's no cold-start flash. It resolves to Home/Outside once a position is known.

**"Somewhere new" is ON HOLD — not built.** It would only be meaningful for a new *city*, and for 99% of use the city name already covers it. Home vs Outside is the whole binary.

Priority order (as implemented in `resolveLanternState`, mirroring `resolveContextChipView`): **mall > trip > home/outside**. Offline is a quiet modifier on any state (the `offlineDot` precedent), never its own state.

### Rules

- No numbers anywhere in the Lantern. No fill, no completion, no percentage, no spin.
- Breathing motion only — 4.5s cycle (6s unset), imperceptible. If a user can tell it's animating, it's too fast. Runs on the halo View via `useNativeDriver`, never on the SVG icon (KAN-157). Respects reduce-motion.
- State transitions take **seconds, not frames**. Nothing snaps.
- All text sits on the background, never inside the lit area (the open white-on-amber ~2.5:1 contrast issue must not be made worse).
- Only the pill is tappable; it opens **your places** (the unset state points at the home-address flow; other destinations are KAN-304).

---

## 3. Two-state header

Same expanded/collapsed treatment the ring has today (KAN-157/KAN-214), reusing `useCollapseAnimation` unchanged:

- `collapseT` 0↔1, 240 ms `Easing.inOut(cubic)`, UI thread only
- `SECTION_H_REST` 240 → `SECTION_H_COLLAPSED` 150, `SCROLL_RANGE` 90, threshold 0.6
- `RING_REST` 184 → `RING_COLLAPSED` 112, `RING_LEFT_COLLAPSED` 22

**Rest:** Lantern at full size, word beneath.
**Collapsed:** compact Lantern pinned left, word inline beside it — the slot the collapsed date row uses now.

> Note: `useCollapseAnimation` currently fires a haptic on collapse (`Vibration.vibrate`, 10 ms Android / 1 ms iOS). Re-evaluate — a buzz on scroll works against "nothing snaps, everything breathes."

---

## 4. What the Lantern absorbs

**`ContextChip` is folded into the Lantern.** It answers the same question ("where am I and what do I know here") at the wrong size, in a second location. Two context indicators on one screen breaks surface-ownership (doctrine §9) — a user in a mall in Porto currently has both firing.

Offline, mall and trip stop being separate chips and become **quiet modifiers** on the one object. The precedent already exists: `offlineDot` is a modifier today, not a takeover.

### Hysteresis — hard requirement

GPS drifts hardest at building edges, exactly where state flips. A Lantern oscillating Colombo → Out → Colombo destroys the entire premise in about four seconds.

**Enter fast, leave slow — a distance buffer, not a timer.** As implemented: enter Home at ≤150 m, leave only past 200 m (`HOME_ENTER_M` / `HOME_LEAVE_M`). The buffer is tracked independently of the rendered state, so a mall/trip override doesn't clear it — leaving that context while still inside the leave threshold stays Home. Mall bounds inherit the same damping from proximity.ts's existing 200 m / 3-min recompute gate.

---

## 5. What comes off the screen

| Removed | Why |
|---|---|
| Progress ring + `PROGRESS` label + `N/N` fraction + percentage | No denominator under persistent tasks; guilt grammar |
| Date number / month caption | Load-bearing when tasks belonged to days; vestigial now |
| Points chip in `Header.tsx` | Renders unconditionally "to drive engagement", even at 0. KAN-262 says never lead with tiers/medals/streaks — that rule doesn't stop at the website. Achievements should be **discovered, never displayed** |

**Kept as-is:** FAB, empty-state rotating nudges, NearbyCard + also-close, task list.

**Conflict to resolve first:** KAN-300 (currently *Testing*) shrinks the calendar circle to 75% and renames the section. It should land or be explicitly superseded before this starts.

---

## 6. Where the door goes

The Lantern is **not** the door to trips. That was a design error — it optimised the main screen for the 5% case.

The destination is **your places**, and it is a home feature: `learnedPlaces.ts` already promotes a place to "your usual" after N=3 brushes. Your supermarket, your café, your pharmacy. That is valuable on an ordinary Tuesday and is currently buried behind a date number.

Trips and "Where we've been" are the **rare tenses** of the same screen — future and past of "places I know" — not its headline. The calendar grid goes away; past tasks appear as *evidence of a place* ("Faro — you brushed 6 things here"), which is memory, not an audit.

**Discovery principle, now doing work in three places:** *offer it where it's true, never advertise it.*
- Trips surface when coverage fails (KAN-244's invitation already exists as a transient toast — make it a state instead)
- Mall mode surfaces when you're standing in a mall
- Home address surfaces via the "Where do you start?" state, which is a better prompt than a settings row nobody opens

---

## 7. Follow-on: walking / driving (not now — leave the seams)

Two engines, both already built, currently running at once and competing for the same screen:

- **Walking** → `proximity.ts`, NearbyCard, Nearby hero/also-close, proximity notifications. Continuous, ambient, opportunistic. **The default.**
- **Driving** → `oneTripForAll.ts`, `routeHandoff.ts`, `ItineraryOptionsScreen`, "Stop by stop", mall card. Pre-planned routes only. **No proximity checking at all.**

Driving mode turns the proximity loop *off*. That is a safety property by construction rather than policy, and a large §8 win — zero API calls, no polling. The walking engine resumes when you stop; the handoff between the two products is arriving somewhere.

Branding beat: in driving mode the Lantern visibly **is not looking**. Light at rest. That makes the anti-surveillance promise observable rather than claimed.

Mode is a **modifier, never a second word**. Five location states × two modes is how a calm object becomes a dashboard.

**Hard requirement:** driving mode must **self-expire** (off-grid window pattern — stationary for N minutes, or a few hours, or declared arrival). A mode that silently disables the core loop is the most dangerous thing we can ship: the user won't file a bug, they'll conclude the app stopped working and leave.

**Explicit over inferred** (doctrine §4). Speed from the existing location stream can *offer* the mode — no new permission, no activity-recognition API — but must never decide it, and must never announce the inference.

Nothing needs pre-building for this. The radius rule (400 m Nearby, <100 m Nearby hero, 100–400 m also-close) is correct and works; it stays untouched until this feature is actually specced.

---

## 8. Ticket breakdown

One ticket per branch, cut from `develop`.

| Ticket | Scope | Blocked by |
|---|---|---|
| **KAN-301** | **The Lantern** — five states, light + word, two-state collapse, hysteresis, ring/date/points removal, ContextChip absorption | KAN-300 (merged, `fa7a7c1`) |
| **KAN-302** | Notification Preferences shows Portuguese in English (`copy.ts:503`) | — |
| **KAN-303** | Notification prefs — cut the pressure channels, keep Daily + Location | KAN-302 |
| **KAN-304** | Places I know — drop the calendar grid, merge the screens | KAN-301 |
| **KAN-305** | Walking / driving mode — placeholder, do not start | KAN-301, KAN-304 |

### Why KAN-301 is one ticket, not three

An earlier draft of this plan split it into E (build the Lantern), F (retire the ring/date/points) and G (absorb ContextChip). **That split was abandoned** — no ordering of those three ships a releasable screen:

* F without E → the slot is empty
* E without F → two objects in the same position
* G separately → the Lantern ships alongside ContextChip, which is the exact bug being fixed

They are one change to one slot. Review size is handled with commit structure inside the branch, not by splitting the ticket:

1. `Lantern.tsx` + `LanternState` + state resolution (unwired)
2. Hysteresis layer
3. Two-state collapse wiring
4. Swap into TodayScreen, remove ring + date caption
5. Absorb ContextChip, delete from header
6. Remove points chip
7. Dark-mode tokens + guard-test entries

---

## 10. Resolved decisions (2026-07-25)

**Word for the home state — DECIDED: "Home".** Not the neighbourhood or street name. Place names are used only when the user is *outside* (the "Out, known area" state). Home is the one state that names a relationship rather than a location.

**Dark mode enclosure — DECIDED: a different palette, not a darker one.** The mall/Home "enclosed" feeling cannot be expressed by reducing luminance on `#0e0e0c` — the Lantern would sink into the background. Dark mode needs its own colour set for the Lantern's lit states rather than a dimmed version of the light-mode ramp.

> Build note: new tokens must go in `theme/tokens.ts`. The KAN-259 ESLint guard rejects hardcoded colours outside `theme/`, and the KAN-258 contrast test guards the palette — both will need entries for the new values.

**KAN-265 (`poiPlaceId` pin UI) — DECIDED: will not be built.** Pinning a *specific store* contradicts the core concept: the app matches POI **types**, not individual places ("we don't care where you solve your task"). KAN-353 removed the unused Google-specific field after a zero-record production audit; any future pinning design must use a source-independent destination model.

**Rollover — CLOSED.** Already built and working. Not in scope.
