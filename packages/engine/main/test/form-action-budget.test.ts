/**
 * sommo-io fork: a form whose field actions run past the aggregate action
 * read budget (512 action models per read) still loads. The fields after the
 * budget ran out come without their actions; before, `forms.list()` failed
 * as a whole and the document had no fields at all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DocumentHandle, Engine } from '@embedpdf/engine-core/runtime';
import { createLocalEngine } from '../src/index';
import { pdf, type Objects } from './helpers/miniPdf';

const FIELDS = 300; // two scripts each (keystroke + format): 600 action models

function formPdf(): Uint8Array {
  const first = 10;
  const refs = Array.from({ length: FIELDS }, (_, i) => `${first + i} 0 R`).join(' ');
  const objects: Objects = {
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [${refs}] >>`,
    4: `<< /Fields [${refs}] /DA (/Helv 0 Tf 0 g) >>`,
  };
  for (let i = 0; i < FIELDS; i++) {
    const x = 20 + (i % 30) * 19;
    const y = 100 + Math.floor(i / 30) * 25;
    objects[first + i] =
      `<< /Type /Annot /Subtype /Widget /FT /Tx /T (f${i}) /V (v${i}) /F 4 ` +
      `/Rect [${x} ${y} ${x + 15} ${y + 15}] /P 3 0 R ` +
      `/AA << /K << /S /JavaScript /JS (AFNumber_Keystroke\\(2,0,0,0,"",true\\);) >> ` +
      `/F << /S /JavaScript /JS (AFNumber_Format\\(2,0,0,0,"",true\\);) >> >> >>`;
  }
  return pdf(objects);
}

describe('a form past the action read budget, engine-local wasm', () => {
  let engine: Engine;
  let doc: DocumentHandle;

  beforeAll(async () => {
    engine = await createLocalEngine({ runtime: { prefer: 'wasm' } });
    doc = await engine.open({ kind: 'bytes', id: 'form-action-budget', bytes: formPdf() });
  }, 30_000);

  afterAll(async () => {
    await doc?.close();
    await engine?.destroy?.();
  });

  test('forms.list() loads every field, with actions until the budget runs out', async () => {
    const { fields } = await doc.forms.list();
    expect(fields).toHaveLength(FIELDS);
    expect(fields.map((field) => field.name)).toEqual(
      Array.from({ length: FIELDS }, (_, i) => `f${i}`),
    );
    expect(fields.every((field) => field.family === 'text')).toBe(true);
    expect(fields.every((field) => field.widgets.length === 1)).toBe(true);
    expect(fields[0]?.actions?.keystroke).toBeTruthy();
    expect(fields[0]?.actions?.format).toBeTruthy();
    // 512 models = 256 fields with both actions; the rest come without them.
    const withActions = fields.filter((field) => field.actions !== undefined).length;
    expect(withActions).toBe(256);
    expect(fields.at(-1)?.actions).toBeUndefined();
  });

  test('a value write on a field past the budget lands', async () => {
    const { fields } = await doc.forms.list();
    const last = fields.at(-1)!;
    const ref = { kind: 'objectNumber' as const, fieldObjectNumber: last.fieldObjectNumber };
    const written = await doc.forms.setValue(ref, { type: 'text', value: 'typed' });
    expect(written.field.family === 'text' ? written.field.value : null).toBe('typed');
    const after = (await doc.forms.list()).fields.at(-1)!;
    expect(after.family === 'text' ? after.value : null).toBe('typed');
  });
});
