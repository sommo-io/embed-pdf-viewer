// sommo-io fork: a whole-file save that never holds the file in WASM memory.
//
// EPDF_SaveDocumentToOwnedBuffer builds the saved file in one growing buffer
// on the WASM heap, then it is copied out. A WASM heap never shrinks, so a
// 100 MB save leaves the worker hundreds of MB larger for good. Here PDFium
// writes through an FPDF_FILEWRITE callback instead: each block it writes is
// copied straight into JS memory, and the WASM heap keeps only PDFium's own
// small write buffer.
import type { PdfRuntimeModule, Ptr } from '@embedpdf/engine-runtime';

/** Largest file a save may produce (a wasm32 heap cannot hold more). */
const MAX_BYTES = 2 ** 31;
/** Fallback chunk size when resizable ArrayBuffers are unavailable. */
const CHUNK_BYTES = 8 * 1024 * 1024;

/** Collects written blocks into one ArrayBuffer, growing it in place where the browser can. */
export class SaveSink {
  private resizable: ArrayBuffer | null = null;
  private readonly chunks: Uint8Array[] = [];
  private current: Uint8Array | null = null;
  private used = 0;
  size = 0;

  constructor() {
    try {
      // Grows in place (no copy, no second buffer): Chrome 111, Safari 16.4, Firefox 128.
      const ab = new (ArrayBuffer as unknown as new (
        length: number,
        options: { maxByteLength: number },
      ) => ArrayBuffer)(0, { maxByteLength: MAX_BYTES });
      if ((ab as { resizable?: boolean }).resizable === true) this.resizable = ab;
    } catch {
      this.resizable = null;
    }
  }

  write(block: Uint8Array): void {
    if (block.byteLength === 0) return;
    if (this.size + block.byteLength > MAX_BYTES) throw new RangeError('saved file is too large');
    const resizable = this.resizable as (ArrayBuffer & { resize(length: number): void }) | null;
    if (resizable) {
      resizable.resize(this.size + block.byteLength);
      new Uint8Array(resizable, this.size, block.byteLength).set(block);
      this.size += block.byteLength;
      return;
    }
    let offset = 0;
    while (offset < block.byteLength) {
      if (!this.current || this.used === this.current.byteLength) {
        this.current = new Uint8Array(Math.max(CHUNK_BYTES, block.byteLength - offset));
        this.chunks.push(this.current);
        this.used = 0;
      }
      const n = Math.min(block.byteLength - offset, this.current.byteLength - this.used);
      this.current.set(block.subarray(offset, offset + n), this.used);
      this.used += n;
      offset += n;
    }
    this.size += block.byteLength;
  }

  /** The saved file as one fixed-length ArrayBuffer. */
  finish(): ArrayBuffer {
    const resizable = this.resizable as
      | (ArrayBuffer & { transferToFixedLength?: () => ArrayBuffer })
      | null;
    if (resizable) {
      this.resizable = null;
      // Fixed length for consumers that store or post it; a copy only where the
      // browser lacks transferToFixedLength.
      return resizable.transferToFixedLength?.() ?? resizable.slice(0);
    }
    if (this.chunks.length === 1 && this.used === this.chunks[0]!.byteLength) {
      return this.chunks[0]!.buffer as ArrayBuffer;
    }
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks.splice(0)) {
      const n = Math.min(chunk.byteLength, this.size - offset);
      out.set(chunk.subarray(0, n), offset);
      offset += n;
    }
    this.current = null;
    return out.buffer;
  }
}

/**
 * Runs `save(fileWritePtr)` (an `FPDF_SaveAsCopy`-style call) with an
 * FPDF_FILEWRITE that streams into a {@link SaveSink}. WASM runtime only.
 */
export function saveThroughFileWrite(
  runtime: PdfRuntimeModule,
  save: (fileWrite: Ptr) => boolean,
): { bytes: ArrayBuffer; size: number } | null {
  const { mem, cb } = runtime;
  const sink = new SaveSink();
  // struct FPDF_FILEWRITE { int version; int (*WriteBlock)(FPDF_FILEWRITE*, const void*, unsigned long); }
  const struct = mem.alloc(8);
  let failure: unknown = null;
  const callback = cb.register('iiii', (_self, data, size) => {
    try {
      sink.write(mem.readBytes(data as Ptr, Number(size)));
      return 1;
    } catch (error) {
      failure = error;
      return 0;
    }
  });
  try {
    mem.poke(struct, 'i32', 1, 0);
    mem.poke(struct, 'i32', Number(callback), 4);
    const ok = save(struct);
    if (failure) throw failure;
    if (!ok || sink.size === 0) return null;
    return { bytes: sink.finish(), size: sink.size };
  } finally {
    cb.dispose(callback);
    mem.free(struct);
  }
}
