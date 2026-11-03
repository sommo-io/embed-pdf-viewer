// sommo-io fork: geometry runs carry their text object's font (GeometryRunFont).
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createLocalEngine, type LocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, '..', '..', '..', '..', 'examples', 'engine-runtime-demo', 'public', 'sample.pdf');

describe('geometry run font (sommo-io fork)', () => {
  let engine: LocalEngine;
  beforeAll(async () => {
    engine = await createLocalEngine({ runtime: { prefer: 'wasm' } });
  });
  afterAll(async () => {
    await engine?.destroy?.();
  });

  test('every run of drawn glyphs names its font, flags, weight, size and fill colour', async () => {
    const doc = await engine.open({ kind: 'bytes', id: 'run-font', bytes: new Uint8Array(await readFile(samplePath)) });
    try {
      const [first] = (await doc.pages.list()).pages;
      const { runs } = await doc.page(first.pageObjectNumber).geometry.read();
      expect(runs.length).toBeGreaterThan(0);
      // Generated characters (line breaks PDFium adds) have no text object and no font.
      const drawn = runs.filter((run) => run.glyphs.some((glyph) => !(glyph.flags & 2)));
      expect(drawn.length).toBeGreaterThan(0);
      for (const run of drawn) {
        expect(run.font?.name).toMatch(/\S/);
        expect(Number.isInteger(run.font?.flags)).toBe(true);
        if (run.font?.weight !== undefined) expect(run.font.weight).toBeGreaterThanOrEqual(100);
        if (run.font?.size !== undefined) expect(run.font.size).toBeGreaterThan(1);
        if (run.font?.color !== undefined) expect(run.font.color).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(drawn.some((run) => run.font?.color !== undefined)).toBe(true);
      // The sample sets its text with `Tf 1` and a scaled `Tm`: the run's size is the scaled one.
      expect(drawn.some((run) => run.fontSize === 1 && (run.font?.size ?? 0) > 4)).toBe(true);
    } finally {
      await doc.close();
    }
  });
});
