import type { PageObjectNumber } from '@embedpdf/engine-core/runtime';
import { EngineError, EngineErrorCode } from '@embedpdf/engine-core/runtime';
import type { PdfRuntimeModule, Ptr } from '@embedpdf/engine-runtime';

/**
 * Manages pagePtr lifetime for a single open `DocumentSession`.
 *
 * `acquire(pon)` returns a loaded pagePtr for the given PDF object number,
 * loading it via `EPDFDoc_LoadPageByObjectNumberNormalized` (rotation forced
 * to 0deg so render/text/geometry/annotation coordinates all share one
 * normalized space) if not already in the pool. `release(pon)` decrements the
 * refcount and closes when it reaches
 * zero; `closeAll()` is called by `DocumentSession.close()`.
 *
 * While at least one holder is active the pagePtr is shared (refcounted),
 * so overlapping `acquire(pon)` calls for the same page reuse a single
 * load. Once the refcount reaches zero the page is closed; a later
 * `acquire` reloads it — there is no LRU retention across the zero-ref
 * boundary. A future slice could add that without changing callers.
 *
 * sommo-io fork: one "warm" page. Read-only callers (render, text, geometry)
 * pass `{ warm: true }`: on release the page stays loaded until another
 * page is acquired, any other caller acquires a page, a mutation is noted,
 * or `WARM_IDLE_MS` pass. PDFium keeps a page's decoded images on its
 * `CPDF_Page`, so the tiles of one page no longer decode every image again
 * (a 20-layer JPX scan page at 200 %: 25 s → 4 s). The warm page is closed
 * BEFORE another page loads, so at most one page's images are in memory,
 * as before.
 */
/** sommo-io fork: how long the warm page outlives its last read. */
export const WARM_IDLE_MS = 1000;

export class PagePtrPool {
  private readonly counts = new Map<PageObjectNumber, { ptr: Ptr; refs: number }>();
  private warm: PageObjectNumber | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly runtime: PdfRuntimeModule,
    private readonly docPtr: Ptr,
  ) {}

  acquire(pageObjectNumber: PageObjectNumber, options?: { warm?: boolean }): Ptr {
    const { fn } = this.runtime;
    if (this.warm !== null && (this.warm !== pageObjectNumber || !options?.warm)) {
      this.closeWarm();
    }
    if (this.warm === pageObjectNumber) this.takeWarm();
    const existing = this.counts.get(pageObjectNumber);
    if (existing) {
      existing.refs++;
      return existing.ptr;
    }
    const ptr = fn.EPDFDoc_LoadPageByObjectNumberNormalized(this.docPtr, pageObjectNumber);
    if (!ptr) {
      throw new EngineError(
        EngineErrorCode.NotFound,
        `no page with object number ${pageObjectNumber}`,
      );
    }
    this.counts.set(pageObjectNumber, { ptr, refs: 1 });
    return ptr;
  }

  /**
   * True while at least one holder has the page open. Page-STRUCTURE
   * mutations (delete) assert on this: thread confinement means no other
   * job can be mid-flight, so a held pagePtr during a structural mutation
   * is a leaked `acquire` (an internal bug) — the mutator fails loudly
   * instead of mutating under a live handle.
   */
  isHeld(pageObjectNumber: PageObjectNumber): boolean {
    if (this.warm === pageObjectNumber) this.closeWarm();
    return this.counts.has(pageObjectNumber);
  }

  release(pageObjectNumber: PageObjectNumber, options?: { warm?: boolean }): void {
    const entry = this.counts.get(pageObjectNumber);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      if (options?.warm) {
        if (this.warm !== null) this.closeWarm();
        this.warm = pageObjectNumber;
        this.warmTimer = setTimeout(() => {
          this.warmTimer = null;
          this.closeWarm();
        }, WARM_IDLE_MS);
        return;
      }
      this.runtime.fn.FPDF_ClosePage(entry.ptr);
      this.counts.delete(pageObjectNumber);
    }
  }

  /** sommo-io fork: close the warm page, if any (a mutation is about to change the document). */
  closeWarm(): void {
    const pon = this.warm;
    if (pon === null) return;
    this.takeWarm();
    const entry = this.counts.get(pon);
    if (entry && entry.refs <= 0) {
      this.runtime.fn.FPDF_ClosePage(entry.ptr);
      this.counts.delete(pon);
    }
  }

  private takeWarm(): void {
    this.warm = null;
    if (this.warmTimer !== null) {
      clearTimeout(this.warmTimer);
      this.warmTimer = null;
    }
  }

  closeAll(): void {
    this.takeWarm();
    const { fn } = this.runtime;
    for (const { ptr } of this.counts.values()) {
      fn.FPDF_ClosePage(ptr);
    }
    this.counts.clear();
  }
}
