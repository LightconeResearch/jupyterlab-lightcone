import type { IChatModel, IMessageContent } from '@jupyter/chat';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlanChecklist, planSummary, readPlan } from '../plan-checklist';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const steps = [
  { content: 'Load the Union 2.1 data', status: 'completed', priority: 'high' },
  { content: 'Fit the cosmology', status: 'in_progress', priority: 'medium' },
  { content: 'Plot residuals', status: 'pending' }
];

describe('readPlan', () => {
  it('reads ACP plan entries, as a list or under entries', () => {
    const plan = readPlan({ plan: steps });
    expect(plan).toEqual([
      {
        content: 'Load the Union 2.1 data',
        status: 'completed',
        priority: 'high'
      },
      {
        content: 'Fit the cosmology',
        status: 'in_progress',
        priority: 'medium'
      },
      { content: 'Plot residuals', status: 'pending', priority: null }
    ]);
    expect(readPlan({ plan: { entries: steps } })).toEqual(plan);
    expect(planSummary(plan!)).toBe('Plan · 1 of 3');
  });

  it('skips malformed steps and ignores messages without a plan', () => {
    expect(
      readPlan({
        plan: [
          { content: '', status: 'pending' },
          { content: 'x', status: 'unknown' },
          'step',
          { content: 'Kept', status: 'pending', priority: 'urgent' }
        ]
      })
    ).toEqual([{ content: 'Kept', status: 'pending', priority: null }]);
    expect(readPlan({ plan: [] })).toBeNull();
    expect(readPlan({ tool_calls: [] })).toBeNull();
    expect(readPlan(undefined)).toBeNull();
  });
});

describe('PlanChecklist', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(metadata: unknown): void {
    act(() => {
      root.render(
        <PlanChecklist
          model={{} as IChatModel}
          message={{ metadata } as unknown as IMessageContent}
        />
      );
    });
  }

  it('lists the steps, open while any remains and folded once done', () => {
    render({ plan: steps });
    const details = container.querySelector('details')!;
    expect(details.open).toBe(true);
    expect(container.querySelector('summary')?.textContent).toBe(
      'Plan · 1 of 3'
    );
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(3);
    expect(items[1].getAttribute('data-status')).toBe('in_progress');
    expect(
      items[0].querySelector('[role="img"]')?.getAttribute('aria-label')
    ).toBe('done');
    render({
      plan: steps.map(step => ({ ...step, status: 'completed' }))
    });
    expect(container.querySelector('details')!.open).toBe(false);
    render({});
    expect(container.innerHTML).toBe('');
  });
});
