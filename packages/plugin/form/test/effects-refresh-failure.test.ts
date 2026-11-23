/**
 * sommo-io fork: the effects' snapshot re-read (on `document.replaced` and
 * the other whole-document events) is fired and forgotten, so a failed
 * `forms.list()` must be caught there, not left as an unhandled rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentEvent, EffectContext } from '@embedpdf/core';

import { registerFormEffects } from '../src/effects';
import type { FormAction, FormState } from '../src/types';

describe('form effects: a failed snapshot re-read', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is caught and warned, and the model keeps its last snapshot', async () => {
    const failure = new Error('aggregate PDF action read budget exceeded');
    const list = vi.fn(() => Promise.reject(failure));
    let listener: ((event: DocumentEvent) => void) | null = null;
    const dispatch = vi.fn();
    const ctx = {
      doc: {
        forms: { list },
        events: {
          subscribe: (fn: (event: DocumentEvent) => void) => {
            listener = fn;
            return () => {};
          },
        },
      },
      dispatch,
      getState: () => ({}) as FormState,
      cleanup: () => {},
    } as unknown as EffectContext<FormState, FormAction>;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      registerFormEffects(ctx);
      listener!({ type: 'document.replaced' } as DocumentEvent);
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(list).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[form] form snapshot failed to load', failure);
    expect(dispatch).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
