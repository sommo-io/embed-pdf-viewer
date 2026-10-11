import {
  EngineError,
  EngineErrorCode,
  type PageCropBox,
  type PageObjectNumber,
} from '@embedpdf/engine-core/runtime';
import type { PdfRuntimeModule } from '@embedpdf/engine-runtime';

import type { DocumentSession } from '../../document-session/DocumentSession';
import { withScratch } from '../../runtime/memory/scratch';
import { readRectF } from '../../runtime/memory/structs';

/** `FS_RECTF`: four f32. */
const RECTF_BYTES = 16;

interface Box {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/**
 * sommo-io fork: run `save` with the given pages' CropBoxes set, then put
 * each page's previous visible box back. The download carries the crop; the
 * open document's page geometry (and the viewer's coordinates) never
 * changes. Replaces a second pass that reopened the exported file in another
 * PDFium only to set CropBoxes.
 *
 * A page without its own `/CropBox` gets its previous visible box (CropBox ∩
 * MediaBox, `FPDF_GetPageBoundingBox`) written back explicitly: the same
 * page, one more key.
 */
export function withCropBoxes<T>(
  runtime: PdfRuntimeModule,
  session: DocumentSession,
  cropBoxes: readonly PageCropBox[],
  save: () => T,
): T {
  if (cropBoxes.length === 0) return save();
  const seen = new Set<PageObjectNumber>();
  for (const { pageObjectNumber, box } of cropBoxes) {
    session.recordByObjectNumber(pageObjectNumber); // NotFound on unknown pon
    if (seen.has(pageObjectNumber)) {
      throw new EngineError(
        EngineErrorCode.InvalidArg,
        `cropBoxes lists page ${pageObjectNumber} twice`,
      );
    }
    seen.add(pageObjectNumber);
    const values = [box.left, box.bottom, box.right, box.top];
    if (!values.every(Number.isFinite) || box.right <= box.left || box.top <= box.bottom) {
      throw new EngineError(
        EngineErrorCode.InvalidArg,
        `crop box of page ${pageObjectNumber} has no area`,
      );
    }
  }

  const { fn, mem } = runtime;
  const docPtr = session.requireDocPtr();
  // Pooled pages computed their geometry at load; nothing may hold one across this.
  session.pagePool().closeWarm();

  const withPage = <R>(
    pon: PageObjectNumber,
    body: (pagePtr: ReturnType<typeof fn.EPDFDoc_LoadPageByObjectNumber>) => R,
  ): R => {
    const pagePtr = fn.EPDFDoc_LoadPageByObjectNumber(docPtr, pon);
    if (!pagePtr)
      throw new EngineError(EngineErrorCode.NotFound, `no page with object number ${pon}`);
    try {
      return body(pagePtr);
    } finally {
      fn.FPDF_ClosePage(pagePtr);
    }
  };
  const setBox = (pon: PageObjectNumber, b: Box) =>
    withPage(pon, (pagePtr) => fn.FPDFPage_SetCropBox(pagePtr, b.left, b.bottom, b.right, b.top));

  const previous: { pon: PageObjectNumber; box: Box }[] = [];
  try {
    for (const { pageObjectNumber, box } of cropBoxes) {
      const before = withPage(pageObjectNumber, (pagePtr) =>
        withScratch(mem, RECTF_BYTES, (buf) => {
          if (!fn.FPDF_GetPageBoundingBox(pagePtr, buf)) {
            throw new EngineError(
              EngineErrorCode.Unknown,
              `cannot read the boxes of page ${pageObjectNumber}`,
            );
          }
          return readRectF(mem, buf);
        }),
      );
      previous.push({ pon: pageObjectNumber, box: before });
      setBox(pageObjectNumber, box);
    }
    return save();
  } finally {
    for (const { pon, box } of previous.reverse()) setBox(pon, box);
  }
}
