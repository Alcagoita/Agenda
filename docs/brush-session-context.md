# Brush — Session Context & Working Handbook
*Handoff file for new Claude sessions. Last updated: 2026-07-19. Owner: Olegário.*

---

## 1. What the app is

**Brush (Brush Away)** — a calm, location-aware to-do app (React Native 0.85 / Expo 56, TypeScript, Android-first, iOS later). Every task is tied to a real-world place *type* (pharmacy, café, supermarket… 16 built-in types + custom). When the user walks near a matching place, the app surfaces the task. Completion gesture = a painted **brush stroke** (Reanimated scaleX, never a checkbox). "Brush" is always a verb.

**The emotional contract:** no guilt, no urgency, no pressure. A task not done isn't overdue — it's waiting for the right moment. The app is a helper, not a reminder. "We don't care where you solve your task" — place *types*, not addresses.

**The moat:** works offline. GPS works without data; only place lookup needs the network — and the app caches its own map (OSM). No competitor does offline location to-dos.

## 2. Brand voice (non-negotiable)

- First-person companion ("I'll keep an eye out", "I know my way around"), peer not assistant. "How can I help?" was explicitly rejected as chatbot voice.
- Questions over labels: "What do you need?", "Where does this happen?", "Which part of your life?", "Going somewhere?".
- Banned words in UI: POI, cache, mode, snapshot, geofence, optimize, itinerary, overdue, missed, skipped, expired, deadline, edit, manage, archive, history, best, optimal, recommended.
- Memory framing: "I'll know Faro until July 24", "Forget this place" (delete = forgetting; but canceling a plan = "Not going anymore" — *forget* is reserved for past-trip memories).
- Sentence case, never ALL CAPS labels. No emoji as icons (AppIcon/PoiIcon components only). Accent is warm amber — **never green**. No drop shadows — 1px `line` borders carry elevation. Geist font, weights 400/500/600, tabular-nums on all changing numbers.
- The app never lies: no fake 100% days, no presence claims from date-only data, no unverifiable numbers (store counts), no distances presented as routed when they're straight-line.

## 3. Core doctrine (settled — cite these, don't relitigate)

1. **Reveal facts freely; order stops on request only; judge/command never.** Bundle cards state what *can* happen where; routes are built only when the user asks; "best way"/"you should" never appear.
2. **Pull vs push:** the app never says "go now", but when the user says it (Take me there, One trip), it already knows the way.
3. **Absence is default:** chips, cards, buttons render only when they have something true to show. No empty states, no disabled buttons, no placeholder apologies.
4. **Explicit beats inferred:** Home address (KAN-247), favorites (KAN-290) — the user tells the app; the app never guesses identity-level facts.
5. **Opt-in urgency:** the Time field = the user inviting a reminder. One calm notification, never re-fired on rollover, exempt from quiet hours (they asked).
6. **Fix forward, never claw back:** data-bug migrations never revoke awarded streaks/points/achievements (KAN-264).
7. **Foreground-only location — permanent** (KAN-231 closed as DECIDED): never request background/always-on location, never native background geofences. "While using the app" is the model.
8. **API minimalism:** Cloudflare/Foursquare is the primary POI source. OSM is the retried fallback for API failure or unavailable coverage and is cacheable under ODbL. Google Maps is used only for native navigation handoff, never POI search.
9. **Surface ownership:** ContextChip owns presence (real location); Calendar owns plans (dates); "Where we've been" owns memories; Today owns now. Copy must never claim another surface's job.
10. **Monetization doctrine (revised 2026-07-19): "monetize fulfillment, never placement."** Two categories: (A) sponsored PLACEMENT (partner pays to appear) — contained to the trip's "While you're there" ONLY, labeled, area-fetched, core loop permanently ad-free; (B) monetized FULFILLMENT (affiliate link on an organically-shown action, e.g. "Get tickets" on the KAN-293 leisure line) — allowed wherever the suggestion is organic, with the inviolable line that no commercial relationship may ever influence detection, ranking, wording, or frequency. No prices/discounts/deal language anywhere, ever.

## 4. Architecture facts (verified in code)

- **Location:** expo-location, foreground `watchPositionAsync`, two-tier accuracy (coarse/fine, KAN-55), 3-min timer + 200 m movement gate (`src/services/proximity.ts`). `getPositionLowAccuracy` falls back to GPS offline. No native geofences in use.
- **Places online:** Cloudflare POI API in `src/services/maps.ts`, queried by broad type and requested subtype; OSM/Overpass is the fallback for API failure or unavailable coverage. `openInMaps`/`openMapsSearch` only hand off to the device's map app.
- **Places offline:** habitat cache — SQLite (`src/services/habitatCache.ts`), OSM/Overpass source (`osmPlaces.ts`), all POI types prefetched (KAN-238), per-type cap 50. Trip downloads (`tripDownload.ts`: `computeTripExpiresAt`, `shouldPreRefreshTrip`, `refreshTripArea`, `TRIP_RADIUS_PRESETS`) — expiry/pre-refresh are pure derivations, no schedulers.
- **Data:** Firestore, offline persistence on, unlimited cache (`firebase.ts`). All user data under `/users/{uid}/`. Tasks: `date` mutates on rollover; `originDate` (immutable, KAN-264) is the calendar day; `completedPlaceId/Name` recorded at brush (KAN-226). KAN-353 removed the unused Google-specific `poiPlaceId` field after a zero-record audit.
- **Inference:** `poiInference.ts` (keyword dict EN+pt-PT, self-growing) + `poiLlm.ts` (on-device TFLite ~90 KB) — both offline; wired into import AND quick-add suggestion (suggested-POI chip state, KAN-249: nearTint dashed = app's guess; confirm/ignore/replace feed learn-back).
- **Learned places:** `learnedPlaces.ts` — N=3 brushes at same internal place id promotes it; "your usual".
- **Screens of note:** TodayScreen (post-KAN-260 cleanup: no pts in header, no %, brush-stroke-only done state, "N waiting"), CalendarScreen (trip entry row `tripForDate(selectedDate)`, day-driven single row; "Where we've been ›" secondary row), TripPlannerScreen (rendering-only over `useTripPlanner` step hook: destination→dates→radius→downloading), WhereWeveBeenScreen (year timeline), OffGridScreen, PlacesIKnowScreen (owns trip refresh/delete actions), TaskFormScreen (folder: index.tsx, PoiTile, poiSuggestions), MiniTimePicker (custom clock, quiet surface2 12h/24h pill toggle), ContextChip, NearbyCard, ItineraryOptionsScreen (KAN-281/282).
- **Testing:** Jest in `__tests__/` mirroring `src/`; offline paths = mocked NetInfo (KAN-227 pattern) — NO airplane-mode E2E, never build network-simulation infra. Detox exists (`e2e/auth`, `e2e/events`) but is minimal. Contrast test guards palette (KAN-258); ESLint guard rejects hardcoded colors outside theme/ (KAN-259).
- **Notifications:** notifee; TriggerType.TIMESTAMP pattern with deterministic ids (see EOD/STREAK/WEEKLY precedents in `notifications.ts`; task reminders = `task_time_{taskId}`); NO exact alarms (no SCHEDULE_EXACT_ALARM).

## 5. Feature map (shipped → in flight → future)

**Shipped:** offline core (habitat cache, cache-backed proximity, cross-source identity, all-types prefetch), offline expectations messaging (3 states), ContextChip (+ trip/mall states), Trip Planner "Going somewhere?" on Calendar (day-tap prefill, trip bands, stored-trip row states), dateless areas, "Where we've been" (past-trip timeline, "Forget this trip"), off-grid window ("Going off-grid?" in Profile nav + chip sheet; welcome-back toast N≥1 only), birthday tasks (IMPORT-ONLY, no POI, unscored, silent expiry), suggested-POI chip, Home address in Settings, calendar honesty (originDate + "brushed away on Wednesday" redemption copy), Today cleanup, dark palette retune + hardcoded-color sweep, mall snapshots (KAN-237), contextual trip suggestions (calendar signal + empty-state; far-pin signal DORMANT), coverage-failure invitation, time picker + calm reminder (KAN-280), "Take me there" (KAN-279 — shipped SIMPLER than spec: Maps text search, no resolver; header + row NavigateIcon, muted, only-when-far).
**In flight (Sprint 20):** KAN-281 "One trip for all of these" (options screen, "Stop by stop" card, destinationResolver.ts, ≤1 batched call + radius cap), KAN-282 mall card (see §6 — most-litigated ticket), KAN-283 cluster-box route handoff (shared `routeHandoff.ts` utils), KAN-251 trip-row copy (descoped to copy-only, day-driven).
**Backlog, scoped:** KAN-266 trip editing (edit mode via `{editTripId, initialStep}`), KAN-290 favorites (fold into Places I know; favorite = learned place with rank ∞), KAN-291 route refresh (session-scoped in-memory history — NO SQLite persistence; once-online-then-cache per screen session), KAN-293 leisure companion line ("Central Park is right there" + Keep it in mind).
**Future / gated:** KAN-239 Vacation Planner 2.0 ("While you're there" + partner monetization, post-release), KAN-234-related trip ideas, KAN-265 pin decision, Wear polish / widgets (featuring hooks), KAN-263 release screenshots → KAN-261/262 landing page (hero copy frozen; callouts = "Works offline" + "Going somewhere?"; site repo location was never confirmed — ask).

**Release plan** (docs/brush-release-plan.pdf): closed testing 12 testers/14 days → Portugal soft launch (pt-PT shipped; in-app review API only at payoff moments) → official launch ("The to-do app that waits for you"); featuring hooks: offline collections, Wear, widgets, honest Data Safety.

## 6. KAN-282 mall detection — final resolved design (hardest-won decisions)

- "Big mall (100+ stores)" was a **proxy**; the real metric is coverage of THIS user's tasks. No API can count mall stores — never try (no per-mall detail calls, no Overpass counts — deleted).
- **Three radii:** `ROUTE_MAX_RADIUS_M` 5 km = how far the user will go (only search range); `MALL_CONTAINMENT_RADIUS_M` 250 m = is the store inside the building (pin→store evidence, checked against ALL cached places, not resolved stops); `MALL_VERIFY_USER_RADIUS_M` 1 km = near enough to justify verification.
- **Evidence tiers:** snapshot (incl. auto mini-snapshots) → cached OSM places → near-mall verification (ONE pin-centered 250 m Nearby Search, persisted as auto mini-snapshot, once per mall per lifetime) → otherwise NO CARD (opportunistic, never hunted; self-heals via OSM refresh + visit snapshot offer).
- **Hard budget: ≤2 Google calls per trip computation** (the KAN-281 batched call + at most one verification), spy-tested.
- Qualify = venue covers ≥2 tasks; rank = coverage desc, then user-distance; covered tasks re-resolve to the mall's own places for handoff; card = "All in one place", nearTint/nearBorder, BELOW "Stop by stop".

## 7. Working process with Claude Code (learned the hard way)

- **Tickets must be self-contained descriptions. Claude Code does not read comments.** Fold every decision into the description body ("supersedes all comments" header pattern).
- **Jira MCP bug:** markdown descriptions sometimes save with literal `\n` mangling — after every create/edit, CHECK the returned description; if mangled, re-edit with proper newlines.
- **Verify code before speccing.** Multiple tickets referenced things that didn't exist (the "trip sheet", the KAN-279 resolver, native picker). Grep first; cite files/lines in tickets.
- **Ship-vs-spec drift is normal and often good** (KAN-279 text search, single route card, custom time picker) — accept deviations explicitly in the ticket with date + "decided with Olegário", update ACs, never let QA flag agreed changes.
- **ACs must be mechanically enforceable:** call-budget spies, "component untouched" assertions, fixtures for every branch incl. the absent/null path.
- **One ticket per branch; changes to Done work = NEW ticket** (never reopen/amend shipped tickets' scope). Decision tickets get "DECISION/DECIDED:" titles and close as records.
- **Gitflow:** features from develop → PR to develop; ticket transitions: start = In Development, PR open = Testing, merged = Done. Sprint end checklist lives in CLAUDE.md (never skip the GitHub release). Never merge without Olegário's explicit consent.
- **Jira access:** cloudId `035e98f2-9261-4cb8-a008-64f565594dea`, project KAN, site olegarioncnascimento.atlassian.net. Issue types: Epic/Story/Task/Bug/Subtask. Transitions: 11 To Do, 21 In Development, 31 Testing, 41 Done.
- Olegário's style: brainstorms in rough ideas → wants brand/UX pushback (uses "Branding Expert" / "Senior UI/UX designer" personas), then tickets. Prefers concise. Portuguese market first (EN + pt-PT copy always). When he vetoes (e.g. Calendar tab, persistent history), the veto usually enforces the app's own rules — check ideas against §3 before proposing.

## 8. Standing copy inventory (approved strings)

"What do you need?" (sheet/header) · rotating example placeholders · "Where does this happen?" · "Which part of your life?" · "Around when?" / "Anytime is fine" · "Add it" · "Just the what and the where" · "Got it — I'll keep an eye out." · "N waiting" (never "left"/"overdue") · "Going somewhere?" / "Off to Faro soon" / "Faro · until July 24" / "Going somewhere else?" / "Not going anymore" · "Where we've been" / "Forget this trip" · "Going off-grid?" / "Got it — I'll know this area until 18:00." / "Welcome back — N things brushed away while you were off-grid." · "You're outside the area I know by heart…" (+ invitation variant) · "Take me there" · "One trip for all of these" / "Stop by stop" / "All in one place" / "About X km all together" · "8 of these can happen at Colombo — one stop." · "{name} · your usual" · "You wanted this at 14:00 — {task}" · "It's a birthday" toggle blurb · Home note: "So I know my way around your neighborhood. This stays on your device." · "{Park} is right there — fancy a walk while you're at it?" / "Keep it in mind".

## 9. Open questions (ask Olegário, don't decide)

- onAccent white-on-amber ~2.5:1 contrast (both modes) — deliberate design decision pending.
- Calendar discoverability (big-number tap) — tab bar VETOED; moment-based first-complete-day hint proposed but he's "not sold"; unresolved.
- Landing page repo location — never confirmed.
- KAN-290/291 rewrites approved in discussion but descriptions may still need the agreed changes baked in (Places-I-know placement; session-scoped history).
