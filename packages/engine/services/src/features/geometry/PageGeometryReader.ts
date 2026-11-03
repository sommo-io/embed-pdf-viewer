// Modified by Sommo (sommo-io fork, Apache-2.0 section 4(b)); the changes are marked "sommo-io fork".
import type {
  GeometryRunFont,
  PageGeometryGlyph,
  PageGeometryRun,
  PageGeometrySnapshot,
  PageObjectNumber,
  PdfQuad,
  PdfRect,
  RotatedGeometryGlyph,
} from '@embedpdf/engine-core/runtime';
import {
  EngineError,
  EngineErrorCode,
  normalizePdfRect,
  pdfQuadBounds,
} from '@embedpdf/engine-core/runtime';
import type { PdfRuntimeMemory, PdfRuntimeModule, Ptr } from '@embedpdf/engine-runtime';

import type { DocumentSession } from '../../document-session/DocumentSession';
import {
  EPDF_CHAR_GEOMETRY_LAYOUT,
  readF32,
  readI32,
  readRectF,
} from '../../runtime/memory/structs';
import { readUtf8String } from '../../runtime/memory/strings'; // sommo-io fork
import { throwIfAborted } from '../../shared/abort';

/**
 * Mid-object orientation drift that forces a run split (~0.5°). Real content
 * keeps one char matrix per text object; this guards the exotic cases so a
 * run's `rotation` is always representative of every glyph in it.
 */
const ROTATION_SPLIT_TOLERANCE = 0.0087;

/**
 * One glyph as read from `EPDFText_GetCharGeometry`, plus the run-grouping
 * context sampled alongside it. Pure data — no native handles — so the
 * grouping stage below is a pure function the tests can drive directly.
 */
export interface RawGeometryGlyphRecord {
  /** Grouping key: the glyph's text object handle (opaque identity). */
  objectKey: number | bigint;
  /** Sampled at each text object's first glyph (run splits inherit it). */
  fontSize?: number;
  /** sommo-io fork: sampled with `fontSize`. */
  font?: GeometryRunFont;
  /**
   * Wire flags (bit 1 = space, bit 2 = empty). Synthesized-but-visible
   * glyphs (/ActualText pieces) stay 0, exactly like the legacy reader —
   * they represent real, selectable text.
   */
  flags: number;
  /** Page-space AABB (zeroed when empty). */
  looseBox: PdfRect;
  tightBox?: PdfRect;
  /** Oriented cells — real glyphs with a usable (non-singular) matrix only. */
  looseQuad?: PdfQuad;
  tightQuad?: PdfQuad;
  /** Native uprightness of the char matrix (empty glyphs: true, inert). */
  upright: boolean;
  /** Baseline angle (radians CCW, PDF y-up); 0 when upright. */
  rotation: number;
  /** True when the ascent vector maps opposite the rotated +y (det < 0). */
  ascentFlip: boolean;
}

/** The orientation class a run commits to at its first classifiable glyph. */
type RunClass = { upright: true } | { upright: false; rotation: number; ascentFlip: boolean };

/**
 * Geometry-only text layout reader.
 *
 * Emits geometry in PDF user space (y-up edges) — the canonical engine
 * geometry. The viewer converts to content/view space via the page geometry
 * matrix; this reader applies NO Y-flip or device transform.
 *
 * One `EPDFText_GetCharGeometry` call per glyph supplies boxes, oriented
 * cells, and flags together; `buildRunsFromRawGlyphs` then groups glyphs
 * into the upright/rotated run union. Upright runs are byte-identical to the
 * pre-orientation reader (quads the native layer offers are deliberately
 * dropped — the dominant case never pays for orientation).
 */
export class PageGeometryReader {
  constructor(
    private readonly runtime: PdfRuntimeModule,
    private readonly session: DocumentSession,
  ) {}

  read(pageObjectNumber: PageObjectNumber, signal: AbortSignal): PageGeometrySnapshot {
    throwIfAborted(signal);
    const { fn, mem } = this.runtime;
    const pool = this.session.pagePool();
    const pagePtr = pool.acquire(pageObjectNumber, { warm: true }); // sommo-io fork: warm page

    try {
      throwIfAborted(signal);
      const textPagePtr = fn.FPDFText_LoadPage(pagePtr);
      if (!textPagePtr) {
        throw new EngineError(
          EngineErrorCode.RuntimeUnavailable,
          `FPDFText_LoadPage returned null for page object ${pageObjectNumber}`,
        );
      }
      try {
        throwIfAborted(signal);
        const glyphCount = Math.max(fn.FPDFText_CountChars(textPagePtr), 0);
        const records: RawGeometryGlyphRecord[] = [];
        const geometryPtr = mem.alloc(EPDF_CHAR_GEOMETRY_LAYOUT.bytes);
        const fontPtrs = [4, 4, 4, 4, 4, 24].map((bytes) => mem.alloc(bytes)); // sommo-io fork: font flags, R, G, B, A, char matrix

        try {
          let prevObjectKey: number | bigint | null = null;
          for (let i = 0; i < glyphCount; i++) {
            throwIfAborted(signal);
            const objectKey = fn.FPDFText_GetTextObject(textPagePtr, i);
            const record: RawGeometryGlyphRecord = {
              objectKey,
              ...this.readGlyphRaw(textPagePtr, i, geometryPtr),
            };
            if (objectKey !== prevObjectKey) {
              record.fontSize = fn.FPDFText_GetFontSize(textPagePtr, i);
              const font = this.readFont(textPagePtr, i, fontPtrs); // sommo-io fork
              if (font) record.font = font;
              prevObjectKey = objectKey;
            }
            records.push(record);
          }
        } finally {
          mem.free(geometryPtr);
          for (const ptr of fontPtrs) mem.free(ptr); // sommo-io fork
        }

        return { runs: buildRunsFromRawGlyphs(records) };
      } finally {
        fn.FPDFText_ClosePage(textPagePtr);
      }
    } finally {
      pool.release(pageObjectNumber, { warm: true });
    }
  }

  /** sommo-io fork: the font of the glyph's text object (GeometryRunFont), or undefined without a name. */
  private readFont(textPagePtr: Ptr, charIndex: number, [flags, r, g, b, a, matrix]: Ptr[]): GeometryRunFont | undefined {
    const { fn, mem } = this.runtime;
    const name = readUtf8String(mem, (buf, capacity) =>
      fn.FPDFText_GetFontInfo(textPagePtr, charIndex, buf, capacity, flags),
    );
    if (!name) return undefined;
    const font: GeometryRunFont = { name, flags: readI32(mem, flags) };
    const weight = fn.FPDFText_GetFontWeight(textPagePtr, charIndex);
    if (weight > 0) font.weight = weight;
    // The em size on the page: Tf scaled by the char matrix (`Tf 1` with a `Tm` of 12 is 12 pt).
    const em = fn.FPDFText_GetFontSize(textPagePtr, charIndex);
    if (em > 0 && fn.FPDFText_GetMatrix(textPagePtr, charIndex, matrix)) {
      const size = em * Math.hypot(readF32(mem, matrix, 8), readF32(mem, matrix, 12));
      if (Number.isFinite(size) && size > 0) font.size = Math.round(size * 100) / 100;
    }
    if (fn.FPDFText_GetFillColor(textPagePtr, charIndex, r, g, b, a)) {
      const hex = (ptr: Ptr) => (readI32(mem, ptr) & 0xff).toString(16).padStart(2, '0');
      font.color = `#${hex(r)}${hex(g)}${hex(b)}`;
    }
    return font;
  }

  private readGlyphRaw(
    textPagePtr: Ptr,
    charIndex: number,
    geometryPtr: Ptr,
  ): Omit<RawGeometryGlyphRecord, 'objectKey' | 'fontSize' | 'font'> {
    const { fn, mem } = this.runtime;
    if (!fn.EPDFText_GetCharGeometry(textPagePtr, charIndex, geometryPtr)) {
      return emptyRawGlyph();
    }

    const { offsets, flags: bits } = EPDF_CHAR_GEOMETRY_LAYOUT;
    const native = readI32(mem, geometryPtr, offsets.flags) >>> 0;
    // Degenerate geometry keeps the legacy zeroed-glyph convention so
    // upright snapshots stay bit-identical to the pre-orientation reader.
    if (native & bits.empty) {
      return emptyRawGlyph();
    }

    const upright = Boolean(native & bits.upright);
    const raw: Omit<RawGeometryGlyphRecord, 'objectKey' | 'fontSize' | 'font'> = {
      flags: native & bits.space ? 1 : 0,
      looseBox: normalizePdfRect(readRectF(mem, geometryPtr, offsets.looseBox)),
      upright,
      rotation: 0,
      ascentFlip: false,
    };
    if (native & bits.hasTightBox) {
      raw.tightBox = normalizePdfRect(readRectF(mem, geometryPtr, offsets.tightBox));
    }
    if (native & bits.hasLooseQuad) {
      raw.looseQuad = readQuad(mem, geometryPtr, offsets.looseQuad);
      if (native & bits.hasTightQuad) {
        raw.tightQuad = readQuad(mem, geometryPtr, offsets.tightQuad);
      }
      if (!upright) {
        const a = readF32(mem, geometryPtr, offsets.matrix);
        const b = readF32(mem, geometryPtr, offsets.matrix + 4);
        const c = readF32(mem, geometryPtr, offsets.matrix + 8);
        const d = readF32(mem, geometryPtr, offsets.matrix + 12);
        raw.rotation = Math.atan2(b, a);
        raw.ascentFlip = a * d - b * c < 0;
      }
    }
    return raw;
  }
}

/**
 * Group per-glyph records into the run union. Pure — exported for tests.
 *
 * Runs split on text-object change (the legacy rule) and on orientation
 * change between classifiable glyphs (θ drift / mixed orientation). A run's
 * variant is decided by its FIRST classifiable glyph:
 *   - empty glyphs never classify (they adopt the run's variant);
 *   - real glyphs WITHOUT an oriented cell (singular matrix, synthesized
 *     /ActualText pieces) classify as upright — box-only data degrades to
 *     exactly the legacy behavior;
 *   - real glyphs with a non-upright matrix classify as rotated.
 * Runs that never see a classifiable glyph emit as upright (degenerate,
 * legacy behavior).
 */
export function buildRunsFromRawGlyphs(records: RawGeometryGlyphRecord[]): PageGeometryRun[] {
  const runs: PageGeometryRun[] = [];
  let buffer: RawGeometryGlyphRecord[] = [];
  let charStart = 0;
  let fontSize: number | undefined;
  let font: GeometryRunFont | undefined; // sommo-io fork
  let objectKey: number | bigint | null = null;
  let cls: RunClass | undefined;

  const flush = (nextStart: number) => {
    if (buffer.length > 0) {
      runs.push(materializeRun(buffer, charStart, fontSize, cls, font));
      buffer = [];
      cls = undefined;
    }
    charStart = nextStart;
  };

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.objectKey !== objectKey) {
      flush(i);
      objectKey = record.objectKey;
      fontSize = record.fontSize;
      font = record.font; // sommo-io fork
    }
    const recordClass = classOf(record);
    if (recordClass) {
      if (cls && !sameClass(cls, recordClass)) flush(i);
      if (!cls) cls = recordClass;
    }
    buffer.push(record);
  }
  flush(records.length);
  return runs;
}

function classOf(record: RawGeometryGlyphRecord): RunClass | undefined {
  if (record.flags & 2) return undefined; // empty glyphs never classify
  if (record.looseQuad && !record.upright) {
    return { upright: false, rotation: record.rotation, ascentFlip: record.ascentFlip };
  }
  return { upright: true };
}

function sameClass(a: RunClass, b: RunClass): boolean {
  if (a.upright || b.upright) return a.upright === b.upright;
  if (a.ascentFlip !== b.ascentFlip) return false;
  const delta = a.rotation - b.rotation;
  return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) <= ROTATION_SPLIT_TOLERANCE;
}

function materializeRun(
  buffer: RawGeometryGlyphRecord[],
  charStart: number,
  fontSize: number | undefined,
  cls: RunClass | undefined,
  font?: GeometryRunFont, // sommo-io fork
): PageGeometryRun {
  if (cls && !cls.upright) {
    const glyphs: RotatedGeometryGlyph[] = buffer.map((g) =>
      g.looseQuad
        ? {
            looseQuad: g.looseQuad,
            flags: g.flags,
            ...(g.tightQuad ? { tightQuad: g.tightQuad } : {}),
          }
        : // Empty glyphs inside a rotated run: zeroed quad + the empty flag,
          // mirroring the upright variant's zeroed-box convention.
          { looseQuad: zeroQuad(), flags: g.flags },
    );
    return {
      rect: runBounds(buffer, (g) => (g.looseQuad ? pdfQuadBounds(g.looseQuad) : ZERO_RECT)),
      charStart,
      glyphs,
      rotation: cls.rotation,
      ascentFlip: cls.ascentFlip,
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(font ? { font } : {}), // sommo-io fork
    };
  }

  // Upright (and degenerate-only) runs: the legacy materialization verbatim —
  // native-offered quads are dropped, the rect seeds from the FIRST glyph's
  // box (zeroed for empty glyphs, quirk included) and expands over non-empty
  // glyphs only.
  const glyphs: PageGeometryGlyph[] = buffer.map((g) => ({
    looseBox: g.looseBox,
    flags: g.flags,
    ...(g.tightBox ? { tightBox: g.tightBox } : {}),
  }));
  return {
    rect: runBounds(buffer, (g) => g.looseBox),
    charStart,
    glyphs,
    ...(fontSize !== undefined ? { fontSize } : {}),
    ...(font ? { font } : {}), // sommo-io fork
  };
}

/** Legacy run-rect algorithm: seed from the first glyph, expand on non-empty. */
function runBounds(
  buffer: RawGeometryGlyphRecord[],
  boundsOf: (g: RawGeometryGlyphRecord) => PdfRect,
): PdfRect {
  const seed = boundsOf(buffer[0]);
  const rect = { left: seed.left, bottom: seed.bottom, right: seed.right, top: seed.top };
  for (const g of buffer) {
    if (g.flags & 2) continue;
    const b = boundsOf(g);
    rect.left = Math.min(rect.left, b.left);
    rect.bottom = Math.min(rect.bottom, b.bottom);
    rect.right = Math.max(rect.right, b.right);
    rect.top = Math.max(rect.top, b.top);
  }
  return rect;
}

const ZERO_RECT: PdfRect = { left: 0, bottom: 0, right: 0, top: 0 };

function zeroQuad(): PdfQuad {
  return { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, p3: { x: 0, y: 0 }, p4: { x: 0, y: 0 } };
}

function emptyRawGlyph(): Omit<RawGeometryGlyphRecord, 'objectKey' | 'fontSize' | 'font'> {
  return {
    flags: 2,
    looseBox: { left: 0, bottom: 0, right: 0, top: 0 },
    upright: true,
    rotation: 0,
    ascentFlip: false,
  };
}

function readQuad(mem: PdfRuntimeMemory, ptr: Ptr, byteOffset: number): PdfQuad {
  const f = (offset: number) => readF32(mem, ptr, byteOffset + offset);
  return {
    p1: { x: f(0), y: f(4) },
    p2: { x: f(8), y: f(12) },
    p3: { x: f(16), y: f(20) },
    p4: { x: f(24), y: f(28) },
  };
}
