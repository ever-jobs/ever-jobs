import { DEFAULT_YIELD_BUDGET_MS, YieldBudget, yieldToEventLoop } from '../src/cooperative';

describe('cooperative scheduling helpers (Spec 1730)', () => {
  it('yieldToEventLoop resumes in the check phase: a queued setImmediate runs first, microtasks do not suffice', async () => {
    const order: string[] = [];
    setImmediate(() => order.push('immediate'));
    await Promise.resolve();
    order.push('after-microtask');
    await yieldToEventLoop();
    order.push('after-yield');
    expect(order).toEqual(['after-microtask', 'immediate', 'after-yield']);
  });

  it('YieldBudget expires after its budget and renews', async () => {
    const budget = new YieldBudget(5);
    expect(budget.expired).toBe(false);
    const until = Date.now() + 6;
    while (Date.now() < until) {
      // spend the budget
    }
    expect(budget.expired).toBe(true);
    budget.renew();
    expect(budget.expired).toBe(false);
  });

  it('yieldIfExpired yields only once the slice is spent', async () => {
    const budget = new YieldBudget(1_000);
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    expect(await budget.yieldIfExpired()).toBe(false);
    expect(ran).toBe(false);

    const spent = new YieldBudget(0);
    expect(await spent.yieldIfExpired()).toBe(true);
    expect(ran).toBe(true);
  });

  it('defaults to a 10 ms budget', () => {
    expect(DEFAULT_YIELD_BUDGET_MS).toBe(10);
  });
});
