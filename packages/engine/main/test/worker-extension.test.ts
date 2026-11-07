/**
 * sommo-io fork: `DocumentHandle.callExtension` runs host code in the engine
 * worker against the engine's own open document. A call that writes page
 * content reports its pages; the engine reads the new content from then on
 * and emits `pages.contentChanged`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DocumentEvent, Engine } from '@embedpdf/engine-core/runtime';
import type { WorkerExtension } from '@embedpdf/engine-services';
import { createLocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  resolve(here, '..', '..', '..', '..', 'examples', 'snippet-react', 'public', name);

const FPDF_PAGEOBJ_TEXT = 1;

/** Removes every text object of a page (payload: page index) and answers how many it removed. */
const removeText: WorkerExtension = {
  call(ctx, payload) {
    const { fn } = ctx.runtime;
    const index = payload as number;
    ctx.closeCachedPages();
    const page = fn.FPDF_LoadPage(ctx.docPtr, index);
    let removed = 0;
    try {
      for (let i = fn.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
        const obj = fn.FPDFPage_GetObject(page, i);
        if (fn.FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
        if (fn.FPDFPage_RemoveObject(page, obj)) {
          fn.FPDFPageObj_Destroy(obj);
          removed++;
        }
      }
      if (removed) fn.FPDFPage_GenerateContent(page);
    } finally {
      fn.FPDF_ClosePage(page);
    }
    return { result: { removed }, changedPages: removed ? [index] : [] };
  },
};

const released: string[] = [];
const echo: WorkerExtension = {
  async call(_ctx, payload) {
    await Promise.resolve();
    return { result: payload };
  },
  release(docId) {
    released.push(docId);
  },
};

describe('DocumentHandle.callExtension, engine-local wasm', () => {
  let engine: Engine;
  let bytes: Uint8Array;

  beforeAll(async () => {
    engine = createLocalEngine({ runtime: { prefer: 'wasm' }, extensions: { removeText, echo } });
    bytes = new Uint8Array(await readFile(fixture('report.pdf')));
  }, 30_000);

  afterAll(async () => {
    await engine?.destroy?.();
  });

  test('a content write is read back, announced and saved', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'ext-write', bytes: bytes.slice() });
    try {
      const pon = (await doc.pages.list()).pages[0]!.pageObjectNumber;
      const before = await doc.page(pon).text.read();
      expect(before.text.trim().length).toBeGreaterThan(0);

      const events: DocumentEvent[] = [];
      const off = doc.events.subscribe((event) => events.push(event));
      const answer = await doc.callExtension!<{ removed: number }>('removeText', 0);
      off();

      expect(answer.result.removed).toBeGreaterThan(0);
      expect(answer.changedPageObjectNumbers).toEqual([pon]);
      expect(events.map((e) => e.type)).toEqual(['pages.contentChanged']);
      // The engine's own reads see the edit: no reopen, no second copy.
      expect((await doc.page(pon).text.read()).text.trim()).toBe('');

      const saved = await doc.download();
      const reopened = await engine.open({ kind: 'bytes', id: 'ext-check', bytes: saved });
      const reread = await reopened.page(pon).text.read();
      await reopened.close();
      expect(reread.text.trim()).toBe('');
    } finally {
      await doc.close();
    }
  });

  test('a call that writes nothing changes no page; release runs on close', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'ext-echo', bytes: bytes.slice() });
    const answer = await doc.callExtension!('echo', { hello: 1 });
    expect(answer).toEqual({ result: { hello: 1 }, changedPageObjectNumbers: [] });
    await doc.close();
    expect(released).toContain('ext-echo');
  });

  test('an unknown extension rejects', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'ext-none', bytes: bytes.slice() });
    try {
      await expect(doc.callExtension!('nope', null)).rejects.toBeTruthy();
    } finally {
      await doc.close();
    }
  });
});
