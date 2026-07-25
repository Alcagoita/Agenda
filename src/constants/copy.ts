/**
 * copy.ts — KAN-110, bilingual since KAN-252
 *
 * Single source of truth for all brand micro-copy, in English and
 * Português-Portugal (pt-PT — explicitly not pt-BR).
 *
 * Usage (unchanged from before KAN-252 — every existing call site keeps
 * working as-is):
 *   import { COPY } from '../constants/copy';
 *   accessibilityLabel={COPY.taskRow.brushAway(task.title)}
 *
 * `COPY` is a Proxy over whichever language dictionary is currently active
 * (see `setCopyLanguage` below, called from ThemeContext whenever the
 * resolved user language changes) — property reads are forwarded live, so
 * dozens of existing `import { COPY }` call sites across the app never
 * needed to switch to a hook just to become language-aware. Since nearly
 * every screen already calls `useTheme()` for its palette (CLAUDE.md rule 1),
 * a language change already re-renders almost the entire app the same way a
 * dark-mode toggle does.
 */

export type SupportedLanguage = 'en' | 'pt-PT';

const en = {

  // ─── Task row ─────────────────────────────────────────────────────────────
  taskRow: {
    /** Primary tap action — mark an undone task as done. */
    brushAway:   (title: string) => `Brush away ${title}`,
    /** Reverse action — mark a done task as undone. */
    unbrush:     (title: string) => `Unbrush ${title}`,
    syncingA11y: 'Syncing',
    editA11y:    (title: string) => `Edit ${title}`,
  },

  // ─── Progress ring / counters ──────────────────────────────────────────────
  progress: {
    /** Ring accessibility label: "3 of 5 tasks brushed" */
    ringA11y: (done: number, total: number) => `${done} of ${total} tasks brushed`,
  },

  // ─── Empty states ──────────────────────────────────────────────────────────
  emptyState: {
    todayNoTasks:    'Nothing to brush away today',
    todayAllBrushed: 'Clean canvas. 🖌',
    calendarNoTasks: 'Nothing to brush away',
    inboxNoShared:   "No one's brushed anything your way yet",
  },

  // ─── Push / local notifications ───────────────────────────────────────────
  notification: {
    /** Proximity alert — fires when within NEARBY_RADIUS of a POI type with pending tasks. KAN-142. */
    proximityTitle: (poiLabel: string) => {
      const article = /^[aeiou]/i.test(poiLabel) ? 'an' : 'a';
      return `You're near ${article} ${poiLabel}`;
    },
    proximityBody: (count: number) =>
      `You have ${count} thing${count === 1 ? '' : 's'} to brush away.`,

    /** Daily complete celebration. */
    dailyCompleteTitle: "You've brushed it all away today 🖌",
    dailyCompleteBody:  "Every task brushed. Clean canvas!",
  },

  // ─── Achievements ─────────────────────────────────────────────────────────
  achievement: {
    challengeWinnerTitle:    'First to brush it away',
    challengeWonBody:        'Achievement unlocked: First to brush it away',
    challengeEndedBody:      'Better luck next time!',
    challengeWonNotifTitle:  '🏆 You won the challenge!',
    dailyCompleteTitle:      "All brushed for today!",
    dailyCompleteBody:       "You've brushed every task on your list. Great work!",
  },

  // ─── Challenges ───────────────────────────────────────────────────────────
  challenge: {
    goalTypeLabel:   (count: number) => `First to brush away ${count} tasks`,
    inviteTitle:     (handle: string, typeLabel: string) =>
      `${handle} challenged you: [${typeLabel}] 🏆 — Accept?`,
  },

  // ─── Share flow ───────────────────────────────────────────────────────────
  share: {
    screenTitle:          'Brush a To-do with a friend',
    sendButton:           (name: string) => `Brush this over to ${name}`,
    activityFeedReceived: (senderName: string) => `${senderName} brushed a to-do your way`,
    /** Same phrase as activityFeedReceived, without the name prefix — for
     *  callers that already render the sender's name separately (e.g. bold). */
    activityFeedSuffix:   'brushed a to-do your way',
  },

  // ─── New task quick sheet (KAN-148) + More Details (KAN-149) ───────────────
  // Shared between both screens — copy must be identical on overlapping
  // fields, since tapping "More details ›" should feel like the same
  // conversation continuing, not a different form.
  newTaskSheet: {
    title:        'What do you need?',
    poiQuestion:  'Where does this happen?',
    catQuestion:  'Which part of your life?',
    catOptional:  ' (optional)',
    swipeHint:    'Swipe for more',
    moreDetails:  'More details ›',
    cta:          'Add it',
    ctaSubmitting: 'Adding…',
    /** Rotating title-input placeholder examples — fade between strings, not a hard swap. */
    titleExamples: [
      'Pick up toothpaste…',
      'Withdraw some cash…',
      'Return the library book…',
      'Grab something at the pharmacy…',
      'Fill up on the way home…',
    ],
    // ── More Details only (KAN-149) ──
    poiSearchPlaceholder: 'A café, a pharmacy, a gym…',
    timeQuestion:         'Around when?',
    timeOptional:         ' (optional)',
    timePlaceholder:      'Anytime is fine',
    clearTimeA11y:        'Clear time',
    footerHint:           'Just the what and the where',
    /** Fires after a successful add from either surface — never on edit. */
    confirmToast:         "Got it — I'll keep an eye out.",
    /** KAN-249 — shown on a POI tile that's the app's inferred guess, not yet confirmed. */
    poiSuggestionHint:    'my guess?',
    /** Accessibility-only suffix once an inferred suggestion is confirmed/reselected. */
    poiSuggestionConfirmedSuffix: 'suggestion',
  },

  // ─── Offline expectations messaging (KAN-236) ──────────────────────────────
  // Never say "POI"/"cache" here — frame everything as the app's own
  // limitation, not the user's problem. State-based, not launch-based: only
  // shown when it's actually true this session, never a blanket warning.
  offline: {
    /** NetworkBanner text when offline AND the habitat cache has never been seeded (fresh install/new phone) — the only fully broken case (KAN-241: every other offline case is now a quiet ContextChip glyph instead of a banner). */
    noCacheYetBanner: "No connection — I can't look around for places yet. I'll start learning your area once you're online.",
    /** One-time toast, once per session — offline and the user has moved beyond what the cache knows for their pending errands. Plain apology variant, shown after the invitation variant below has reached its lifetime cap (KAN-244). */
    uncoveredAreaToast: "You're outside the area I know by heart — I'll need a connection to spot places here.",
    /** KAN-244 — same trigger as uncoveredAreaToast, but teaches the fix instead of just apologizing. Shown up to COVERAGE_INVITATION_LIFETIME_CAP times (see proximity.ts), then this moment reverts to the plain copy above. */
    uncoveredAreaInvitationToast: "You're outside the area I know by heart. Next time, tell me before you go — I can learn a place ahead of time.",
    /** Action label on the invitation toast — navigates to the Calendar's "Going somewhere?" trip flow (KAN-243). */
    uncoveredAreaInvitationAction: 'Show me',
  },

  // ─── Trip Planner (KAN-234) ────────────────────────────────────────────────
  // Never say "POI"/"cache"/"download region" here — frame everything in the
  // app's first-person voice, same as offline/newTaskSheet above.
  tripPlanner: {
    placesIKnowBackA11y: 'Back',
    refreshTripA11y: (destination: string) => `Refresh ${destination}`,
    refresh: 'Refresh',
    deleteTripA11y: (destination: string) => `Delete ${destination}`,
    changeTripDates: 'Edit dates',
    addTripDates: 'Edit dates',
    changeTripDatesA11y: (destination: string) => `Change the dates for ${destination}`,
    learnBiggerArea: 'Edit area size',
    learnBiggerAreaA11y: (destination: string) => `Learn a bigger area around ${destination}`,
    entryRowLabel: 'Going somewhere?',
    entryRowA11y:  'Plan a trip',
    /** KAN-243 — the future-day CTA in Calendar's detail card; dateLabel is the full formatted date (e.g. "Friday, July 24"). */
    entryRowA11yWithDate: (dateLabel: string) => `Plan a trip starting ${dateLabel}`,
    destinationQuestion: 'Where are you headed?',
    destinationPlaceholder: 'Faro, Lisbon, Tokyo…',
    datesQuestion: 'When are you going?',
    datesOptional: ' (optional)',
    datesSkip:     "I'll skip the dates",
    radiusTown:          'Just the town',
    radiusTownAndAround: 'Town and around',
    radiusRegion:        'The whole region',
    /** The pre-download "one honest line" — untilDate is set only for a dated trip. */
    sizeEstimateLine: (mb: string, untilDate?: string) =>
      untilDate
        ? `About ${mb} — I'll know it until ${untilDate}.`
        : `About ${mb} — I'll keep it fresh for about a month.`,
    downloadButton:   'Learn this area',
    saveDatesButton:  'Save dates',
    saveAreaButton:   'Save area',
    downloadingLabel: 'Learning the area…',
    downloadErrorToast: "Couldn't learn this area — check your connection and try again.",
    downloadSuccessToast: (destination: string) => `Got it — I know ${destination} now.`,
    editDatesSuccessToast: (destination: string) => `Dates updated for ${destination}.`,
    editRadiusSuccessToast: (destination: string) => `Area updated for ${destination}.`,
    changeDatesTitle: 'Change the dates',
    placesIKnowTitle: 'Places I know',
    placesIKnowEmpty: "I don't know any trip areas yet — add one above.",
    /**
     * KAN-251 — Calendar's day CTA for a selected day inside a stored trip's
     * range. Two states only (dropped the old cache-expiry-based wording):
     * "upcoming" (today hasn't reached the trip's startDate yet) and
     * "active" (today is within the trip's dates). Deliberately never
     * claims presence ("you're here") — that's the ContextChip's job, which
     * has real location; this row is date-based only and must never lie
     * about a delayed flight.
     */
    tripUpcomingRowLabel: (destination: string) => `Off to ${destination} soon`,
    tripUpcomingRowSubtitle: (untilDate: string) => `I'll know my way around · until ${untilDate}`,
    tripUpcomingRowA11y: (destination: string) => `Off to ${destination} soon`,
    tripActiveRowLabel: (destination: string, untilDate: string) => `${destination} · until ${untilDate}`,
    tripActiveRowA11y: (destination: string) => `${destination} — trip in progress`,
    /** KAN-257 — Calendar's day CTA when the selected day falls inside a trip whose dates are over. Replaces the states above for that day; navigates to the "Where we've been" timeline instead of Places I Know. */
    whereWeveBeenRowLabel: (destination: string) => `Where we've been · ${destination}`,
    whereWeveBeenRowA11y:  (destination: string) => `Where we've been — ${destination}`,
    /** KAN-257 — always-visible secondary row under the trip entry row, shown only when at least one past trip exists. */
    whereWeveBeenEntryRowLabel: "Where we've been",
    whereWeveBeenEntryRowA11y:  "See where we've been",
    habitatRowLabel: 'Everywhere I usually go',
    habitatRowSub:   'Updated automatically as you go about your day',
    tripRowDates:      (start: string, end: string) => `${start} – ${end}`,
    tripRowNoDates:    'No dates set',
    tripRowKnownUntil: (date: string) => `I'll know it until ${date}`,
    deleteConfirmTitle:  (destination: string) => `Forget ${destination}?`,
    deleteConfirmBody:   "I'll stop recognizing places there. You can always learn it again later.",
    deleteConfirmAction: 'Forget it',
    deleteCancelAction:  'Keep it',
    /**
     * KAN-251 — "forget" is reserved for past-trip memories (KAN-257); an
     * upcoming/active trip is a plan, not a memory, so cancelling it reads
     * "not going anymore" throughout the whole dialog (title included —
     * showing "Forget Faro?" as the title with this button would visibly
     * contradict the reasoning). Off-grid windows are untouched, still use
     * deleteConfirmTitle/Body/Action above.
     */
    cancelConfirmTitle:  (destination: string) => `Not going to ${destination} anymore?`,
    cancelConfirmBody:   "I'll stop preparing for this trip.",
    cancelConfirmAction: 'Not going anymore',
  },

  // ─── "Where we've been" (KAN-257) ──────────────────────────────────────────
  // Companion voice — the app forgets the place data but remembers being
  // there together. Never "history"/"archive"/"records" here or in the row
  // that links to this screen.
  whereWeveBeenScreen: {
    screenTitle: "Where we've been",
    backA11y: 'Back',
    forgetTripLabel: 'Forget this trip',
    forgetTripA11y: (destination: string) => `Forget this trip — ${destination}`,
    forgetConfirmTitle: (destination: string) => `Forget ${destination}?`,
    forgetConfirmBody: "This trip won't show up here again.",
    forgetConfirmAction: 'Forget it',
    cancel: 'Cancel',
  },

  // ─── One trip for all of these (KAN-281) — offer, never a command; no
  // "itinerary"/"optimize" jargon anywhere in this copy. ────────────────────
  oneTripForAll: {
    entryLabel: 'One trip for all of these',
    entryA11y:  'One trip for all of these',
  },

  itineraryOptionsScreen: {
    screenTitle:  'One trip for all of these',
    cardLabel:    'Stop by stop',
    backA11y:     'Back',
    loadingLabel: 'Finding the way…',
    stopsCount:   (n: number) => (n === 1 ? '1 stop' : `${n} stops`),
    /** "{name} · your usual" — learned-place stop. */
    destinationLearned: (name: string) => `${name} · your usual`,
    /** "{name} · {distance}" — cache/live-resolved stop. */
    destinationWithDistance: (name: string, distance: string) => `${name} · ${distance}`,
    /** Straight-line sum, clearly approximate — Maps owns real routing. */
    totalDistance:  (km: string) => `About ${km} km all together`,
    exclusionLine:  (n: number) => (n === 1 ? "Couldn't find a place for 1 of them" : `Couldn't find a place for ${n} of them`),
    openInMapsA11y: 'Open directions in Maps',
    emptyStateBody: "Couldn't find places for any of these right now.",
    errorBody:      "Something went wrong finding the way.",
    retryLabel:     'Try again',
    mapsOpenFailed: "Couldn't open Maps — try again.",
    // ── Mall card (KAN-282) ──
    mallCardTitle:     'All in one place',
    mallCardSubtitle:  (name: string) => name,
    mallCardDistance:  (distance: string) => `${distance} away`,
    mallCardA11y:      (name: string) => `All in one place — ${name}`,
    mallOpenInMapsA11y: 'Open directions to the mall in Maps',
  },

  // ─── Context chip (KAN-241 / KAN-242) ──────────────────────────────────────
  // Never say "mode"/"cache"/"snapshot" here — same first-person voice as
  // offline/tripPlanner above. The offline glyph's sheet copy stays
  // area-name-agnostic (no reverse geocoding available); the mall/trip sheets
  // can name the place since it's a destination the user chose themselves.
  contextChip: {
    offlineGlyphA11y: 'Offline — I know this area',
    closeSheetA11y: 'Close sheet',
    closeA11y:      'Close',
    sheetTitle: 'What I know here',
    /** date is the last-learned day (e.g. "Jun 28"), or undefined if the cache has no timestamp yet. */
    sheetBody: (date?: string) =>
      date
        ? `I've learned the places around here — last updated ${date}.`
        : "I've learned the places around here.",
    refreshButton:    'Refresh now',
    refreshingLabel:  'Refreshing…',
    refreshErrorToast: "Couldn't refresh — check your connection and try again.",

    // KAN-242 — mall/trip place contexts.
    mallChipA11y: (name: string) => `In ${name} — tap for details`,
    tripChipA11y: (destination: string) => `In ${destination} — tap for details`,
    offlineDotA11y: 'Offline',
    mallSheetTitle: (name: string) => `While you're at ${name}`,
    tripSheetTitle: (destination: string) => `While you're in ${destination}`,
    placeSheetCoverageLine: "I've learned the places around here.",
    mallSheetFreshnessLine: (date: string) => `Last learned ${date}`,
    placeRefreshErrorToast: "Couldn't refresh — check your connection and try again.",
  },

  // ─── Mall snapshot (KAN-237) ───────────────────────────────────────────────
  mallSnapshot: {
    rowLabel: 'Activate Mall mode',
    rowSublabel: 'Download this mall\'s places so I can help you faster without a signal.',
    downloadingLabel: 'Downloading Shopping mall data…',
    noMallFoundToast: "I can't find a mall nearby — try this again once you're inside one.",
    errorToast: "Couldn't learn this mall — check your connection and try again.",
  },

  // ─── Errand bundling (KAN-235) ──────────────────────────────────────────────
  // "Can happen near each other" reveals opportunity — never "you should",
  // never an itinerary ("first X, then Y"), never a task count framed as
  // pressure ("3 waiting near the market" is wrong; this is right).
  errandBundle: {
    cardLine: (taskCount: number, anchorName: string) =>
      `${taskCount} of these can happen near each other — a ten-minute walk around ${anchorName}.`,
    cardA11y: (taskCount: number, anchorName: string) =>
      `${taskCount} tasks can happen near each other, around ${anchorName} — tap for details`,
    dismissA11y: 'Not now',
    sheetTitle: (anchorName: string) => `Near ${anchorName}`,
    sheetIntro: 'These can happen close together — see what fits, in whatever order suits you.',
    closeA11y: 'Close',
    closeSheetA11y: 'Close sheet',
    // KAN-283 — route handoff for the whole cluster. States the number of
    // stops and nothing else: no "best", no "optimal", no suggestion that
    // this order is the one to follow.
    openAllInMaps: (stopCount: number) => `Open in Maps — all ${stopCount} stops`,
    openAllInMapsA11y: (stopCount: number) => `Open all ${stopCount} stops in Maps`,
    deselectStopA11y: (taskTitle: string) => `Leave out ${taskTitle}`,
    selectStopA11y:   (taskTitle: string) => `Include ${taskTitle}`,
    // Two stops is the floor — fewer isn't a route, and a single place is
    // already one tap away in the Nearby list.
    deselectStopDisabledA11y: 'Keeping this one — a route needs at least two stops',
    // KAN-293 — the leisure companion line. An invitation, never a plan: it
    // states a fact (the place is there) and offers. No urgency, no deals,
    // no prices, and never an instruction to go.
    leisureParkLine: (placeName: string) =>
      `${placeName} is right there — fancy a walk while you're at it?`,
    leisureOtherLine: (placeName: string) => `${placeName} is right there too.`,
    leisureKeepInMind: 'Add to this walk',
    leisureKeepInMindA11y: (placeName: string) => `Add ${placeName} to this walk`,
    leisureKeptConfirmation: (placeName: string) => `${placeName} will be added to this Maps route.`,
    // Naming the action, not selling it — "Get tickets", never a price or an offer.
    leisureGetTickets: 'Get tickets',
    leisureGetTicketsA11y: (placeName: string) => `Open the ${placeName} website`,
  },

  // ─── Contextual trip suggestions (KAN-245) ─────────────────────────────────
  // Discoverability through moments, not menus. No badges, no counters, no
  // urgency copy — a quiet, dismissible offer, never a notification-style nag.
  tripSuggestion: {
    cardLine: (place: string, day: string) =>
      `Off to ${place} on ${day}? I can learn it before you go.`,
    cardA11y: (place: string, day: string) =>
      `Off to ${place} on ${day}? I can learn it before you go — tap to set it up`,
    dismissA11y: 'Not now',
  },

  // ─── Off-grid window (KAN-246) ─────────────────────────────────────────────
  // Never "mode"/"offline mode"/"cache" — human words only. Sister feature to
  // tripPlanner above: now + duration instead of future + destination.
  offGrid: {
    profileRowLabel: 'Going off-grid?',
    profileRowSublabel: 'Heading somewhere with no signal for a while? I can get ready.',
    profileRowA11y: 'Set up an off-grid window',
    screenTitle: 'Going off-grid for a bit?',
    durationFewHours: 'A few hours',
    durationUntilTonight: 'Until tonight',
    durationPickTime: 'Pick a time',
    destinationOverridePrompt: 'Somewhere else?',
    destinationPlaceholder: 'Faro, Lisbon, Tokyo…',
    /** Trip.destination label when no override is chosen — center = current location. */
    currentAreaLabel: 'this area',
    confirmButton: 'Get ready',
    confirmingLabel: 'Getting ready…',
    confirmToast: (until: string) => `Got it — I'll know this area until ${until}.`,
    errorToast: "Couldn't get this area ready — check your connection and try again.",
    welcomeBackToast: (n: number) => `Welcome back — ${n} ${n === 1 ? 'thing' : 'things'} brushed away while you were off-grid.`,
    chipA11y: (until: string) => `Off-grid until ${until}`,
    sheetTitle: 'Off-grid',
    sheetBody: (until: string) => `I'll know this area until ${until}.`,
  },

  // ─── Home address (KAN-247) ────────────────────────────────────────────────
  // Explicit beats inferred — never "detection"/"fill this" form language.
  home: {
    backA11y: 'Back',
    loadingA11y: 'Loading home address',
    savingA11y: 'Saving',
    cancel: 'Cancel',
    settingsRowLabel: 'Home',
    settingsRowEmptySublabel: 'Not set',
    screenTitle: 'Home',
    searchPlaceholder: 'Search for your address…',
    note: "So I know my way around your neighborhood. Saved to your account — only you can see it.",
    changeButton: 'Change',
    clearButton: 'Clear',
    clearConfirmTitle: 'Clear home address?',
    clearConfirmBody: "I'll stop using it to know my way around your neighborhood.",
    clearConfirmAction: 'Clear',
    clearCancelAction: 'Keep it',
    saveErrorToast: "Couldn't save — check your connection and try again.",
    clearErrorToast: "Couldn't clear — check your connection and try again.",
  },

  // ─── Settings (KAN-252) ─────────────────────────────────────────────────────
  settings: {
    screenTitle: 'Settings',
    backA11y: 'Back',
    sectionTasks: 'TASKS',
    sectionAppearance: 'APPEARANCE',
    sectionLocationBattery: 'LOCATION & BATTERY',
    sectionImportTasks: 'IMPORT TASKS',
    sectionAccount: 'ACCOUNT',
    manageCategories: 'Manage Categories',
    notificationPreferences: 'Notification Preferences',
    darkMode: 'Dark mode',
    darkModeToggleA11y: 'Dark mode toggle',
    pauseLowBattery: 'Pause nearby alerts on low battery',
    pauseLowBatteryToggleA11y: 'Pause nearby alerts on low battery toggle',
    languageRowLabel: 'Language',
    languageSheetTitle: 'Choose a language',
    languageEnglish: 'English',
    languagePortuguese: 'Português',
    languageCancel: 'Cancel',
    importGoogleTasks: 'Google Tasks',
    importGoogleCalendar: 'Google Calendar',
    importReminders: 'Reminders',
    importCalendar: 'Calendar',
    importInProgressA11y: 'Import in progress',
    importedCount: (count: number) => `${count} imported`,
    importFailedRetry: 'Failed · retry',
    importErrorMessage: 'Import failed. Please try again.',
    signOutConfirmTitle: 'Sign out',
    signOutConfirmBody: "You'll need to sign back in to see your tasks.",
    signOutConfirmAction: 'Sign out',
    signOutCancelAction: 'Cancel',
    signOutErrorTitle: 'Error',
    signOutErrorBody: 'Failed to sign out. Please try again.',
    footerVersion: (version: string) => `Brush Away · v${version}`,
    footerAttribution: 'Place data © OpenStreetMap contributors (ODbL)',
  },

  // ─── Login (KAN-252) ────────────────────────────────────────────────────────
  login: {
    // "Brush away" is the brand verb — kept in English (see taskRow above).
    tagline: 'Brush away os teus to-dos, à medida que os vais encontrando.',
    emailLabel: 'E-mail',
    emailPlaceholder: 'you@example.com',
    passwordLabel: 'Palavra-passe',
    forgotPassword: 'Esqueceste-te da palavra-passe?',
    showPassword: 'Mostrar',
    hidePassword: 'Ocultar',
    showPasswordA11y: 'Mostrar palavra-passe',
    hidePasswordA11y: 'Ocultar palavra-passe',
    passwordPlaceholderSignup: 'Mín. 6 caracteres',
    passwordPlaceholderSignin: '••••••••',
    orDivider: 'ou',
    continueWithGoogle: 'Continuar com o Google',
    createAccount: 'Criar conta',
    signIn: 'Iniciar sessão',
    createAccountA11y: 'Criar conta',
    signInA11y: 'Iniciar sessão',
    alreadyHaveAccount: 'Já tens conta? ',
    dontHaveAccount: 'Ainda não tens conta? ',
    signInLink: 'Iniciar sessão',
    signUpLink: 'Criar conta',
    errorInvalidEmail: 'Introduz um endereço de e-mail válido.',
    errorUserNotFound: 'Não encontrei nenhuma conta com este e-mail.',
    errorInvalidCredential: 'E-mail ou palavra-passe inválidos. Confirma os teus dados.',
    errorWrongPassword: 'Palavra-passe incorreta. Tenta novamente.',
    errorEmailInUse: 'Já existe uma conta com este e-mail.',
    errorWeakPassword: 'A palavra-passe tem de ter pelo menos 6 caracteres.',
    errorTooManyRequests: 'Demasiadas tentativas. Espera um momento e volta a tentar.',
    errorNetwork: 'Erro de rede — verifica a tua ligação.',
    errorCreateAccountGeneric: 'Não foi possível criar a conta. Tenta novamente.',
    errorSignInGeneric: 'Falha no início de sessão. Tenta novamente.',
    errorEmailRequired: 'Introduz o teu endereço de e-mail.',
    errorPasswordRequired: 'Introduz a tua palavra-passe.',
    errorGoogleSignIn: 'Falha no início de sessão com o Google. Tenta novamente.',
  },

  // ─── Username setup (KAN-97, KAN-252) ──────────────────────────────────────
  usernameSetup: {
    title: 'Escolhe um nome de utilizador',
    subtitle: 'O teu identificador único para partilhares tarefas e ligares-te a amigos.',
    placeholder: 'yourhandle',
    inputA11y: 'Nome de utilizador',
    hint: '3–20 carateres · só letras, números e sublinhados',
    continueButton: 'Continuar',
    note: 'Podes mudar o teu nome de utilizador uma vez a cada 30 dias.',
    errorTaken: (value: string) => `@${value} já está em uso. Escolhe outro.`,
    errorGeneric: 'Algo correu mal. Tenta novamente.',
    errorTooShort: (min: number) => `São necessários pelo menos ${min} carateres.`,
    errorTooLong: (max: number) => `Máximo de ${max} carateres.`,
    errorInvalidChars: 'Apenas letras minúsculas, números e sublinhados.',
  },

  // ─── Notification preferences (KAN-80, KAN-252) ────────────────────────────
  notificationPreferences: {
    screenTitle: 'Notificações',
    backA11y: 'Voltar',
    loadingA11y: 'A carregar preferências',
    sectionDaily: 'DIÁRIO',
    sectionStreaks: 'SEQUÊNCIAS',
    sectionSummary: 'RESUMO',
    sectionEngagement: 'INTERAÇÃO',
    sectionLocation: 'LOCALIZAÇÃO',
    sectionAchievements: 'CONQUISTAS',
    eodLabel: 'Resumo do fim do dia',
    eodSublabel: 'Lembra-te de quaisquer tarefas de localização por terminar.',
    streakLabel: 'Sequência em risco',
    streakSublabel: 'Avisa-te às 20:00 quando a tua sequência estiver em risco.',
    weeklyLabel: 'Resumo semanal',
    weeklySublabel: 'Resumo de domingo à noite da tua semana.',
    reengageLabel: 'Lembretes de regresso',
    reengageSublabel: 'Um toque depois de 3 dias longe da app.',
    exitPromptLabel: 'Aviso ao sair',
    exitPromptSublabel: 'Pergunta se concluíste uma tarefa depois de saíres de um local marcado.',
    achievementNudgesLabel: 'Sugestões de conquistas',
    achievementNudgesSublabel: 'Notifica-te quando falta 1 passo para desbloquear uma distinção.',
    reminderTimeLabel: 'Hora do lembrete',
    reminderTimeA11y: (time: string) => `Hora do lembrete: ${time}`,
  },

  // ─── Onboarding (KAN-140, KAN-252) ──────────────────────────────────────────
  onboarding: {
    // "BRUSH AWAY" is the app name — kept in English (see taskRow above).
    eyebrow: 'BRUSH AWAY',
    welcomeTagline: 'Uma casa calma para o que os teus dias te vão pedindo em silêncio.',
    letsBegin: 'Vamos começar',
    reassurance: 'Sem configuração. Sem visita guiada. Só o teu dia.',
    addFirstThing: '+ Adiciona a tua primeira coisa',
    addFirstThingA11y: 'Adicionar a tua primeira coisa',
    emptyHelper: 'São só ideias passageiras. Adiciona o que é mesmo teu.',
    sheetEyebrow: 'A primeira coisa em que estás a pensar…',
    sheetHelper: 'Hora e local podem esperar. Tira isso da cabeça.',
    addTaskA11y: 'Adicionar tarefa',
    addItButton: 'Adicionar',
    greeting: 'Bom dia',
    todayLabel: 'TODAY',
    doneCountDone: '1 / 1 concluído',
    doneCountPending: '0 / 1',
    defaultTaskTitle: 'A tua tarefa',
    hintPrefix: 'Toca no círculo para ',
    // "brush it away" is the brand verb — kept in English (see taskRow above).
    hintBold: 'brush it away.',
    rewardHeadline: 'É uma. Já foi tratada.',
    rewardCaption: 'O Dia 1 da tua sequência começa aqui. No fundo, é só isto a app: ver, passar, deixar ir.',
    seeFullDay: 'Ver um dia completo →',
    nudgeTexts: {
      bread: 'Não te apetece pão?',
      coffeeOutside: 'Talvez hoje seja um bom dia para café na rua.',
      postOffice: 'Esta é a semana para ir aos CTT.',
      sportOutside: 'Que bom dia para fazer desporto lá fora.',
      pendingErrand: 'Esse recado que tens adiado? Continua à espera.',
      fridgeReplacement: 'Provavelmente há algo no frigorífico que precisa de ser substituído.',
    },
    chipBuyBread: 'Comprar pão',
    chipCoffeeOutside: 'Café na rua',
    chipGoForRun: 'Ir correr',
    chipWithdrawCash: 'Levantar dinheiro',
    chipGroceries: 'Compras',
  },

  // ─── Built-in category labels (KAN-252) — read live by theme/tokens.ts's
  // `categories` object (a getter per key) so every existing
  // `categories.work.label` / `categories[key].label` call site across the
  // app stays language-aware without changing. ──────────────────────────────
  categories: {
    work: 'Work',
    health: 'Health',
    errands: 'Errands',
    personal: 'Personal',
  },

  // ─── Built-in POI catalog labels (KAN-252) — read live via
  // poiCatalogLabel(type) in types/index.ts, same reasoning as categories
  // above. ─────────────────────────────────────────────────────────────────
  poiCatalog: {
    atm: 'ATM',
    cafe: 'Café',
    supermarket: 'Market',
    pharmacy: 'Pharmacy',
    gas: 'Gas',
    gym: 'Gym',
    bank: 'Bank',
    restaurant: 'Restaurant',
    park: 'Park',
    library: 'Library',
    post: 'Post',
    store: 'Store',
    clinic: 'Clinic',
    salon: 'Salon',
    bus: 'Bus',
    school: 'School',
  },

  // ─── Categories screen (KAN-16, KAN-252) ───────────────────────────────────
  categoriesScreen: {
    screenTitle: 'Categories',
    backA11y: 'Back',
    sectionBuiltIn: 'BUILT-IN',
    sectionCustom: 'CUSTOM',
    loadError: 'Could not load categories. Please try again.',
    retry: 'Try again',
    loading: 'Loading…',
    emptyCustom: 'No custom categories yet',
    addCategory: '+ Add Category',
    addCategoryA11y: 'Add category',
    sheetTitleNew: 'New Category',
    sheetTitleEdit: 'Edit Category',
    nameFieldLabel: 'NAME',
    namePlaceholder: 'Category name',
    nameA11y: 'Category name',
    nameRequiredError: 'Please enter a category name.',
    colorFieldLabel: 'COLOUR',
    swatchA11y: (hex: string) => `Color ${hex}`,
    hexPlaceholder: '#rrggbb',
    hexA11y: 'Custom hex colour',
    locationFieldLabel: 'LOCATION TYPE',
    locationNone: 'None',
    locationSearchPlaceholder: 'Search more types…',
    locationSearchA11y: 'Search location type',
    locationSelectedLabel: 'Selected:',
    locationClearA11y: 'Clear location type',
    dismissSheetA11y: 'Dismiss category sheet',
    cancel: 'Cancel',
    save: 'Save',
    saveA11y: 'Save category',
    rowA11y: (name: string) => `${name} category`,
    editButton: 'Edit',
    editA11y: (name: string) => `Edit ${name}`,
    deleteA11y: (name: string) => `Delete ${name}`,
    quickPickAtm: 'ATM',
    quickPickCafe: 'Café',
    quickPickSupermarket: 'Supermarket',
    quickPickPharmacy: 'Pharmacy',
  },

  // ─── Today screen (KAN-45, KAN-252) ─────────────────────────────────────────
  today: {
    weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    emptyMessages: [
      'Nothing on today. That doesn’t mean nothing matters.',
      'Don’t you feel the need for bread?',
      'Maybe today’s a good day for coffee outside.',
      'Might be worth grabbing some cash while you’re out.',
      'Anything in the cabinet running low?',
      'Something in the fridge is probably asking to be replaced.',
      'A clear day is a gift. What will you do with it?',
      'What’s the one thing future-you will thank you for?',
      'Going somewhere soon?',
    ],
    sectionTitlePrefix: 'WHAT I NEED',
    leftCount: (n: number) => `${n} left`,
    retry: 'Try again',
    addSomething: 'Add something',
    addSomethingHelper: 'Those are just passing thoughts. Add what’s actually yours.',
    openCalendarA11y: (weekday: string, day: number) => `Open calendar for ${weekday} ${day}`,
    nearbyCount: (n: number) => `${n} Nearby`,
    addTaskA11y: 'Add task',
    progressLabel: 'PROGRESS',
    progressSummary: (pct: number, remaining: number) => `${pct}% complete · ${remaining} left`,
  },

  // ─── Header (KAN-252) ───────────────────────────────────────────────────────
  header: {
    goodMorning: 'Good morning',
    goodAfternoon: 'Good afternoon',
    goodEvening: 'Good evening',
    goodNight: 'Good night',
    openProfileA11y: 'Open profile',
    pointsA11y: (points: number) => `${points} achievement points · view achievements`,
    pointsSuffix: (points: number) => `${points} pts`,
    socialA11y: (badge: number) => `Social, ${badge} pending`,
    socialA11yNoBadge: 'Social',
    notificationsA11yUnread: 'Notifications, unread',
    notificationsA11y: 'Notifications',
  },

  // ─── Achievements (KAN-114, KAN-252) ────────────────────────────────────────
  achievements: {
    screenTitle: 'Achievements',
    backA11y: 'Back',
    totalPointsLabel: 'TOTAL POINTS',
    totalPointsCaption: 'points earned so far',
    topTierPrefix: 'Top tier · ',
    tinFallback: 'Tin',
    tierLabel: (name: string) => name,
    onItsWay: (nextTierName: string) => ` · ${nextTierName} is on its way`,
    earnedSection: (count: number) => `EARNED · ${count}`,
    lockedSection: (count: number) => `LOCKED · ${count}`,
    cardA11y: (label: string, earned: boolean) => `${label} achievement, ${earned ? 'earned' : 'locked'}`,
    ptsEarned: (total: number) => `${total} pts earned`,
    ptsAvailable: (points: number) => `${points} pts available`,
    lockedBadge: 'Locked',
    catalogue: {
      firstTaskLabel: 'Off your mind',
      firstTaskCondition: 'Add your first task',
      firstBrushLabel: 'First brush',
      firstBrushCondition: 'Brush away your first task',
      rightPlaceLabel: 'Right place, right time',
      rightPlaceCondition: 'Brush a task while near where it happens',
      worthWaitLabel: 'Worth the wait',
      worthWaitCondition: 'Brush a task that stuck around for a few days',
      customCatLabel: 'Make it yours',
      customCatCondition: 'Create a custom category',
      outAboutLabel: 'Out and about',
      outAboutCondition: 'Brush tasks at a few different kinds of places',
      challengeWinnerLabel: 'First to brush it away',
      challengeWinnerCondition: 'Win a challenge against a friend',
      earlyBirdLabel: 'Early bird',
      earlyBirdCondition: 'Brush a task away before 9 AM',
      dayCompleteLabel: 'Day complete',
      dayCompleteCondition: 'Brush away every task in a single day',
      onARollLabel: 'On a roll',
      onARollCondition: '3-day brushing streak',
      explorerLabel: 'Explorer',
      explorerCondition: 'Brush away 10 location-based tasks',
      centurionLabel: 'Centurion',
      centurionCondition: 'Reach 100 achievement points',
    },
  },

  // ─── Compare achievements (KAN-105, KAN-252) ────────────────────────────────
  compareAchievements: {
    backA11y: 'Back',
    screenTitle: 'Compare',
    loadError: 'Could not load comparison. Try again later.',
    you: 'You',
    totalPoints: 'Total points',
    achievements: 'Achievements',
    streakDays: 'Streak (days)',
  },

  // ─── Social hub (KAN-100, KAN-252) ──────────────────────────────────────────
  socialHub: {
    backA11y: 'Back',
    screenTitle: 'Friends',
    refreshA11y: 'Refresh',
    loadError: 'Could not load Friends. Check your connection.',
    retry: 'Retry',
    // "Brush a To-do" is the brand verb — kept in English (see taskRow above).
    brushToDoAction: 'Brush a To-do',
    challengeAction: 'Challenge',
    sectionSharedTasks: 'SHARED TASKS',
    noSharedTasks: 'No shared tasks yet.',
    sharedTaskA11y: (name: string) => `Shared task from ${name}`,
    sectionChallenges: 'CHALLENGES',
    challengesComingSoon: 'Challenge alerts coming soon.',
    sectionFollowing: 'FOLLOWING',
    sectionFollowingCount: (n: number) => `FOLLOWING (${n})`,
    notFollowingAnyone: "You're not following anyone yet.",
    findMoreFriendsA11y: 'Find more friends',
    findMore: 'Find more',
  },

  // ─── Contact suggestions (KAN-99, KAN-252) ──────────────────────────────────
  contactSuggestions: {
    backA11y: 'Back',
    screenTitle: 'Find friends',
    idleTitle: 'Find friends from contacts',
    idleSub: 'Your contacts are hashed on-device — raw data never leaves your phone.',
    scanA11y: 'Scan contacts',
    scanButton: 'Scan contacts',
    requestingPermission: 'Requesting permission…',
    scanning: 'Scanning contacts…',
    deniedTitle: 'Permission required',
    deniedSub: 'Contacts access was denied. Open Settings to allow it.',
    openSettingsA11y: 'Open settings',
    openSettingsButton: 'Open Settings',
    unavailableTitle: 'Not available',
    unavailableSub: 'Contacts scanning is not available on this device or build.',
    emptyTitle: 'No matches found',
    emptySub: 'None of your contacts are on Brush Away yet — share your link to invite them!',
    errorTitle: 'Something went wrong',
    errorGeneric: 'Could not scan contacts. Please try again.',
    tryAgain: 'Try again',
    followingA11y: (name: string) => `Following ${name}`,
    followA11y: (name: string) => `Follow ${name}`,
    following: 'Following',
    follow: 'Follow',
  },

  friendPicker: {
    followingLoadError: 'Could not load your friends list. Check your connection.',
    title: 'Brush this over to…', // brand verb — stays literal
    closeA11y: 'Close',
    taskLabel: 'Task',
    searchPlaceholder: 'Search friends…',
    searchA11y: 'Search friends',
    loadingA11y: 'Loading friends',
    notFollowingAnyone: "You're not following anyone yet.",
    noMatches: (query: string) => `No friends match "${query}".`,
    sentToHandle: (username: string) => `Brushed to @${username}`, // brand verb
    sentCheck: 'Brushed ✓', // brand verb
    sendAtLeastOneA11y: (count: number) => `Brush it over to ${count} friend${count > 1 ? 's' : ''}`, // brand verb
    selectFriendsFirstA11y: 'Select friends first',
    sendButton: 'Brush it over', // brand verb
    selectFriendsFirstButton: 'Select friends first',
    sendFailed: (names: string) => `Could not send to: ${names}`,
  },

  challengeDetail: {
    mostTasksByDeadline: (deadline: string) => `Most tasks by ${deadline}`,
    loadError: 'Could not load challenge.',
    acceptFailed: 'Failed to accept. Please try again.',
    declineFailed: 'Failed to decline. Please try again.',
    backA11y: 'Back',
    screenTitle: 'Challenge',
    youSuffix: ' (you)',
    acceptA11y: 'Accept challenge',
    accept: 'Accept',
    declineA11y: 'Decline challenge',
    decline: 'Decline',
    finalResults: 'FINAL RESULTS',
    live: 'LIVE',
    participants: 'PARTICIPANTS',
    rowA11y: (handle: string, count: number, goal?: number) => `${handle}: ${count}${goal ? `/${goal}` : ''} tasks`,
    countA11y: (count: number) => `${count} tasks`,
    statusPending: 'pending',
    statusAccepted: 'accepted',
    statusDeclined: 'declined',
  },

  createChallenge: {
    followingLoadError: 'Could not load your friends list. Check your connection.',
    sendFailed: 'Failed to send challenge. Please try again.',
    stepTitleNew: 'New challenge',
    stepTitleGoal: 'Set goal',
    stepTitleDeadline: 'Set deadline',
    stepTitleFriends: 'Choose opponents',
    stepTitleMessage: 'Add a message',
    sentTitle: 'Challenge sent!',
    sentSubGroup: 'Your group challenge is on its way.',
    sentSub: 'Your challenge is on its way.',
    done: 'Done',
    backA11y: 'Back',
    goalTypeA11y: 'Goal-based challenge',
    timeTypeA11y: 'Time-based challenge',
    goalTypeTitle: 'First to X tasks',
    timeTypeTitle: 'Most tasks by deadline',
    goalTypeSub: 'Race to complete a set number of tasks',
    timeTypeSub: 'Whoever completes the most tasks wins',
    goalCountPrompt: 'First to complete how many tasks?',
    taskCountA11y: (n: number) => `${n} tasks`,
    customNumberPlaceholder: 'Custom number…',
    customTaskCountA11y: 'Custom task count',
    challengeEndsAt: 'Challenge ends at:',
    selectDeadlineA11y: 'Select deadline',
    groupChallengeCount: (n: number) => `Group challenge (${n} selected)`,
    selectOpponents: 'Select opponents',
    searchPlaceholder: 'Search friends…',
    searchA11y: 'Search friends',
    loadingFriendsA11y: 'Loading friends',
    notFollowingAnyone: "You're not following anyone yet.",
    noMatches: (query: string) => `No friends match "${query}".`,
    addMessageOptional: 'Add a message (optional)',
    messagePlaceholder: "Let's see what you've got! 💪",
    messageA11y: 'Challenge message',
    challengeSummary: 'Challenge summary',
    typeGoalSummary: (n: number | string) => `Type: First to ${n} tasks`,
    typeDeadlineSummary: (date: string) => `Type: Most tasks by ${date}`,
    opponentsSummary: (names: string) => `Opponents: ${names}`,
    sendChallengeA11y: 'Send challenge',
    continueA11y: 'Continue',
    sendChallenge: 'Send challenge',
    continue: 'Continue',
  },

  shareReceive: {
    poiNone: 'None',
    poiLabelAtm: 'ATM',
    poiLabelCafe: 'Café',
    poiLabelSupermarket: 'Market',
    poiLabelPharmacy: 'Pharmacy',
    discardA11y: 'Discard',
    navTitle: 'Add from message',
    parsingMessage: 'Parsing message…',
    couldntParse: "We couldn't parse a brush automatically. Add the details manually.",
    tryAgainA11y: 'Try again',
    tryAgain: 'Try again',
    aiSuggestion: 'AI suggestion — tap to edit',
    titlePlaceholder: 'Brush title', // brand noun — stays literal
    titleA11y: 'Title',
    titleRequired: 'Title is required.',
    sectionLocation: 'LOCATION',
    sectionTime: 'TIME',
    sectionDueDate: 'DUE DATE',
    sectionCategory: 'CATEGORY',
    clearTimeA11y: 'Clear time',
    setTimeA11y: 'Set time',
    setTime: 'Set time',
    clearDateA11y: 'Clear date',
    setDateA11y: 'Set due date',
    setDate: 'Set date',
    addBrushA11y: 'Add brush', // brand noun — stays literal
    addBrush: 'Add brush', // brand noun — stays literal
    saving: 'Saving…',
    discard: 'Discard',
  },

  shareTaskSheet: {
    cannotSendToSelf: 'You cannot send a task to yourself.',
    searchError: 'Could not search users. Check your connection.',
    sendFailedDefault: 'Failed to send task.',
    closeA11y: 'Close share sheet',
    title: 'Share task',
    closeButtonA11y: 'Close',
    emailPlaceholder: 'Recipient email address',
    emailA11y: 'Recipient email',
    findA11y: 'Find user',
    find: 'Find',
    noUserFound: 'No user found with that email.',
    sentTo: (name: string) => `✓ Task sent to ${name}`,
  },

  shareProfileSheet: {
    closeSheetA11y: 'Close sheet',
    headerTitle: 'Share my profile',
    closeA11y: 'Close',
    profilePhotoA11y: 'Profile photo',
    pointsPill: (n: number) => `${n} pts`,
    setUsernameFirst: 'Set a username first',
    setUsernameBody: 'Your profile link uses your username — add one to share your profile.',
    setUsernameA11y: 'Set username',
    setUsername: 'Set username',
    linkCopiedA11y: 'Link copied',
    copyLinkA11y: 'Copy link',
    copied: 'Copied!',
    copyLink: 'Copy link',
    shareViaMessageA11y: 'Share via message',
    message: 'Message',
    qrCodeComingSoonA11y: 'Show QR code (coming soon)',
    qrCode: 'QR code',
    moreSharingA11y: 'More sharing options',
    more: 'More',
  },

  publicProfile: {
    followToggleFailed: 'Something went wrong. Please try again.',
    backA11y: 'Back',
    userNotFound: (username: string) => `User @${username} not found.`,
    avatarA11y: (name: string) => `${name} avatar`,
    followers: 'Followers',
    following: 'Following',
    unfollowA11y: (name: string) => `Unfollow ${name}`,
    followA11y: (name: string) => `Follow ${name}`,
    followingLabel: 'Following',
    followLabel: 'Follow',
    points: 'Points',
    streak: 'Streak',
    compareAchievementsA11y: (name: string) => `Compare achievements with ${name}`,
    compareAchievements: 'Compare achievements',
  },

  profile: {
    usernameTaken: (username: string) => `@${username} is already taken.`,
    cooldownError: (days: number) => `You can change your username in ${days} day${days !== 1 ? 's' : ''}.`,
    saveFailed: 'Failed to save. Please try again.',
    backA11y: 'Back',
    screenTitle: 'Profile',
    profilePhotoA11y: 'Profile photo',
    editingProfile: 'Editing profile',
    closeEditA11y: 'Close edit',
    editProfileA11y: 'Edit profile',
    nameLabel: 'Name',
    editNameA11y: 'Edit name',
    usernameLabel: 'Username',
    editUsernameA11y: 'Edit username',
    cooldownRemaining: (days: number) => `${days}d cooldown remaining`,
    cancelA11y: 'Cancel',
    cancel: 'Cancel',
    saveProfileA11y: 'Save profile',
    saving: 'Saving…',
    save: 'Save',
    shareMyProfileA11y: 'Share my profile',
    shareMyProfile: 'Share my profile',
    pointsAndAchievements: 'POINTS & ACHIEVEMENTS',
    totalPointsLabel: 'TOTAL POINTS',
    totalPointsA11y: (n: number) => `${n} points`,
    topTierPrefix: 'Top tier · ',
    ptsToGo: (n: number) => `${n} pts`,
    toGoSuffix: (tierName: string) => ` to ${tierName}`,
    dayStreakSuffix: '-day streak',
    achievements: 'Achievements',
    achievementsCount: (earned: number, total: number) => ` · ${earned}/${total}`,
    seeAllA11y: 'See all achievements',
    seeAll: 'See all ›',
    settingsA11y: 'Settings',
    settingsTitle: 'Settings',
    settingsSub: 'App & account',
  },

  taskFormScreen: {
    deleteConfirmTitle: 'Delete this task?',
    cancel: 'Cancel',
    delete: 'Delete',
    goBackA11y: 'Go back',
    editTaskTitle: 'Edit task',
    taskTitleA11y: 'Task title',
    clearSearchA11y: 'Clear search',
    createNewCategoryA11y: 'Create new category',
    categoryNamePlaceholder: 'Category name',
    notesPlaceholder: 'Add a note, link, or reminder…',
    deleteTaskA11y: 'Delete task',
    birthdayToggleLabel: "It's a birthday",
    birthdayToggleSublabel: 'No place needed, never affects your ring or streak, and clears itself the day after.',
    birthdayToggleA11y: 'Mark as a birthday',
    birthdayWarningTitle: 'Mark this as a birthday?',
    birthdayWarningBody: "This removes the place it's tied to, drops it from your ring and streak, and it'll quietly disappear the day after — no missed mark, no trace.",
    birthdayWarningConfirm: 'Mark as birthday',
    birthdayUnsetWarningTitle: 'Unmark this birthday?',
    birthdayUnsetWarningBody: "This task becomes a normal task again — you'll need to give it a place before you can save.",
    birthdayUnsetWarningConfirm: 'Unmark',
  },

  takeMeThere: {
    /** Never "Navigate to nearest POI" — no jargon, no urgency (KAN-279). */
    a11yFor: (poiLabel: string) => {
      const article = /^[aeiou]/i.test(poiLabel) ? 'an' : 'a';
      return `Take me to ${article} ${poiLabel}`;
    },
  },

  pointsHistoryScreen: {
    backA11y: 'Back',
    loadingA11y: 'Loading points history',
    loadMoreA11y: 'Load more history',
  },

  tripPlannerScreen: {
    backA11y: 'Back',
    startDateA11y: 'Start date',
    endDateA11y: 'End date',
    continueA11y: 'Continue',
    continue: 'Continue',
  },

  nearbyCard: {
    headerLabel: 'Nearby',
    headerNowLabel: 'Nearby · now',
    placesCount: (n: number) => (n === 1 ? '1 Place' : `${n} Places`),
    openInMaps: 'Open in Maps',
    openInMapsA11y: (placeName: string) => `Open ${placeName} in Maps`,
    tryAnotherPlace: 'Try another place',
    tryAnotherPlaceA11y: 'Try another place',
    refreshLocationA11y: 'Refresh location',
    storeTuningOn: 'Store tuning on',
    refreshUpdated: 'Updated',
    refreshFailed: 'Failed',
    alsoClose: 'Also close',
  },

  newTaskSheet2: {
    closeA11y: 'Close',
    moreDetailsA11y: 'More details',
  },

  storeTuningPromptSheet: {
    dismissA11y: 'Dismiss prompt',
    turnOnA11y: 'Turn on Store fine tuning',
    notNowA11y: 'Not now',
  },

  importTasksSection: {
    inProgressA11y: 'Import in progress',
    cancelledA11y: 'Import cancelled',
    sectionA11y: 'Import tasks section',
  },

  errorBoundary: {
    tryAgainA11y: 'Try again',
  },

  timePicker: {
    hourA11y: 'Hour',
    minuteA11y: 'Minute',
    formatToggleTo24: 'Clock format: 12 hour. Switch to 24 hour.',
    formatToggleTo12: 'Clock format: 24 hour. Switch to 12 hour.',
  },

  taskReminder: {
    /** notifee trigger notification fired at the task's user-set time (KAN-280). Never "due"/"deadline"/"overdue" — the user asked for this, it's service, not pressure. */
    title: (time: string) => `You wanted this at ${time}`,
    body: (taskTitle: string) => taskTitle,
  },

  calendar: {
    weekdayLabels: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
    monthNamesFull: [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ],
    fullWeekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    dayCellA11y: (day: number, isToday: boolean, isSelected: boolean) =>
      `${day}${isToday ? ', today' : ''}${isSelected ? ', selected' : ''}`,
    loadError: 'Could not load tasks. Check your connection.',
    loadErrorRetry: 'Could not load tasks. Please try again.',
    statusToday: 'Today',
    statusUpcoming: 'Upcoming',
    statusComplete: 'Day complete',
    statusPast: 'Past',
    noTasks: 'No tasks',
    tasksPlanned: (n: number) => `${n} task${n === 1 ? '' : 's'} planned`,
    tasksNoneCompleted: (n: number) => `${n} task${n === 1 ? '' : 's'} · none completed`,
    tasksDoneStats: (done: number, total: number, pct: number) => `${done} of ${total} done · ${pct}%`,
    backA11y: 'Back',
    screenTitle: 'Calendar',
    jumpToTodayA11y: 'Jump to today',
    today: 'Today',
    previousMonthA11y: 'Previous month',
    nextMonthA11y: 'Next month',
    tryAgainA11y: 'Try again',
    tryAgain: 'Try again',
    dayRun: (n: number) => `${n}-day run`,
    unlockedSuffix: (label: string) => `${label} · unlocked`,
    nothingOnThisDay: 'Nothing on this day.',
    openTodayA11y: 'Open today',
    openToday: 'Open today',
    /** KAN-264 — shown under a rolled task on its origin day, once it's later brushed. Neutral/redemptive — never "missed"/"expired"/"overdue". */
    brushedAwayOn: (weekday: string) => `Brushed away on ${weekday}`,
  },

  shareToDo: {
    shareA11y: (title: string) => `Share ${title}`,
    backA11y: 'Back',
    subtitle: 'Brush this over to a friend', // brand verb — stays literal
    noOpenTasks: 'No open tasks for today.',
  },

  sharedTaskInbox: {
    startedFollowingA11y: (handle: string) => `${handle} started following you`,
    startedFollowingSuffix: ' started following you',
    followBackA11y: (handle: string) => `Follow back ${handle}`,
    followBack: 'Follow back',
    following: 'Following',
    avatarA11y: (name: string) => `${name} avatar`,
    acceptTaskA11y: 'Accept task',
    accept: 'Accept',
    declineTaskA11y: 'Decline task',
    decline: 'Decline',
    followPrompt: (handle: string) => `+ Follow ${handle}`,
    backA11y: 'Back',
    notifications: 'Notifications',
    unreadSuffix: (n: number) => ` (${n})`,
    allCaughtUp: 'All caught up',
  },

};

const ptPT: typeof en = {

  // "Brush"/"brush away"/"unbrush"/"brushed" — the app's own name and its
  // defining completion-verb wordplay — are kept in English even here, per
  // an explicit product decision: the brand verb never gets localized.
  taskRow: {
    brushAway: (title: string) => `Brush away ${title}`,
    unbrush:   (title: string) => `Unbrush ${title}`,
    syncingA11y: 'A sincronizar',
    editA11y:    (title: string) => `Editar ${title}`,
  },

  progress: {
    ringA11y: (done: number, total: number) => `${done} of ${total} tasks brushed`,
  },

  emptyState: {
    todayNoTasks:    'Nada para tratar hoje',
    todayAllBrushed: 'Tela limpa. 🖌',
    calendarNoTasks: 'Nada para tratar',
    inboxNoShared:   'Ainda ninguém te enviou nada',
  },

  notification: {
    // A "an"/"a" agreement in English maps to gendered "um"/"uma" in
    // Portuguese, which we can't resolve correctly without a gender lookup
    // per POI label — so the article is dropped here rather than risk
    // guessing the wrong gender.
    proximityTitle: (poiLabel: string) => `Estás perto de: ${poiLabel}`,
    proximityBody: (count: number) =>
      `Tens ${count} coisa${count === 1 ? '' : 's'} para tratar.`,

    dailyCompleteTitle: 'Já trataste de tudo hoje 🖌',
    dailyCompleteBody:  'Todas as tarefas tratadas. Tela limpa!',
  },

  achievement: {
    challengeWinnerTitle:    'Primeiro a tratá-la',
    challengeWonBody:        'Conquista desbloqueada: primeiro a tratá-la',
    challengeEndedBody:      'Mais sorte para a próxima!',
    challengeWonNotifTitle:  '🏆 Ganhaste o desafio!',
    dailyCompleteTitle:      'Tudo tratado por hoje!',
    dailyCompleteBody:       'Trataste de todas as tarefas da tua lista. Bom trabalho!',
  },

  challenge: {
    goalTypeLabel: (count: number) => `Primeiro a tratar ${count} tarefas`,
    inviteTitle:   (handle: string, typeLabel: string) =>
      `${handle} desafiou-te: [${typeLabel}] 🏆 — Aceitar?`,
  },

  share: {
    screenTitle:          'Partilha um to-do com um amigo',
    sendButton:           (name: string) => `Envia isto para ${name}`,
    activityFeedReceived: (senderName: string) => `${senderName} enviou-te um to-do`,
    activityFeedSuffix:   'enviou-te um to-do',
  },

  newTaskSheet: {
    title:        'O que precisas de fazer?',
    poiQuestion:  'Onde é que isto acontece?',
    catQuestion:  'Que parte da tua vida?',
    catOptional:  ' (opcional)',
    swipeHint:    'Desliza para ver mais',
    moreDetails:  'Mais detalhes ›',
    cta:          'Adicionar',
    ctaSubmitting: 'A adicionar…',
    titleExamples: [
      'Comprar pasta de dentes…',
      'Levantar dinheiro…',
      'Devolver o livro à biblioteca…',
      'Passar pela farmácia…',
      'Atestar o depósito a caminho de casa…',
    ],
    poiSearchPlaceholder: 'Um café, uma farmácia, um ginásio…',
    timeQuestion:         'Para quando, mais ou menos?',
    timeOptional:         ' (opcional)',
    timePlaceholder:      'Qualquer altura serve',
    clearTimeA11y:        'Limpar hora',
    footerHint:           'Só o quê e o onde',
    confirmToast:         'Entendido — vou estar atento.',
    poiSuggestionHint:    'o meu palpite?',
    poiSuggestionConfirmedSuffix: 'sugestão',
  },

  offline: {
    noCacheYetBanner: 'Sem ligação — ainda não consigo procurar sítios por perto. Vou começar a aprender a tua zona assim que estiveres online.',
    uncoveredAreaToast: 'Estás fora da zona que já conheço bem — vou precisar de ligação para encontrar sítios aqui.',
    uncoveredAreaInvitationToast: 'Estás fora da zona que já conheço bem. Para a próxima, diz-me antes de saíres — posso aprender um sítio com antecedência.',
    uncoveredAreaInvitationAction: 'Mostra-me',
  },

  tripPlanner: {
    placesIKnowBackA11y: 'Voltar',
    refreshTripA11y: (destination: string) => `Atualizar ${destination}`,
    refresh: 'Atualizar',
    deleteTripA11y: (destination: string) => `Eliminar ${destination}`,
    changeTripDates: 'Editar datas',
    addTripDates: 'Editar datas',
    changeTripDatesA11y: (destination: string) => `Alterar as datas de ${destination}`,
    learnBiggerArea: 'Editar tamanho da zona',
    learnBiggerAreaA11y: (destination: string) => `Aprender uma zona maior à volta de ${destination}`,
    entryRowLabel: 'Vais a algum lado?',
    entryRowA11y:  'Planear uma viagem',
    entryRowA11yWithDate: (dateLabel: string) => `Planear uma viagem a partir de ${dateLabel}`,
    destinationQuestion: 'Para onde vais?',
    destinationPlaceholder: 'Faro, Lisboa, Tóquio…',
    datesQuestion: 'Quando vais?',
    datesOptional: ' (opcional)',
    datesSkip:     'Vou saltar as datas',
    radiusTown:          'Só a cidade',
    radiusTownAndAround: 'Cidade e arredores',
    radiusRegion:        'A região toda',
    sizeEstimateLine: (mb: string, untilDate?: string) =>
      untilDate
        ? `Cerca de ${mb} — vou saber até ${untilDate}.`
        : `Cerca de ${mb} — vou manter isto atualizado durante cerca de um mês.`,
    downloadButton:   'Aprender esta zona',
    saveDatesButton:  'Guardar datas',
    saveAreaButton:   'Guardar zona',
    downloadingLabel: 'A aprender a zona…',
    downloadErrorToast: 'Não consegui aprender esta zona — verifica a tua ligação e tenta outra vez.',
    downloadSuccessToast: (destination: string) => `Entendido — já conheço ${destination}.`,
    editDatesSuccessToast: (destination: string) => `Datas atualizadas para ${destination}.`,
    editRadiusSuccessToast: (destination: string) => `Zona atualizada para ${destination}.`,
    changeDatesTitle: 'Alterar as datas',
    placesIKnowTitle: 'Sítios que conheço',
    placesIKnowEmpty: 'Ainda não conheço nenhuma zona de viagem — adiciona uma acima.',
    tripUpcomingRowLabel: (destination: string) => `Vou a ${destination} em breve`,
    tripUpcomingRowSubtitle: (untilDate: string) => `Vou saber orientar-me · até ${untilDate}`,
    tripUpcomingRowA11y: (destination: string) => `Vou a ${destination} em breve`,
    tripActiveRowLabel: (destination: string, untilDate: string) => `${destination} · até ${untilDate}`,
    tripActiveRowA11y: (destination: string) => `${destination} — viagem em curso`,
    whereWeveBeenRowLabel: (destination: string) => `Onde já estivemos · ${destination}`,
    whereWeveBeenRowA11y:  (destination: string) => `Onde já estivemos — ${destination}`,
    whereWeveBeenEntryRowLabel: 'Onde já estivemos',
    whereWeveBeenEntryRowA11y:  'Ver onde já estivemos',
    habitatRowLabel: 'Onde costumo andar',
    habitatRowSub:   'Atualizado automaticamente ao longo do teu dia',
    tripRowDates:      (start: string, end: string) => `${start} – ${end}`,
    tripRowNoDates:    'Sem datas definidas',
    tripRowKnownUntil: (date: string) => `Vou saber até ${date}`,
    deleteConfirmTitle:  (destination: string) => `Esquecer ${destination}?`,
    deleteConfirmBody:   'Vou deixar de reconhecer sítios aí. Podes sempre voltar a aprender mais tarde.',
    deleteConfirmAction: 'Esquecer',
    deleteCancelAction:  'Manter',
    cancelConfirmTitle:  (destination: string) => `Já não vais a ${destination}?`,
    cancelConfirmBody:   'Vou deixar de me preparar para esta viagem.',
    cancelConfirmAction: 'Já não vou',
  },

  // ─── "Onde já estivemos" (KAN-257) ─────────────────────────────────────────
  whereWeveBeenScreen: {
    screenTitle: 'Onde já estivemos',
    backA11y: 'Voltar',
    forgetTripLabel: 'Esquecer esta viagem',
    forgetTripA11y: (destination: string) => `Esquecer esta viagem — ${destination}`,
    forgetConfirmTitle: (destination: string) => `Esquecer ${destination}?`,
    forgetConfirmBody: 'Esta viagem deixa de aparecer aqui.',
    forgetConfirmAction: 'Esquecer',
    cancel: 'Cancelar',
  },

  oneTripForAll: {
    entryLabel: 'Uma viagem para todas estas',
    entryA11y:  'Uma viagem para todas estas',
  },

  itineraryOptionsScreen: {
    screenTitle:  'Uma viagem para todas estas',
    cardLabel:    'Paragem a paragem',
    backA11y:     'Voltar',
    loadingLabel: 'A encontrar o caminho…',
    stopsCount:   (n: number) => (n === 1 ? '1 paragem' : `${n} paragens`),
    destinationLearned: (name: string) => `${name} · o teu habitual`,
    destinationWithDistance: (name: string, distance: string) => `${name} · ${distance}`,
    totalDistance:  (km: string) => `Cerca de ${km} km no total`,
    exclusionLine:  (n: number) => (n === 1 ? 'Não encontrei um local para 1 delas' : `Não encontrei um local para ${n} delas`),
    openInMapsA11y: 'Abrir direções no Maps',
    emptyStateBody: 'Não encontrei locais para nenhuma delas agora.',
    errorBody:      'Algo correu mal ao encontrar o caminho.',
    retryLabel:     'Tentar novamente',
    mapsOpenFailed: 'Não consegui abrir o Maps — tenta outra vez.',
    // ── Mall card (KAN-282) ──
    mallCardTitle:     'Tudo num só lugar',
    mallCardSubtitle:  (name: string) => name,
    mallCardDistance:  (distance: string) => `A ${distance}`,
    mallCardA11y:      (name: string) => `Tudo num só lugar — ${name}`,
    mallOpenInMapsA11y: 'Abrir direções para o centro comercial no Maps',
  },

  contextChip: {
    offlineGlyphA11y: 'Offline — conheço esta zona',
    closeSheetA11y: 'Fechar painel',
    closeA11y:      'Fechar',
    sheetTitle: 'O que conheço aqui',
    sheetBody: (date?: string) =>
      date
        ? `Aprendi os sítios aqui perto — última atualização a ${date}.`
        : 'Aprendi os sítios aqui perto.',
    refreshButton:    'Atualizar agora',
    refreshingLabel:  'A atualizar…',
    refreshErrorToast: 'Não consegui atualizar — verifica a tua ligação e tenta outra vez.',

    mallChipA11y: (name: string) => `Em ${name} — toca para detalhes`,
    tripChipA11y: (destination: string) => `Em ${destination} — toca para detalhes`,
    offlineDotA11y: 'Offline',
    mallSheetTitle: (name: string) => `Enquanto estás em ${name}`,
    tripSheetTitle: (destination: string) => `Enquanto estás em ${destination}`,
    placeSheetCoverageLine: 'Aprendi os sítios aqui perto.',
    mallSheetFreshnessLine: (date: string) => `Última aprendizagem a ${date}`,
    placeRefreshErrorToast: 'Não consegui atualizar — verifica a tua ligação e tenta outra vez.',
  },

  mallSnapshot: {
    rowLabel: 'Activar modo Shopping',
    rowSublabel: 'Descarregue os locais deste Shopping para que eu te ajude mais rapidamente e sem internet.',
    downloadingLabel: 'A descarregar dados do centro comercial…',
    noMallFoundToast: 'Não encontro nenhum centro comercial por perto — tenta outra vez quando estiveres dentro de um.',
    errorToast: 'Não consegui aprender este centro comercial — verifica a tua ligação e tenta outra vez.',
  },

  errandBundle: {
    cardLine: (taskCount: number, anchorName: string) =>
      `${taskCount} destas tarefas podem acontecer perto umas das outras — dez minutos a pé à volta de ${anchorName}.`,
    cardA11y: (taskCount: number, anchorName: string) =>
      `${taskCount} tarefas podem acontecer perto umas das outras, à volta de ${anchorName} — toca para detalhes`,
    dismissA11y: 'Agora não',
    sheetTitle: (anchorName: string) => `Perto de ${anchorName}`,
    sheetIntro: 'Estas podem acontecer perto umas das outras — vê o que encaixa, pela ordem que preferires.',
    closeA11y: 'Fechar',
    closeSheetA11y: 'Fechar painel',
    // KAN-283 — ver nota na versão EN: indica apenas o número de paragens.
    openAllInMaps: (stopCount: number) => `Abrir no Maps — as ${stopCount} paragens`,
    openAllInMapsA11y: (stopCount: number) => `Abrir as ${stopCount} paragens no Maps`,
    deselectStopA11y: (taskTitle: string) => `Deixar ${taskTitle} de fora`,
    selectStopA11y:   (taskTitle: string) => `Incluir ${taskTitle}`,
    deselectStopDisabledA11y: 'Esta fica — uma rota precisa de pelo menos duas paragens',
    // KAN-293 — ver nota na versão EN: convite, nunca plano. Sem urgência,
    // sem promoções, sem preços.
    leisureParkLine: (placeName: string) =>
      `${placeName} fica mesmo ali — que tal um passeio, já que estás por perto?`,
    leisureOtherLine: (placeName: string) => `${placeName} também fica mesmo ali.`,
    leisureKeepInMind: 'Juntar à rota',
    leisureKeepInMindA11y: (placeName: string) => `Juntar ${placeName} a esta rota`,
    leisureKeptConfirmation: (placeName: string) => `${placeName} vai entrar nesta rota do Maps.`,
    leisureGetTickets: 'Comprar bilhetes',
    leisureGetTicketsA11y: (placeName: string) => `Abrir o site de ${placeName}`,
  },

  tripSuggestion: {
    cardLine: (place: string, day: string) =>
      `Vais a ${place} no dia ${day}? Posso aprender o sítio antes de saíres.`,
    cardA11y: (place: string, day: string) =>
      `Vais a ${place} no dia ${day}? Posso aprender o sítio antes de saíres — toca para configurar`,
    dismissA11y: 'Agora não',
  },

  offGrid: {
    profileRowLabel: 'Vais ficar sem rede?',
    profileRowSublabel: 'Vais para algum sítio sem rede por umas horas? Posso preparar-me.',
    profileRowA11y: 'Configurar um período sem rede',
    screenTitle: 'Vais ficar sem rede por umas horas?',
    durationFewHours: 'Umas horas',
    durationUntilTonight: 'Até logo à noite',
    durationPickTime: 'Escolher uma hora',
    destinationOverridePrompt: 'Noutro sítio?',
    destinationPlaceholder: 'Faro, Lisboa, Tóquio…',
    currentAreaLabel: 'esta zona',
    confirmButton: 'Preparar',
    confirmingLabel: 'A preparar…',
    confirmToast: (until: string) => `Entendido — vou conhecer esta zona até às ${until}.`,
    errorToast: 'Não consegui preparar esta zona — verifica a tua ligação e tenta outra vez.',
    welcomeBackToast: (n: number) => `Bem-vindo de volta — ${n} ${n === 1 ? 'coisa foi' : 'coisas foram'} riscada${n === 1 ? '' : 's'} enquanto estavas sem rede.`,
    chipA11y: (until: string) => `Sem rede até às ${until}`,
    sheetTitle: 'Sem rede',
    sheetBody: (until: string) => `Vou conhecer esta zona até às ${until}.`,
  },

  home: {
    backA11y: 'Voltar',
    loadingA11y: 'A carregar morada',
    savingA11y: 'A guardar',
    cancel: 'Cancelar',
    settingsRowLabel: 'Casa',
    settingsRowEmptySublabel: 'Não definida',
    screenTitle: 'Casa',
    searchPlaceholder: 'Procura a tua morada…',
    note: 'Para eu saber orientar-me pelo teu bairro. Guardado na tua conta — só tu podes ver.',
    changeButton: 'Alterar',
    clearButton: 'Limpar',
    clearConfirmTitle: 'Limpar morada de casa?',
    clearConfirmBody: 'Vou deixar de a usar para me orientar pelo teu bairro.',
    clearConfirmAction: 'Limpar',
    clearCancelAction: 'Manter',
    saveErrorToast: 'Não consegui guardar — verifica a tua ligação e tenta outra vez.',
    clearErrorToast: 'Não consegui limpar — verifica a tua ligação e tenta outra vez.',
  },

  settings: {
    screenTitle: 'Definições',
    backA11y: 'Voltar',
    sectionTasks: 'TAREFAS',
    sectionAppearance: 'APARÊNCIA',
    sectionLocationBattery: 'LOCALIZAÇÃO E BATERIA',
    sectionImportTasks: 'IMPORTAR TAREFAS',
    sectionAccount: 'CONTA',
    manageCategories: 'Gerir Categorias',
    notificationPreferences: 'Preferências de Notificação',
    darkMode: 'Modo escuro',
    darkModeToggleA11y: 'Alternar modo escuro',
    pauseLowBattery: 'Pausar alertas próximos com bateria fraca',
    pauseLowBatteryToggleA11y: 'Alternar pausa de alertas com bateria fraca',
    languageRowLabel: 'Idioma',
    languageSheetTitle: 'Escolhe um idioma',
    languageEnglish: 'English',
    languagePortuguese: 'Português',
    languageCancel: 'Cancelar',
    importGoogleTasks: 'Google Tasks',
    importGoogleCalendar: 'Google Calendar',
    importReminders: 'Lembretes',
    importCalendar: 'Calendário',
    importInProgressA11y: 'Importação em curso',
    importedCount: (count: number) => `${count} importada${count === 1 ? '' : 's'}`,
    importFailedRetry: 'Falhou · tentar novamente',
    importErrorMessage: 'Falha na importação. Tenta outra vez.',
    signOutConfirmTitle: 'Terminar sessão?',
    signOutConfirmBody: 'Vais precisar de iniciar sessão novamente para ver as tuas tarefas.',
    signOutConfirmAction: 'Terminar sessão',
    signOutCancelAction: 'Cancelar',
    signOutErrorTitle: 'Erro',
    signOutErrorBody: 'Falha ao terminar sessão. Tenta outra vez.',
    footerVersion: (version: string) => `Brush Away · v${version}`,
    footerAttribution: 'Dados de locais © colaboradores do OpenStreetMap (ODbL)',
  },

  login: {
    tagline: 'Brush away your to-dos, as you pass them.',
    emailLabel: 'Email',
    emailPlaceholder: 'tu@exemplo.com',
    passwordLabel: 'Palavra-passe',
    forgotPassword: 'Esqueceste-te da palavra-passe?',
    showPassword: 'Ver',
    hidePassword: 'Ocultar',
    showPasswordA11y: 'Ver palavra-passe',
    hidePasswordA11y: 'Ocultar palavra-passe',
    passwordPlaceholderSignup: 'Mín. 6 caracteres',
    passwordPlaceholderSignin: '••••••••',
    orDivider: 'ou',
    continueWithGoogle: 'Continuar com Google',
    createAccount: 'Criar Conta',
    signIn: 'Entrar',
    createAccountA11y: 'Criar conta',
    signInA11y: 'Entrar',
    alreadyHaveAccount: 'Já tens conta? ',
    dontHaveAccount: 'Não tens conta? ',
    signInLink: 'Entrar',
    signUpLink: 'Criar conta',
    errorInvalidEmail: 'Introduz um endereço de email válido.',
    errorUserNotFound: 'Não encontrámos nenhuma conta com este email.',
    errorInvalidCredential: 'Email ou palavra-passe inválidos. Verifica as tuas credenciais.',
    errorWrongPassword: 'Palavra-passe incorreta. Tenta outra vez.',
    errorEmailInUse: 'Já existe uma conta com este email.',
    errorWeakPassword: 'A palavra-passe deve ter pelo menos 6 caracteres.',
    errorTooManyRequests: 'Demasiadas tentativas. Espera um momento e tenta outra vez.',
    errorNetwork: 'Erro de rede — verifica a tua ligação.',
    errorCreateAccountGeneric: 'Não foi possível criar a conta. Tenta outra vez.',
    errorSignInGeneric: 'Falha ao entrar. Tenta outra vez.',
    errorEmailRequired: 'Introduz o teu endereço de email.',
    errorPasswordRequired: 'Introduz a tua palavra-passe.',
    errorGoogleSignIn: 'Falha ao entrar com Google. Tenta outra vez.',
  },

  usernameSetup: {
    title: 'Escolhe um nome de utilizador',
    subtitle: 'O teu identificador único para partilhar tarefas e ligares-te a amigos.',
    placeholder: 'oteuidentificador',
    inputA11y: 'Nome de utilizador',
    hint: '3–20 carateres · letras, números e underscores apenas',
    continueButton: 'Continuar',
    note: 'Podes alterar o teu nome de utilizador uma vez cada 30 dias.',
    errorTaken: (value: string) => `@${value} já está a ser usado. Escolhe outro.`,
    errorGeneric: 'Algo correu mal. Tenta outra vez.',
    errorTooShort: (min: number) => `São necessários pelo menos ${min} carateres.`,
    errorTooLong: (max: number) => `Máximo de ${max} carateres.`,
    errorInvalidChars: 'Apenas letras minúsculas, números e underscores.',
  },

  notificationPreferences: {
    screenTitle: 'Notificações',
    backA11y: 'Voltar',
    loadingA11y: 'A carregar preferências',
    sectionDaily: 'DIÁRIO',
    sectionStreaks: 'SEQUÊNCIAS',
    sectionSummary: 'RESUMO',
    sectionEngagement: 'ENVOLVIMENTO',
    sectionLocation: 'LOCALIZAÇÃO',
    sectionAchievements: 'CONQUISTAS',
    eodLabel: 'Ponto de situação do dia',
    eodSublabel: 'Recorda-te de tarefas de localização por terminar.',
    streakLabel: 'Sequência em risco',
    streakSublabel: 'Avisa-te às 20h quando a tua sequência estiver em risco.',
    weeklyLabel: 'Resumo semanal',
    weeklySublabel: 'Resumo da tua semana ao domingo à noite.',
    reengageLabel: 'Lembretes de regresso',
    reengageSublabel: 'Um toque depois de 3 dias sem abrir a app.',
    exitPromptLabel: 'Pergunta ao sair',
    exitPromptSublabel: 'Pergunta se concluíste uma tarefa depois de saíres de um local marcado.',
    achievementNudgesLabel: 'Lembretes de conquistas',
    achievementNudgesSublabel: 'Avisa-te quando estiveres a 1 passo de desbloquear um distintivo.',
    reminderTimeLabel: 'Hora do lembrete',
    reminderTimeA11y: (time: string) => `Hora do lembrete: ${time}`,
  },

  onboarding: {
    eyebrow: 'BRUSH AWAY',
    welcomeTagline: 'Um lugar calmo para as coisas que os teus dias andam a pedir em silêncio.',
    letsBegin: 'Vamos começar',
    reassurance: 'Sem configurações. Sem tour. Só o teu dia.',
    addFirstThing: '+ Adiciona a primeira coisa',
    addFirstThingA11y: 'Adiciona a primeira coisa',
    emptyHelper: 'Isso são só pensamentos passageiros. Adiciona o que é realmente teu.',
    sheetEyebrow: 'A primeira coisa em que pensas…',
    sheetHelper: 'A hora e o local podem esperar. Tira isso da cabeça.',
    addTaskA11y: 'Adicionar tarefa',
    addItButton: 'Adicionar',
    greeting: 'Bom dia',
    todayLabel: 'HOJE',
    doneCountDone: '1 / 1 feita',
    doneCountPending: '0 / 1',
    defaultTaskTitle: 'A tua tarefa',
    hintPrefix: 'Toca no círculo para ',
    hintBold: 'brush it away.',
    rewardHeadline: 'Essa foi uma. Já foi tratada.',
    rewardCaption: 'O dia 1 da tua sequência começa aqui. É basicamente a app toda, no fundo: vês, passas por ela, deixas ir.',
    seeFullDay: 'Ver um dia completo →',
    nudgeTexts: {
      bread: 'Não sentes falta de pão?',
      coffeeOutside: 'Talvez hoje seja um bom dia para um café na rua.',
      postOffice: 'É esta a semana para ires aos correios.',
      sportOutside: 'Que belo dia para fazeres desporto ao ar livre.',
      pendingErrand: 'Aquele recado que tens andado a adiar? Continua lá.',
      fridgeReplacement: 'Provavelmente há algo no frigorífico que precisa de ser reposto.',
    },
    chipBuyBread: 'Comprar pão',
    chipCoffeeOutside: 'Café na rua',
    chipGoForRun: 'Ir correr',
    chipWithdrawCash: 'Levantar dinheiro',
    chipGroceries: 'Compras',
  },

  categories: {
    work: 'Trabalho',
    health: 'Saúde',
    errands: 'Recados',
    personal: 'Pessoal',
  },

  poiCatalog: {
    atm: 'Multibanco',
    cafe: 'Café',
    supermarket: 'Mercado',
    pharmacy: 'Farmácia',
    gas: 'Combustível',
    gym: 'Ginásio',
    bank: 'Banco',
    restaurant: 'Restaurante',
    park: 'Parque',
    library: 'Biblioteca',
    post: 'Correios',
    store: 'Loja',
    clinic: 'Clínica',
    salon: 'Salão',
    bus: 'Autocarro',
    school: 'Escola',
  },

  categoriesScreen: {
    screenTitle: 'Categorias',
    backA11y: 'Voltar',
    sectionBuiltIn: 'PRÉ-DEFINIDAS',
    sectionCustom: 'PERSONALIZADAS',
    loadError: 'Não consegui carregar as categorias. Tenta outra vez.',
    retry: 'Tentar outra vez',
    loading: 'A carregar…',
    emptyCustom: 'Ainda não tens categorias personalizadas',
    addCategory: '+ Adicionar Categoria',
    addCategoryA11y: 'Adicionar categoria',
    sheetTitleNew: 'Nova Categoria',
    sheetTitleEdit: 'Editar Categoria',
    nameFieldLabel: 'NOME',
    namePlaceholder: 'Nome da categoria',
    nameA11y: 'Nome da categoria',
    nameRequiredError: 'Introduz um nome para a categoria.',
    colorFieldLabel: 'COR',
    swatchA11y: (hex: string) => `Cor ${hex}`,
    hexPlaceholder: '#rrggbb',
    hexA11y: 'Cor hexadecimal personalizada',
    locationFieldLabel: 'TIPO DE LOCAL',
    locationNone: 'Nenhum',
    locationSearchPlaceholder: 'Procura mais tipos…',
    locationSearchA11y: 'Procurar tipo de local',
    locationSelectedLabel: 'Selecionado:',
    locationClearA11y: 'Limpar tipo de local',
    dismissSheetA11y: 'Fechar painel de categoria',
    cancel: 'Cancelar',
    save: 'Guardar',
    saveA11y: 'Guardar categoria',
    rowA11y: (name: string) => `Categoria ${name}`,
    editButton: 'Editar',
    editA11y: (name: string) => `Editar ${name}`,
    deleteA11y: (name: string) => `Eliminar ${name}`,
    quickPickAtm: 'Multibanco',
    quickPickCafe: 'Café',
    quickPickSupermarket: 'Supermercado',
    quickPickPharmacy: 'Farmácia',
  },

  today: {
    weekdays: ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
    months: ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'],
    emptyMessages: [
      'Nada para hoje. Isso não significa que nada importa.',
      'Não sentes falta de pão?',
      'Talvez hoje seja um bom dia para um café na rua.',
      'Pode valer a pena levantar dinheiro enquanto sais.',
      'Falta alguma coisa no armário?',
      'Provavelmente há algo no frigorífico que precisa de ser reposto.',
      'Um dia livre é um presente. O que vais fazer com ele?',
      'Qual é a coisa pela qual o teu eu futuro te vai agradecer?',
      'Vais a algum lado em breve?',
    ],
    sectionTitlePrefix: 'O QUE PRECISO',
    leftCount: (n: number) => (n === 1 ? 'Falta 1' : `Faltam ${n}`),
    retry: 'Tentar outra vez',
    addSomething: 'Adiciona algo',
    addSomethingHelper: 'Isso são só pensamentos passageiros. Adiciona o que é realmente teu.',
    openCalendarA11y: (weekday: string, day: number) => `Abrir calendário de ${weekday} ${day}`,
    nearbyCount: (n: number) => (n === 1 ? '1 Local' : `${n} Locais`),
    addTaskA11y: 'Adicionar tarefa',
    progressLabel: 'PROGRESSO',
    progressSummary: (pct: number, remaining: number) => `${pct}% concluído · faltam ${remaining}`,
  },

  header: {
    goodMorning: 'Bom dia',
    goodAfternoon: 'Boa tarde',
    goodEvening: 'Boa noite',
    goodNight: 'Boa noite',
    openProfileA11y: 'Abrir perfil',
    pointsA11y: (points: number) => `${points} pontos de conquistas · ver conquistas`,
    pointsSuffix: (points: number) => `${points} pts`,
    socialA11y: (badge: number) => `Social, ${badge} pendentes`,
    socialA11yNoBadge: 'Social',
    notificationsA11yUnread: 'Notificações, por ler',
    notificationsA11y: 'Notificações',
  },

  achievements: {
    screenTitle: 'Conquistas',
    backA11y: 'Voltar',
    totalPointsLabel: 'PONTOS TOTAIS',
    totalPointsCaption: 'pontos ganhos até agora',
    topTierPrefix: 'Nível máximo · ',
    tinFallback: 'Estanho',
    tierLabel: (name: string) => ({
      Tin: 'Estanho',
      Bronze: 'Bronze',
      Silver: 'Prata',
      Gold: 'Ouro',
      Adamantium: 'Adamantina',
      Vibranium: 'Vibrânio',
    }[name] ?? name),
    onItsWay: (nextTierName: string) => ` · ${nextTierName} está perto`,
    earnedSection: (count: number) => `DESBLOQUEADAS · ${count}`,
    lockedSection: (count: number) => `BLOQUEADAS · ${count}`,
    cardA11y: (label: string, earned: boolean) => `Conquista ${label}, ${earned ? 'ganha' : 'bloqueada'}`,
    ptsEarned: (total: number) => `${total} pts ganhos`,
    ptsAvailable: (points: number) => `${points} pts disponíveis`,
    lockedBadge: 'Bloqueada',
    catalogue: {
      firstTaskLabel: 'Tirado da cabeça',
      firstTaskCondition: 'Adiciona a tua primeira tarefa',
      firstBrushLabel: 'Primeira Brush',
      firstBrushCondition: 'Brush away a tua primeira tarefa',
      rightPlaceLabel: 'No sítio certo, à hora certa',
      rightPlaceCondition: 'Brush uma tarefa quando estás perto do sítio onde acontece',
      worthWaitLabel: 'Valeu a pena esperar',
      worthWaitCondition: 'Brush uma tarefa que ficou aí uns dias',
      customCatLabel: 'Torna-a tua',
      customCatCondition: 'Cria uma categoria personalizada',
      outAboutLabel: 'Por aí fora',
      outAboutCondition: 'Brush tarefas em vários tipos de sítios',
      challengeWinnerLabel: 'Primeiro a tratar',
      challengeWinnerCondition: 'Ganha um desafio contra um amigo',
      earlyBirdLabel: 'Madrugador',
      earlyBirdCondition: 'Brush uma tarefa antes das 9:00',
      dayCompleteLabel: 'Dia concluído',
      dayCompleteCondition: 'Brush todas as tarefas num só dia',
      onARollLabel: 'Em sequência',
      onARollCondition: 'Brush tarefas durante 3 dias seguidos',
      explorerLabel: 'Explorador',
      explorerCondition: 'Brush 10 tarefas ligadas a localizações',
      centurionLabel: 'Centurião',
      centurionCondition: 'Alcança 100 pontos de conquistas',
    },
  },

  compareAchievements: {
    backA11y: 'Voltar',
    screenTitle: 'Comparar',
    loadError: 'Não consegui carregar a comparação. Tenta mais tarde.',
    you: 'Tu',
    totalPoints: 'Pontos totais',
    achievements: 'Conquistas',
    streakDays: 'Sequência (dias)',
  },

  socialHub: {
    backA11y: 'Voltar',
    screenTitle: 'Amigos',
    refreshA11y: 'Atualizar',
    loadError: 'Não consegui carregar os Amigos. Verifica a tua ligação.',
    retry: 'Tentar novamente',
    brushToDoAction: 'Brush a To-do',
    challengeAction: 'Desafio',
    sectionSharedTasks: 'TAREFAS PARTILHADAS',
    noSharedTasks: 'Ainda não há tarefas partilhadas.',
    sharedTaskA11y: (name: string) => `Tarefa partilhada por ${name}`,
    sectionChallenges: 'DESAFIOS',
    challengesComingSoon: 'Alertas de desafios brevemente.',
    sectionFollowing: 'A SEGUIR',
    sectionFollowingCount: (n: number) => `A SEGUIR (${n})`,
    notFollowingAnyone: 'Ainda não segues ninguém.',
    findMoreFriendsA11y: 'Encontrar mais amigos',
    findMore: 'Encontrar mais',
  },

  contactSuggestions: {
    backA11y: 'Voltar',
    screenTitle: 'Encontrar amigos',
    idleTitle: 'Encontrar amigos nos contactos',
    idleSub: 'Os teus contactos são cifrados no dispositivo — os dados nunca saem do telemóvel.',
    scanA11y: 'Procurar contactos',
    scanButton: 'Procurar contactos',
    requestingPermission: 'A pedir permissão…',
    scanning: 'A procurar contactos…',
    deniedTitle: 'Permissão necessária',
    deniedSub: 'O acesso aos contactos foi negado. Abre as Definições para o permitir.',
    openSettingsA11y: 'Abrir definições',
    openSettingsButton: 'Abrir Definições',
    unavailableTitle: 'Não disponível',
    unavailableSub: 'A procura de contactos não está disponível neste dispositivo ou versão.',
    emptyTitle: 'Nenhuma correspondência encontrada',
    emptySub: 'Nenhum dos teus contactos está no Brush Away ainda — partilha o teu link para os convidar!',
    errorTitle: 'Algo correu mal',
    errorGeneric: 'Não foi possível procurar contactos. Tenta novamente.',
    tryAgain: 'Tentar novamente',
    followingA11y: (name: string) => `A seguir ${name}`,
    followA11y: (name: string) => `Seguir ${name}`,
    following: 'A seguir',
    follow: 'Seguir',
  },

  friendPicker: {
    followingLoadError: 'Não foi possível carregar a tua lista de amigos. Verifica a tua ligação.',
    title: 'Brush this over to…',
    closeA11y: 'Fechar',
    taskLabel: 'Tarefa',
    searchPlaceholder: 'Procurar amigos…',
    searchA11y: 'Procurar amigos',
    loadingA11y: 'A carregar amigos',
    notFollowingAnyone: 'Ainda não segues ninguém.',
    noMatches: (query: string) => `Nenhum amigo corresponde a "${query}".`,
    sentToHandle: (username: string) => `Brushed to @${username}`,
    sentCheck: 'Brushed ✓',
    sendAtLeastOneA11y: (count: number) => `Brush it over to ${count} friend${count > 1 ? 's' : ''}`,
    selectFriendsFirstA11y: 'Seleciona amigos primeiro',
    sendButton: 'Brush it over',
    selectFriendsFirstButton: 'Seleciona amigos primeiro',
    sendFailed: (names: string) => `Não foi possível enviar para: ${names}`,
  },

  challengeDetail: {
    mostTasksByDeadline: (deadline: string) => `Mais tarefas até ${deadline}`,
    loadError: 'Não foi possível carregar o desafio.',
    acceptFailed: 'Falha ao aceitar. Tenta novamente.',
    declineFailed: 'Falha ao recusar. Tenta novamente.',
    backA11y: 'Voltar',
    screenTitle: 'Desafio',
    youSuffix: ' (tu)',
    acceptA11y: 'Aceitar desafio',
    accept: 'Aceitar',
    declineA11y: 'Recusar desafio',
    decline: 'Recusar',
    finalResults: 'RESULTADOS FINAIS',
    live: 'AO VIVO',
    participants: 'PARTICIPANTES',
    rowA11y: (handle: string, count: number, goal?: number) => `${handle}: ${count}${goal ? `/${goal}` : ''} tarefas`,
    countA11y: (count: number) => `${count} tarefas`,
    statusPending: 'pendente',
    statusAccepted: 'aceite',
    statusDeclined: 'recusado',
  },

  createChallenge: {
    followingLoadError: 'Não foi possível carregar a tua lista de amigos. Verifica a tua ligação.',
    sendFailed: 'Falha ao enviar o desafio. Tenta novamente.',
    stepTitleNew: 'Novo desafio',
    stepTitleGoal: 'Definir objetivo',
    stepTitleDeadline: 'Definir prazo',
    stepTitleFriends: 'Escolher adversários',
    stepTitleMessage: 'Adicionar mensagem',
    sentTitle: 'Desafio enviado!',
    sentSubGroup: 'O teu desafio em grupo está a caminho.',
    sentSub: 'O teu desafio está a caminho.',
    done: 'Concluído',
    backA11y: 'Voltar',
    goalTypeA11y: 'Desafio baseado em objetivo',
    timeTypeA11y: 'Desafio baseado em tempo',
    goalTypeTitle: 'Primeiro a X tarefas',
    timeTypeTitle: 'Mais tarefas até ao prazo',
    goalTypeSub: 'Corre para completar um número definido de tarefas',
    timeTypeSub: 'Quem completar mais tarefas vence',
    goalCountPrompt: 'Primeiro a completar quantas tarefas?',
    taskCountA11y: (n: number) => `${n} tarefas`,
    customNumberPlaceholder: 'Número personalizado…',
    customTaskCountA11y: 'Número de tarefas personalizado',
    challengeEndsAt: 'O desafio termina em:',
    selectDeadlineA11y: 'Selecionar prazo',
    groupChallengeCount: (n: number) => `Desafio em grupo (${n} selecionados)`,
    selectOpponents: 'Selecionar adversários',
    searchPlaceholder: 'Procurar amigos…',
    searchA11y: 'Procurar amigos',
    loadingFriendsA11y: 'A carregar amigos',
    notFollowingAnyone: 'Ainda não segues ninguém.',
    noMatches: (query: string) => `Nenhum amigo corresponde a "${query}".`,
    addMessageOptional: 'Adicionar mensagem (opcional)',
    messagePlaceholder: 'Vamos ver do que és capaz! 💪',
    messageA11y: 'Mensagem do desafio',
    challengeSummary: 'Resumo do desafio',
    typeGoalSummary: (n: number | string) => `Tipo: Primeiro a ${n} tarefas`,
    typeDeadlineSummary: (date: string) => `Tipo: Mais tarefas até ${date}`,
    opponentsSummary: (names: string) => `Adversários: ${names}`,
    sendChallengeA11y: 'Enviar desafio',
    continueA11y: 'Continuar',
    sendChallenge: 'Enviar desafio',
    continue: 'Continuar',
  },

  shareReceive: {
    poiNone: 'Nenhum',
    poiLabelAtm: 'ATM',
    poiLabelCafe: 'Café',
    poiLabelSupermarket: 'Mercado',
    poiLabelPharmacy: 'Farmácia',
    discardA11y: 'Descartar',
    navTitle: 'Adicionar a partir de mensagem',
    parsingMessage: 'A analisar mensagem…',
    couldntParse: 'Não conseguimos analisar automaticamente. Adiciona os detalhes manualmente.',
    tryAgainA11y: 'Tentar novamente',
    tryAgain: 'Tentar novamente',
    aiSuggestion: 'Sugestão da IA — toca para editar',
    titlePlaceholder: 'Brush title',
    titleA11y: 'Título',
    titleRequired: 'O título é obrigatório.',
    sectionLocation: 'LOCALIZAÇÃO',
    sectionTime: 'HORA',
    sectionDueDate: 'DATA LIMITE',
    sectionCategory: 'CATEGORIA',
    clearTimeA11y: 'Limpar hora',
    setTimeA11y: 'Definir hora',
    setTime: 'Definir hora',
    clearDateA11y: 'Limpar data',
    setDateA11y: 'Definir data limite',
    setDate: 'Definir data',
    addBrushA11y: 'Add brush',
    addBrush: 'Add brush',
    saving: 'A guardar…',
    discard: 'Descartar',
  },

  shareTaskSheet: {
    cannotSendToSelf: 'Não podes enviar uma tarefa a ti próprio.',
    searchError: 'Não foi possível procurar utilizadores. Verifica a tua ligação.',
    sendFailedDefault: 'Falha ao enviar a tarefa.',
    closeA11y: 'Fechar folha de partilha',
    title: 'Partilhar tarefa',
    closeButtonA11y: 'Fechar',
    emailPlaceholder: 'Endereço de email do destinatário',
    emailA11y: 'Email do destinatário',
    findA11y: 'Procurar utilizador',
    find: 'Procurar',
    noUserFound: 'Nenhum utilizador encontrado com esse email.',
    sentTo: (name: string) => `✓ Tarefa enviada para ${name}`,
  },

  shareProfileSheet: {
    closeSheetA11y: 'Fechar folha',
    headerTitle: 'Partilhar o meu perfil',
    closeA11y: 'Fechar',
    profilePhotoA11y: 'Foto de perfil',
    pointsPill: (n: number) => `${n} pts`,
    setUsernameFirst: 'Define um nome de utilizador primeiro',
    setUsernameBody: 'O link do teu perfil usa o teu nome de utilizador — adiciona um para partilhar o teu perfil.',
    setUsernameA11y: 'Definir nome de utilizador',
    setUsername: 'Definir nome de utilizador',
    linkCopiedA11y: 'Link copiado',
    copyLinkA11y: 'Copiar link',
    copied: 'Copiado!',
    copyLink: 'Copiar link',
    shareViaMessageA11y: 'Partilhar por mensagem',
    message: 'Mensagem',
    qrCodeComingSoonA11y: 'Mostrar código QR (brevemente)',
    qrCode: 'Código QR',
    moreSharingA11y: 'Mais opções de partilha',
    more: 'Mais',
  },

  publicProfile: {
    followToggleFailed: 'Algo correu mal. Tenta novamente.',
    backA11y: 'Voltar',
    userNotFound: (username: string) => `Utilizador @${username} não encontrado.`,
    avatarA11y: (name: string) => `Avatar de ${name}`,
    followers: 'Seguidores',
    following: 'A seguir',
    unfollowA11y: (name: string) => `Deixar de seguir ${name}`,
    followA11y: (name: string) => `Seguir ${name}`,
    followingLabel: 'A seguir',
    followLabel: 'Seguir',
    points: 'Pontos',
    streak: 'Sequência',
    compareAchievementsA11y: (name: string) => `Comparar conquistas com ${name}`,
    compareAchievements: 'Comparar conquistas',
  },

  profile: {
    usernameTaken: (username: string) => `@${username} já está em uso.`,
    cooldownError: (days: number) => `Podes mudar o teu nome de utilizador em ${days} dia${days !== 1 ? 's' : ''}.`,
    saveFailed: 'Falha ao guardar. Tenta novamente.',
    backA11y: 'Voltar',
    screenTitle: 'Perfil',
    profilePhotoA11y: 'Foto de perfil',
    editingProfile: 'A editar perfil',
    closeEditA11y: 'Fechar edição',
    editProfileA11y: 'Editar perfil',
    nameLabel: 'Nome',
    editNameA11y: 'Editar nome',
    usernameLabel: 'Nome de utilizador',
    editUsernameA11y: 'Editar nome de utilizador',
    cooldownRemaining: (days: number) => `${days}d de espera restantes`,
    cancelA11y: 'Cancelar',
    cancel: 'Cancelar',
    saveProfileA11y: 'Guardar perfil',
    saving: 'A guardar…',
    save: 'Guardar',
    shareMyProfileA11y: 'Partilhar o meu perfil',
    shareMyProfile: 'Partilhar o meu perfil',
    pointsAndAchievements: 'PONTOS E CONQUISTAS',
    totalPointsLabel: 'PONTOS TOTAIS',
    totalPointsA11y: (n: number) => `${n} pontos`,
    topTierPrefix: 'Nível máximo · ',
    ptsToGo: (n: number) => `${n} pts`,
    toGoSuffix: (tierName: string) => ` para ${tierName}`,
    dayStreakSuffix: ' dias seguidos',
    achievements: 'Conquistas',
    achievementsCount: (earned: number, total: number) => ` · ${earned}/${total}`,
    seeAllA11y: 'Ver todas as conquistas',
    seeAll: 'Ver todas ›',
    settingsA11y: 'Definições',
    settingsTitle: 'Definições',
    settingsSub: 'Aplicação e conta',
  },

  taskFormScreen: {
    deleteConfirmTitle: 'Eliminar esta tarefa?',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    goBackA11y: 'Voltar',
    editTaskTitle: 'Editar tarefa',
    taskTitleA11y: 'Título da tarefa',
    clearSearchA11y: 'Limpar pesquisa',
    createNewCategoryA11y: 'Criar nova categoria',
    categoryNamePlaceholder: 'Nome da categoria',
    notesPlaceholder: 'Adiciona uma nota, link ou lembrete…',
    deleteTaskA11y: 'Eliminar tarefa',
    birthdayToggleLabel: 'É um aniversário',
    birthdayToggleSublabel: 'Não precisa de local, nunca afeta o teu anel ou sequência, e desaparece sozinha no dia seguinte.',
    birthdayToggleA11y: 'Marcar como aniversário',
    birthdayWarningTitle: 'Marcar isto como aniversário?',
    birthdayWarningBody: 'Isto remove o local associado, tira a tarefa do teu anel e sequência, e ela vai desaparecer sozinha no dia seguinte — sem marca de falha, sem rasto.',
    birthdayWarningConfirm: 'Marcar como aniversário',
    birthdayUnsetWarningTitle: 'Desmarcar este aniversário?',
    birthdayUnsetWarningBody: 'Esta tarefa volta a ser uma tarefa normal — vais precisar de lhe dar um local antes de conseguires guardar.',
    birthdayUnsetWarningConfirm: 'Desmarcar',
  },

  takeMeThere: {
    /** "até" sidesteps o/a gender agreement on the POI label. */
    a11yFor: (poiLabel: string) => `Leva-me até ${poiLabel}`,
  },

  pointsHistoryScreen: {
    backA11y: 'Voltar',
    loadingA11y: 'A carregar histórico de pontos',
    loadMoreA11y: 'Carregar mais histórico',
  },

  tripPlannerScreen: {
    backA11y: 'Voltar',
    startDateA11y: 'Data de início',
    endDateA11y: 'Data de fim',
    continueA11y: 'Continuar',
    continue: 'Continuar',
  },

  nearbyCard: {
    headerLabel: 'Na proximidade',
    headerNowLabel: 'Na proximidade · agora',
    placesCount: (n: number) => (n === 1 ? '1 Local' : `${n} Locais`),
    openInMaps: 'Abrir no Mapas',
    openInMapsA11y: (placeName: string) => `Abrir ${placeName} no Mapas`,
    tryAnotherPlace: 'Tentar outro local',
    tryAnotherPlaceA11y: 'Tentar outro local',
    refreshLocationA11y: 'Atualizar localização',
    storeTuningOn: 'Ajuste de lojas ativo',
    refreshUpdated: 'Atualizado',
    refreshFailed: 'Falhou',
    alsoClose: 'Também perto',
  },

  newTaskSheet2: {
    closeA11y: 'Fechar',
    moreDetailsA11y: 'Mais detalhes',
  },

  storeTuningPromptSheet: {
    dismissA11y: 'Dispensar aviso',
    turnOnA11y: 'Ativar afinação da loja',
    notNowA11y: 'Agora não',
  },

  importTasksSection: {
    inProgressA11y: 'Importação em curso',
    cancelledA11y: 'Importação cancelada',
    sectionA11y: 'Secção de importação de tarefas',
  },

  errorBoundary: {
    tryAgainA11y: 'Tentar novamente',
  },

  timePicker: {
    hourA11y: 'Hora',
    minuteA11y: 'Minuto',
    formatToggleTo24: 'Formato do relógio: 12 horas. Mudar para 24 horas.',
    formatToggleTo12: 'Formato do relógio: 24 horas. Mudar para 12 horas.',
  },

  taskReminder: {
    title: (time: string) => `Querias isto às ${time}`,
    body: (taskTitle: string) => taskTitle,
  },

  calendar: {
    weekdayLabels: ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'],
    monthNamesFull: [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
    ],
    fullWeekdays: ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'],
    dayCellA11y: (day: number, isToday: boolean, isSelected: boolean) =>
      `${day}${isToday ? ', hoje' : ''}${isSelected ? ', selecionado' : ''}`,
    loadError: 'Não foi possível carregar as tarefas. Verifica a tua ligação.',
    loadErrorRetry: 'Não foi possível carregar as tarefas. Tenta novamente.',
    statusToday: 'Hoje',
    statusUpcoming: 'Em breve',
    statusComplete: 'Dia concluído',
    statusPast: 'Passado',
    noTasks: 'Sem tarefas',
    tasksPlanned: (n: number) => `${n} tarefa${n === 1 ? '' : 's'} planeada${n === 1 ? '' : 's'}`,
    tasksNoneCompleted: (n: number) => `${n} tarefa${n === 1 ? '' : 's'} · nenhuma concluída`,
    tasksDoneStats: (done: number, total: number, pct: number) => `${done} de ${total} concluídas · ${pct}%`,
    backA11y: 'Voltar',
    screenTitle: 'Calendário',
    jumpToTodayA11y: 'Ir para hoje',
    today: 'Hoje',
    previousMonthA11y: 'Mês anterior',
    nextMonthA11y: 'Mês seguinte',
    tryAgainA11y: 'Tentar novamente',
    tryAgain: 'Tentar novamente',
    dayRun: (n: number) => `${n} dias seguidos`,
    unlockedSuffix: (label: string) => `${label} · desbloqueado`,
    nothingOnThisDay: 'Nada para este dia.',
    openTodayA11y: 'Abrir hoje',
    openToday: 'Abrir hoje',
    // "Brush away" stays in English here too — brand verb, never localized (see taskRow's note above).
    brushedAwayOn: (weekday: string) => `Brushed away on ${weekday}`,
  },

  shareToDo: {
    shareA11y: (title: string) => `Partilhar ${title}`,
    backA11y: 'Voltar',
    subtitle: 'Brush this over to a friend',
    noOpenTasks: 'Sem tarefas por fazer hoje.',
  },

  sharedTaskInbox: {
    startedFollowingA11y: (handle: string) => `${handle} começou a seguir-te`,
    startedFollowingSuffix: ' começou a seguir-te',
    followBackA11y: (handle: string) => `Seguir de volta ${handle}`,
    followBack: 'Seguir de volta',
    following: 'A seguir',
    avatarA11y: (name: string) => `Avatar de ${name}`,
    acceptTaskA11y: 'Aceitar tarefa',
    accept: 'Aceitar',
    declineTaskA11y: 'Recusar tarefa',
    decline: 'Recusar',
    followPrompt: (handle: string) => `+ Seguir ${handle}`,
    backA11y: 'Voltar',
    notifications: 'Notificações',
    unreadSuffix: (n: number) => ` (${n})`,
    allCaughtUp: 'Tudo em dia',
  },

};

const DICTIONARIES: Record<SupportedLanguage, typeof en> = { en, 'pt-PT': ptPT };

let currentLang: SupportedLanguage = 'en';

/**
 * Switches which language dictionary COPY reads from. Call once whenever the
 * resolved user language changes (see theme/ThemeContext.tsx) — never call
 * this per-render.
 */
export function setCopyLanguage(lang: SupportedLanguage): void {
  currentLang = lang;
}

/** Read the currently-active copy language outside React render paths. */
export function getCopyLanguage(): SupportedLanguage {
  return currentLang;
}

/** Test-only: read back the active language without a full render cycle. */
export function __getCopyLanguageForTests(): SupportedLanguage {
  return currentLang;
}

export const COPY: typeof en = new Proxy(en, {
  get(_target, prop: string) {
    return (DICTIONARIES[currentLang] as Record<string, unknown>)[prop];
  },
});
