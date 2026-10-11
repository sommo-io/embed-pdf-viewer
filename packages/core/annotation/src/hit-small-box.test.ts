// sommo-io fork: handles on small boxes (a tapped Check mark is ~17 px on a
// phone). The nearest handle wins; a box under two grab zones is moved from
// inside and resized from outside; a short side shows no edge handles.
import { describe, expect, it } from 'vitest';
import { geomHandles } from './geometry';
import { hitTest } from './hit';
import type { Annot, ChromeGeom, Model, Msg, Vec } from './types';
import { initialModel, update } from './update';
import { chrome } from './view';

const PON = 1 as Annot['pon'];
const run = (m: Model, msgs: Msg[]): Model => msgs.reduce((acc, msg) => update(acc, msg)[0], m);
const GEOM: ChromeGeom = { handleTol: 12, knobTol: 12, knobOffset: 32, edgeHandleMinSide: 48 };

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

describe('handles on small boxes (sommo-io fork)', () => {
  it('a box under two grab zones moves from inside and resizes from its corners outside', () => {
    const m = squareFrom({ x: 100, y: 100 }, { x: 110, y: 110 });
    const id = m.selected[0];
    expect(hitTest(m, PON, { x: 105, y: 105 }, GEOM, 6)).toEqual({ t: 'annot', id });
    expect(hitTest(m, PON, { x: 102, y: 108 }, GEOM, 6)).toEqual({ t: 'annot', id });
    expect(hitTest(m, PON, { x: 97, y: 97 }, GEOM, 6)).toMatchObject({ t: 'handle', handle: 'nw' });
    expect(hitTest(m, PON, { x: 114, y: 113 }, GEOM, 6)).toMatchObject({
      t: 'handle',
      handle: 'se',
    });
    expect(hitTest(m, PON, { x: 113, y: 96 }, GEOM, 6)).toMatchObject({
      t: 'handle',
      handle: 'ne',
    });
  });

  it('a short or narrow side shows and grabs no edge handles', () => {
    const m = squareFrom({ x: 100, y: 100 }, { x: 130, y: 300 });
    const geom = m.byId[m.selected[0]].geom;
    // 30 wide (< 48): no n / s; 200 tall: e / w stay.
    expect(geomHandles(geom, 48).map((h) => h.id)).toEqual(['nw', 'ne', 'e', 'se', 'sw', 'w']);
    expect(geomHandles(geom).map((h) => h.id)).toEqual([
      'nw',
      'n',
      'ne',
      'e',
      'se',
      's',
      'sw',
      'w',
    ]);
    const drawn = chrome(m, PON, undefined, 32, undefined, 48).filter((n) => n.kind === 'handle');
    expect(drawn).toHaveLength(6);
  });

  it('where grab zones overlap the nearest handle wins', () => {
    const m = squareFrom({ x: 100, y: 100 }, { x: 130, y: 130 });
    const all: ChromeGeom = { handleTol: 12, knobTol: 12, knobOffset: 32 };
    // n sits at (115, 100), 4 away; nw at (100, 100), 11 away. Upstream took nw (first in order).
    expect(hitTest(m, PON, { x: 111, y: 101 }, all, 6)).toMatchObject({ t: 'handle', handle: 'n' });
    expect(hitTest(m, PON, { x: 103, y: 101 }, all, 6)).toMatchObject({
      t: 'handle',
      handle: 'nw',
    });
  });
});
