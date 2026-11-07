import test from 'ava';
import { shelterGoal } from '../../src/client/brain/goals.js';
import type { Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';

const night = (over: Partial<Snapshot> = {}) => ({ activity: 'rest', sleeping: false, dimension: 'overworld', home: { x: 0, y: 64, z: 0 }, distHome: 0, ...over }) as unknown as Snapshot;
const world = (bed?: { x: number; y: number; z: number }) => ({ landmarks: { bed, chests: [], farmland: [] } }) as unknown as WorldMemory;

test('shelter: a new bot home at night with no bed walls itself in; with a bed it goes to bed; boxed in already, nothing', t => {
  const g = shelterGoal();
  t.is(g.wants(night(), world()), 'night: no bed yet: wall in');
  t.is(g.wants(night(), world({ x: 1, y: 64, z: 0 })), 'night: go to bed');
  t.is(g.wants(night({ boxedIn: [] } as unknown as Partial<Snapshot>), world()), null);
  t.is(g.wants(night({ activity: 'work' } as Partial<Snapshot>), world()), null, 'by day it works');
});
