import type { PageObjectNumber } from '../identity/PageObjectNumber';
import type { PdfRect } from '../geometry/primitives';

/**
 * sommo-io fork: a CropBox written into one page of a download only
 * (`DocumentHandle.download({ cropBoxes })`). The open document keeps its
 * own boxes, so the viewer's page geometry never changes; the exported file
 * carries the crop. `box` is in PDF user space (`top > bottom`).
 */
export interface PageCropBox {
  pageObjectNumber: PageObjectNumber;
  box: PdfRect;
}
