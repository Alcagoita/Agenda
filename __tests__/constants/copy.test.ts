import { COPY, __getCopyLanguageForTests, setCopyLanguage } from '../../src/constants/copy';

describe('COPY language switching', () => {
  beforeEach(() => {
    setCopyLanguage('en');
  });

  afterEach(() => {
    setCopyLanguage('en');
  });

  it('reads nested values from the active dictionary and tracks current language', () => {
    expect(__getCopyLanguageForTests()).toBe('en');
    expect(COPY.challenge.goalTypeLabel(3)).toBe('First to brush away 3 tasks');

    setCopyLanguage('pt-PT');
    expect(__getCopyLanguageForTests()).toBe('pt-PT');
    expect(COPY.challenge.goalTypeLabel(3)).toBe('Primeiro a tratar 3 tarefas');

    setCopyLanguage('en');
    expect(__getCopyLanguageForTests()).toBe('en');
    expect(COPY.challenge.goalTypeLabel(3)).toBe('First to brush away 3 tasks');
  });
});

describe('COPY — notification preferences', () => {
  beforeEach(() => {
    setCopyLanguage('en');
  });

  afterEach(() => {
    setCopyLanguage('en');
  });

  it('keeps the English notification preferences block distinct from pt-PT', () => {
    const keys = [
      'screenTitle',
      'backA11y',
      'loadingA11y',
      'sectionWhenOut',
      'sectionDaily',
      'sectionFromPeople',
      'proximityLabel',
      'proximitySublabel',
      'exitPromptLabel',
      'exitPromptSublabel',
      'eodLabel',
      'eodSublabel',
      'reminderTimeLabel',
      'sharedTasksLabel',
      'sharedTasksSublabel',
    ] as const;

    setCopyLanguage('en');
    const englishValues = keys.map(key => COPY.notificationPreferences[key]);
    const englishReminderTime = COPY.notificationPreferences.reminderTimeA11y('20:00');

    setCopyLanguage('pt-PT');
    keys.forEach((key, index) => {
      expect(englishValues[index]).not.toBe(COPY.notificationPreferences[key]);
    });
    expect(englishReminderTime).not.toBe(COPY.notificationPreferences.reminderTimeA11y('20:00'));
  });

  it('renders section labels in sentence case, not ALL CAPS (KAN-303, AC8)', () => {
    for (const lang of ['en', 'pt-PT'] as const) {
      setCopyLanguage(lang);
      for (const label of [
        COPY.notificationPreferences.sectionWhenOut,
        COPY.notificationPreferences.sectionDaily,
        COPY.notificationPreferences.sectionFromPeople,
      ]) {
        expect(label).toMatch(/[a-z]/);
        expect(label).not.toBe(label.toUpperCase());
      }
    }
  });
});

describe('COPY — pt-PT localized count strings', () => {
  beforeEach(() => {
    setCopyLanguage('pt-PT');
  });

  afterEach(() => {
    setCopyLanguage('en');
  });

  it('uses singular and plural forms for Today and Nearby labels', () => {
    expect(COPY.today.leftCount(1)).toBe('Falta 1');
    expect(COPY.today.leftCount(4)).toBe('Faltam 4');
    expect(COPY.today.nearbyCount(1)).toBe('1 Local');
    expect(COPY.today.nearbyCount(3)).toBe('3 Locais');
    expect(COPY.nearbyCard.headerLabel).toBe('Na proximidade');
    expect(COPY.nearbyCard.placesCount(1)).toBe('1 Local');
    expect(COPY.nearbyCard.placesCount(2)).toBe('2 Locais');
    expect(COPY.nearbyCard.openInMaps).toBe('Abrir no Mapas');
    expect(COPY.nearbyCard.openInMapsA11y('Continente')).toBe('Abrir Continente no Mapas');
    expect(COPY.nearbyCard.tryAnotherPlace).toBe('Tentar outro local');
    expect(COPY.nearbyCard.storeTuningOn).toBe('Ajuste de lojas ativo');
    expect(COPY.nearbyCard.refreshUpdated).toBe('Atualizado');
    expect(COPY.nearbyCard.refreshFailed).toBe('Falhou');
    expect(COPY.nearbyCard.alsoClose).toBe('Também perto');
  });

  it('keeps Brush in English and localizes achievements tiers', () => {
    expect(COPY.achievements.earnedSection(3)).toBe('DESBLOQUEADAS · 3');
    expect(COPY.achievements.onItsWay('Bronze')).toBe(' · Bronze está perto');
    expect(COPY.achievements.tierLabel('Tin')).toBe('Estanho');
    expect(COPY.achievements.tierLabel('Silver')).toBe('Prata');
    expect(COPY.achievements.tierLabel('Vibranium')).toBe('Vibrânio');
    expect(COPY.achievements.catalogue.firstBrushLabel).toBe('Primeira Brush');
    expect(COPY.achievements.catalogue.firstBrushCondition).toBe('Brush away a tua primeira tarefa');
    expect(COPY.achievements.catalogue.explorerCondition).toBe('Brush 10 tarefas ligadas a localizações');
  });

  it('localizes the mall snapshot row copy', () => {
    setCopyLanguage('en');
    expect(COPY.mallSnapshot.rowLabel).toBe('Activate Mall mode');
    expect(COPY.mallSnapshot.rowSublabel).toBe("Download this mall's places so I can help you faster without a signal.");
    setCopyLanguage('pt-PT');
    expect(COPY.mallSnapshot.rowLabel).toBe('Activar modo Shopping');
    expect(COPY.mallSnapshot.rowSublabel).toBe('Descarregue os locais deste Shopping para que eu te ajude mais rapidamente e sem internet.');
  });
});
