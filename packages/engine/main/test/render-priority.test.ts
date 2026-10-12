// sommo-io fork: page rasters queue behind interactive work, tiles behind whole pages.
import type {
  PageObjectNumber,
  WirePack,
  WorkerRequest,
  WorkerResponse,
} from '@embedpdf/engine-core/runtime';
import { describe, expect, test } from 'vitest';

import { LocalPageGeometryService } from '../src/document/LocalPageGeometryService';
import { LocalPageRenderService } from '../src/document/LocalPageRenderService';
import type { LocalImageEncoder } from '../src/render/BrowserImageEncoder';
import type { ScopeGuard } from '../src/scope';
import type { Transport } from '../src/transport/Transport';
import { WorkerQueue } from '../src/worker/WorkerQueue';

/** Records what reaches the worker; answers nothing until told to. */
class HeldTransport implements Transport {
  readonly sent: WorkerRequest[] = [];
  private readonly listeners = new Set<(msg: WorkerResponse) => void>();
  send(pack: WirePack<WorkerRequest>): void {
    this.sent.push(pack.payload);
  }
  onMessage(handler: (msg: WorkerResponse) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  async terminate(): Promise<void> {}
  /** Fails the job so the queue dispatches the next one. */
  finish(jobId: number): void {
    const msg = {
      kind: 'reject',
      jobId,
      error: { name: 'EngineError', code: 'Internal', message: 'test' },
    } as unknown as WorkerResponse;
    for (const fn of this.listeners) fn(msg);
  }
}

const guard = { assertCapability() {} } as unknown as ScopeGuard;
const view = { isClosed: () => false };
const encoder = {} as LocalImageEncoder;
const pon = 1 as PageObjectNumber;

function setup() {
  const transport = new HeldTransport();
  const queue = new WorkerQueue(transport);
  const render = new LocalPageRenderService('doc', pon, queue, view, encoder, guard);
  const geometry = new LocalPageGeometryService('doc', pon, queue, view, guard);
  return { transport, queue, render, geometry };
}

const describeJob = (req: WorkerRequest) => {
  if (req.kind !== 'pages.render') return req.kind;
  const target = (req as { options?: { target?: { kind: string } } }).options?.target;
  return target?.kind === 'rect' ? 'tile' : 'page';
};

describe('render priority (sommo-io fork)', () => {
  test('text geometry and whole-page rasters run before queued tiles', async () => {
    const { transport, queue, render, geometry } = setup();
    const jobs = [
      render.raw({ target: { kind: 'page' } }), // dispatched at once
      render.raw({ target: { kind: 'rect', rect: { left: 0, top: 10, right: 10, bottom: 0 } } }),
      render.raw({ target: { kind: 'rect', rect: { left: 10, top: 10, right: 20, bottom: 0 } } }),
      render.raw({ target: { kind: 'page' } }),
      geometry.read(),
    ];
    for (const job of jobs) job.catch(() => {});

    expect(transport.sent.map(describeJob)).toEqual(['page']);
    for (let i = 0; i < 4; i++) transport.finish(transport.sent.at(-1)!.jobId);
    expect(transport.sent.map(describeJob)).toEqual([
      'page',
      'pages.geometry',
      'page',
      'tile',
      'tile',
    ]);
    transport.finish(transport.sent.at(-1)!.jobId);
    await queue.shutdown();
  });
});
