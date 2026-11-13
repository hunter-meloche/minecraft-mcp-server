import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Brain, decide } from '../../src/client/brain/brain.js';
import { brainRun, type ClientRuntime, type InventoryItem } from '../../src/client/tools.js';
import type { Goal, GoalContext, Snapshot } from '../../src/client/brain/goals.js';
import type { WorldMemory } from '../../src/client/brain/memory.js';
import { explainIdle, idleOf } from '../../src/client/brain/idlelog.js';
import type { Run } from '../../src/client/brain/loops.js';
import { activityAt } from '../../src/client/brain/schedule.js';
import { TREE } from '../../src/client/brain/tree.js';
import type { Milestone, Step } from '../../src/client/brain/progress.js';
import { blocksWorked, projectGoal } from '../../src/client/brain/project.js';
import { structureGoal } from '../../src/client/structures/job.js';
import { deepTrip } from '../../src/client/brain/deep.js';
import { lights, stock } from '../../src/client/brain/chores.js';
import { caneRound } from '../../src/client/brain/cane.js';
import { pens } from '../../src/client/brain/pens.js';
import { treeFarm } from '../../src/client/brain/farming.js';
import { larder } from '../../src/client/brain/food.js';
import { donateGoal, missionGoal } from '../../src/client/brain/community.js';
import { repairGoal } from '../../src/client/brain/repair.js';
import { ROOM, pockets, room, type RoomKind } from '../../src/client/brain/pockets.js';

const reply = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const settle = () => new Promise(r => setTimeout(r, 20));

/** 14:00:00 UTC: the "held until" and log times below read from here. */
const T0 = Date.UTC(2026, 10, 10, 14, 0, 0);
const MIN = 60_000;
const HOME = { x: 0, y: 64, z: 0 };
const ARMOUR = ['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'].map((name, i): InventoryItem => ({ slot: 36 + i, name, count: 1 }));

/** At home at noon, awake, well and fed, carrying `items`. */
function snapOf(items: InventoryItem[], over: Partial<Snapshot> = {}): Snapshot {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.count);
  return {
    now: T0, timeOfDay: 6000, activity: 'work', health: 20, food: 20, position: { ...HOME }, dimension: 'overworld',
    sleeping: false, raining: false, thundering: false, process: null, items, counts, slotsUsed: items.filter(i => i.slot < 36).length,
    home: { ...HOME, dimension: 'overworld' }, distHome: 0, ...over
  };
}

// ---- the grid: every gated goal, with something to do at home ----

const SLOTS = [10, 26, 27, 30, 31, 33, 34, 35, 36];
const TIMES = [0, 3000, 5000, 6000, 6800, 8000, 9000, 9800, 10400, 10700];
/** The deep trip's kit in the first slots, bread for 20 food points (the larder still wants more), then filler. */
const POCKETS = ['torch', 'cobblestone', 'bread', 'stone', 'iron_pickaxe', 'dirt', 'iron_ingot', 'gold_ingot'];
const FILLER = ['oak_log', 'coal', 'stick', 'oak_planks', 'sand', 'raw_iron', 'cobbled_deepslate'];

function carrying(slots: number, filler = FILLER): InventoryItem[] {
  const items: InventoryItem[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const name = POCKETS[slot] ?? filler[slot % filler.length];
    items.push({ slot, name, count: name === 'bread' ? 4 : name === 'iron_pickaxe' ? 1 : 64 });
  }
  return [...items, ...ARMOUR];
}

/**
 * The yard of the busy home: long to the west, its far end 64 from home (as the live yard has grown), 16 to the east.
 * Only the pockets rule reads it here (the stash can be sent from anywhere in it, and the deep trip sets out from it).
 */
const YARD = { x1: -64, z1: -24, x2: 16, z2: 24, y: 64 };
/**
 * Where the grid stands the bot, by x: at home; 60 west, the far end of the busy home's yard; 50 east, outside that
 * yard and further than the stash is sent home from (40).
 */
const PLACES = [0, -60, 50];
const placed = (x: number) => (x === 0 ? 'at home' : x < 0 ? `${-x} west` : `${x} east`);

const gridSnap = (slots: number, time: number, x: number, filler = FILLER): Snapshot =>
  snapOf(carrying(slots, filler), { timeOfDay: time, activity: activityAt(time), position: { x, y: 64, z: 0 }, distHome: Math.abs(x) });

/** The project with nothing done yet; `blocked`: every milestone waits ten minutes, short of cane and leather. */
const projectAt = (blocked: boolean): NonNullable<WorldMemory['progress']> => ({
  done: [], journal: [],
  ...(blocked ? { blockedUntil: Object.fromEntries(TREE.map(m => [m.id, T0 + 10 * MIN])), need: { sugar_cane: 98, leather: 38 } } : {})
});

/**
 * A home where each of the ten has something to do: a cane patch, a tree farm and a pen whose rounds are due, a queued
 * build, a mission, a community chest and ingots to spare for it, no diamonds, little food.
 */
function busyWorld(blocked: boolean): WorldMemory {
  const hourAgo = T0 - 60 * MIN;
  const world: WorldMemory = {
    landmarks: { chests: [{ x: 1, y: 64, z: 1 }], farmland: [], bed: { x: -1, y: 64, z: 0 } }, leash: 96, yard: { ...YARD },
    chestItems: { '1,64,1': { diamond: 0, iron_ingot: 80, gold_ingot: 40 } },
    lastDone: { cane: hourAgo, trees: hourAgo, pens: hourAgo, deep: hourAgo },
    zones: { cane: [{ x: -10, y: 64, z: -10 }], 'trees:sapling': [{ x: -20, y: 64, z: -20 }], 'pen:cow': [{ x: 10, y: 64, z: 10, width: 7, length: 7 }] },
    progress: projectAt(blocked),
    buildJobs: [{ id: 1, world: 'w', structure: 'hut', mode: 'apply', status: 'queued', createdAt: T0 - MIN, updatedAt: T0 - MIN }],
    community: {
      chests: { community1: { x: 300, y: 64, z: 300 } }, nextId: 2,
      missions: [{ id: 1, item: 'cobblestone', count: 64, chest: 'community1', gathered: 0, delivered: 0, status: 'active', createdAt: T0, updatedAt: T0 }]
    }
  };
  return world;
}

/** A home with nothing set up yet: no chest, no patch, no pen, no job, no mission. Most of the ten have nothing to do there. */
const newWorld = (blocked: boolean): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96, progress: projectAt(blocked) });

/** The ten goals that say why they do not want to run, each from one gate. */
const gated = (): Goal[] => [projectGoal(TREE), structureGoal({} as never), deepTrip, stock, caneRound, pens, treeFarm, larder, donateGoal, missionGoal];
/** What a goal may give as its cause: `hold` is the brain's own (a goal it keeps back), `nothing` is nobody saying anything. */
const SAID = ['away', 'health', 'pockets', 'late', 'kit', 'project', 'dry', 'stocked', 'unneeded'];
/**
 * The room each of the seven asks the one pockets rule for (pockets.ts ROOM). The other three have no slot limit of
 * that kind: the larder and the donation never wait on the pockets, and the mission keeps the trip's fixed ten free.
 */
const KIND: Record<string, RoomKind> = { project: 'project', build: 'project', 'deep trip': 'deep', stock: 'trip', cane: 'yard', pens: 'yard', trees: 'yard' };
/** The same for the rungs of the work queue on the real goal list (worktasks.ts). */
const WORK_KIND: Record<string, RoomKind> = { 'work: trip kit': 'yard', 'work: deep': 'deep', 'work: surface': 'trip' };

test('wants is null exactly when declines is not: the ten gated goals over pockets x hour x project blocked or not x at home, at the far end of the yard or 50 out; and full pockets are the reason only where the stash could make no room', (t) => {
  const goals = gated();
  t.deepEqual(goals.map(g => g.name), ['project', 'build', 'deep trip', 'stock', 'cane', 'pens', 'trees', 'larder', 'donate', 'community']);
  // each cell at two homes: one where all ten have work (so the blockers decide), one where most have none. The
  // blocked project is short of sand as well: the cane is the work queue's now, and the sand still sends the stock
  // goal out, so the grid sees its pockets rule
  const withSand = (w: WorldMemory) => { if (w.progress?.need) w.progress.need = { ...w.progress.need, sand: 20 }; return w; };
  const homes = { busy: (b: boolean) => withSand(busyWorld(b)), new: (b: boolean) => withSand(newWorld(b)) };
  const bad: string[] = [];
  const seen = new Map(Object.keys(homes).flatMap(home => goals.map(g => [`${home}: ${g.name}`, { wants: 0, causes: new Set<string>(), full: new Set<string>() }])));
  let cells = 0;
  for (const slots of SLOTS) for (const time of TIMES) for (const blocked of [false, true]) for (const x of PLACES) {
    cells++;
    const s = gridSnap(slots, time, x);
    for (const [home, make] of Object.entries(homes)) for (const g of goals) {
      const say = (what: string) => bad.push(`${g.name} at the ${home} home, ${slots} slots, time ${time}, project ${blocked ? 'blocked' : 'free'}, ${placed(x)}: ${what}`);
      if (!g.gate || !g.declines) { say('no gate'); continue; }
      // a home of its own for each asking: wants() may write down what it finds (a milestone already done in the
      // world), and the two have to say the same whichever is asked first. declines() only looks (the next test)
      const a = make(blocked), b = make(blocked);
      const want = g.wants(s, a), no = g.declines(s, a);
      const noFirst = g.declines(s, b), wantAfter = g.wants(s, b);
      if (want !== wantAfter || JSON.stringify(no) !== JSON.stringify(noFirst)) say(`asked the other way round: wants ${JSON.stringify(wantAfter)}, declines ${JSON.stringify(noFirst)}`);
      if ((want === null) !== (no !== null)) say(`wants ${JSON.stringify(want)}, declines ${JSON.stringify(no)}`);
      // both are the one gate's answer
      const one = g.gate(s, make(blocked));
      if (JSON.stringify('want' in one ? one.want : one) !== JSON.stringify(want ?? no)) say(`the gate says ${JSON.stringify(one)}`);
      const rec = seen.get(`${home}: ${g.name}`)!;
      // the deep trip sets out only with 3 min at the ore after the walk there: that is 5000 at the latest
      if (g.name === 'deep trip' && want !== null && time > 5000) say('sets out with under 3 min left at the ore');
      if (want !== null) { rec.wants++; continue; }
      if (!no) continue;
      rec.causes.add(no.cause);
      if (!SAID.includes(no.cause) || !no.text || /undefined|NaN|\[object/.test(no.text)) say(`a decline that does not say why: ${JSON.stringify(no)}`);
      if (no.until !== undefined && !(Number.isFinite(no.until) && no.until > s.now)) say(`until ${no.until} is no time to come`);
      if (no.cause === 'pockets') {
        // the one slot rule: full pockets hold a goal only where the stash could not make its room (nothing to put
        // away, or the chests out of reach). With the room, or with the stash able to make it, the goal wants and its
        // run makes the room first. brain.log 2026-11-08..10: 294.7 idle minutes with the pockets at 34-36 slots, each
        // goal waiting under a limit of its own for a stash that was waiting for fuller pockets
        const kind = KIND[g.name];
        const answer = kind ? room(kind, s, make(blocked)) : undefined;
        if (kind ? answer !== 'no' : g.name !== 'community' || 36 - slots >= 10) say(`pockets (${no.text}) while its room is ${answer ?? 'never asked'}`);
        if (kind) {
          // and counted here by hand, not by room(): short of its room, and the chests out of reach (none, or the bot
          // outside the yard and over 40 from home) or the stash not able to make up the difference
          const w = make(blocked), p = pockets(s, w, kind);
          const reach = w.landmarks.chests.length > 0 && (Math.abs(x) <= 40 || (!!w.yard && x >= w.yard.x1 && x <= w.yard.x2));
          if (!(p.free < ROOM[kind] && (!reach || p.free + p.loose < ROOM[kind]))) say(`pockets (${no.text}) with ${p.free} free, ${p.loose} to put away, the chests ${reach ? 'in' : 'out of'} reach`);
        }
        rec.full.add(`${slots} ${placed(x)}`);
      }
      if (no.cause === 'late') {
        // the hour is the reason only when it is the only one: the same pockets and place in the morning, and it runs
        const morning = { ...s, timeOfDay: 1000, activity: activityAt(1000) };
        if (g.wants(morning, make(blocked)) === null) say(`late (${no.text}), yet in the morning it still does not want to run`);
      }
    }
  }
  t.is(cells, 540);
  t.deepEqual(bad.slice(0, 20), []);
  // where all have work the grid shows each of them both ways
  for (const g of goals) {
    const rec = seen.get(`busy: ${g.name}`)!;
    t.true(rec.wants > 0 && rec.wants < cells, `${g.name} wants to run in ${rec.wants} of ${cells} cells`);
  }
  // the deep trip's last hour: it wanted to run to 6000, set out, found under 3 min left at the ore, turned back with
  // nothing and had the day marked done. The bound is its gate's now: it says "late", with the numbers, and only
  // where nothing else holds it (the loop above asks every "late" whether the morning would run)
  const deep = goals[2];
  // at home or anywhere in the yard, project blocked or not, at 0, 3000 and 5000 (not at 6000, as it once did), and
  // with any of the nine pockets: under ten slots free its run puts the grid's logs, sand and ingots away first (it
  // was 12 cells: at home only, and only with 10 or 26 slots)
  t.is(seen.get('busy: deep trip')!.wants, 108);
  for (const blocked of [false, true]) {
    t.is(deep.wants(gridSnap(10, 5000, 0), busyWorld(blocked)), '31 diamond(s) wanted: a deep trip');
    t.deepEqual(deep.declines!(gridSnap(10, 5001, 0), busyWorld(blocked)), { cause: 'late', text: 'deep trip needs 3 min, 2.9 left' });
    t.deepEqual(deep.declines!(gridSnap(10, 6000, 0), busyWorld(blocked)), { cause: 'late', text: 'deep trip needs 3 min, 2.1 left' });
    t.deepEqual(deep.declines!(gridSnap(10, 6800, 0), busyWorld(blocked)), { cause: 'late', text: 'time of day 6800 (deep trip sets out by 6000)' });
    // not the hour's while something else holds it: full pockets with no chest to empty them into say so at 6000 as
    // they do at 5000
    const noChest = () => { const w = busyWorld(blocked); w.landmarks.chests = []; return w; };
    t.deepEqual(deep.declines!(gridSnap(36, 5000, 0), noChest()), { cause: 'pockets', text: '36/36 slots, nothing to put away (deep trip needs 10 free)' });
    t.deepEqual(deep.declines!(gridSnap(36, 6000, 0), noChest()), deep.declines!(gridSnap(36, 5000, 0), noChest()));
    // with the chest the trip's run makes the room: full pockets set out at 5000, and at 6000 only the hour is left
    t.is(deep.wants(gridSnap(36, 5000, 0), busyWorld(blocked)), '31 diamond(s) wanted: a deep trip');
    t.deepEqual(deep.declines!(gridSnap(36, 6000, 0), busyWorld(blocked)), { cause: 'late', text: 'deep trip needs 3 min, 2.1 left' });
    // nothing it asks writes the trip down as made
    const home = busyWorld(blocked), was = JSON.stringify(home);
    for (const time of [5000, 5001, 6000, 6800]) { deep.wants(gridSnap(10, time, 0), home); deep.declines!(gridSnap(10, time, 0), home); }
    t.is(JSON.stringify(home), was);
  }
  t.log([...seen].map(([name, rec]) => `${name}: wants ${rec.wants}, declines ${[...rec.causes].sort().join(' ')}`).join('\n'));
  // every cell in which full pockets were the reason, by slots used and place (at some hour, the project blocked or not)
  t.deepEqual(Object.fromEntries([...seen].filter(([, rec]) => rec.full.size).map(([name, rec]) => [name, [...rec.full].join(' | ')])), {
    // the busy home: only 50 east, where the stash is not sent home from, and with less free than the goal's room
    // (one slot for the project and a build, three for a materials trip: the project's sand). The yard rounds are
    // too far from home there, the deep trip too; at home and in the yard the grid's logs, sand and ingots are there
    // to put away
    'busy: project': '36 50 east',
    'busy: build': '36 50 east',
    'busy: stock': '34 50 east | 35 50 east | 36 50 east',
    // the new home has no chest to put anything in: short of its room a goal waits wherever it stands (the deep trip
    // sets out from home only: no yard is drawn there yet)
    'new: project': '36 at home | 36 60 west | 36 50 east',
    'new: deep trip': '27 at home | 30 at home | 31 at home | 33 at home | 34 at home | 35 at home | 36 at home',
    'new: stock': '34 at home | 34 60 west | 34 50 east | 35 at home | 35 60 west | 35 50 east | 36 at home | 36 60 west | 36 50 east'
  });
});

test('declines() only looks: asked of the ten at any hour, at a home with work, one just begun and one with no project or job list yet, the world stays as it was', (t) => {
  const goals = gated();
  // the idle log and brain-status ask it where nothing is being decided (another goal running, the goal kept back,
  // the LLM driving, the autopilot off, the night): what a look wrote down there was written without the brain
  const homes: Record<string, (blocked: boolean) => WorldMemory> = { busy: busyWorld, new: newWorld, bare: () => ({ landmarks: { chests: [], farmland: [] }, leash: 96 }) };
  const wrote = new Map<string, string>();
  let asked = 0;
  for (const slots of SLOTS) for (const time of [...TIMES, 11_500, 14_000]) for (const blocked of [false, true]) for (const x of PLACES) {
    const s = gridSnap(slots, time, x);
    for (const [home, make] of Object.entries(homes)) for (const g of goals) {
      const world = make(blocked), who = `${g.name} at the ${home} home`;
      const before = JSON.stringify(world);
      g.declines!(s, world);
      asked++;
      if (JSON.stringify(world) === before || wrote.has(who)) continue;
      // the first cell for each goal and home says what changed
      const was = JSON.parse(before) as Record<string, unknown>, is = world as unknown as Record<string, unknown>;
      const changed = [...new Set([...Object.keys(was), ...Object.keys(is)])].filter(k => JSON.stringify(was[k]) !== JSON.stringify(is[k]));
      wrote.set(who, `${slots} slots, time ${time}, project ${blocked ? 'blocked' : 'free'}, ${placed(x)}: ${changed.map(k => `${k} ${JSON.stringify(was[k])} became ${JSON.stringify(is[k])}`).join('; ')}`.slice(0, 500));
    }
  }
  t.is(asked, 9 * 12 * 2 * 3 * 3 * 10);
  t.deepEqual([...wrote].map(([who, what]) => `${who}: ${what}`), []);

  // and there is something to write down at these homes: wants(), which the deciding brain asks, does write it (the
  // busy home has its bed, so the first milestone is found in place)
  const project = goals[0], build = goals[1];
  const busy = busyWorld(false);
  t.truthy(project.wants(gridSnap(10, 3000, 0), busy));
  t.deepEqual(busy.progress, { done: ['home'], journal: [{ at: T0, text: 'a home: a bed under a roof: already in place' }] });
  // (the build goal's job list is started by the run and by queueing a job, not by asking)
  const bare = homes.bare(false);
  t.is(project.declines!(gridSnap(10, 3000, 0), bare), null, 'the first milestone can be worked');
  t.is(build.declines!(gridSnap(10, 3000, 0), bare)?.text, 'no build job');
  t.deepEqual(Object.keys(bare).sort(), ['landmarks', 'leash']);
});

test('outside work hours none of the ten wants to run, and the hour is what it says; in another dimension none does either', (t) => {
  const goals = gated();
  t.deepEqual([activityAt(11_500), activityAt(14_000), activityAt(6000, true)], ['return', 'rest', 'rest']);
  // for each goal a cell of the grid in which it runs at the busy home; then only the hour changes, or only the dimension
  const cells = SLOTS.flatMap(slots => TIMES.flatMap(time => PLACES.map(x => gridSnap(slots, time, x))));
  const hours: Record<string, (day: Snapshot) => Partial<Snapshot>> = {
    'on the way home at dusk': () => ({ timeOfDay: 11_500, activity: activityAt(11_500) }),
    'at night': () => ({ timeOfDay: 14_000, activity: activityAt(14_000) }),
    'in a thunderstorm by day': day => ({ thundering: true, activity: activityAt(day.timeOfDay, true) }),
    'asleep': () => ({ sleeping: true })
  };
  const bad: string[] = [];
  for (const g of goals) {
    const day = cells.find(s => g.wants(s, busyWorld(false)) !== null);
    if (!day) { bad.push(`${g.name}: no cell of the grid in which it runs`); continue; }
    for (const [when, change] of Object.entries(hours)) {
      const s = { ...day, ...change(day) };
      const want = g.wants(s, busyWorld(false)), no = g.declines!(s, busyWorld(false));
      if (want !== null || no?.cause !== 'late') bad.push(`${g.name} ${when}: wants ${JSON.stringify(want)}, declines ${JSON.stringify(no)}`);
    }
    const nether = { ...day, dimension: 'the_nether', distHome: Infinity };
    const want = g.wants(nether, busyWorld(false)), no = g.declines!(nether, busyWorld(false));
    if (want !== null || no?.cause !== 'away') bad.push(`${g.name} in the nether: wants ${JSON.stringify(want)}, declines ${JSON.stringify(no)}`);
  }
  t.deepEqual(bad, []);
});

test('a decline names its numbers, and the hour is the reason only for a goal nothing else holds', (t) => {
  const project = projectGoal(TREE);
  // one slot free and the round wants two: at the busy home its run puts the logs and sand away first; with no chest
  // to put them in the pockets are the reason, and the line says what is missing
  t.is(caneRound.wants(gridSnap(35, 3000, 0), busyWorld(false)), 'daily round: the sugar cane');
  const noChest = busyWorld(false);
  noChest.landmarks.chests = [];
  t.deepEqual(caneRound.declines!(gridSnap(35, 3000, 0), noChest), { cause: 'pockets', text: '35/36 slots, nothing to put away (cane needs 2 free)' });
  t.deepEqual(project.declines!(gridSnap(10, 3000, 0), busyWorld(true)), { cause: 'project', text: 'short of 98 sugar_cane, 38 leather', until: T0 + 10 * MIN });
  // 2000 ticks of day left, the project needs 2400
  t.deepEqual(project.declines!(gridSnap(10, 9000, 0), busyWorld(false)), { cause: 'late', text: '1.7 min of daylight left (project needs 2.0)' });
  // blocked, or full where the chests are out of reach, at that hour: that is the reason, not the hour (the morning
  // would not help). Full at home is the hour's: in the morning the run would put the logs away and go on
  t.is(project.declines!(gridSnap(10, 9000, 0), busyWorld(true))?.cause, 'project');
  t.deepEqual(project.declines!(gridSnap(36, 9000, 50), busyWorld(false)), { cause: 'pockets', text: '36/36 slots, the chests out of reach (project needs 1 free)' });
  t.deepEqual(project.declines!(gridSnap(36, 9000, 0), busyWorld(false)), { cause: 'late', text: '1.7 min of daylight left (project needs 2.0)' });
  // stock is short of logs and coal here: with pockets full of sand 50 out that is what stops it, at any hour; with
  // room, or at home where the sand can go in the chest, the hour
  t.is(stock.wants(gridSnap(10, 3000, 0, ['sand']), busyWorld(false)), 'short of 32 log, 16 coal');
  t.deepEqual(stock.declines!(gridSnap(36, 9800, 50, ['sand']), busyWorld(false)), { cause: 'pockets', text: '36/36 slots, the chests out of reach (stock needs 3 free)' });
  t.is(stock.wants(gridSnap(36, 3000, 0, ['sand']), busyWorld(false)), 'short of 32 log, 16 coal');
  t.deepEqual(stock.declines!(gridSnap(36, 9800, 0, ['sand']), busyWorld(false)), { cause: 'late', text: '1.0 min of daylight left (stock needs 2.5)' });
  t.deepEqual(stock.declines!(gridSnap(10, 9800, 0, ['sand']), busyWorld(false)), { cause: 'late', text: '1.0 min of daylight left (stock needs 2.5)' });
  // and with the logs and the coal in its pockets (the grid's filler) there is nothing to fetch
  t.deepEqual(stock.declines!(gridSnap(36, 9800, 0), busyWorld(false)), { cause: 'stocked', text: 'nothing short' });
  // by night nobody works: said as the hour too
  t.deepEqual(caneRound.declines!(gridSnap(10, 14_000, 0), busyWorld(false)), { cause: 'late', text: 'not work time (rest)' });
  t.deepEqual(caneRound.declines!({ ...gridSnap(10, 3000, 0), sleeping: true }, busyWorld(false)), { cause: 'late', text: 'asleep' });
  // a round that ran a quarter of an hour ago: when it is due again
  const ran = busyWorld(false);
  ran.lastDone!.cane = T0 - 15 * MIN;
  t.deepEqual(caneRound.declines!(gridSnap(10, 3000, 0), ran), { cause: 'unneeded', text: 'cane is not due for 5 min (every 20)', until: T0 + 5 * MIN });
  t.deepEqual(caneRound.declines!(gridSnap(10, 3000, 50), busyWorld(false)), { cause: 'away', text: '50 blocks from home (cane works within 24)' });
});

test('stock with the kit whole and the chests looked in: nothing short; a chest not looked in yet is the kit\'s to see to', (t) => {
  const gear = ['stone_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_sword', 'stone_hoe']
    .map((name, slot): InventoryItem => ({ slot, name, count: 1, damage: 0, maxDamage: 131 }))
    .concat([{ slot: 10, name: 'torch', count: 20 }, { slot: 11, name: 'cobblestone', count: 40 }, { slot: 12, name: 'bread', count: 5 }], ARMOUR);
  const world: WorldMemory = {
    landmarks: { chests: [{ x: 1, y: 64, z: 1 }], farmland: [] }, leash: 96,
    chestItems: { '1,64,1': { oak_log: 40, coal: 20, iron_ingot: 20, cobblestone: 64 } }
  };
  t.is(stock.wants(snapOf(gear), world), null);
  t.deepEqual(stock.declines!(snapOf(gear), world), { cause: 'stocked', text: 'nothing short' });
  const unseen: WorldMemory = { landmarks: { chests: [{ x: 1, y: 64, z: 1 }], farmland: [] }, leash: 96 };
  t.deepEqual(stock.declines!(snapOf(gear), unseen), { cause: 'kit', text: '1 home chest(s) not looked in yet' });
});

// ---- what a run achieved ----

test('blocksWorked: what a tool\'s report says it placed, dug, tilled or leveled; nothing for a walk, a look or a failure', (t) => {
  t.is(blocksWorked('place-block', 'Placed cobblestone at (1, 64, 2) using down face'), 1);
  t.is(blocksWorked('place-block', "There's already a block (stone) at (1, 64, 2)"), 0);
  t.is(blocksWorked('dig-block', 'Dug dirt at (1, 64, 2)'), 1);
  t.is(blocksWorked('dig-block', 'No block at (1, 64, 2)'), 0);
  t.is(blocksWorked('use-item-on-block', 'Used stone_hoe on grass_block at (3, 63, 4): it is now farmland[moisture=0]'), 1);
  t.is(blocksWorked('use-item-on-block', 'Used the held item on oak_fence_gate[open=false] at (3, 64, 4): it is now oak_fence_gate[open=true]'), 0);
  // the blocks, not the tool that broke on the way
  t.is(blocksWorked('build-structure', 'Built 15 of 15 blocks. Used: oak_planks x12, cobblestone x3; wore out: stone_axe x1.'), 15);
  t.is(blocksWorked('build-structure', 'Could not reach the site'), 0);
  const plan = 'Level (0, 0)..(8, 8) to ground y 63: cut 20 block(s) (dirt 14, stone 6), fill 5 dirt + 3 cobblestone; left alone: 0 water column(s), 0 column(s) with builds, crops or furniture.';
  t.is(blocksWorked('level-area', `${plan}\nWorked 1/1 tile(s) of 9x9 in 40s. Still to do: cut 4, fill 2 dirt (have 9) + 0 cobblestone (have 30). Run level-area again to continue.`), 22);
  t.is(blocksWorked('level-area', `${plan}\nWorked 1/1 tile(s) of 9x9 in 55s. Now level.`), 28);
  t.is(blocksWorked('level-area', plan), 0, 'a dry run');
  t.is(blocksWorked('level-area', plan.replace('cut 20 block(s) (dirt 14, stone 6), fill 5 dirt + 3', 'cut 0 block(s), fill 0 dirt + 0') + ' Already level.'), 0);
  t.is(blocksWorked('move-to-position', 'Placed nothing, walked to (1, 64, 2)'), 0);
});

interface State { pos: { x: number; y: number; z: number }; time: number }

/**
 * A bot in the world `seed:1` with a home at (0, 64, 0), carrying `items`. The `slow` tool returns when the test says
 * `finish`; any other tool is noted in `acts` and does nothing.
 */
function fakeRuntime(state: State, items: InventoryItem[] = []) {
  const acts: string[] = [];
  const region = new Array(25 * 11 * 25).fill('air');
  let release: (() => void) | undefined;
  const slow = async () => { await new Promise<void>(r => { release = r; }); await rt.call('status'); return reply('slow done'); };
  const rt: ClientRuntime = {
    actions: new Proxy({ slow } as ClientRuntime['actions'], {
      get: (known, tool: string) => known[tool] ?? (async () => { acts.push(tool); return reply(`${tool}: nothing`); })
    }),
    call: (async (method: string) => {
      if (brainRun.getStore()?.signal.aborted) throw new Error('aborted: the brain gave this job up');
      if (method === 'inventory') return { items };
      if (method === 'world.region') return { blocks: region };
      if (method === 'cancel') { release?.(); return {}; }
      return {};
    }) as ClientRuntime['call'],
    status: async () => ({ inWorld: true, username: 'Bot', screen: null, position: state.pos, block: state.pos, timeOfDay: state.time, hashedSeed: '1',
      dimension: 'overworld', sleeping: false, thundering: false, process: null, health: 20, food: 20 }),
    home: () => ({ ...HOME, dimension: 'overworld' }),
    lastDeath: () => undefined,
    setManualHook: () => undefined,
    builtNear: () => [],
    setHomeZone: () => undefined,
    restoreBlock: async () => undefined, adoptStates: () => undefined, protectBuilt: () => undefined
  };
  return { rt, acts, finish: () => release?.() };
}

/** Today's tally as the brain keeps it. */
const today = (brain: Brain) => idleOf(brain.worldMemory()!).today;
/** The line of brain-status that starts so. */
const statusLine = (brain: Brain, start: string) => brain.status().split('\n').find(l => l.startsWith(start));

/**
 * One run of a goal as the brain books it: the goal's own run() on the test's fakes (`inner`), reporting its gain to
 * the brain's run. The run is kept under way over a tick 5 s on (a run over within the tick that began it used no
 * time), so the 5 s are booked: empty when it reported no gain, busy when it did. It wants that one run only: the
 * brain looks again the moment a run is over (the hand-over), and a second run would be under way, its books open,
 * when these are read.
 */
async function booked(goal: Goal, inner: Partial<GoalContext>) {
  const { rt, finish } = fakeRuntime({ pos: HOME, time: 6000 });
  let clock = T0, text: string | undefined, threw: unknown, began = false;
  let ran!: () => void;
  const over = new Promise<void>(r => { ran = r; });
  const wrapped: Goal = {
    name: goal.name, priority: goal.priority, wants: () => (began ? null : 'test'), timeoutMs: 600_000, retryMs: 1000,
    ...(goal.gains ? { gains: true as const } : {}),
    run: async (ctx) => {
      began = true;
      try { text = await goal.run({ ...ctx, ...inner, gain: ctx.gain }); } catch (e) { threw = e; } finally { ran(); }
      await ctx.act('slow');
      return text ?? '';
    }
  };
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => clock, goals: [wrapped] });
  brain.setEnabled(true);
  await brain.tick();
  await over; await settle();
  clock += 5000; await brain.tick(); await settle();
  finish(); await settle();
  const day = today(brain);
  const run = (brain as unknown as { loops: { runs: Run[] } }).loops.runs.at(-1);
  brain.setEnabled(false);
  if (threw) throw threw;
  return { text, gain: run?.gain, emptyMs: day.emptyMs, day };
}

/** The 5 s of a run as the day's tally has them. */
const EMPTY = { day: 0, workMs: 5000, idleMs: 0, emptyMs: 5000, by: {} };
const BUSY = { day: 0, workMs: 5000, idleMs: 0, emptyMs: 0, by: {} };
const bareWorld = (over: Partial<WorldMemory> = {}): WorldMemory => ({ landmarks: { chests: [], farmland: [] }, leash: 96, ...over });
const quiet = { progress: () => undefined, status: async () => ({ inWorld: true, username: 'b', screen: null }) };

test('a gains goal with no gain is booked empty: the project (a block laid, a step done; a step that is short of something)', async (t) => {
  const wall = (run: Step['run'], more: Step[] = []): Milestone[] => [{ id: 'wall', title: 'garden wall', prereqs: [], steps: [{ name: 'lay', run }, ...more] }];
  const placing = { ...quiet, s: snapOf([]), call: (async () => ({})) as GoalContext['call'], act: async () => ({ ok: true, text: 'Placed cobblestone at (1, 64, 1) using down face' }) };
  t.is(projectGoal(wall(async () => ({ status: 'done', text: '' }))).gains, true);

  // a step not done yet: the blocks its tools say they placed
  const laid = await booked(projectGoal(wall(async (ctx) => {
    await ctx.act('place-block', { x: 1, y: 64, z: 1 });
    await ctx.act('place-block', { x: 2, y: 64, z: 1 });
    await ctx.act('move-to-position', { x: 3, y: 64, z: 1 });
    return { status: 'progress', text: '2/8 laid' };
  })), { ...placing, world: bareWorld() });
  t.deepEqual([laid.text, laid.gain, laid.day], ['garden wall - lay: 2/8 laid', 2, BUSY]);

  // a step done with nothing placed (a site found) is a step on
  const sited = await booked(projectGoal(wall(async () => ({ status: 'done', text: 'site at (5, 64, 5)' }), [{ name: 'cap', run: async () => ({ status: 'done', text: '' }) }])),
    { ...placing, world: bareWorld() });
  t.deepEqual([sited.text, sited.gain, sited.day], ['garden wall - lay: site at (5, 64, 5)', 1, BUSY]);

  // short of something: it looked and went home
  const world = bareWorld();
  const short = await booked(projectGoal(wall(async () => ({ status: 'blocked', text: 'short of 8 cobblestone' }))), { ...placing, world });
  t.deepEqual([short.text, short.gain, short.day], ['garden wall - lay: short of 8 cobblestone', undefined, EMPTY]);
  t.is(world.progress?.blockedUntil?.wall, T0 + 10 * MIN, 'and the run did what it does');
});

test('a gains goal with no gain is booked empty: the pens (one culled; nothing in the pen and none to lure)', async (t) => {
  t.is(pens.gains, true);
  const round = (herd: number) => {
    // a 7 x 7 pen from (10, 64, 10) with `herd` cows in it; six is a full pen
    let cows = Array.from({ length: herd }, (_, i) => ({ id: i + 1, name: 'cow', category: 'creature', distance: 12 + i, position: { x: 10.5 + i, y: 64, z: 12.5 } }));
    return booked(pens, {
      ...quiet, s: snapOf([]), world: bareWorld({ zones: { 'pen:cow': [{ x: 10, y: 64, z: 10, width: 7, length: 7 }] } }),
      call: (async (method: string) => (method === 'world.entities' ? { entities: cows } : { items: [] })) as GoalContext['call'],
      act: async (tool: string, args: Record<string, unknown> = {}) => {
        if (tool !== 'attack-entity') return { ok: false, text: `unexpected ${tool}` };
        cows = cows.filter(c => `#${c.id}` !== args.target);
        return { ok: true, text: 'Killed cow' };
      }
    });
  };
  const culled = await round(7);
  t.deepEqual([culled.text, culled.gain, culled.day], ['cow: culled one (Killed cow); cow: the pen is full (6 adults, 0 babies)', 1, BUSY]);
  const none = await round(0);
  t.deepEqual([none.text, none.gain, none.day], ['cow: 0 cow in the pen and none within 32 to lure; 0 cow ready to breed', undefined, EMPTY]);
});

test('a gains goal with no gain is booked empty: the cane (a stalk cut; bare cells and no cane to plant)', async (t) => {
  t.is(caneRound.gains, true);
  const round = (grown: boolean) => {
    const grid = new Map<string, string>(grown ? [['0,63,0', 'sugar_cane'], ['0,64,0', 'sugar_cane']] : []);
    let cane = 0;
    return booked(caneRound, {
      ...quiet, s: snapOf([]), world: bareWorld({ zones: { cane: [{ x: 0, y: 63, z: 0 }] }, lastDone: {} }),
      call: (async (method: string, a: { x: number; y: number; z: number }) => (method === 'inventory'
        ? { items: cane ? [{ slot: 3, name: 'sugar_cane', count: cane }] : [] }
        : { blocks: [0, 1, 2].map(dy => grid.get(`${a.x},${a.y + dy},${a.z}`) ?? 'air') })) as GoalContext['call'],
      act: async (tool: string, a: Record<string, unknown> = {}) => {
        const k = `${a.x},${a.y},${a.z}`;
        if (tool !== 'dig-block' || !grid.has(k)) return { ok: false, text: `unexpected ${tool} at ${k}` };
        grid.delete(k); cane++;
        return { ok: true, text: `Dug sugar_cane at (${k})` };
      }
    });
  };
  const cut = await round(true);
  t.deepEqual([cut.text, cut.gain, cut.day], ['cut 1 stalk(s) (1 cane)', 1, BUSY]);
  const bare = await round(false);
  t.deepEqual([bare.text, bare.gain, bare.day], ['cut 0 stalk(s) (0 cane)', undefined, EMPTY]);
});

test('a gains goal with no gain is booked empty: the tree farm (a log cut, a sapling set; saplings still growing)', async (t) => {
  t.is(treeFarm.gains, true);
  const round = (grown: boolean) => {
    // a 5 x 5 plot from (0, 62, 0), grass at y 62, the sapling cell at (2, 63, 2): a one-log tree on it, or a sapling
    const blocks = new Map<string, string>();
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) blocks.set(`${x},62,${z}`, 'minecraft:grass_block');
    blocks.set('2,63,2', grown ? 'minecraft:oak_log[axis=y]' : 'minecraft:oak_sapling[stage=0]');
    const read = (b: { x: number; y: number; z: number; width: number; height: number; length: number }) => {
      const out: string[] = [];
      for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) out.push(blocks.get(`${b.x + x},${b.y + y},${b.z + z}`) ?? 'minecraft:air');
      return out;
    };
    return booked(treeFarm, {
      ...quiet, s: snapOf([], { position: { x: 2, y: 63, z: 4 } }),
      world: bareWorld({ zones: { trees: [{ x: 0, y: 62, z: 0, width: 5, length: 5 }], 'trees:sapling': [{ x: 2, y: 63, z: 2 }] } }),
      call: (async (method: string, p: Record<string, number> = {}) => {
        if (method === 'world.region') return { blocks: read(p as Parameters<typeof read>[0]) };
        if (method === 'dig.here') return blocks.delete(`${p.x},${p.y},${p.z}`) ? { dug: true } : { dug: false, reason: 'air' };
        if (method === 'goto') return { arrived: true, at: { x: p.x, y: p.y, z: p.z } };
        if (method === 'inventory') return { items: [{ slot: 1, name: 'oak_sapling', count: 4 }] };
        return {};
      }) as GoalContext['call'],
      act: async (tool: string, a: Record<string, unknown> = {}) => {
        if (tool === 'place-block') { blocks.set(`${a.x},${a.y},${a.z}`, 'minecraft:oak_sapling[stage=0]'); return { ok: true, text: 'Placed oak_sapling' }; }
        return { ok: true, text: 'ok' };
      }
    });
  };
  const cut = await round(true);
  t.deepEqual([cut.text, cut.gain, cut.day], ['cut 1 log(s); cleared 0 scaffold block(s); planted 1 sapling(s)', 2, BUSY]);
  const growing = await round(false);
  t.deepEqual([growing.text, growing.gain, growing.day], ['cut 0 log(s); cleared 0 scaffold block(s); planted 0 sapling(s)', undefined, EMPTY]);
});

test('a gains goal with no gain is booked empty: the lights (a torch placed; the yard already lit)', async (t) => {
  t.is(lights.gains, true);
  const round = (lit: boolean) => {
    // a 5 x 5 yard on dirt at y 60: the round reads 7 x 13 x 7 from (-3, 57, -3). A torch lights 14 less a level a block
    const torches: { x: number; y: number; z: number }[] = [];
    const cells = <T>(b: { x: number; y: number; z: number; width: number; height: number; length: number }, at: (x: number, y: number, z: number) => T) => {
      const out: T[] = [];
      for (let y = 0; y < b.height; y++) for (let z = 0; z < b.length; z++) for (let x = 0; x < b.width; x++) out.push(at(b.x + x, b.y + y, b.z + z));
      return out;
    };
    return booked(lights, {
      ...quiet, s: snapOf([{ slot: 0, name: 'torch', count: 4 }]), world: bareWorld({ yard: { x1: -2, z1: -2, x2: 2, z2: 2, y: 60 } }),
      call: (async (method: string, b: Parameters<typeof cells>[0]) => (method === 'world.region'
        ? { blocks: cells(b, (x, y, z) => (torches.some(p => p.x === x && p.y === y && p.z === z) ? 'torch' : y <= 60 ? 'dirt' : 'air')) }
        : { block: cells(b, (x, y, z) => (lit ? 15 : Math.max(0, ...torches.map(p => 14 - Math.abs(p.x - x) - Math.abs(p.y - y) - Math.abs(p.z - z))))) })) as GoalContext['call'],
      act: async (tool: string, a: Record<string, unknown> = {}) => {
        if (tool !== 'place-block') return { ok: false, text: `unexpected ${tool}` };
        torches.push({ x: Number(a.x), y: Number(a.y), z: Number(a.z) });
        return { ok: true, text: `Placed torch at (${a.x}, ${a.y}, ${a.z})` };
      }
    });
  };
  const dark = await round(false);
  t.deepEqual([dark.text, dark.gain, dark.day], ['yard: placed 1 torch(es); 0 of 25 dark spot(s) left', 1, BUSY]);
  const lit = await round(true);
  t.deepEqual([lit.text, lit.gain, lit.day], ['the yard is lit', undefined, EMPTY]);
});

test('a gains goal with no gain is booked empty: the repair round (a block put back; none missing)', async (t) => {
  const round = (standing: string) => {
    const rt = { builtNear: () => [{ at: { x: 2, y: 64, z: 0 }, state: 'cobblestone' }], restoreBlock: async () => undefined, adoptStates: () => undefined } as unknown as ClientRuntime;
    const goal = repairGoal(rt);
    t.is(goal.gains, true);
    return booked(goal, {
      ...quiet, s: snapOf([]), world: bareWorld(),
      call: (async (method: string) => (method === 'inventory' ? { items: [{ slot: 0, name: 'cobblestone', count: 5 }] } : { blocks: [standing] })) as GoalContext['call'],
      act: async (tool: string) => ({ ok: false, text: `unexpected ${tool}` })
    });
  };
  const gone = await round('air');
  t.deepEqual([gone.text, gone.gain, gone.day], ['put back 1/1 missing block(s)', 1, BUSY]);
  const whole = await round('cobblestone');
  t.deepEqual([whole.text, whole.gain, whole.day], ['all 1 built blocks checked, none missing', undefined, EMPTY]);
});

// ---- the whole brain ----

/** Pockets with the kit whole (so nothing is crafted), then cobblestone. */
function kitted(slots: number): InventoryItem[] {
  const kit = ['iron_pickaxe', 'iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_sword', 'iron_hoe', 'shield', 'torch', 'bread', 'cobblestone', 'oak_log', 'coal', 'water_bucket'];
  return Array.from({ length: slots }, (_, slot): InventoryItem => {
    const name = kit[slot] ?? 'cobblestone';
    return { slot, name, count: /pickaxe|axe|shovel|sword|hoe|shield|bucket/.test(name) ? 1 : 64 };
  }).concat(ARMOUR);
}

/** A home with no chest (so nothing to put away into) and the day's rounds done just now. */
const restedWorld = (blocked: boolean): WorldMemory => ({
  landmarks: { chests: [], farmland: [], foundAt: T0 }, leash: 96,
  lastDone: Object.fromEntries(['stash', 'tidy', 'sort', 'repair', 'lights', 'furnace', 'farm', 'structures', 'storage', 'signs', 'project'].map(k => [k, T0])),
  progress: projectAt(blocked)
});

test('the real goal list, pockets 36/36 and the project blocked, by day: brain-status says what it idles on', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gates-')), 'brain.json');
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': restedWorld(true) }));
  const { rt, acts } = fakeRuntime({ pos: HOME, time: 3000 }, kitted(36));
  let clock = T0;
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => clock, memoryFile: file });
  brain.setEnabled(true);
  await brain.tick(); await settle();
  for (let i = 0; i < 3; i++) { clock += 5000; await brain.tick(); await settle(); }

  t.deepEqual(acts, [], 'nothing ran');
  // the work queue's rungs are said first: the deep rung, with its kit ready and nothing stored, is what full pockets keep at home
  t.is(statusLine(brain, 'Now:'), 'Now: idle (pockets): 36/36 slots, nothing to put away (deep needs 10 free).');
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: project - short of 98 sugar_cane, 38 leather');
  t.deepEqual(today(brain), { day: 0, workMs: 15_000, idleMs: 15_000, emptyMs: 0, by: { pockets: 15_000 } });
  const lines = brain.status().split('\n');
  t.true(lines.includes('- 14:00:15 idle 15s: pockets: 36/36 slots, nothing to put away (deep needs 10 free) | project: short of 98 sugar_cane, 38 leather | stocked: 320 food points at home (keep 60)'), lines.join('\n'));
  brain.setEnabled(false);
});

/** Food the stash leaves carried: one kind a slot, each under the stack it keeps of a kind. */
const MEALS = ['bread', 'apple', 'cooked_porkchop', 'cooked_cod', 'cooked_salmon', 'cookie', 'melon_slice', 'dried_kelp', 'cooked_beef', 'cooked_chicken', 'carrot',
  'baked_potato', 'pumpkin_pie', 'cooked_rabbit', 'cooked_mutton', 'beetroot', 'sweet_berries', 'glow_berries', 'porkchop', 'cod', 'salmon', 'beef', 'chicken',
  'potato', 'rabbit', 'mutton', 'tropical_fish', 'honey_bottle'];

/**
 * Pockets the stash leaves as they are: the kit, a stack each of torches, cobblestone and dirt, then food. With
 * `loose`, that many stacks of bones after the kit (all there is for the chests).
 */
function keptOnly(slots: number, loose = 0): InventoryItem[] {
  const names = ['iron_pickaxe', 'iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_sword', 'iron_hoe', 'shield', 'torch', 'cobblestone', 'water_bucket', 'dirt',
    ...Array.from({ length: loose }, () => 'bone'), ...MEALS];
  return names.slice(0, slots).map((name, slot): InventoryItem => (
    { slot, name, count: /pickaxe|axe|shovel|sword|hoe|shield|bucket/.test(name) ? 1 : MEALS.includes(name) && name !== 'bread' ? 8 : 64 }
  )).concat(ARMOUR);
}

/** The rested home with what the stash needs: a chest (looked in, empty) and the yard round it. */
const settledWorld = (blocked: boolean): WorldMemory => ({
  ...restedWorld(blocked), landmarks: { chests: [{ x: 1, y: 64, z: 1 }], farmland: [], foundAt: T0 }, chestItems: { '1,64,1': {} }, yard: { ...YARD }
});

test('the real goal list over the grid: wherever no goal is chosen, one of them says why; where that is the pockets, the stash could not have made the room', (t) => {
  const goals = (new Brain(fakeRuntime({ pos: HOME, time: 6000 }).rt, { tickMs: 1e9, now: () => T0 }) as unknown as { goals: Goal[] }).goals;
  const homes: Record<string, (blocked: boolean) => WorldMemory> = { 'no chest': restedWorld, 'a chest and a yard': settledWorld };
  // cobblestone by the stack (all of it for the chests), nothing for the chests, and six stacks for them
  const fillings: Record<string, (slots: number) => InventoryItem[]> = { 'cobblestone': kitted, 'kept things only': keptOnly, 'six stacks to put away': slots => keptOnly(slots, 6) };
  const unsaid: string[] = [], bad: string[] = [], tally: string[] = [];
  /** the cells idle for the pockets: who says so and how many cells (hours, project blocked or not), by home, pockets and place */
  const full = new Map<string, { who: Set<string>; cells: number }>();
  /** the same cells by home and pockets alone, to pin below */
  const led = new Map<string, Set<string>>();
  let all = 0, chosenAll = 0;
  for (const [home, make] of Object.entries(homes)) for (const [filling, fill] of Object.entries(fillings)) {
    const lead = new Map<string, number>();
    let chosen = 0, cells = 0;
    for (const slots of SLOTS) for (const time of TIMES) for (const blocked of [false, true]) for (const x of PLACES) {
      cells++;
      const s = snapOf(fill(slots), { timeOfDay: time, activity: activityAt(time), position: { x, y: 64, z: 0 }, distHome: Math.abs(x) });
      if (decide(s, make(blocked), goals, new Map())) { chosen++; continue; }
      const why = explainIdle(s, make(blocked), goals, new Map(), new Map());
      lead.set(why[0].cause, (lead.get(why[0].cause) ?? 0) + 1);
      const cell = `${home}, ${filling}, ${slots} slots, time ${time}, project ${blocked ? 'blocked' : 'free'}, ${placed(x)}`;
      if (why[0].cause === 'nothing') unsaid.push(cell);
      if (why[0].cause !== 'pockets') continue;
      // who says the pockets, and do the pockets bear it out: short of that goal's room, and the chests out of reach
      // (none, or the bot outside the yard and over 40 from home) or too little in the pockets for them
      const w = make(blocked);
      const reach = w.landmarks.chests.length > 0 && (Math.abs(x) <= 40 || (!!w.yard && x >= w.yard.x1 && x <= w.yard.x2));
      const rec = full.get(`${home}, ${filling}, ${slots}/36 ${placed(x)}`) ?? { who: new Set<string>(), cells: 0 };
      full.set(`${home}, ${filling}, ${slots}/36 ${placed(x)}`, rec);
      rec.cells++;
      led.set(`${home}, ${filling}`, (led.get(`${home}, ${filling}`) ?? new Set<string>()).add(`${slots} ${placed(x)}`));
      for (const g of goals) {
        const no = g.declines?.(s, make(blocked));
        if (no?.cause !== 'pockets') continue;
        const kind = KIND[g.name] ?? WORK_KIND[g.name];
        if (!kind) { bad.push(`${cell}: ${g.name} says ${no.text}, and has no room of its own in the rule`); continue; }
        const p = pockets(s, w, kind);
        rec.who.add(`${g.name} (needs ${ROOM[kind]}, ${p.loose} to put away${reach ? '' : ', chests out of reach'})`);
        if (room(kind, s, w) !== 'no' || !(p.free < ROOM[kind] && (!reach || p.free + p.loose < ROOM[kind]))) {
          bad.push(`${cell}: ${g.name} says ${no.text} with ${p.free} free and ${p.loose} to put away, the chests ${reach ? 'in' : 'out of'} reach`);
        }
        // the rule lets a goal wait with something to put away where that is still too little for it (ten free for
        // the mine out of two free and six to put away). No cell here stands idle on that: the stash goes first
        if (reach && p.loose) bad.push(`${cell}: ${g.name} says ${no.text}, idle with ${p.loose} slot(s) the stash could empty`);
      }
      if (!rec.who.size) bad.push(`${cell}: idle for the pockets, and no goal says so`);
    }
    all += cells; chosenAll += chosen;
    tally.push(`${home}, ${filling}: a goal chosen in ${chosen} of ${cells} cells; idle put down to ${[...lead].map(([c, n]) => `${c} ${n}`).join(', ') || 'nothing'}`);
  }
  t.deepEqual(unsaid, []);
  t.deepEqual(bad.slice(0, 20), []);
  t.is(all, 6 * 540);
  t.true(chosenAll > 0 && chosenAll < all, `a goal chosen in ${chosenAll} of ${all} cells`);
  t.log(tally.join('\n'));
  t.log([...full].map(([where, rec]) => `${where}: ${rec.cells} cell(s): ${[...rec.who].join('; ')}`).join('\n'));
  // every cell idle for the pockets (at some hour, the project blocked or not): at home only (out in the yard and
  // beyond it the bot is walked back first), and only with no chest to put anything in or with nothing in the pockets
  // for one. From 27 used the mine's ten are short, from 34 a materials trip's three, at 36 the project's one. With a
  // chest and anything at all to put away (cobblestone by the stack, six stacks of bones) no cell is idle for them
  const AT_HOME = [27, 30, 31, 33, 34, 35, 36].map(n => `${n} at home`).join(' | ');
  t.deepEqual(Object.fromEntries([...led].map(([where, cells]) => [where, [...cells].join(' | ')])), {
    'no chest, cobblestone': AT_HOME,
    'no chest, kept things only': AT_HOME,
    'no chest, six stacks to put away': AT_HOME,
    'a chest and a yard, kept things only': AT_HOME
  });
});

// ---- the one slot rule, goal by goal ----

test('the one slot rule, goal by goal: with its room free a goal wants; short of it, it wants where the stash can make the room, and where it cannot it says which of the two is missing', (t) => {
  // brain.log 2026-11-08..10: 294.7 idle minutes with the pockets at 34-36 slots. Each goal had a limit of its own
  // (the cane and the pens ran under 34 used, the trees and a materials trip under 33, the project under 35, the mine
  // with ten free) and none of them made room: they waited for a stash that started at 33, once in ten minutes
  const goals = new Map(gated().map(g => [g.name, g]));
  /** the free slots each sets out with (written out here, not read from the rule) */
  const table: [name: string, kind: RoomKind, needs: number][] = [
    ['project', 'project', 1], ['build', 'project', 1], ['stock', 'trip', 3], ['cane', 'yard', 2], ['pens', 'yard', 2], ['trees', 'yard', 2], ['deep trip', 'deep', 10]
  ];
  t.deepEqual(table.map(([name, kind]) => [name, kind]), Object.entries(KIND).sort((a, b) => table.findIndex(r => r[0] === a[0]) - table.findIndex(r => r[0] === b[0])));
  // the busy home as it is (a chest, the yard 64 long to the west), with no yard drawn (40 from home is the reach
  // then), and with no chest
  const homes: Record<string, () => WorldMemory> = {
    'a chest and a yard': () => busyWorld(false),
    'a chest, no yard': () => { const w = busyWorld(false); delete w.yard; return w; },
    'no chest': () => { const w = busyWorld(false); w.landmarks.chests = []; return w; }
  };
  const bad: string[] = [];
  const seen = { 'room free': 0, 'the stash makes it': 0, 'nothing to put away': 0, 'too few to put away': 0, 'the chests out of reach': 0, away: 0 };
  for (const [home, make] of Object.entries(homes)) for (const used of [26, 30, 33, 34, 35, 36]) for (const loose of [0, 1, 2, 3, 6, 10]) for (const x of [0, -20, -40, -60, 50]) {
    // by 3000 of the day: the hour holds none of them
    const s = snapOf(keptOnly(used, loose), { timeOfDay: 3000, activity: activityAt(3000), position: { x, y: 64, z: 0 }, distHome: Math.abs(x) });
    for (const [name, kind, needs] of table) {
      const g = goals.get(name)!;
      const w = make();
      const say = (what: string) => bad.push(`${name} at the home with ${home}, ${used}/36 of which ${loose} to put away, ${placed(x)}: ${what}`);
      if (ROOM[kind] !== needs) say(`the rule gives it ${ROOM[kind]}`);
      const chests = w.landmarks.chests.length > 0;
      // the pockets as the test packed them: `loose` stacks of bones are all the stash would move, whatever the goal
      if (chests && pockets(s, w, kind).loose !== loose) say(`the test's pockets: ${pockets(s, w, kind).loose} to put away`);
      const near = Math.abs(x) <= 40 || (!!w.yard && x >= w.yard.x1 && x <= w.yard.x2);
      const want = g.wants(s, w), no = g.declines!(s, make());
      // what a gate asks before the pockets: a round in the yard runs within 24 of home, the mine is set out for
      // from the yard or within 40 of home
      if ((kind === 'yard' && Math.abs(x) > 24) || (kind === 'deep' && !near)) {
        seen.away++;
        if (want !== null || no?.cause !== 'away') say(`wants ${JSON.stringify(want)}, declines ${JSON.stringify(no)}; it is too far out`);
        continue;
      }
      const free = 36 - used, reach = chests && near;
      // with no chest there is nothing the stash could do with the bones
      const put = chests ? loose : 0;
      if (free >= needs || (reach && free + put >= needs)) {
        seen[free >= needs ? 'room free' : 'the stash makes it']++;
        if (want === null || no !== null) say(`wants ${JSON.stringify(want)}, declines ${JSON.stringify(no)}; ${free} free and ${reach ? put : 0} more from the stash is its room`);
        continue;
      }
      // three ways to be short, each said as what it is: the chests too far, some to put away but too few, none at all
      const lack = !reach && free + put >= needs ? 'the chests out of reach' : put > 0 ? 'too few to put away' : 'nothing to put away';
      seen[lack]++;
      const text = `${used}/36 slots, ${lack === 'too few to put away' ? `only ${put} more to put away` : lack} (${name} needs ${needs} free)`;
      if (want !== null || JSON.stringify(no) !== JSON.stringify({ cause: 'pockets', text })) say(`wants ${JSON.stringify(want)}, declines ${JSON.stringify(no)}; expected ${text}`);
    }
  }
  t.deepEqual(bad.slice(0, 20), []);
  t.log(Object.entries(seen).map(([k, n]) => `${k}: ${n}`).join(', '));
  for (const [k, n] of Object.entries(seen)) t.true(n > 0, `${k}: in no cell`);
  t.is(Object.values(seen).reduce((a, n) => a + n, 0), 3 * 6 * 6 * 5 * 7);
});

/**
 * A project of two: A is in place once `flag.inPlace` says so (a zone registered while something else ran), B comes
 * after it. Their steps are short of something for an hour; with `fail` A's step throws, and the brain keeps the
 * project back.
 */
const twoMilestones = (flag: { inPlace: boolean }, fail = false): Milestone[] => {
  const short: Step['run'] = async () => ({ status: 'blocked', text: 'short of something', retryMs: 60 * MIN });
  return [
    { id: 'a', title: 'A', prereqs: [], done: () => flag.inPlace, steps: [{ name: 'work', run: fail ? async () => { throw new Error('the step broke'); } : short }] },
    { id: 'b', title: 'B', prereqs: ['a'], steps: [{ name: 'work', run: short }] }
  ];
};

/** What the project and the build goal have written into the world, as it is now (null: not there at all). */
function written(brain: Brain): { done: string[] | null; journal: string[] | null; jobs: unknown[] | null } {
  const world = brain.worldMemory();
  return JSON.parse(JSON.stringify({ done: world?.progress?.done ?? null, journal: world?.progress?.journal.map(j => j.text) ?? null, jobs: world?.buildJobs ?? null }));
}

test('brain-status and the idle log only look: a milestone found in place is written down by the tick that decides, not by them', async (t) => {
  // another goal running: nothing has looked at the tree yet, and asking for the status does not start the project's notes
  {
    const flag = { inPlace: true };
    const { rt, finish } = fakeRuntime({ pos: HOME, time: 6000 });
    const busy: Goal = { name: 'busy', priority: 90, wants: () => 'busy', timeoutMs: 60 * MIN, retryMs: 1000, run: async (ctx) => { await ctx.act('slow'); return 'ok'; } };
    const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => T0, goals: [busy, projectGoal(twoMilestones(flag)), structureGoal({} as never)] });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    t.is(statusLine(brain, 'Now:'), 'Now: busy (busy) for 0s.');
    t.deepEqual(written(brain), { done: null, journal: null, jobs: null });
    finish(); await settle();
    brain.setEnabled(false);
  }

  // the LLM driving, then the autopilot off: A came to be in place meanwhile, and the status leaves that for the brain
  {
    const flag = { inPlace: false };
    const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
    let clock = T0;
    const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => clock, goals: [projectGoal(twoMilestones(flag)), structureGoal({} as never)] });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    clock += 5000; await brain.tick(); await settle();
    const before = written(brain);
    t.deepEqual(before, { done: [], journal: ['started: A', 'A: work blocked (short of something)'], jobs: null });
    flag.inPlace = true;
    await brain.manual('dig-block');
    t.true(brain.status().includes('Paused for the LLM'));
    t.deepEqual(written(brain), before, 'the LLM driving');
    brain.setEnabled(false);
    t.true(brain.status().startsWith('Autonomy off'));
    t.deepEqual(written(brain), before, 'the autopilot off');
    // back in charge, the tick that decides writes it down as it always did, and goes on to B
    brain.setEnabled(true);
    clock += 5000; await brain.tick(); await settle();
    t.deepEqual(written(brain), { done: ['a'], journal: [...before.journal!, 'A: already in place', 'started: B', 'B: work blocked (short of something)'], jobs: null });
    brain.setEnabled(false);
  }

  // the project kept back after a failure: the brain does not ask it, the idle tick's log does
  {
    const flag = { inPlace: false };
    const { rt } = fakeRuntime({ pos: HOME, time: 6000 });
    let clock = T0;
    const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => clock, goals: [projectGoal(twoMilestones(flag, true)), structureGoal({} as never)] });
    brain.setEnabled(true);
    await brain.tick(); await settle();
    const before = written(brain);
    t.deepEqual(before, { done: [], journal: ['started: A'], jobs: null });
    flag.inPlace = true;
    clock += 5000; await brain.tick(); await settle();
    t.is(today(brain).idleMs, 5000, 'an idle tick, booked with its reasons');
    t.deepEqual(written(brain), before, 'the idle tick');
    t.truthy(statusLine(brain, 'Now: idle'));
    t.deepEqual(written(brain), before, 'and the status');
    // kept back no longer: now the brain asks it
    clock += 2 * MIN; await brain.tick(); await settle();
    t.deepEqual(written(brain), { done: ['a'], journal: ['started: A', 'A: already in place', 'started: B', 'B: work blocked (short of something)'], jobs: null });
    brain.setEnabled(false);
  }
});

test('a step short of materials: brain-status says what is short now, which try it was and when the next one is; a part of it coming in starts nothing, all of it starts the step', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gates-')), 'brain.json');
  // a room that takes 113 cane and 40 leather, the bot carrying 17 and 2: short three times so far, the third at 14:28
  const bill: Record<string, number> = { sugar_cane: 113, leather: 40 };
  const items: InventoryItem[] = [{ slot: 0, name: 'sugar_cane', count: 17 }, { slot: 1, name: 'leather', count: 2 }];
  const ran: string[] = [];
  const build: Step = {
    name: 'build',
    run: async (ctx) => {
      const short = Object.fromEntries(Object.entries(bill).map(([k, n]): [string, number] => [k, n - (ctx.s.counts.get(k) ?? 0)]).filter(([, n]) => n > 0));
      const text = Object.entries(short).map(([k, n]) => `${n} ${k}`).join(', ');
      ran.push(text || 'built');
      return text ? { status: 'blocked', text: `gathering for the room: short of ${text}`, retryMs: 3 * MIN, need: short } : { status: 'done', text: 'built' };
    }
  };
  const journal = ['started: the room', ...[0, 3, 9].map(() => 'the room: build blocked (gathering for the room: short of 96 sugar_cane, 38 leather)')];
  const world: WorldMemory = {
    landmarks: { chests: [], farmland: [], foundAt: T0 }, leash: 96, lastDone: { project: T0 + 28 * MIN },
    progress: {
      done: [], journal: journal.map((text, i) => ({ at: T0 + i * MIN, text })), current: { id: 'room', step: 0, data: {} }, need: { sugar_cane: 96, leather: 38 },
      blocked: { id: 'room/0', n: 3, at: T0 + 28 * MIN, need: { sugar_cane: 113, leather: 40 } }, blockedUntil: { room: T0 + 40 * MIN }
    }
  };
  fs.writeFileSync(file, JSON.stringify({ 'seed:1': world }));
  const { rt, acts } = fakeRuntime({ pos: HOME, time: 3000 }, items);
  let clock = T0 + 30 * MIN;
  const brain = new Brain(rt, { tickMs: 1e9, leaseMs: 60_000, now: () => clock, memoryFile: file, goals: [projectGoal([{ id: 'room', title: 'the room', prereqs: [], steps: [build] }])] });
  const ticks = async (n: number) => { for (let i = 0; i < n; i++) { clock += 5000; await brain.tick(); await settle(); } };
  const notes = () => brain.worldMemory()!.progress!.journal.map(j => j.text);
  brain.setEnabled(true);
  await brain.tick(); await settle();
  await ticks(3);

  // read back from brain.json (a restart): it waits, and says for what, which try that was and when it looks again
  t.is(statusLine(brain, 'Now:'), 'Now: idle (project): short of 96 sugar_cane, 38 leather (try 3, next 14:40).');
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: project - short of 96 sugar_cane, 38 leather (try 3, next 14:40)');
  t.deepEqual(today(brain).by, { project: 15_000 });

  // 20 cane come in: the count goes down, the wait stands
  items[0].count = 37;
  await ticks(3);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: project - short of 76 sugar_cane, 38 leather (try 3, next 14:40)');
  t.deepEqual([ran, notes()], [[], journal], 'nothing ran and nothing was written');

  // 14:40: the step looks once, is short still, and waits twice as long; the ticks after its run start nothing
  clock = T0 + 40 * MIN - 5000;
  await ticks(1);
  t.deepEqual(ran, ['76 sugar_cane, 38 leather']);
  await ticks(12);
  t.deepEqual(ran, ['76 sugar_cane, 38 leather'], 'one run');
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: project - short of 76 sugar_cane, 38 leather (try 4, next 15:04)');
  t.deepEqual(notes(), [...journal, 'the room: build blocked (gathering for the room: short of 76 sugar_cane, 38 leather)'], 'one line for the run');
  t.deepEqual(brain.worldMemory()!.progress!.blocked, { id: 'room/0', n: 4, at: T0 + 40 * MIN, need: { sugar_cane: 113, leather: 40 } });

  // all the leather, and the cane but for one: still not the whole of it
  items[1].count = 40;
  items[0].count = 112;
  await ticks(3);
  t.is(statusLine(brain, 'Blocked:'), 'Blocked: project - short of 1 sugar_cane (try 4, next 15:04)');
  t.is(ran.length, 1);
  // the last cane: the next tick starts the step, 23 min before its time, and the room is built
  items[0].count = 113;
  await ticks(1);
  t.deepEqual(ran, ['76 sugar_cane, 38 leather', 'built']);
  await ticks(2);
  t.deepEqual(notes().slice(-2), ['the room: build done (built)', 'done: the room']);
  t.is(statusLine(brain, 'Blocked:'), undefined);
  t.is(statusLine(brain, 'Now:'), 'Now: idle (unneeded): all 1 milestone(s) done.');
  const p = brain.worldMemory()!.progress!;
  t.deepEqual([p.done, p.blocked, p.blockedUntil, p.need], [['room'], undefined, {}, undefined]);
  t.deepEqual(acts, []);
  brain.setEnabled(false);
});
