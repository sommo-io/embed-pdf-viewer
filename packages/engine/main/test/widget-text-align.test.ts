/**
 * sommo-io fork: a text field's alignment (/Q) through the annotation plane.
 * Upstream `EPDFAnnot_SetTextAlignment` / `GetTextAlignment` only serve
 * free-text and redact annotations, so a widget patch wrote nothing and every
 * widget read back as left.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type {
  AnnotationRef,
  DocumentHandle,
  Engine,
  FormFieldDTO,
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

interface Raster {
  data: ArrayBuffer;
  width: number;
  height: number;
  stride: number;
}

/** Mean x (0..1) of the dark pixels: where the text sits in the box. */
function inkCentre(raster: Raster): number {
  const bytes = new Uint8Array(raster.data);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const i = y * raster.stride + x * 4;
      if (bytes[i + 3]! > 200 && bytes[i]! < 100 && bytes[i + 1]! < 100 && bytes[i + 2]! < 100) {
        sum += x;
        n++;
      }
    }
  }
  return n ? sum / n / raster.width : NaN;
}

describe('widget text alignment (/Q), engine-local wasm', () => {
  let engine: Engine;
  let doc: DocumentHandle;
  let field: FormFieldDTO;
  let ref: AnnotationRef & { kind: 'objectNumber' };

  beforeAll(async () => {
    engine = await createLocalEngine({ runtime: { prefer: 'wasm' } });
    const bytes = new Uint8Array(await readFile(fixturePath));
    doc = await engine.open({ kind: 'bytes', id: 'form-pdf-widget-q', bytes });
    const found = (await doc.forms.list()).fields.find((f) => f.name === 'First_Name');
    if (!found) throw new Error('fixture is missing the First_Name field');
    field = found;
    const widget = field.widgets[0]!;
    ref = {
      kind: 'objectNumber',
      annotObjectNumber: widget.annotObjectNumber,
      pageObjectNumber: widget.pageObjectNumber,
    };
    await doc.forms.setValue(
      { kind: 'objectNumber', fieldObjectNumber: field.fieldObjectNumber },
      { type: 'text', value: 'Ada' },
    );
  }, 30_000);

  afterAll(async () => {
    await doc?.close();
    await engine?.destroy();
  });

  async function readBack() {
    const page = doc.page(ref.pageObjectNumber);
    const list = await page.annotations.list();
    const dto = list.annotations.find(
      (a) => a.ref.kind === 'objectNumber' && a.ref.annotObjectNumber === ref.annotObjectNumber,
    );
    const render = await page.annotations.renderAppearances({ scale: 2 });
    const raster = render.appearances.find(
      (a) => a.ref.kind === 'objectNumber' && a.ref.annotObjectNumber === ref.annotObjectNumber,
    )?.raster;
    return {
      align: (dto as { textAlign?: string } | undefined)?.textAlign,
      centre: raster ? inkCentre(raster) : NaN,
    };
  }

  test('right, centre and left are written, drawn and read back', async () => {
    const left = await readBack();
    expect(left.align).toBe('left');
    expect(left.centre).toBeLessThan(0.3);

    await doc
      .page(ref.pageObjectNumber)
      .annotations.update(ref, { subtype: 'widget', textAlign: 'right' });
    const right = await readBack();
    expect(right.align).toBe('right');
    expect(right.centre).toBeGreaterThan(0.7);

    await doc
      .page(ref.pageObjectNumber)
      .annotations.update(ref, { subtype: 'widget', textAlign: 'center' });
    const centre = await readBack();
    expect(centre.align).toBe('center');
    expect(centre.centre).toBeGreaterThan(0.4);
    expect(centre.centre).toBeLessThan(0.6);

    await doc
      .page(ref.pageObjectNumber)
      .annotations.update(ref, { subtype: 'widget', textAlign: 'left' });
    expect((await readBack()).align).toBe('left');
  });
});
