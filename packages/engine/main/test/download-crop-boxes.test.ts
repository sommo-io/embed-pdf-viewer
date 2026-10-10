/**
 * sommo-io fork: `download({ cropBoxes })` writes CropBoxes into the
 * downloaded file only; the open document's boxes and page size stay.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { DocumentHandle, Engine } from '@embedpdf/engine-core/runtime';
import { createLocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const formPdf = resolve(
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

describe('download with crop boxes (engine-local wasm)', () => {
  let engine: Engine | undefined;
  const docs: DocumentHandle[] = [];

  afterEach(async () => {
    for (const d of docs.splice(0)) await d.close();
    await engine?.destroy();
    engine = undefined;
  });

  async function open(bytes: Uint8Array, id: string): Promise<DocumentHandle> {
    engine ??= await createLocalEngine({ runtime: { prefer: 'wasm' } });
    const doc = await engine.open({ kind: 'bytes', id, bytes });
    docs.push(doc);
    return doc;
  }

  test.each(['rewrite', 'incremental'] as const)(
    '%s: the file carries the crop, the open document does not',
    async (mode) => {
      const doc = await open(new Uint8Array(await readFile(formPdf)), `crop-${mode}`);
      expect(doc.downloadCropBoxes).toBe(true);
      const before = (await doc.pages.list()).pages;
      const [first, second] = before;
      const media = first!.boxes.media;
      const box = {
        left: media.left + 50,
        bottom: media.bottom + 100,
        right: media.right - 50,
        top: media.top - 40,
      };
      const firstRaster = await doc
        .page(first!.pageObjectNumber)
        .render.raw({ viewport: { kind: 'scale', scale: 1 } });

      const bytes = await doc.download({
        mode,
        cropBoxes: [{ pageObjectNumber: first!.pageObjectNumber, box }],
      });

      // The open document is unchanged: boxes and rendered size.
      const after = (await doc.pages.list()).pages;
      expect(after.map((p) => p.boxes.crop)).toEqual(before.map((p) => p.boxes.crop));
      const again = await doc
        .page(first!.pageObjectNumber)
        .render.raw({ viewport: { kind: 'scale', scale: 1 } });
      expect([again.width, again.height]).toEqual([firstRaster.width, firstRaster.height]);

      // The file has the crop on page 1 only.
      const out = (await (await open(bytes, `crop-${mode}-out`)).pages.list()).pages;
      expect(out[0]!.boxes.crop).toEqual(box);
      if (second) expect(out[1]!.boxes.crop).toEqual(second.boxes.crop);

      // A plain download afterwards has no crop.
      const plain = (
        await (
          await open(await doc.download({ mode: 'rewrite' }), `crop-${mode}-plain`)
        ).pages.list()
      ).pages;
      expect(plain[0]!.boxes.crop).toEqual(first!.boxes.crop);
    },
  );

  test('rejects a box without area and an unknown page', async () => {
    const doc = await open(new Uint8Array(await readFile(formPdf)), 'crop-bad');
    const pon = (await doc.pages.list()).pages[0]!.pageObjectNumber;
    await expect(
      doc.download({
        cropBoxes: [{ pageObjectNumber: pon, box: { left: 10, bottom: 10, right: 10, top: 20 } }],
      }),
    ).rejects.toMatchObject({ code: 'InvalidArg' });
    await expect(
      doc.download({
        cropBoxes: [{ pageObjectNumber: 999_999, box: { left: 0, bottom: 0, right: 10, top: 10 } }],
      }),
    ).rejects.toBeTruthy();
  });
});
