// sommo-io fork: `handles.hiddenFor` — a kind whose plain box sizes itself
// (a free-text box) shows and grabs no resize handles; it moves and rotates.
import { describe, expect, it } from 'vitest';
import { boxHandlesHidden } from './kinds';
import { hitTest } from './hit';
import type { Annot, ChromeGeom, Model, Msg, Vec } from './types';
import { initialModel, update } from './update';
import { chrome } from './view';

const PON = 1 as Annot['pon'];
const run = (m: Model, msgs: Msg[]): Model => msgs.reduce((acc, msg) => update(acc, msg)[0], m);
const GEOM: ChromeGeom = { handleTol: 12, knobTol: 12, knobOffset: 32 };
const HIDDEN: ChromeGeom = { ...GEOM, hiddenHandleSubtypes: ['square'] };

/** A square dragged from `a` to `b` (the new annotation is selected). */
function squareFrom(a: Vec, b: Vec): Model {
  const ptr = (phase: 'down' | 'move' | 'up', point: Vec): Msg => ({
    t: 'createPointer',
    phase,
    subtype: 'square',
    in: { pon: PON, point, shift: false },
  });
  const m = run(initialModel, [ptr('down', a), ptr('move', b), ptr('up', b)]);
  expect(m.selected).toHaveLength(1);
  return m;
}

describe('hidden box handles (sommo-io fork)', () => {
  it('a listed kind draws no handles but keeps its outline and rotate knob', () => {
    const m = squareFrom({ x: 100, y: 100 }, { x: 200, y: 160 });
    const shown = chrome(m, PON, undefined, 32);
    expect(shown.filter((n) => n.kind === 'handle')).toHaveLength(8);
    const hidden = chrome(m, PON, undefined, 32, undefined, 0, ['square']);
    expect(hidden.filter((n) => n.kind === 'handle')).toHaveLength(0);
    expect(hidden.find((n) => n.kind === 'outline')).toMatchObject({ subtype: 'square' });
    expect(hidden.some((n) => n.kind === 'rotate-knob')).toBe(true);
  });

  it('a corner, the frame and a grab zone around a listed kind move the body instead of resizing it', () => {
    const m = squareFrom({ x: 100, y: 100 }, { x: 200, y: 160 });
    const id = m.selected[0];
    expect(hitTest(m, PON, { x: 199, y: 159 }, GEOM, 6)).toMatchObject({
      t: 'handle',
      handle: 'se',
    });
    expect(hitTest(m, PON, { x: 199, y: 159 }, HIDDEN, 6)).toEqual({ t: 'annot', id });
    // On the frame and just outside it (the drawn frame and halo, within a grab zone): the body, never a handle.
    expect(hitTest(m, PON, { x: 201, y: 161 }, HIDDEN, 6)).toEqual({ t: 'annot', id });
    expect(hitTest(m, PON, { x: 208, y: 166 }, HIDDEN, 6)).toEqual({ t: 'annot', id });
    expect(hitTest(m, PON, { x: 150, y: 96 }, HIDDEN, 6)).toEqual({ t: 'annot', id });
    // Past the grab zone: not this box.
    expect(hitTest(m, PON, { x: 230, y: 190 }, HIDDEN, 6)).toEqual({ t: 'empty' });
  });

  it('only a plain box is affected: a callout keeps its leader handles', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(boxHandlesHidden('free-text', { t: 'text', rect }, ['free-text'])).toBe(true);
    expect(
      boxHandlesHidden('free-text', { t: 'text', rect, callout: {} as never }, ['free-text']),
    ).toBe(false);
    expect(boxHandlesHidden('free-text', { t: 'text', rect }, undefined)).toBe(false);
    expect(
      boxHandlesHidden('line', { t: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }, ['line']),
    ).toBe(false);
  });
});
