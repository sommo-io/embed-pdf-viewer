/**
 * Priority levels for the WorkerQueue. Higher number = served first.
 * Wider range than v2 to leave room for future additions (idle, foreground,
 * critical) without re-indexing.
 *
 * sommo-io fork: page rasters have their own levels below every other read
 * and write. One raster of a scanned page can take seconds, so user actions
 * (text geometry for a text tool, annotation and form edits, saves) no
 * longer wait behind every queued raster, only behind the one already
 * running. A page's whole-page raster comes before tiles of any page.
 */
export const Priority = {
  LOW: 0,
  /** Tiles (`target.kind === 'rect'`): sharp detail over a page that already shows. */
  RASTER_TILE: 40,
  /** Whole-page rasters (the page's first pixels, thumbnails). */
  RASTER: 60,
  MEDIUM: 100,
  HIGH: 200,
  CRITICAL: 300,
} as const;

export type Priority = (typeof Priority)[keyof typeof Priority];
