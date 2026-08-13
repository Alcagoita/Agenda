import {
  filterFinancialServicePlacesForTasks,
  financialServiceTaskMatchesPlace,
  inferFinancialServiceKind,
} from '../../src/services/financialServiceKinds';

describe('financial service kinds', () => {
  it.each([
    ['Pay Cofidis', 'consumer_credit'],
    ['Renew Fidelidade insurance', 'insurance'],
    ['Visit Banco de Portugal', 'central_bank'],
    ['Go to Finanças', 'public_finance'],
  ])('infers %p as %p', (title, kind) => {
    expect(inferFinancialServiceKind(title)).toBe(kind);
  });

  it('matches an authoritative financial-service kind instead of guessing from the place name', () => {
    const creditTask = { poi: 'financial_service', title: 'Pay Cofidis', financialServiceKind: 'consumer_credit' as const };
    expect(financialServiceTaskMatchesPlace(creditTask, { name: 'Cofidis', financialServiceKinds: ['consumer_credit'] })).toBe(true);
    expect(financialServiceTaskMatchesPlace(creditTask, { name: 'Fidelidade', financialServiceKinds: ['insurance'] })).toBe(false);
  });

  it('keeps only places for one of the open financial-service task kinds', () => {
    const places = [
      { name: 'Cofidis', financialServiceKinds: ['consumer_credit' as const] },
      { name: 'Fidelidade', financialServiceKinds: ['insurance' as const] },
      { name: 'Banco de Portugal', financialServiceKinds: ['central_bank' as const] },
    ];
    expect(filterFinancialServicePlacesForTasks('financial_service', places, [
      { poi: 'financial_service', title: 'Pay Cofidis', financialServiceKind: 'consumer_credit' as const },
      { poi: 'financial_service', title: 'Renew insurance', financialServiceKind: 'insurance' as const },
    ])).toEqual(places.slice(0, 2));
  });
});
