// sommo-io fork: result of a worker extension call (`DocumentHandle.callExtension`).
import type { PageObjectNumber } from '../identity/PageObjectNumber';

/**
 * A host application can run its own code in the engine worker, next to the
 * open document (see `WorkerHostOptions.extensions` in engine-services). The
 * engine does not know what the code does; it only learns which pages'
 * content it changed, so their rasters and text reads are renewed.
 */
export interface DocumentExtensionResult<T = unknown> {
  /** Whatever the extension answered (structured-cloneable). */
  result: T;
  /** Pages whose content the call changed (empty when none). */
  changedPageObjectNumbers: PageObjectNumber[];
}

/** Options of `DocumentHandle.callExtension`. */
export interface DocumentExtensionCallOptions {
  /** Buffers in the payload to move to the worker instead of copying them. */
  transfer?: ArrayBuffer[];
}
