import {
  richTextRunIsSquiggly,
  type AnnotationBase,
  type BlendMode,
  type FreeTextDraft,
  type RichTextDocument,
  type RichTextRunStyle,
} from '@embedpdf/engine-core/runtime';
import type { PdfRuntimeModule, Ptr } from '@embedpdf/engine-runtime';

import { blendModeToCode } from '../blendMode';
import type { AnnotationReadContext } from '../read/annotationReadContext';
import { readAnnotRect } from '../read/annotationReadPrimitives';
import { readFreeText } from '../read/readFreeTextAnnotation';
import { readUtf16String } from '../../../../runtime/memory/strings';
import { readEngineRichText } from '../richTextWire';
import type { AnnotationWriteContext } from './annotationWriteContext';
import { applyFreeTextDraft } from './writeFreeTextAnnotation';

/**
 * sommo-io fork: draw a free text's squiggly underlines as waves.
 *
 * The engine lays out and draws `underline` and `line-through` only; a
 * squiggly underline is an underline whose `text-decoration-style` is `wavy`
 * (`richTextRunIsSquiggly`), which the engine draws straight. Its appearance
 * stream cannot be edited in place: `FPDFAnnot_SetAP` writes a new stream
 * without the old one's `/Resources` (the fonts), and `FPDFAnnot_AppendObject`
 * refuses free text. So the box is redrawn in a scratch document:
 *
 *  1. a copy of the box whose only lines are the squiggly underlines, then one
 *     with no lines at all: the strokes the first has and the second lacks are
 *     where the waves go (`x y m x2 y l S`, form space);
 *  2. the copy with its real text minus those underlines is flattened onto
 *     its page, the waves are added as paths (through the appearance matrix,
 *     so a rotated box gets rotated waves), and the page is cut to `/Rect`;
 *  3. that page becomes the box's appearance (`EPDFAnnot_SetAppearanceFromPage`,
 *     the stamp path: content and resources cloned into a wrapped form).
 *
 * `/RC` and the rest of the dictionary are untouched: a later bake starts
 * from them again. Returns whether the appearance was replaced; a box with
 * no squiggly run is left as the engine drew it.
 */
export function bakeSquigglyUnderlines(
  runtime: PdfRuntimeModule,
  annotPtr: Ptr,
  readCtx: AnnotationReadContext,
  writeCtx: AnnotationWriteContext,
  blendMode?: BlendMode,
): boolean {
  const { fn, mem } = runtime;
  const rich = readEngineRichText(fn, mem, annotPtr);
  if (!rich || !hasSquiggly(rich)) return false;

  const rect = readAnnotRect(fn, mem, annotPtr);
  const dto = readFreeText(
    fn,
    mem,
    annotPtr,
    { contents: '' } as AnnotationBase,
    undefined,
    readCtx,
  );
  const draft: FreeTextDraft = {
    subtype: 'free-text',
    intent: dto.intent,
    fontFamily: dto.fontFamily,
    fontSize: dto.fontSize,
    textAlign: dto.textAlign,
    rect,
    color: dto.color,
    ...(dto.fontColor ? { fontColor: dto.fontColor } : {}),
    interiorColor: dto.interiorColor,
    // The box's own /CA still applies to the whole appearance.
    opacity: 1,
    strokeWidth: dto.strokeWidth,
    borderStyle: dto.borderStyle,
    ...(dto.dashArray ? { dashArray: dto.dashArray } : {}),
    rectDifferences: dto.rectDifferences,
    ...(dto.calloutLine ? { calloutLine: dto.calloutLine } : {}),
    ...(dto.lineEnding ? { lineEnding: dto.lineEnding } : {}),
    ...(dto.rotation !== undefined ? { rotation: dto.rotation } : {}),
    ...(dto.unrotatedRect ? { unrotatedRect: dto.unrotatedRect } : {}),
  };
  // The scratch writes need no document or page of their own.
  const scratchCtx: AnnotationWriteContext = {
    ...(writeCtx.resolveRegisteredFontId
      ? { resolveRegisteredFontId: writeCtx.resolveRegisteredFontId }
      : {}),
    ...(writeCtx.describeRegisteredFont
      ? { describeRegisteredFont: writeCtx.describeRegisteredFont }
      : {}),
  };

  const docPtr = fn.FPDF_CreateNewDocument();
  if (!docPtr) return false;
  try {
    // Any page that holds the box: the flatten places it at its /Rect.
    let pagePtr = fn.FPDFPage_New(
      docPtr,
      0,
      Math.max(1, rect.right) + 1,
      Math.max(1, rect.top) + 1,
    );
    if (!pagePtr) return false;
    let waves: Stroke[];
    let matrix: Matrix;
    try {
      const copy = fn.FPDFPage_CreateAnnot(pagePtr, FREE_TEXT);
      if (!copy) return false;
      try {
        applyFreeTextDraft(
          fn,
          mem,
          copy,
          { ...draft, richText: linesOnly(rich, 'squiggly') },
          scratchCtx,
        );
        const marked = strokesOf(appearanceText(runtime, copy));
        applyFreeTextDraft(
          fn,
          mem,
          copy,
          { ...draft, richText: linesOnly(rich, 'none') },
          scratchCtx,
        );
        const plain = new Set(strokesOf(appearanceText(runtime, copy)).map((s) => s.key));
        waves = marked.filter((s) => !plain.has(s.key));
        if (!waves.length) return false;
        applyFreeTextDraft(
          fn,
          mem,
          copy,
          { ...draft, richText: withoutSquiggly(rich) },
          scratchCtx,
        );
        if (blendMode !== undefined) {
          fn.EPDFAnnot_GenerateAppearanceWithBlend(copy, blendModeToCode(blendMode));
        }
        matrix = appearanceMatrix(runtime, copy);
      } finally {
        fn.FPDFPage_CloseAnnot(copy);
      }
      if (fn.EPDFPage_Flatten(pagePtr, 0) === FLATTEN_FAIL) return false;
    } finally {
      fn.FPDF_ClosePage(pagePtr);
    }
    // Flatten rewrote the page: reload it before adding objects.
    pagePtr = fn.FPDF_LoadPage(docPtr, 0);
    if (!pagePtr) return false;
    try {
      for (const stroke of waves) {
        const path = wavePath(runtime, stroke);
        if (!path) continue;
        fn.FPDFPageObj_Transform(path, ...matrix);
        fn.FPDFPage_InsertObject(pagePtr, path);
      }
      if (!fn.FPDFPage_GenerateContent(pagePtr)) return false;
      fn.FPDFPage_SetMediaBox(pagePtr, rect.left, rect.bottom, rect.right, rect.top);
      fn.FPDFPage_SetCropBox(pagePtr, rect.left, rect.bottom, rect.right, rect.top);
    } finally {
      fn.FPDF_ClosePage(pagePtr);
    }
    return fn.EPDFAnnot_SetAppearanceFromPage(annotPtr, docPtr, 0);
  } finally {
    fn.FPDF_CloseDocument(docPtr);
  }
}

const FREE_TEXT = 3;
const FLATTEN_FAIL = 0;

type Matrix = [number, number, number, number, number, number];

/** An underline the engine stroked: form-space ends, width, RGB 0..1. */
interface Stroke {
  key: string;
  x1: number;
  x2: number;
  y: number;
  width: number;
  color: [number, number, number];
}

function hasSquiggly(doc: RichTextDocument): boolean {
  return doc.paragraphs.some((p) =>
    p.runs.some((r) => r.text.length > 0 && richTextRunIsSquiggly(doc.body, r.style)),
  );
}

/** Every run with its lines stated, the body with none: `squiggly` keeps
 *  only the squiggly runs' underline, `none` drops every line. */
function linesOnly(doc: RichTextDocument, keep: 'squiggly' | 'none'): RichTextDocument {
  return {
    body: { ...doc.body, decoration: [] },
    paragraphs: doc.paragraphs.map((p) => ({
      ...p,
      runs: p.runs.map((r) => {
        const squiggly = keep === 'squiggly' && richTextRunIsSquiggly(doc.body, r.style);
        const lines = (r.style?.decoration ?? doc.body.decoration).filter(
          (d) => d === 'underline' || d === 'word',
        );
        return {
          ...r,
          style: { ...(r.style ?? {}), decoration: squiggly ? lines : [] },
        };
      }),
    })),
  };
}

/** The real text with the squiggly runs' straight underline taken out
 *  (their line-through stays). */
function withoutSquiggly(doc: RichTextDocument): RichTextDocument {
  const strip = (d: RichTextRunStyle['decoration']) =>
    d.filter((x) => x !== 'underline' && x !== 'word');
  return {
    body: doc.body,
    paragraphs: doc.paragraphs.map((p) => ({
      ...p,
      runs: p.runs.map((r) => {
        if (!richTextRunIsSquiggly(doc.body, r.style)) return r;
        const decoration = strip(r.style?.decoration ?? doc.body.decoration);
        return { ...r, style: { ...(r.style ?? {}), decoration } };
      }),
    })),
  };
}

function appearanceText(runtime: PdfRuntimeModule, annotPtr: Ptr): string {
  const { fn, mem } = runtime;
  return readUtf16String(mem, (buf, cap) => fn.FPDFAnnot_GetAP(annotPtr, 0, buf, cap)) ?? '';
}

const NUM = '(-?[\\d.]+)';
const STROKE_TOKENS = new RegExp(
  `${NUM} w\\b|${NUM} ${NUM} ${NUM} RG\\b|${NUM} ${NUM} m\\s+${NUM} ${NUM} l\\s+S\\b`,
  'g',
);

/** The horizontal stroked segments of an appearance, with the width and
 *  stroke colour in force where each is drawn. */
function strokesOf(content: string): Stroke[] {
  const out: Stroke[] = [];
  let width = 1;
  let color: [number, number, number] = [0, 0, 0];
  for (const m of content.matchAll(STROKE_TOKENS)) {
    if (m[1] !== undefined) {
      width = Number(m[1]);
    } else if (m[2] !== undefined) {
      color = [Number(m[2]), Number(m[3]), Number(m[4])];
    } else if (m[6] === m[8]) {
      const x1 = Number(m[5]);
      const x2 = Number(m[7]);
      const y = Number(m[6]);
      if (!(x2 > x1)) continue;
      out.push({ key: `${m[5]} ${m[6]} ${m[7]} ${m[8]} ${width}`, x1, x2, y, width, color });
    }
  }
  return out;
}

function appearanceMatrix(runtime: PdfRuntimeModule, annotPtr: Ptr): Matrix {
  const { fn, mem } = runtime;
  const buf = mem.alloc(24);
  try {
    if (!fn.EPDFAnnot_GetAPMatrix(annotPtr, 0, buf)) return [1, 0, 0, 1, 0, 0];
    const at = (i: number) => Number(mem.peek(buf, 'f32', i * 4));
    return [at(0), at(1), at(2), at(3), at(4), at(5)];
  } finally {
    mem.free(buf);
  }
}

/**
 * The wave under one underline: a zigzag whose ends sit on the line, like
 * Edit text's squiggly, a little below the straight line. The engine's
 * underline width follows the font size (about 0.027 em), so the wave's
 * size is taken from it.
 */
function wavePath(runtime: PdfRuntimeModule, s: Stroke): Ptr | null {
  const { fn } = runtime;
  const amp = Math.max(0.6, 1.65 * s.width);
  const step = Math.max(1, 5.2 * s.width);
  const y = s.y - 0.6 * s.width;
  const path = fn.FPDFPageObj_CreateNewPath(s.x1, y);
  if (!path) return null;
  const steps = Math.max(2, Math.round((s.x2 - s.x1) / step));
  for (let k = 1; k <= steps; k++) {
    const x = s.x1 + ((s.x2 - s.x1) * k) / steps;
    fn.FPDFPath_LineTo(path, x, k === steps ? y : y + (k % 2 ? -amp : amp));
  }
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  fn.FPDFPageObj_SetStrokeColor(path, byte(s.color[0]), byte(s.color[1]), byte(s.color[2]), 255);
  fn.FPDFPageObj_SetStrokeWidth(path, Math.max(0.4, 1.85 * s.width));
  fn.FPDFPageObj_SetLineJoin(path, 1);
  fn.FPDFPath_SetDrawMode(path, 0, true);
  return path;
}
