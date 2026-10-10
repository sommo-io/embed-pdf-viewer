/**
 * sommo-io fork: the page pool keeps the last page that was rendered or read
 * ("warm") so its tiles reuse PDFium's decoded images. These tests pin that a
 * warm page never serves stale content and never blocks a page mutation.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { DocumentHandle, Engine, PageRaster } from '@embedpdf/engine-core/runtime';
import { createLocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const formPdf = resolve(here, '..', '..', '..', '..', 'examples', 'snippet-react', 'public', 'form.pdf');

/** Share of pixels that are clearly red in a raster. */
function redShare(raster: PageRaster): number {
  const bytes = new Uint8Array(raster.data);
  let red = 0;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const i = y * raster.stride + x * 4;
      if (bytes[i]! > 200 && bytes[i + 1]! < 60 && bytes[i + 2]! < 60) red++;
    }
  }
  return red / (raster.width * raster.height);
}

describe('warm page (engine-local wasm)', () => {
  let engine: Engine | undefined;
  let doc: DocumentHandle | undefined;

  afterEach(async () => {
    await doc?.close();
    await engine?.destroy();
  });

  async function open(): Promise<DocumentHandle> {
    engine = await createLocalEngine({ runtime: { prefer: 'wasm' } });
    const bytes = new Uint8Array(await readFile(formPdf));
    doc = await engine.open({ kind: 'bytes', id: `warm-${Math.random()}`, bytes });
    return doc;
  }

  test('a tile rendered after an annotation is added shows it', async () => {
    const d = await open();
    const pon = (await d.pages.list()).pages[0]!.pageObjectNumber;
    const page = d.page(pon);
    const rect = { left: 100, bottom: 100, right: 300, top: 300 };
    const tile = { target: { kind: 'rect' as const, rect }, viewport: { kind: 'scale' as const, scale: 1 } };
    expect(redShare(await page.render.raw(tile))).toBe(0);
    await page.annotations.create({
      subtype: 'square',
      contents: 'warm page',
      rect,
      unrotatedRect: rect,
      rotation: 0,
      interiorColor: { r: 255, g: 0, b: 0 },
      color: { r: 255, g: 0, b: 0 },
      strokeWidth: 1,
      borderStyle: 'solid',
      opacity: 1,
    });
    expect(redShare(await page.render.raw(tile))).toBeGreaterThan(0.9);
  });

  test('a page just rendered can be deleted, and pages switch back and forth', async () => {
    const d = await open();
    const pages = (await d.pages.list()).pages;
    expect(pages.length).toBeGreaterThan(1);
    const [a, b] = [pages[0]!.pageObjectNumber, pages[1]!.pageObjectNumber];
    for (const pon of [a, b, a, b]) {
      const raster = await d.page(pon).render.raw({ viewport: { kind: 'width', width: 200 } });
      expect(raster.width).toBe(200);
    }
    await d.pages.delete([b]);
    expect((await d.pages.list()).pages.map((p) => p.pageObjectNumber)).not.toContain(b);
    const raster = await d.page(a).render.raw({ viewport: { kind: 'width', width: 200 } });
    expect(raster.width).toBe(200);
  });
});
