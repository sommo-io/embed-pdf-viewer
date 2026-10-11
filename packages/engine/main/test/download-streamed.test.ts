/**
 * sommo-io fork: a whole-file download streams out of PDFium through an
 * FPDF_FILEWRITE (services/src/features/save/internal/streamedSave.ts)
 * instead of being built on the WASM heap.
 */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { DocumentHandle, Engine } from '@embedpdf/engine-core/runtime';
import { SaveSink } from '../../services/src/features/save/internal/streamedSave';
import { createLocalEngine } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const formPdf = resolve(here, '..', '..', '..', '..', 'examples', 'snippet-react', 'public', 'form.pdf');

describe('streamed download (engine-local wasm)', () => {
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

  test('a rewrite download is a complete PDF that reopens with the same pages', async () => {
    const doc = await open(new Uint8Array(await readFile(formPdf)), 'streamed');
    const pages = (await doc.pages.list()).pages;
    const bytes = new Uint8Array(await doc.download({ mode: 'rewrite' }));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(new TextDecoder().decode(bytes.subarray(bytes.byteLength - 8))).toContain('%%EOF');
    const reopened = await open(bytes, 'streamed-reopened');
    const again = (await reopened.pages.list()).pages;
    expect(again.length).toBe(pages.length);
    expect(again.map((p) => p.boxes.media)).toEqual(pages.map((p) => p.boxes.media));
    // A second download gives the same file.
    expect(new Uint8Array(await doc.download({ mode: 'rewrite' }))).toEqual(bytes);
  });
});

describe('SaveSink', () => {
  const same = (a: ArrayBuffer, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
  const blocks = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array(10_000_000).fill(7), new Uint8Array([9])];
  const expected = () => {
    const out = new Uint8Array(3 + 10_000_000 + 1);
    out.set([1, 2, 3]);
    out.fill(7, 3, 3 + 10_000_000);
    out[out.length - 1] = 9;
    return out;
  };

  test('joins blocks in a growable buffer and hands out a fixed-length one', () => {
    const sink = new SaveSink();
    for (const block of blocks) sink.write(block);
    const bytes = sink.finish();
    expect((bytes as { resizable?: boolean }).resizable ?? false).toBe(false);
    expect(same(bytes, expected())).toBe(true);
  });

  test('joins blocks in chunks where buffers cannot grow', () => {
    const sink = new SaveSink();
    (sink as unknown as { resizable: null }).resizable = null;
    for (const block of blocks) sink.write(block);
    expect(sink.size).toBe(10_000_004);
    expect(same(sink.finish(), expected())).toBe(true);
  });
});
