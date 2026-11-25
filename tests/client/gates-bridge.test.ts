import test from 'ava';
import fs from 'fs';
import path from 'path';

// The jar of the villager fetch (client-mod Gates.java, GateHolds.java, Handlers.java, Guardian.java, Interact.java: the
// bridge changes B1-B7). Live Nov 24, with the gate closer switched off for a villager, the bot's own walk left the
// yard's west gate open the night that villager got out of the yard; and villagers left the hall each of the three
// times its gate stood open with one awake inside. So a gate is held open by a hold the brain must keep renewing and
// that the bridge ends by a shut click; the lock's gates are strict (never forgotten, reported by block state), a pair
// (never both open) and guarded (never open onto a villager in the lock); and the closer switched off comes back on by
// itself.
//
// GateHolds.java holds those rules with no Minecraft type in it. The port below is that file rule for rule: it was run
// against the compiled class in scratch (GateHoldsCheck: every call the scenarios of this file make on the port, then
// 4,000 random scripts of 120 steps and more each, 700,000 calls: every reply and every gate's state after every call
// the same, and each of 24 small changes to the Java told apart). Here the port is held to what the design asks of the
// bridge, and the Java to the port by the lines the rules stand on. The rest of the Java is compiled against the 26.3
// jar and pinned: the calls are registered, and what the brain leans on stays put.

const mod = path.join(process.cwd(), 'client-mod', 'src', 'claudebridge');
const read = (f: string): string => fs.readFileSync(path.join(mod, f), 'utf8');
const body = (java: string, call: string): string => {
  const at = java.indexOf(`s.register("${call}"`);
  const next = java.indexOf('s.register("', at + 10);
  return at < 0 ? '' : java.slice(at, next < 0 ? undefined : next);
};

// ---- the port of GateHolds.java ----

const TICK_MS = 50, MAX_HOLD_MS = 30_000, MAX_OFF_MS = 120_000, REACH = 4.4, LEFT_OPEN_TICKS = 100, CLICK_GAP = 10;

/** A gate as Gates.java read it this tick (GateHolds.Sight). */
interface Sight { key: number; loaded: boolean; open: boolean; powered: boolean; eye: number; feet: number; inside: boolean }
/** A guarded gate and its box of cells, both corners in it (GateHolds.Guard). */
interface Guard { gate: number; box: [number, number, number, number, number, number] }
interface Click { key: number; why: 'hold' | 'pair' | 'guard' }
interface Gate {
  loaded: boolean; open: boolean; powered: boolean; inside: boolean; eye: number; feet: number;
  openTicks: number; until: number; owed: boolean; clickedAt: number;
}

const ticksOf = (ms: number): number => Math.floor((ms + TICK_MS - 1) / TICK_MS);
const boxHolds = (g: Guard, x: number, y: number, z: number): boolean => {
  const [x1, y1, z1, x2, y2, z2] = g.box;
  return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2) && z >= Math.min(z1, z2) && z <= Math.max(z1, z2);
};

class Holds {
  private readonly gates = new Map<number, Gate>();
  private readonly strictSet = new Set<number>();
  private pairList: [number, number][] = [];
  private guardList: Guard[] = [];
  private readonly made = new Map<string, number>();
  private offUntil = -1;

  // gates.auto's timer (B4)
  off(forMs: number, now: number): number {
    const ms = forMs <= 0 || forMs > MAX_OFF_MS ? MAX_OFF_MS : forMs;
    this.offUntil = now + ticksOf(ms);
    return ms;
  }
  on(): void { this.offUntil = -1; }
  enabled(now: number): boolean { return this.offUntil < 0 || now >= this.offUntil; }
  offLeftMs(now: number): number { return this.enabled(now) ? 0 : (this.offUntil - now) * TICK_MS; }

  // the strict set, its pairs and guards (B3, B7)
  strict(gates: number[], pairs: [number, number][], guards: Guard[]): void {
    this.strictSet.clear();
    for (const k of gates) { this.strictSet.add(k); this.gate(k); }
    this.pairList = [];
    for (const p of pairs) { this.pairList.push([p[0], p[1]]); this.gate(p[0]); this.gate(p[1]); }
    this.guardList = [];
    for (const g of guards) { this.guardList.push(g); this.gate(g.gate); }
    this.prune();
  }
  isStrict(key: number): boolean { return this.strictSet.has(key); }
  strictGates(): number[] { return [...this.strictSet]; }
  pairs(): number { return this.pairList.length; }
  guards(): Guard[] { return [...this.guardList]; }
  tracked(): number[] { return [...this.gates.keys()]; }

  private gate(key: number): Gate {
    let g = this.gates.get(key);
    if (!g) {
      g = { loaded: false, open: false, powered: false, inside: false, eye: Infinity, feet: Infinity, openTicks: 0, until: -1, owed: false, clickedAt: -1 };
      this.gates.set(key, g);
    }
    return g;
  }
  private named(key: number): boolean {
    return this.strictSet.has(key) || this.pairList.some(p => p[0] === key || p[1] === key) || this.guardList.some(g => g.gate === key);
  }
  private prune(): void {
    for (const [k, g] of [...this.gates]) if (!this.named(k) && g.until < 0 && !g.owed) this.gates.delete(k);
  }

  // what is read
  look(s: Sight): void {
    const g = this.gate(s.key);
    g.loaded = s.loaded;
    g.eye = s.eye;
    g.feet = s.feet;
    g.inside = s.inside;
    if (!s.loaded) return; // out of sight: as last read
    g.open = s.open;
    g.powered = s.powered;
    if (!g.open) g.clickedAt = -1;
  }
  open(key: number): boolean { return this.gates.get(key)?.open ?? false; }
  loaded(key: number): boolean { return this.gates.get(key)?.loaded ?? false; }
  openTicks(key: number): number { return this.gates.get(key)?.openTicks ?? 0; }
  leftOpen(key: number, now: number): boolean {
    const g = this.gates.get(key);
    return !!g && g.open && !this.held(key, now) && (!g.loaded || g.eye > REACH || g.openTicks >= LEFT_OPEN_TICKS);
  }

  // holds (B2)
  hold(key: number, ms: number, now: number): number {
    if (ms <= 0) return 0;
    const g = this.gate(key);
    if (g.open && g.eye > REACH) { g.until = -1; g.owed = true; return 0; }
    g.until = now + ticksOf(Math.min(ms, MAX_HOLD_MS));
    g.owed = false;
    return (g.until - now) * TICK_MS;
  }
  release(key: number, shut: boolean, now: number): boolean {
    const was = this.held(key, now);
    const g = shut ? this.gate(key) : this.gates.get(key);
    if (g) {
      g.until = -1;
      if (shut) g.owed = g.open;
    }
    this.prune();
    return was;
  }
  held(key: number, now: number): boolean { const g = this.gates.get(key); return !!g && g.until >= 0 && now < g.until; }
  heldMs(key: number, now: number): number { return this.held(key, now) ? (this.gates.get(key)!.until - now) * TICK_MS : 0; }

  // the clicks
  private click(g: Gate, now: number, busy: boolean): boolean {
    if (busy || !g.loaded || g.powered || g.inside || g.eye > REACH) return false;
    if (g.clickedAt >= 0 && now - g.clickedAt < CLICK_GAP) return false;
    g.clickedAt = now;
    return true;
  }
  private did(key: number, why: Click['why']): Click {
    this.made.set(why, (this.made.get(why) ?? 0) + 1);
    return { key, why };
  }
  clicks(why: string): number { return this.made.get(why) ?? 0; }
  clicked(key: number, now: number): void { const g = this.gates.get(key); if (g) g.clickedAt = now; }
  recent(key: number, now: number): boolean { const g = this.gates.get(key); return !!g && g.clickedAt >= 0 && now - g.clickedAt < CLICK_GAP; }
  shutNow(key: number, now: number, busy: boolean): boolean {
    const g = this.gates.get(key);
    if (!g || !g.owed || !g.open || !this.click(g, now, busy)) return false;
    this.did(key, 'hold');
    return true;
  }

  tick(now: number, busy: boolean, villagers: Set<number>): Click[] {
    const out: Click[] = [];
    for (const g of this.gates.values()) {
      if (g.loaded) g.openTicks = g.open ? g.openTicks + 1 : 0;
      if (g.until >= 0 && (now >= g.until || (g.open && g.eye > REACH))) { g.until = -1; g.owed = g.open; }
      if (g.owed && g.loaded && !g.open) g.owed = false;
    }
    for (const gd of this.guardList) {
      const g = this.gates.get(gd.gate)!;
      if (g.loaded && g.open && g.until < 0 && villagers.has(gd.gate) && this.click(g, now, busy)) out.push(this.did(gd.gate, 'guard'));
    }
    for (const p of this.pairList) {
      const a = this.gates.get(p[0])!, b = this.gates.get(p[1])!;
      if (!(a.loaded && a.open && a.clickedAt !== now) || !(b.loaded && b.open && b.clickedAt !== now)) continue;
      const second = b.feet > a.feet;
      if (this.click(second ? b : a, now, busy)) out.push(this.did(second ? p[1] : p[0], 'pair'));
    }
    for (const [k, g] of this.gates) {
      if (g.owed && g.open && this.click(g, now, busy)) out.push(this.did(k, 'hold'));
    }
    this.prune();
    return out;
  }
}

// ---- end of the port ----

// ---- the lock as the design draws it (4.8), and Gates.java's side of a tick ----

interface V3 { x: number; y: number; z: number }
const cellOf = (x: number, y: number, z: number): V3 => ({ x, y, z });
/** The hall's gate H, the lock's gate P three cells out, the six cells between them, and the post the bot works from. */
const H = cellOf(-556, 63, 2134), P = cellOf(-556, 63, 2137), POST = cellOf(-553, 63, 2136);
const INSIDE: Guard['box'] = [-557, 63, 2135, -555, 64, 2136];
/** A yard gate, far from the lock. */
const G = cellOf(-540, 63, 2180);
const NAMES = ['H', 'P', 'G'];
const CELLS = [H, P, G];
const KEY = { H: 0, P: 1, G: 2 };
const mid = (c: V3): V3 => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** Standing in a cell: its middle, on its floor. */
const standing = (c: V3): V3 => ({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
const EYE = 1.62;

/**
 * The world for the port, read and clicked as Gates.java does (`sight`, `rules`): the distances from the bot's eye and
 * feet to a gate's middle, "inside" for its own cell and the cells over and under it, a click that shuts the gate at
 * once (the client sets the block itself) and the gate read again after it, and the villagers standing in a guard's box.
 */
class Field {
  readonly holds = new Holds();
  now = 0;
  bot: V3 = standing(POST);
  busy = false;
  /** the bridge's clicks do nothing (the client's own refusal, a spectator's): the gate still reads open after one */
  refuse = false;
  villagers: V3[] = [];
  readonly open = new Map<number, boolean>(CELLS.map((_, k) => [k, false]));
  readonly unloaded = new Set<number>();
  /** held open by redstone (a plate, a lever) */
  readonly powered = new Set<number>();
  readonly log: string[] = [];

  sight(key: number): Sight {
    const c = CELLS[key], m = mid(c), me = { x: Math.floor(this.bot.x), y: Math.floor(this.bot.y), z: Math.floor(this.bot.z) };
    const loaded = !this.unloaded.has(key);
    const inside = c.x === me.x && c.z === me.z && Math.abs(c.y - me.y) <= 1;
    return { key, loaded, open: loaded && this.open.get(key)!, powered: loaded && this.powered.has(key), eye: dist({ ...this.bot, y: this.bot.y + EYE }, m), feet: dist(this.bot, m), inside };
  }
  look(): void { for (const k of this.holds.tracked()) this.holds.look(this.sight(k)); }
  /** One client tick, or `n` of them. */
  tick(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.now++;
      this.look();
      const seen = new Set<number>();
      for (const g of this.holds.guards()) {
        if (this.holds.open(g.gate) && this.villagers.some(v => boxHolds(g, Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))) seen.add(g.gate);
      }
      for (const c of this.holds.tick(this.now, this.busy, seen)) {
        this.log.push(`${this.now} ${c.why} ${NAMES[c.key]}`);
        if (!this.refuse) this.open.set(c.key, false);
        this.holds.look(this.sight(c.key));
      }
    }
  }
  /** gates.hold: looked at, then held. */
  hold(key: number, ms: number): { held: boolean; open: boolean; leftMs: number } {
    const at = this.sight(key);
    this.holds.look(at);
    const leftMs = this.holds.hold(key, ms, this.now);
    return { held: leftMs > 0, open: at.open, leftMs };
  }
  /** gates.release: looked at, released, and with `shut` clicked at once when that can be done. */
  release(key: number, shut: boolean): { released: boolean; open: boolean } {
    this.holds.look(this.sight(key));
    const released = this.holds.release(key, shut, this.now);
    if (shut && this.holds.shutNow(key, this.now, this.busy)) {
      this.log.push(`${this.now} released ${NAMES[key]}`);
      if (!this.refuse) this.open.set(key, false);
      this.holds.look(this.sight(key));
    }
    return { released, open: this.sight(key).open };
  }
  /** gates.status' row for a gate. */
  status(key: number): { open: boolean; loaded: boolean; heldMs: number; openTicks: number; leftOpen: boolean } {
    this.look();
    const h = this.holds;
    return { open: h.open(key), loaded: h.loaded(key), heldMs: h.heldMs(key, this.now), openTicks: h.openTicks(key), leftOpen: h.leftOpen(key, this.now) };
  }
}

/** The lock's strict set as the brain sends it: the yard gate, P and H; the pair; the guard on P. */
function lock(): Field {
  const f = new Field();
  f.holds.strict([KEY.G, KEY.P, KEY.H], [[KEY.P, KEY.H]], [{ gate: KEY.P, box: INSIDE }]);
  return f;
}

// ---- the calls, and the Java around the rules ----

test('the bridge registers the gate calls, and the mod starts them', (t) => {
  const java = read('Gates.java');
  for (const m of ['gates.auto', 'gates.hold', 'gates.release', 'gates.strict', 'gates.status']) t.true(java.includes(`s.register("${m}", true,`), m);
  t.regex(read('ClaudeBridge.java'), /Gates\.register\(server\);/);
  // the rules are one object, and hold no Minecraft type (a scratch check and the port can run them)
  t.regex(java, /private static final GateHolds HOLDS = new GateHolds\(\);/);
  t.notRegex(read('GateHolds.java'), /net\.minecraft|com\.mojang|import claudebridge/);
});

test('B1: world.entities says every entity\'s uuid, and a sleeper only when it sleeps', (t) => {
  const list = body(read('Handlers.java'), 'world.entities');
  t.regex(list, /JsonObject o = obj\("id", e\.getId\(\), "uuid", e\.getStringUUID\(\), "name", Names\.entity\(e\),/);
  t.regex(list, /if \(e instanceof LivingEntity le\) \{[^}]*?if \(le\.isSleeping\(\)\) o\.addProperty\("sleeping", true\);/s);
  // a vehicle's own uuid line says the same string (UUID.toString)
  t.regex(read('Vehicle.java'), /o\.addProperty\("uuid", v\.getUUID\(\)\.toString\(\)\);/);
});

test('B4: the closer switched off comes back on by itself, after two minutes at most', (t) => {
  const java = read('Gates.java');
  t.regex(body(java, 'gates.auto'), /if \(enabled\) HOLDS\.on\(\); else HOLDS\.off\(intParam\(p, "forMs", GateHolds\.MAX_OFF_MS\), now\);/);
  t.regex(body(java, 'gates.auto'), /if \(!enabled\) r\.addProperty\("autoOffLeftMs", HOLDS\.offLeftMs\(now\)\);/);
  // the tick asks the timer, no flag of its own; off, the closer forgets what it took, as it always did
  t.regex(java, /boolean enabled = HOLDS\.enabled\(tick\);/);
  t.regex(java, /if \(!enabled\) \{ opened\.clear\(\); seen\.clear\(\); return; \}/);
  t.notRegex(java, /private static boolean enabled/);
  const holds = read('GateHolds.java');
  t.regex(holds, new RegExp(`static final int MAX_OFF_MS = ${MAX_OFF_MS.toLocaleString('en-US').replace(/,/g, '_')};`));
  t.regex(holds, /int ms = forMs <= 0 \|\| forMs > MAX_OFF_MS \? MAX_OFF_MS : forMs;\s+offUntil = now \+ ticks\(ms\);/);
  t.regex(holds, /boolean enabled\(long now\) \{ return offUntil < 0 \|\| now >= offUntil; \}/);

  const h = new Holds();
  t.true(h.enabled(0));
  // none given (the pens' old call): the cap; over the cap: the cap
  t.is(h.off(0, 1000), 120_000);
  t.false(h.enabled(1000));
  t.is(h.offLeftMs(1000), 120_000);
  t.false(h.enabled(1000 + 2399));
  t.true(h.enabled(1000 + 2400));
  t.is(h.offLeftMs(1000 + 2400), 0);
  t.is(h.off(600_000, 0), 120_000);
  // the pens renew it while a walk lasts: each call counts from its own moment
  t.is(h.off(5000, 0), 5000);
  t.is(h.off(5000, 60), 5000);
  t.false(h.enabled(159));
  t.true(h.enabled(160));
  // and on again at once when asked
  h.off(120_000, 0);
  h.on();
  t.true(h.enabled(1));
});

test('B5: with a villager within a click\'s reach the look goes straight down before the eat key does, and while it is held', (t) => {
  const java = read('Guardian.java');
  const eat = java.slice(java.indexOf('static void eatThen('), java.indexOf('public static void register('));
  const look = eat.indexOf('lookOffVillager(mc, p);'), key = eat.indexOf('mc.options.keyUse.setDown(true);');
  t.true(look > 0 && look < eat.indexOf('mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);') && look < key);
  // the one place the Guardian puts the key down to eat: keepFed and takeCover both come through it
  t.is(java.split('keyUse.setDown(true)').length - 1, 1);
  t.regex(java, /eatThen\("", r -> \{ eating = false; EatPause\.eating = false;/);
  // what the held key would click is whatever the crosshair is on at any tick it is held (Minecraft.startUseItem reads
  // hitResult): so by reach, not by the crosshair of that instant (a villager steps under it), and straight down (60
  // degrees down meets the ground 0.93 from the bot's column: a villager in the next cell was hit at its legs)
  const off = java.slice(java.indexOf('static boolean lookOffVillager('), java.indexOf('/** Eat the best food there is'));
  t.regex(off, /for \(Entity e : mc\.level\.entitiesForRendering\(\)\) \{\s+if \(!\(e instanceof AbstractVillager\) \|\| !e\.isAlive\(\) \|\| !p\.isWithinEntityInteractionRange\(e, LOOK_OFF_MARGIN\)\) continue;\s+p\.setXRot\(90f\);\s+return true;/);
  t.regex(java, /static final double LOOK_OFF_MARGIN = 1\.0;/);
  t.false(/hitResult/.test(off.replace(/\/\*[\s\S]*?\*\//g, '')), 'not the crosshair of one instant');
  t.false(java.includes('LOOK_OFF_PITCH'));
  // and again on every tick the key is held, before it is let go: one that came into reach during the bite
  const held = eat.slice(key, eat.indexOf('m.options.keyUse.setDown(false);'));
  t.regex(held, /if \(settle < 0\) \{\s+lookOffVillager\(m, m\.player\);/);
});

test('B6: dig.here\'s sight rule is pinned: a face is covered only by a full cube, and the clip stays the judge', (t) => {
  const dig = body(read('Interact.java'), 'dig.here');
  // the eye, the reach, and each face's middle just inside the block
  t.regex(dig, /Vec3 eye = pl\.getEyePosition\(\);\s+double reach = pl\.blockInteractionRange\(\);/);
  t.regex(dig, /if \(mc\.level\.getBlockState\(target\.relative\(d\)\)\.isCollisionShapeFullBlock\(mc\.level, target\.relative\(d\)\)\) continue; \/\/ covered: not seen/);
  t.regex(dig, /Vec3 fc = Vec3\.atCenterOf\(target\)\.add\(d\.getUnitVec3\(\)\.scale\(0\.49\)\);\s+if \(fc\.distanceTo\(eye\) > reach - 0\.1\) continue;/);
  t.regex(dig, /ClipContext\.Block\.OUTLINE,\s+net\.minecraft\.world\.level\.ClipContext\.Fluid\.NONE, pl\)\);\s+if \(hit\.getType\(\) != net\.minecraft\.world\.phys\.HitResult\.Type\.BLOCK \|\| !hit\.getBlockPos\(\)\.equals\(target\)\) continue;/);
  t.regex(dig, /if \(aim == null \|\| fc\.distanceTo\(eye\) < aim\.distanceTo\(eye\)\) \{ face = d; aim = fc; \}/);
  // the old test called a face with a rail, a torch or a flower before it covered: the lock's socket has the sill's rail
  // before its one open face
  t.notRegex(dig, /if \(!replaceable\(mc\.level\.getBlockState\(target\.relative\(d\)\)\)\) continue;/);
  // (the dig stays where the bot stands, and never takes someone else's block or a lit portal's frame)
  t.true(dig.indexOf('Foreign.guarded(target, before)') < dig.indexOf('Vec3 eye = pl.getEyePosition();'));
  t.false(dig.includes('clearArea('));
});

test('strict: never dropped by the closer for distance, age or a chunk away; the closer\'s own rule stays as it was', (t) => {
  const java = read('Gates.java');
  // its own, as it was: a gate that opens within 2.5 of the bot is the bot's; shut from 2.2 clear of it, 4.4 from the
  // eye at most, never from its own cell, never with a screen up, an item in use, a block being broken or the sneak key down
  t.regex(java, /if \(o && was != null && !was && !powered\(s\) && Vec3\.atCenterOf\(q\)\.distanceTo\(p\.position\(\)\) <= 2\.5\) opened\.putIfAbsent\(k, Ticker\.ticks\(\)\);/);
  t.regex(java, /boolean inside = q\.equals\(me\) \|\| q\.equals\(me\.above\(\)\) \|\| q\.equals\(me\.below\(\)\);\s+if \(inside \|\| d < 2\.2 \|\| eye\.distanceTo\(c\) > 4\.4\) continue;/);
  t.regex(java, /if \(mc\.gui\.screen\(\) != null \|\| p\.isUsingItem\(\) \|\| mc\.gameMode\.isDestroying\(\)\) continue;/);
  t.regex(java, /boolean sneaking = mc\.options\.keyShift\.isDown\(\);\s+if \(sneaking\) continue;/);
  // strict: never dropped for distance or age, nor while its chunk is away; kept after the click until it reads shut
  t.regex(java, /boolean strict = HOLDS\.isStrict\(e\.getKey\(\)\);\s+if \(strict && !sees\(mc, q\)\) continue;/);
  t.regex(java, /if \(!strict && \(d > 6 \|\| Ticker\.ticks\(\) - e\.getValue\(\) > 20 \* 60\)\) \{ it\.remove\(\); continue; \}/);
  t.regex(java, /if \(HOLDS\.recent\(e\.getKey\(\), tick\)\) continue;[^\n]*\n\s+mc\.gameMode\.useItemOn\(p, InteractionHand\.MAIN_HAND, new BlockHitResult\(hit, face, q, false\)\);\n[^\n]*\n\s+if \(strict\) HOLDS\.clicked\(e\.getKey\(\), tick\); else it\.remove\(\);/);
  // held: left open by the closer too
  t.regex(java, /if \(HOLDS\.held\(e\.getKey\(\), tick\)\) continue;/);
  // the lock's rules run first and with the closer on or off
  const tick = java.slice(java.indexOf('private static void tick(Minecraft mc)'));
  t.true(tick.indexOf('rules(mc, p, tick);') > 0 && tick.indexOf('rules(mc, p, tick);') < tick.indexOf('if (!enabled)'));
});

test('Gates.java reads a gate for the rules as the closer measures it, and clicks what they say', (t) => {
  const java = read('Gates.java');
  // the four skips, as one: they delay. Sneaking by the key or by Baritone's input, which presses none (a sneaking click
  // goes to the item in hand: a block would be put down beside the gate)
  t.regex(java, /return mc\.gui\.screen\(\) != null \|\| p\.isUsingItem\(\) \|\| mc\.gameMode\.isDestroying\(\) \|\| mc\.options\.keyShift\.isDown\(\) \|\| p\.isShiftKeyDown\(\);/);
  // eye and feet to the gate's middle; inside as the closer's; out of sight: another dimension, or its chunk away
  t.regex(java, /new GateHolds\.Sight\(q\.asLong\(\), loaded, gate && open\(s\), gate && powered\(s\), p\.getEyePosition\(\)\.distanceTo\(c\), c\.distanceTo\(p\.position\(\)\), inside\);/);
  t.regex(java, /if \(!dimension\.equals\(Names\.dimension\(mc\.level\)\)\) return new GateHolds\.Sight\(q\.asLong\(\), false, false, false, Double\.POSITIVE_INFINITY, Double\.POSITIVE_INFINITY, false\);\s+boolean loaded = mc\.level\.isLoaded\(q\);/);
  // B7: a villager (any AbstractVillager, alive) whose cell is in the guard's box, looked for only while the gate is open
  const rules = java.slice(java.indexOf('private static void rules('), java.indexOf('private static void tick('));
  t.regex(rules, /if \(!HOLDS\.open\(g\.gate\(\)\)\) continue;/);
  t.regex(rules, /if \(!\(e instanceof AbstractVillager\) \|\| !e\.isAlive\(\)\) continue;\s+BlockPos at = e\.blockPosition\(\);\s+if \(g\.holds\(at\.getX\(\), at\.getY\(\), at\.getZ\(\)\)\) \{ villagers\.add\(g\.gate\(\)\); break; \}/);
  t.regex(rules, /for \(GateHolds\.Click k : HOLDS\.tick\(now, busy\(mc, p\), villagers\)\) \{/);
  // each click made at once, and the gate read again after it: one that took reads shut, and may be clicked the tick it opens again
  t.regex(rules, /click\(mc, p, q\);\n(\s+\/\/[^\n]*\n)*\s+HOLDS\.look\(sight\(mc, p, q\)\);/);
  // every click of the rules is the closer's own kind of click, and only ever made on a gate the rules read open
  t.regex(java, /Direction face = Direction\.getApproximateNearest\(p\.position\(\)\.x - c\.x, 0, p\.position\(\)\.z - c\.z\);\s+Vec3 hit = c\.add\(face\.getStepX\(\) \* 0\.5, 0, face\.getStepZ\(\) \* 0\.5\);\s+mc\.gameMode\.useItemOn\(p, InteractionHand\.MAIN_HAND, new BlockHitResult\(hit, face, q, false\)\);\s+\}\s+\/\*\* Every gate GateHolds keeps/);
});

test('B2: a hold is taken on a gate or door only, never opens it, and a release with shut clicks before it answers', (t) => {
  const java = read('Gates.java');
  const hold = body(java, 'gates.hold'), release = body(java, 'gates.release');
  // not a gate, out of sight or in another dimension: refused with the reason, nothing held
  t.regex(hold, /String why = notAGate\(mc, q\);\s+if \(why != null\) return obj\("held", false, "open", false, "leftMs", 0, "reason", why\);/);
  t.regex(java, /return gateOrDoor\(s\) \? null : "no gate or door at "/);
  // looked at, then held; the call clicks nothing (a hold keeps a gate that opens from being shut)
  t.true(hold.indexOf('HOLDS.look(at);') > 0 && hold.indexOf('HOLDS.look(at);') < hold.indexOf('int left = HOLDS.hold(q.asLong(), ms, now);'));
  t.false(/useItemOn|click\(/.test(hold));
  t.regex(hold, /return obj\("held", true, "open", at\.open\(\), "leftMs", left\);/);
  // release {shut}: owed, clicked now when it can be, and the state read after the click
  t.regex(release, /boolean released = HOLDS\.release\(key, shut, now\);\s+if \(shut && HOLDS\.shutNow\(key, now, busy\(mc, pl\)\)\) \{/);
  t.regex(release, /click\(mc, pl, q\);\s+HOLDS\.look\(sight\(mc, pl, q\)\);/);
  t.true(release.indexOf('click(mc, pl, q);') < release.indexOf('obj("released", released, "open", at.loaded() ? sight(mc, pl, q).open() : last)'));
  // without shut an open gate is the closer's again (its ordinary rule: clear of it by 2.2)
  t.regex(release, /\} else if \(!shut && at\.loaded\(\) && at\.open\(\) && HOLDS\.enabled\(now\)\) \{\s+opened\.putIfAbsent\(key, now\);/);
});

test('B3: the strict set is sent whole, and every strict gate is reported by its block state read at the call', (t) => {
  const java = read('Gates.java');
  const strict = body(java, 'gates.strict'), status = body(java, 'gates.status');
  for (const k of ['"gates"', '"pairs"', '"guard"', '"box"', '"gate"']) t.true(strict.includes(k), k);
  // a pair is two gates: one named twice would be clicked shut whenever it opens
  t.regex(strict, /if \(a == b\) throw new IllegalArgumentException\("a pair is two gates, not one twice"\);/);
  t.regex(strict, /HOLDS\.strict\(gates\.stream\(\)\.mapToLong\(Long::longValue\)\.toArray\(\), pairs\.toArray\(new long\[0\]\[\]\), guards\.toArray\(new GateHolds\.Guard\[0\]\)\);/);
  t.regex(strict, /return obj\("strict", HOLDS\.strict\(\)\.size\(\), "pairs", HOLDS\.pairs\(\), "guard", HOLDS\.guards\(\)\.size\(\)\);/);
  // the gates stand in the brain's home dimension unless it says another: elsewhere they are out of sight, not shut
  t.regex(strict, /dimension = strParam\(p, "dimension", "overworld"\);/);
  // status: a fresh look first, then each strict gate's row, the count the brain compares with its own, the clicks made
  t.true(status.indexOf('if (world) look(mc, mc.player);') > 0 && status.indexOf('if (world) look(mc, mc.player);') < status.indexOf('for (long k : HOLDS.strict())'));
  for (const k of ['"open", HOLDS.open(k)', '"loaded", world && HOLDS.loaded(k)', '"heldMs", HOLDS.heldMs(k, now)', '"openTicks", HOLDS.openTicks(k)', '"leftOpen", HOLDS.leftOpen(k, now)']) {
    t.true(status.includes(`o.addProperty(${k});`), k);
  }
  t.regex(status, /obj\("enabled", HOLDS\.enabled\(now\), "strict", strict, "count", strict\.size\(\),\s+"clicks", obj\("hold", HOLDS\.clicks\("hold"\), "pair", HOLDS\.clicks\("pair"\), "guard", HOLDS\.clicks\("guard"\)\)\);/);
  t.regex(status, /if \(!HOLDS\.enabled\(now\)\) r\.addProperty\("autoOffLeftMs", HOLDS\.offLeftMs\(now\)\);/);
});

test('GateHolds.java is the port\'s: its numbers and the lines its rules stand on', (t) => {
  const java = read('GateHolds.java');
  const num = (n: number): string => (Number.isInteger(n) && n >= 1000 ? n.toLocaleString('en-US').replace(/,/g, '_') : String(n));
  for (const [name, type, v] of [['TICK_MS', 'int', TICK_MS], ['MAX_HOLD_MS', 'int', MAX_HOLD_MS], ['MAX_OFF_MS', 'int', MAX_OFF_MS], ['REACH', 'double', REACH],
    ['LEFT_OPEN_TICKS', 'int', LEFT_OPEN_TICKS], ['CLICK_GAP', 'int', CLICK_GAP]] as const) {
    t.regex(java, new RegExp(`static final ${type} ${name} = ${num(v).replace('.', '\\.')};`), name);
  }
  t.regex(java, /static long ticks\(int ms\) \{ return \(ms \+ TICK_MS - 1\) \/ TICK_MS; \}/);
  // a guard's box: cells, both corners in it
  t.regex(java, /return x >= Math\.min\(x1, x2\) && x <= Math\.max\(x1, x2\) && y >= Math\.min\(y1, y2\) && y <= Math\.max\(y1, y2\)\s+&& z >= Math\.min\(z1, z2\) && z <= Math\.max\(z1, z2\);/);
  // what is read: out of sight keeps the last read; a gate read shut forgets its last click
  t.regex(java, /if \(!s\.loaded\(\)\) return; \/\/ out of sight: as last read\s+g\.open = s\.open\(\);\s+g\.powered = s\.powered\(\);\s+if \(!g\.open\) g\.clickedAt = -1;/);
  // left open
  t.regex(java, /return g != null && g\.open && !held\(key, now\) && \(!g\.loaded \|\| g\.eye > REACH \|\| g\.openTicks >= LEFT_OPEN_TICKS\);/);
  // a hold: none on a gate open out of reach (owed instead), the cap, taken on a shut gate like any other
  t.regex(java, /if \(ms <= 0\) return 0;\s+Gate g = gate\(key\);\s+if \(g\.open && g\.eye > REACH\) \{ g\.until = -1; g\.owed = true; return 0; \}\s+g\.until = now \+ ticks\(Math\.min\(ms, MAX_HOLD_MS\)\);\s+g\.owed = false;/);
  t.regex(java, /boolean held\(long key, long now\) \{ Gate g = gates\.get\(key\); return g != null && g\.until >= 0 && now < g\.until; \}/);
  // a release: with shut the gate is owed a click if it stands open, held before or not
  t.regex(java, /Gate g = shut \? gate\(key\) : gates\.get\(key\);\s+if \(g != null\) \{\s+g\.until = -1;\s+if \(shut\) g\.owed = g\.open;\s+\}/);
  // a click: the skips, sight, redstone, the bot's own cell, the reach; then the gap after one that did not take
  t.regex(java, /if \(busy \|\| !g\.loaded \|\| g\.powered \|\| g\.inside \|\| g\.eye > REACH\) return false;\s+if \(g\.clickedAt >= 0 && now - g\.clickedAt < CLICK_GAP\) return false;\s+g\.clickedAt = now;\s+return true;/);
  t.regex(java, /if \(g == null \|\| !g\.owed \|\| !g\.open \|\| !click\(g, now, busy\)\) return false;/);
  // the tick: counted, a hold's end (its time, or the bot gone from the open gate), nothing owed on a gate read shut
  t.regex(java, /if \(g\.loaded\) g\.openTicks = g\.open \? g\.openTicks \+ 1 : 0;/);
  t.regex(java, /if \(g\.until >= 0 && \(now >= g\.until \|\| \(g\.open && g\.eye > REACH\)\)\) \{ g\.until = -1; g\.owed = g\.open; \}\s+if \(g\.owed && g\.loaded && !g\.open\) g\.owed = false;/);
  // the guard, then the pair (one just clicked counts as shut; the farther one, the first named on a tie), then what is owed
  const tick = java.slice(java.indexOf('List<Click> tick(long now, boolean busy, Set<Long> villagers)'));
  const guard = tick.indexOf('if (g.loaded && g.open && g.until < 0 && villagers.contains(gd.gate()) && click(g, now, busy)) out.add(made(gd.gate(), "guard"));');
  const pair = tick.indexOf('if (!(a.loaded && a.open && a.clickedAt != now) || !(b.loaded && b.open && b.clickedAt != now)) continue;');
  const owed = tick.indexOf('if (g.owed && g.open && click(g, now, busy)) out.add(made(e.getKey(), "hold"));');
  t.true(guard > 0 && guard < pair && pair < owed);
  t.regex(tick, /boolean second = b\.feet > a\.feet;\s+if \(click\(second \? b : a, now, busy\)\) out\.add\(made\(second \? p\[1\] : p\[0\], "pair"\)\);/);
  // nothing in the file can open a gate: every click it asks for is on a gate it read open
  t.is(tick.split('click(').length - 1, 3);
});

// ---- the rules, on the port ----

test('the lock from the post: both gates within a click, neither within the closer\'s own 2.5', (t) => {
  const f = lock();
  const p = f.sight(KEY.P), h = f.sight(KEY.H);
  // the design's numbers (4.8): P 3.35 and H 3.78 from the eye
  t.is(Math.round(p.eye * 100) / 100, 3.35);
  t.is(Math.round(h.eye * 100) / 100, 3.78);
  t.true(p.eye <= REACH && h.eye <= REACH);
  // a gate opened from there is nothing the closer takes as the bot's (it takes what opens within 2.5 of the feet)
  t.true(p.feet > 2.5 && h.feet > 2.5);
});

test('a hold on a shut gate keeps it open once opened; released, it is shut', (t) => {
  const f = lock();
  // six out of the yard gate: the hold comes before the walk, on the shut gate
  f.bot = standing(cellOf(G.x, G.y, G.z - 6));
  t.deepEqual(f.hold(KEY.G, 20_000), { held: true, open: false, leftMs: 20_000 });
  f.tick(40);
  // the walk opens it, and the bot goes through to 2 inside and 1 aside of the lane
  f.bot = standing(cellOf(G.x, G.y, G.z - 1));
  f.open.set(KEY.G, true);
  f.tick();
  f.bot = standing(G);
  f.tick(5);
  f.bot = standing(cellOf(G.x + 1, G.y, G.z + 2));
  // held for 12 s, renewed each second: nothing shuts it, and it is not "left open"
  for (let s = 0; s < 12; s++) {
    t.true(f.hold(KEY.G, 20_000).held);
    f.tick(20);
  }
  t.deepEqual(f.log, []);
  t.true(f.open.get(KEY.G));
  const row = f.status(KEY.G);
  t.true(row.open && row.heldMs > 0 && row.openTicks > LEFT_OPEN_TICKS && !row.leftOpen);
  // released with shut: clicked before the call answers
  t.deepEqual(f.release(KEY.G, true), { released: true, open: false });
  t.deepEqual(f.log, [`${f.now} released G`]);
  f.tick(40);
  t.is(f.log.length, 1);
  t.is(f.holds.clicks('hold'), 1);
  t.deepEqual(f.status(KEY.G), { open: false, loaded: true, heldMs: 0, openTicks: 0, leftOpen: false });
});

test('a hold never opens a gate, and one that runs out on a shut gate clicks nothing', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x, G.y, G.z - 2));
  f.hold(KEY.G, 5000);
  f.tick(300);
  t.deepEqual(f.log, []);
  t.false(f.open.get(KEY.G));
  t.is(f.status(KEY.G).heldMs, 0);
  // the cap, and nothing for no time at all
  t.is(f.hold(KEY.G, 600_000).leftMs, MAX_HOLD_MS);
  t.deepEqual(f.hold(KEY.P, 0), { held: false, open: false, leftMs: 0 });
  t.deepEqual(f.hold(KEY.P, -5), { held: false, open: false, leftMs: 0 });
  // a release of what is not held says so
  t.deepEqual(f.release(KEY.H, false), { released: false, open: false });
});

test('a hold outlives a silent brain: its time out, the bridge shuts the gate by itself', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x + 1, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  t.deepEqual(f.hold(KEY.G, 20_000), { held: true, open: true, leftMs: 20_000 });
  // the brain is killed here: no renewal, no release
  f.tick(399);
  t.deepEqual(f.log, []);
  t.is(f.status(KEY.G).heldMs, 50);
  f.tick();
  t.deepEqual(f.log, ['400 hold G']);
  t.false(f.open.get(KEY.G));
  f.tick(100);
  t.is(f.log.length, 1);
});

test('a hold that ends with the bot in the gateway is shut as soon as the bot is out of it', (t) => {
  const f = lock();
  f.bot = standing(G);
  f.open.set(KEY.G, true);
  f.hold(KEY.G, 1000);
  f.tick(60);
  t.deepEqual(f.log, []);
  t.true(f.open.get(KEY.G));
  f.bot = standing(cellOf(G.x, G.y, G.z + 1));
  f.tick();
  t.deepEqual(f.log, ['61 hold G']);
});

test('the four skips delay, never drop', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x + 1, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  f.hold(KEY.G, 1000);
  // a screen up, an item in use, a block being broken or the sneak key down as the hold runs out, and for ten seconds on
  f.busy = true;
  f.tick(220);
  t.deepEqual(f.log, []);
  t.true(f.open.get(KEY.G));
  // open, not held, by the bot: left open only once it has stood so for 100 ticks
  t.true(f.status(KEY.G).leftOpen);
  f.busy = false;
  f.tick();
  t.deepEqual(f.log, ['221 hold G']);
  // and a release with shut made while busy is clicked on the first tick that can
  f.open.set(KEY.G, true);
  f.busy = true;
  t.deepEqual(f.release(KEY.G, true), { released: false, open: true });
  f.tick(30);
  f.busy = false;
  f.tick();
  t.deepEqual(f.log, ['221 hold G', '252 hold G']);
});

test('a gate redstone holds open is not the bridge\'s to click: owed, and shut once the power is off', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x + 1, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  f.powered.add(KEY.G);
  f.hold(KEY.G, 1000);
  f.tick(100);
  t.deepEqual(f.log, []);
  t.like(f.status(KEY.G), { open: true, heldMs: 0, leftOpen: true });
  f.powered.delete(KEY.G);
  f.tick();
  t.deepEqual(f.log, ['101 hold G']);
  t.false(f.open.get(KEY.G));
});

test('a hold on a gate opened from 3.4 away runs out: shut', (t) => {
  const f = lock();
  // LOCK step 3, from the post: the hold, then the raw click that opens P (the closer knows nothing of that gate)
  t.true(f.hold(KEY.P, 20_000).held);
  f.open.set(KEY.P, true);
  f.tick(399);
  t.deepEqual(f.log, []);
  f.tick();
  t.deepEqual(f.log, ['400 hold P']);
  t.false(f.open.get(KEY.P));
});

test('the bot gone from a held open gate ends the hold: left open, and shut the tick it is back in reach', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x + 1, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  f.hold(KEY.G, 20_000);
  f.tick(20);
  // carried or pushed off, or walked on: six cells in
  f.bot = standing(cellOf(G.x, G.y, G.z + 6));
  f.tick();
  t.deepEqual(f.log, []);
  t.like(f.status(KEY.G), { open: true, heldMs: 0, leftOpen: true });
  // a renewal from there is refused: the gate is owed a shut click, not a hold
  t.deepEqual(f.hold(KEY.G, 20_000), { held: false, open: true, leftMs: 0 });
  f.tick(200);
  t.deepEqual(f.log, []);
  f.bot = standing(cellOf(G.x, G.y, G.z + 3));
  f.tick();
  t.deepEqual(f.log, ['222 hold G']);
  t.false(f.status(KEY.G).leftOpen);
  // a shut gate is held from any distance (the hold before the walk)
  f.bot = standing(cellOf(G.x, G.y, G.z + 9));
  t.true(f.hold(KEY.G, 20_000).held);
  f.tick(100);
  t.is(f.status(KEY.G).heldMs, 15_000);
});

test('strict: a gate the bot did not open is reported by its state, and never clicked', (t) => {
  const f = lock();
  // a player opens the yard gate with the bot 60 off, at the lock
  f.open.set(KEY.G, true);
  f.tick();
  t.deepEqual(f.status(KEY.G), { open: true, loaded: true, heldMs: 0, openTicks: 1, leftOpen: true });
  f.tick(300);
  t.deepEqual(f.log, []);
  // by the bot (within a click): left open only from 100 ticks on (a passage of a second or two is nobody's business)
  f.open.set(KEY.G, false);
  f.tick();
  f.bot = standing(cellOf(G.x, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  f.tick(99);
  t.like(f.status(KEY.G), { open: true, openTicks: 99, leftOpen: false });
  f.tick();
  t.like(f.status(KEY.G), { open: true, openTicks: 100, leftOpen: true });
  t.deepEqual(f.log, []);
  // its chunk away (the bot far off): as last read, and said so
  f.unloaded.add(KEY.G);
  f.tick(50);
  t.deepEqual(f.status(KEY.G), { open: true, loaded: false, heldMs: 0, openTicks: 100, leftOpen: true });
  f.unloaded.delete(KEY.G);
  f.open.set(KEY.G, false);
  f.tick();
  t.deepEqual(f.status(KEY.G), { open: false, loaded: true, heldMs: 0, openTicks: 0, leftOpen: false });
  // the count the brain compares with its own; a relaunched client has none
  t.is(f.holds.strictGates().length, 3);
  t.is(new Holds().strictGates().length, 0);
});

test('strict: sent again, what is known of a gate stays; a gate named no more is forgotten unless it is held or owed', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  f.tick(150);
  f.holds.strict([KEY.G, KEY.P, KEY.H], [[KEY.P, KEY.H]], [{ gate: KEY.P, box: INSIDE }]);
  t.like(f.status(KEY.G), { open: true, openTicks: 150, leftOpen: true });
  // off: nothing strict, nothing tracked
  f.holds.strict([], [], []);
  t.deepEqual(f.holds.tracked(), []);
  t.is(f.holds.pairs(), 0);
  // a held gate outside the strict set is kept until its hold is over and it reads shut
  f.hold(KEY.G, 1000);
  t.deepEqual(f.holds.tracked(), [KEY.G]);
  f.tick(20);
  t.deepEqual(f.log, ['170 hold G']);
  t.deepEqual(f.holds.tracked(), [KEY.G]);
  f.tick();
  t.deepEqual(f.holds.tracked(), []);
});

test('pair: the other gate is shut the same tick', (t) => {
  // out of the hall by a walk that is not the chores': H open behind the bot, two cells back, as its walk opens P
  const f = lock();
  f.bot = standing(cellOf(P.x, P.y, P.z - 1));
  f.open.set(KEY.H, true);
  f.tick(3);
  t.deepEqual(f.log, []);
  // (the closer would wait until the bot is 2.2 clear of H: it is 2.0 from it)
  t.true(f.sight(KEY.H).feet < 2.2);
  f.open.set(KEY.P, true);
  f.tick();
  t.deepEqual(f.log, ['4 pair H']);
  t.false(f.open.get(KEY.H));
  t.true(f.open.get(KEY.P));
  f.tick(20);
  t.is(f.log.length, 1);

  // and in: P open behind the bot as its walk opens H
  const g = lock();
  g.bot = standing(cellOf(H.x, H.y, H.z + 1));
  g.open.set(KEY.P, true);
  g.tick(2);
  g.open.set(KEY.H, true);
  g.tick();
  t.deepEqual(g.log, ['3 pair P']);
  t.is(g.holds.clicks('pair'), 1);
});

test('pair: the farther gate, held or not; the bot standing in a gateway shuts the other one', (t) => {
  // from the post with P held open (LOCK): H opens, and H is the farther
  const f = lock();
  f.hold(KEY.P, 20_000);
  f.open.set(KEY.P, true);
  f.tick(10);
  f.open.set(KEY.H, true);
  f.tick();
  t.deepEqual(f.log, ['11 pair H']);
  t.true(f.open.get(KEY.P));
  // the bot in P's cell, H open: H goes
  const g = lock();
  g.bot = standing(P);
  g.open.set(KEY.P, true);
  g.open.set(KEY.H, true);
  g.tick();
  t.deepEqual(g.log, ['1 pair H']);
  // the farther one out of a click's reach: tried every tick, clicked the tick it is in reach
  const k = lock();
  k.bot = standing(cellOf(P.x, P.y, P.z + 3));
  k.open.set(KEY.P, true);
  k.open.set(KEY.H, true);
  k.tick(40);
  t.deepEqual(k.log, []);
  t.true(k.sight(KEY.H).eye > REACH);
  k.bot = standing(cellOf(P.x, P.y, P.z + 1));
  k.tick();
  t.deepEqual(k.log, ['41 pair H']);
});

test('guard: P shut on a villager in the lock', (t) => {
  const f = lock();
  // a resident stepped into the lock behind a walk that left H open; the bot's walk opens P from outside
  f.villagers = [standing(cellOf(H.x, H.y, H.z + 1))];
  f.bot = standing(cellOf(P.x, P.y, P.z + 1));
  f.tick(5);
  t.deepEqual(f.log, []);
  f.open.set(KEY.P, true);
  f.tick();
  t.deepEqual(f.log, ['6 guard P']);
  t.false(f.open.get(KEY.P));
  // opened again (Baritone's next click): shut again on that tick, each time
  f.open.set(KEY.P, true);
  f.tick();
  f.open.set(KEY.P, true);
  f.tick();
  t.deepEqual(f.log, ['6 guard P', '7 guard P', '8 guard P']);
  t.is(f.holds.clicks('guard'), 3);
  // nobody in the box: P is the closer's, as any gate
  f.villagers = [];
  f.open.set(KEY.P, true);
  f.tick(30);
  t.is(f.log.length, 3);
  // a villager in the gateway itself, or in the hall, is not in the box
  f.villagers = [standing(P), standing(cellOf(H.x, H.y, H.z - 2))];
  f.tick(30);
  t.is(f.log.length, 3);
});

test('guard: a held P is the arriving villager\'s; the bot in P\'s cell is waited out; H open by design is left alone', (t) => {
  // LOCK: P held from the post, the ward walks in
  const f = lock();
  f.hold(KEY.P, 20_000);
  f.open.set(KEY.P, true);
  f.villagers = [standing(cellOf(P.x, P.y, P.z - 1))];
  f.tick(100);
  t.deepEqual(f.log, []);
  t.deepEqual(f.release(KEY.P, true), { released: true, open: false });
  t.deepEqual(f.log, ['100 released P']);

  // the bot in the gateway with a villager inside: shut as soon as it is out
  const g = lock();
  g.villagers = [standing(cellOf(H.x + 1, H.y, H.z + 2))];
  g.bot = standing(P);
  g.open.set(KEY.P, true);
  g.tick(15);
  t.deepEqual(g.log, []);
  g.bot = standing(cellOf(P.x, P.y, P.z + 1));
  g.tick();
  t.deepEqual(g.log, ['16 guard P']);

  // DOOR: H open with the ward in the lock, P shut. A walk opens P: the guard shuts P, and the pair leaves H be
  const k = lock();
  k.villagers = [standing(cellOf(H.x, H.y, H.z + 1))];
  k.open.set(KEY.H, true);
  k.bot = standing(cellOf(P.x, P.y, P.z + 1));
  k.tick(120);
  t.deepEqual(k.log, []);
  t.true(k.status(KEY.H).leftOpen);
  k.open.set(KEY.P, true);
  k.tick();
  t.deepEqual(k.log, ['121 guard P']);
  t.true(k.open.get(KEY.H));
  // with the guard's click held off (the bot eating), the pair has nothing it may click either; then the guard first
  k.open.set(KEY.P, true);
  k.busy = true;
  k.tick(10);
  t.is(k.log.length, 1);
  k.busy = false;
  k.tick();
  t.deepEqual(k.log, ['121 guard P', '132 guard P']);
  t.true(k.open.get(KEY.H));
});

test('a click that does nothing is not made again at once; a gate read shut is clicked the tick it opens again', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x + 1, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  f.hold(KEY.G, 500);
  // the click is no click here (the client's own refusal): the gate still reads open after it
  f.refuse = true;
  f.tick(35);
  t.deepEqual(f.log, ['10 hold G', '20 hold G', '30 hold G']);
  // the closer's own click on a strict gate counts the same (Gates.java tells the rules of it)
  f.holds.clicked(KEY.G, f.now);
  t.true(f.holds.recent(KEY.G, f.now + 9));
  t.false(f.holds.recent(KEY.G, f.now + 10));
  // read shut, the gate may be clicked the tick it opens again
  f.refuse = false;
  f.tick(10);
  t.is(f.log.at(-1), '45 hold G');
  t.false(f.holds.recent(KEY.G, f.now));
});

test('a release without shut clicks nothing: the gate is the closer\'s again', (t) => {
  const f = lock();
  f.bot = standing(cellOf(G.x + 1, G.y, G.z + 2));
  f.open.set(KEY.G, true);
  f.hold(KEY.G, 20_000);
  f.tick(10);
  t.deepEqual(f.release(KEY.G, false), { released: true, open: true });
  f.tick(50);
  t.deepEqual(f.log, []);
  t.like(f.status(KEY.G), { open: true, heldMs: 0 });
});

// ---- the brain's side of B4 ----

test('no file of the brain but pens.ts switches the gate closer off', (t) => {
  const dir = path.join(process.cwd(), 'src', 'client', 'brain');
  const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith('.ts'));
  t.true(files.includes('pens.ts'));
  /** Code without its comments (a comment may name the call). */
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const f of files) {
    if (f === 'pens.ts') continue;
    const src = code(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of src.matchAll(/(['"`])gates\.auto\1/g)) {
      // the call's parameters: `enabled: true` written out, nothing computed
      const args = src.slice(m.index, m.index + 160);
      t.regex(args, /^(['"`])gates\.auto\1,\s*\{\s*enabled:\s*true\s*[,}]/, `${f}: ${args.split('\n')[0]}`);
    }
  }
  // pens.ts itself does (leading an animal through a pen's gate), and the bridge ends that by itself (B4)
  t.regex(code(fs.readFileSync(path.join(dir, 'pens.ts'), 'utf8')), /'gates\.auto',[^;]*\benabled: (on|false)\b/);
});
