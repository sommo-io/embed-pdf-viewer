// sommo-io fork: result of replacing an open document's bytes in place.
import type { PageListSnapshot } from '../dto/PageListSnapshot';
import type { PageObjectNumber } from '../identity/PageObjectNumber';

/**
 * `DocumentHandle.replace(bytes)`: the session keeps its id, plugins and
 * view; only what the new bytes change is re-read.
 */
export interface DocumentReplaceResult {
  /** The page registry of the new bytes, in display order. */
  layout: PageListSnapshot;
  /**
   * Pages whose content may differ: the caller's `changedPages` hint, or
   * `null` when every page must be treated as changed.
   */
  changedPageObjectNumbers: PageObjectNumber[] | null;
}

/** Options of `DocumentHandle.replace`. */
export interface DocumentReplaceOptions {
  /** Password of the new bytes, when they are encrypted. */
  password?: string;
  /**
   * The pages the caller changed (e.g. the pages a text edit touched). Pages
   * not listed keep their rasters. Ignored when the new bytes do not have
   * the same pages as the open document.
   */
  changedPages?: PageObjectNumber[];
}
