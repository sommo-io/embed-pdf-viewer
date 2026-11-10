/**
 * sommo-io fork: `DocumentHandle.restoreLayer` puts back a layer the document
 * saved earlier (`downloadLayer()`), in place, over the same base: the undo
 * and redo of an edit made in the engine worker, without a second copy of
 * the file and without parsing it again.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DocumentEvent, DocumentHandle, Engine } from '@embedpdf/engine-core/runtime';
import { EngineErrorCode } from '@embedpdf/engine-core/runtime';
import type { WorkerExtension } from '@embedpdf/engine-services';
import { createLocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  resolve(here, '..', '..', '..', '..', 'examples', 'snippet-react', 'public', name);

const FPDF_PAGEOBJ_TEXT = 1;

/** Removes every text object of a page (payload: page index). */
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
    return { result: removed, changedPages: removed ? [index] : [] };
  },
};

const released: string[] = [];
const watcher: WorkerExtension = {
  call: () => ({ result: null }),
  release(docId) {
    released.push(docId);
  },
};

const textOf = async (doc: DocumentHandle, pon: number) =>
  (await doc.page(pon).text.read()).text.trim();

describe('DocumentHandle.restoreLayer, engine-local wasm', () => {
  let engine: Engine;
  let plainEngine: Engine;
  let report: Uint8Array;
  let ebook: Uint8Array;

  beforeAll(async () => {
    engine = createLocalEngine({ runtime: { prefer: 'wasm' }, extensions: { removeText, watcher } });
    plainEngine = createLocalEngine({ runtime: { prefer: 'wasm' }, sessionKind: 'plain' });
    report = new Uint8Array(await readFile(fixture('report.pdf')));
    ebook = new Uint8Array(await readFile(fixture('ebook.pdf')));
  }, 30_000);

  afterAll(async () => {
    await engine?.destroy?.();
    await plainEngine?.destroy?.();
  });

  test('the layer saved before an edit undoes it, the one saved after redoes it; downloads follow', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'restore-undo', bytes: report.slice() });
    try {
      const pon = (await doc.pages.list()).pages[0]!.pageObjectNumber;
      const original = await textOf(doc, pon);
      expect(original.length).toBeGreaterThan(0);

      const before = await doc.downloadLayer!();
      expect(await doc.callExtension!('removeText', 0)).toMatchObject({ changedPageObjectNumbers: [pon] });
      const after = await doc.downloadLayer!();
      expect(await textOf(doc, pon)).toBe('');
      // Layers, not files: both are a small fraction of the document.
      expect(before.byteLength + after.byteLength).toBeLessThan(report.byteLength / 10);

      const events: DocumentEvent[] = [];
      const off = doc.events.subscribe((event) => events.push(event));
      const undone = await doc.restoreLayer!(before);
      expect(undone.changedPageObjectNumbers).toBeNull();
      expect(undone.layout.pages.map((p) => p.pageObjectNumber)).toEqual(
        (await doc.pages.list()).pages.map((p) => p.pageObjectNumber),
      );
      expect(await textOf(doc, pon)).toBe(original);
      // The document is the file it was opened from again, byte for byte.
      expect(new Uint8Array(await doc.download())).toEqual(report);

      const redone = await doc.restoreLayer!(after);
      off();
      expect(await textOf(doc, pon)).toBe('');
      expect(events.map((e) => e.type)).toEqual(['document.replaced', 'document.replaced']);
      expect(redone.changedPageObjectNumbers).toBeNull();

      const saved = await doc.download();
      const reopened = await engine.open({ kind: 'bytes', id: 'restore-undo-check', bytes: saved });
      try {
        expect(await textOf(reopened, pon)).toBe('');
      } finally {
        await reopened.close();
      }
    } finally {
      await doc.close();
    }
  });

  test('the document keeps working after a restore: new edits, annotations and pages', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'restore-then-edit', bytes: report.slice() });
    try {
      const pages = (await doc.pages.list()).pages;
      expect(pages.length).toBeGreaterThan(1);
      const [first, second] = [pages[0]!.pageObjectNumber, pages[1]!.pageObjectNumber];
      const before = await doc.downloadLayer!();

      // A page deleted after the snapshot comes back with its object number.
      await doc.pages.delete([second]);
      expect((await doc.pages.list()).pages.map((p) => p.pageObjectNumber)).not.toContain(second);
      const restored = await doc.restoreLayer!(before);
      expect(restored.layout.pages.map((p) => p.pageObjectNumber)).toEqual(pages.map((p) => p.pageObjectNumber));

      // Edits after the restore land on the restored layer and are saved.
      await doc.callExtension!('removeText', 0);
      const created = await doc.page(first).annotations.create({
        subtype: 'square',
        contents: 'after restore',
        rect: { left: 60, bottom: 60, right: 160, top: 160 },
        interiorColor: null,
        color: { r: 0, g: 128, b: 0 },
        strokeWidth: 2,
        borderStyle: 'solid',
        opacity: 1,
      });
      expect(created.created.subtype).toBe('square');
      const raster = await doc.page(first).render.raw({ viewport: { kind: 'width', width: 120 } });
      expect(raster.width).toBe(120);

      const saved = await doc.download();
      const reopened = await engine.open({ kind: 'bytes', id: 'restore-then-edit-check', bytes: saved });
      try {
        expect(await textOf(reopened, first)).toBe('');
        const listed = await reopened.page(first).annotations.list();
        expect(listed.annotations.some((a) => a.contents === 'after restore')).toBe(true);
        expect((await reopened.pages.list()).pages).toHaveLength(pages.length);
      } finally {
        await reopened.close();
      }
    } finally {
      await doc.close();
    }
  });

  test('the extensions drop their pointers before the document changes under them', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'restore-release', bytes: report.slice() });
    try {
      const before = await doc.downloadLayer!();
      released.length = 0;
      await doc.restoreLayer!(before);
      expect(released).toContain('restore-release');
    } finally {
      await doc.close();
    }
  });

  test('a layer of other bytes, or a broken one, is refused and the document stays as it was', async () => {
    const other = await engine.open({ kind: 'bytes', id: 'restore-other', bytes: ebook.slice() });
    const foreign = await other.downloadLayer!();
    await other.close();

    const doc = await engine.open({ kind: 'bytes', id: 'restore-refused', bytes: report.slice() });
    try {
      const pages = (await doc.pages.list()).pages.map((p) => p.pageObjectNumber);
      await doc.callExtension!('removeText', 0);
      const edited = await doc.downloadLayer!();

      await expect(doc.restoreLayer!(foreign)).rejects.toMatchObject({ code: EngineErrorCode.MalformedPdf });
      await expect(doc.restoreLayer!(new Uint8Array([1, 2, 3, 4]))).rejects.toBeTruthy();

      // Still the edited document: same pages, the edit in place, reads and saves work.
      expect((await doc.pages.list()).pages.map((p) => p.pageObjectNumber)).toEqual(pages);
      expect(await textOf(doc, pages[0]!)).toBe('');
      expect(new Uint8Array(await doc.downloadLayer!())).toEqual(new Uint8Array(edited));
    } finally {
      await doc.close();
    }
  });

  test('a signed document keeps its signed bytes: undo gives the file back as sealed, redo appends', async () => {
    const signed = new Uint8Array(await readFile(resolve(here, 'fixtures', 'signed_two_approvals.pdf')));
    const doc = await engine.open({ kind: 'bytes', id: 'restore-signed', bytes: signed.slice() });
    try {
      const pon = (await doc.pages.list()).pages[0]!.pageObjectNumber;
      const before = await doc.downloadLayer!();
      await doc.page(pon).annotations.create({
        subtype: 'square',
        contents: 'after signing',
        rect: { left: 60, bottom: 60, right: 160, top: 160 },
        interiorColor: null,
        color: { r: 0, g: 128, b: 0 },
        strokeWidth: 2,
        borderStyle: 'solid',
        opacity: 1,
      });
      const after = await doc.downloadLayer!();

      await doc.restoreLayer!(before);
      expect(new Uint8Array(await doc.download())).toEqual(signed);

      await doc.restoreLayer!(after);
      const saved = new Uint8Array(await doc.download());
      // An incremental update: the sealed revision is untouched, the change follows it.
      expect(saved.byteLength).toBeGreaterThan(signed.byteLength);
      expect(saved.subarray(0, signed.byteLength)).toEqual(signed);
      const listed = await doc.page(pon).annotations.list();
      expect(listed.annotations.some((a) => a.contents === 'after signing')).toBe(true);
    } finally {
      await doc.close();
    }
  });

  test('a session opened without a layer has none to restore', async () => {
    const layered = await engine.open({ kind: 'bytes', id: 'restore-layered', bytes: report.slice() });
    const artifact = await layered.downloadLayer!();
    await layered.close();

    const plain = await plainEngine.open({ kind: 'bytes', id: 'restore-plain', bytes: report.slice() });
    try {
      await expect(plain.restoreLayer!(artifact)).rejects.toMatchObject({ code: EngineErrorCode.InvalidArg });
      expect((await plain.pages.list()).pages.length).toBeGreaterThan(0);
    } finally {
      await plain.close();
    }
  });
});
