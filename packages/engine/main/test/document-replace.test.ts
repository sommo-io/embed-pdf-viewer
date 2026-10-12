/**
 * sommo-io fork: `DocumentHandle.replace(bytes)` points an open document at
 * new bytes in place: same handle and id, new content, `document.replaced`.
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
} from '@embedpdf/engine-core/runtime';
import { createLocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  resolve(here, '..', '..', '..', '..', 'examples', 'snippet-react', 'public', name);

const textOf = (field: FormFieldDTO | undefined) =>
  field && field.family === 'text' ? field.value : undefined;

describe('DocumentHandle.replace, engine-local wasm', () => {
  let engine: Engine;
  let formBytes: Uint8Array;
  let filledBytes: Uint8Array;

  beforeAll(async () => {
    engine = await createLocalEngine({ runtime: { prefer: 'wasm' } });
    formBytes = new Uint8Array(await readFile(fixture('form.pdf')));
    // The same file with First_Name filled in, as an edit elsewhere would produce it.
    const doc = await engine.open({
      kind: 'bytes',
      id: 'replace-source',
      bytes: formBytes.slice(),
    });
    const field = (await doc.forms.list()).fields.find((f) => f.name === 'First_Name')!;
    await doc.forms.setValue(
      { kind: 'objectNumber', fieldObjectNumber: field.fieldObjectNumber },
      { type: 'text', value: 'Replaced' },
    );
    filledBytes = await doc.download();
    await doc.close();
  }, 30_000);

  afterAll(async () => {
    await engine?.destroy?.();
  });

  test('same pages: new content is read, only the hinted pages are stale', async () => {
    const doc: DocumentHandle = await engine.open({
      kind: 'bytes',
      id: 'replace-same',
      bytes: formBytes.slice(),
    });
    try {
      const before = await doc.pages.list();
      const firstName = async () =>
        textOf((await doc.forms.list()).fields.find((f) => f.name === 'First_Name'));
      expect(await firstName()).not.toBe('Replaced');

      const events: DocumentEvent[] = [];
      const unsubscribe = doc.events.subscribe((event) => events.push(event));
      const pon = before.pages[0]!.pageObjectNumber;
      const result = await doc.replace!(filledBytes.slice(), { changedPages: [pon] });
      unsubscribe();

      expect(result.layout.pages.map((p) => p.pageObjectNumber)).toEqual(
        before.pages.map((p) => p.pageObjectNumber),
      );
      expect(result.changedPageObjectNumbers).toEqual([pon]);
      expect(events.map((e) => e.type)).toEqual(['document.replaced']);

      // Reads after the swap see the new bytes; the form model was rebuilt.
      expect(await firstName()).toBe('Replaced');
      const raster = await doc.page(pon).render.raw({ viewport: { kind: 'scale', scale: 0.5 } });
      expect(raster.width).toBeGreaterThan(0);
      // The session saves the new bytes.
      const saved = await doc.download();
      const reopened = await engine.open({ kind: 'bytes', id: 'replace-check', bytes: saved });
      const value = textOf(
        (await reopened.forms.list()).fields.find((f) => f.name === 'First_Name'),
      );
      await reopened.close();
      expect(value).toBe('Replaced');
    } finally {
      await doc.close();
    }
  });

  test('different pages: the hint is dropped and the new page registry is reported', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'replace-other', bytes: formBytes.slice() });
    try {
      const before = await doc.pages.list();
      const other = new Uint8Array(await readFile(fixture('report.pdf')));
      const result = await doc.replace!(other, {
        changedPages: [before.pages[0]!.pageObjectNumber],
      });
      const after = await doc.pages.list();
      expect(result.layout.pageCount).toBe(after.pageCount);
      expect(result.layout.pages.map((p) => p.pageObjectNumber)).toEqual(
        after.pages.map((p) => p.pageObjectNumber),
      );
      if (
        after.pages.map((p) => p.pageObjectNumber).join() !==
        before.pages.map((p) => p.pageObjectNumber).join()
      ) {
        expect(result.changedPageObjectNumbers).toBeNull();
      }
    } finally {
      await doc.close();
    }
  });

  test('bytes that do not open leave the document as it was', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'replace-bad', bytes: formBytes.slice() });
    try {
      await expect(doc.replace!(new TextEncoder().encode('not a pdf'))).rejects.toBeTruthy();
      const fields = (await doc.forms.list()).fields;
      expect(fields.some((f) => f.name === 'First_Name')).toBe(true);
    } finally {
      await doc.close();
    }
  });
});
