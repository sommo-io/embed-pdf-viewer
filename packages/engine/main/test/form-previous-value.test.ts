/**
 * sommo-io fork: a value write reports the field as it was before the write
 * (`previous`), in the result and in the `form.valueChanged` event, so a
 * caller can undo it with `setValue(ref, previous.value)`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type {
  DocumentEvent,
  DocumentHandle,
  Engine,
  FormFieldDTO,
  FormFieldRef,
} from '@embedpdf/engine-core/runtime';
import { createLocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'examples',
  'snippet-react',
  'public',
  'form.pdf',
);

const textOf = (field: FormFieldDTO | undefined) =>
  field && field.family === 'text' ? field.value : undefined;

describe('form value writes report the previous value, engine-local wasm', () => {
  let engine: Engine;
  let doc: DocumentHandle;
  let ref: FormFieldRef;
  let initial: string | undefined;

  beforeAll(async () => {
    engine = await createLocalEngine({ runtime: { prefer: 'wasm' } });
    const bytes = new Uint8Array(await readFile(fixturePath));
    doc = await engine.open({ kind: 'bytes', id: 'form-pdf-previous', bytes });
    const field = (await doc.forms.list()).fields.find((f) => f.name === 'First_Name');
    if (!field) throw new Error('fixture is missing the First_Name field');
    ref = { kind: 'objectNumber', fieldObjectNumber: field.fieldObjectNumber };
    initial = textOf(field);
  }, 30_000);

  afterAll(async () => {
    await doc?.close();
    await engine?.destroy?.();
  });

  test('setValue and reset carry the field before the write', async () => {
    const events: DocumentEvent[] = [];
    const unsubscribe = doc.events.subscribe((event) => {
      if (event.type === 'form.valueChanged') events.push(event);
    });
    try {
      const first = await doc.forms.setValue(ref, { type: 'text', value: 'Ada' });
      expect(textOf(first.previous)).toBe(initial);
      expect(textOf(first.field)).toBe('Ada');

      const second = await doc.forms.setValue(ref, { type: 'text', value: 'Grace' });
      expect(textOf(second.previous)).toBe('Ada');

      const reset = await doc.forms.reset(ref);
      expect(textOf(reset.previous)).toBe('Grace');

      const previous = events.map((e) =>
        e.type === 'form.valueChanged' ? textOf(e.previous) : null,
      );
      expect(previous).toEqual([initial, 'Ada', 'Grace']);

      // Undo the reset with the reported previous value.
      await doc.forms.setValue(ref, { type: 'text', value: textOf(reset.previous) ?? '' });
      const now = (await doc.forms.list()).fields.find((f) => f.name === 'First_Name');
      expect(textOf(now)).toBe('Grace');
    } finally {
      unsubscribe();
    }
  });
});
