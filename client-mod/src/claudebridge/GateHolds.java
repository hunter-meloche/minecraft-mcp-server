package claudebridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Which gate the bridge clicks shut by itself, and when: the holds (gates.hold, gates.release), the strict set with
 * its pairs and guards (gates.strict, gates.status) and the timer of gates.auto. No Minecraft type in here: Gates.java
 * reads the world and makes the clicks, this file only decides, so a scratch check and the TypeScript port in
 * tests/client/gates-bridge.test.ts can hold it rule by rule.
 *
 * Why (the villager fetch, live Nov 24): to let a villager through a yard gate the lead had switched the closer off,
 * and the bot's own walk then left the yard's west gate open, the night that villager got out of the yard. And the
 * hall's gate let a villager out each of the three times it stood open with one awake inside, once within 4 s. So:
 * - a HOLD keeps one gate open for a time the brain must keep renewing, and the bridge shuts it when the hold ends:
 *   its time out (a dead brain's runs out by itself), a release, or the bot gone from it. The closer is never off.
 * - a STRICT gate is never forgotten by the closer once it took it, and is reported by its block state whoever
 *   opened it: "left open" is open, not held, and either out of the bot's reach or open for 100 ticks.
 * - of a PAIR (the lock's two gates) never both stand open: the one farther from the bot is shut on the tick the
 *   second opens, whatever walk opened it.
 * - a GUARD keeps a gate from standing open onto a villager in its box (the lock) unless it is held for that one.
 * Times are client ticks (Ticker.ticks()), 50 ms each; a click is only ever a shut click: nothing here opens a gate.
 */
final class GateHolds {
    static final int TICK_MS = 50;
    /** A hold lasts this long at most without being renewed (the brain renews each second). */
    static final int MAX_HOLD_MS = 30_000;
    /** gates.auto {enabled: false} lasts this long at most, and by default: then the closer is on again by itself. */
    static final int MAX_OFF_MS = 120_000;
    /** A click lands on a gate whose middle is this far from the eye at most (the closer's own number). */
    static final double REACH = 4.4;
    /** Open this many ticks with no hold on it, a strict gate is "left open" wherever the bot stands. */
    static final int LEFT_OPEN_TICKS = 100;
    /**
     * After a click the gate reads shut at once: the client sets the block itself (MultiPlayerGameMode.useItemOn runs
     * FenceGateBlock.useWithoutItem on the client's level before the server answers), and Gates.java reads the gate
     * again after each click. One that still reads open then was no click at all here (the client's own refusal: a
     * spectator, a cell beyond the world's border): the next click waits this many ticks. A gate read shut forgets its
     * click: it is clicked again on the very tick it reads open again, whoever opened it (Baritone's next click on a
     * guarded gate, or the server's word that it refused the last one).
     */
    static final int CLICK_GAP = 10;

    /**
     * A gate as Gates.java read it this tick: `loaded` false when its chunk is not there (then `open` and `powered`
     * say nothing and what was last read stands); `eye` and `feet` the distances from the bot's eye and from its
     * position to the gate's middle; `inside` when the bot stands in its cell (or the cell over or under it).
     */
    record Sight(long key, boolean loaded, boolean open, boolean powered, double eye, double feet, boolean inside) { }

    /** A guarded gate and its box of cells, both corners in it: no villager in the box while the gate stands open. */
    record Guard(long gate, int x1, int y1, int z1, int x2, int y2, int z2) {
        boolean holds(int x, int y, int z) {
            return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)
                && z >= Math.min(z1, z2) && z <= Math.max(z1, z2);
        }
    }

    /** A click to make now, and the rule that asks for it: "hold" (a hold's end), "pair" or "guard". */
    record Click(long key, String why) { }

    private static final class Gate {
        boolean loaded, open, powered, inside;
        double eye = Double.POSITIVE_INFINITY, feet = Double.POSITIVE_INFINITY;
        /** ticks it has read open in a row */
        int openTicks;
        /** the tick its hold ends; -1: not held */
        long until = -1;
        /** a hold of it ended with it open: the bridge's to shut, however long that takes */
        boolean owed;
        /** the tick of the last click on it that it has not yet read shut after; -1: none */
        long clickedAt = -1;
    }

    private final Map<Long, Gate> gates = new LinkedHashMap<>();
    private final Set<Long> strict = new LinkedHashSet<>();
    private final List<long[]> pairs = new ArrayList<>();
    private final List<Guard> guards = new ArrayList<>();
    private final Map<String, Integer> clicks = new LinkedHashMap<>();
    /** the tick the closer comes back on; -1: it is on */
    private long offUntil = -1;

    static long ticks(int ms) { return (ms + TICK_MS - 1) / TICK_MS; }

    // ---------------------------------------------------------------- gates.auto's timer (B4)

    /** The closer off for `forMs` (none given, or over the cap: the cap). A brain killed with it off no longer leaves it off. */
    int off(int forMs, long now) {
        int ms = forMs <= 0 || forMs > MAX_OFF_MS ? MAX_OFF_MS : forMs;
        offUntil = now + ticks(ms);
        return ms;
    }

    void on() { offUntil = -1; }

    boolean enabled(long now) { return offUntil < 0 || now >= offUntil; }

    int offLeftMs(long now) { return enabled(now) ? 0 : (int) (offUntil - now) * TICK_MS; }

    // ---------------------------------------------------------------- the strict set, its pairs and guards (B3, B7)

    /** The whole of it anew (empty: off). What is known of a gate that stays in it is kept. */
    void strict(long[] gates, long[][] pairs, Guard[] guards) {
        strict.clear();
        for (long k : gates) { strict.add(k); gate(k); }
        this.pairs.clear();
        for (long[] p : pairs) { this.pairs.add(new long[] { p[0], p[1] }); gate(p[0]); gate(p[1]); }
        this.guards.clear();
        for (Guard g : guards) { this.guards.add(g); gate(g.gate()); }
        prune();
    }

    boolean isStrict(long key) { return strict.contains(key); }

    List<Long> strict() { return new ArrayList<>(strict); }

    int pairs() { return pairs.size(); }

    List<Guard> guards() { return new ArrayList<>(guards); }

    /** Every gate Gates.java reads each tick: the strict ones, the pairs' and guards', the held and the owed. */
    List<Long> tracked() { return new ArrayList<>(gates.keySet()); }

    private Gate gate(long key) { return gates.computeIfAbsent(key, k -> new Gate()); }

    private boolean named(long key) {
        if (strict.contains(key)) return true;
        for (long[] p : pairs) if (p[0] == key || p[1] == key) return true;
        for (Guard g : guards) if (g.gate() == key) return true;
        return false;
    }

    private void prune() {
        gates.entrySet().removeIf(e -> !named(e.getKey()) && e.getValue().until < 0 && !e.getValue().owed);
    }

    // ---------------------------------------------------------------- what is read

    /** A gate as read just now. Counts nothing and clicks nothing: gates.status and the calls look before they answer. */
    void look(Sight s) {
        Gate g = gate(s.key());
        g.loaded = s.loaded();
        g.eye = s.eye();
        g.feet = s.feet();
        g.inside = s.inside();
        if (!s.loaded()) return; // out of sight: as last read
        g.open = s.open();
        g.powered = s.powered();
        if (!g.open) g.clickedAt = -1;
    }

    boolean open(long key) { Gate g = gates.get(key); return g != null && g.open; }

    boolean loaded(long key) { Gate g = gates.get(key); return g != null && g.loaded; }

    int openTicks(long key) { Gate g = gates.get(key); return g == null ? 0 : g.openTicks; }

    /** Open with no hold on it, and the bot out of a click's reach of it or the gate open for 100 ticks. */
    boolean leftOpen(long key, long now) {
        Gate g = gates.get(key);
        return g != null && g.open && !held(key, now) && (!g.loaded || g.eye > REACH || g.openTicks >= LEFT_OPEN_TICKS);
    }

    // ---------------------------------------------------------------- holds (B2)

    /**
     * Hold a gate (looked at just before) for `ms`, the cap at most; again to renew. A shut gate is held too: the
     * brain holds its gate BEFORE the walk that opens it, since after the walk the closer has shut it already. A hold
     * never opens a gate: it keeps one that opens from being shut. The milliseconds held; 0, and no hold, for a gate
     * that stands open out of the bot's reach (then it is owed a shut click, like a hold that ended there).
     */
    int hold(long key, int ms, long now) {
        if (ms <= 0) return 0;
        Gate g = gate(key);
        if (g.open && g.eye > REACH) { g.until = -1; g.owed = true; return 0; }
        g.until = now + ticks(Math.min(ms, MAX_HOLD_MS));
        g.owed = false;
        return (int) (g.until - now) * TICK_MS;
    }

    /**
     * End a hold. `shut`: the gate (looked at just before) is the bridge's to click shut if it stands open, held
     * before or not. Without it an open gate goes back to the closer's ordinary rule (Gates.java). Whether a hold was on.
     */
    boolean release(long key, boolean shut, long now) {
        boolean was = held(key, now);
        Gate g = shut ? gate(key) : gates.get(key);
        if (g != null) {
            g.until = -1;
            if (shut) g.owed = g.open;
        }
        prune();
        return was;
    }

    boolean held(long key, long now) { Gate g = gates.get(key); return g != null && g.until >= 0 && now < g.until; }

    int heldMs(long key, long now) { Gate g = gates.get(key); return held(key, now) ? (int) (g.until - now) * TICK_MS : 0; }

    // ---------------------------------------------------------------- the clicks

    /**
     * Whether a click on this gate can be made on this tick, and if so it is taken as made. `busy`: one of the closer's
     * four skips holds (a screen open, an item in use, a block being broken, the sneak key down): those delay a click,
     * they never drop it. Never with the bot in the gate's cell, never a powered gate (redstone's, not the bot's).
     */
    private boolean click(Gate g, long now, boolean busy) {
        if (busy || !g.loaded || g.powered || g.inside || g.eye > REACH) return false;
        if (g.clickedAt >= 0 && now - g.clickedAt < CLICK_GAP) return false;
        g.clickedAt = now;
        return true;
    }

    private Click made(long key, String why) {
        clicks.merge(why, 1, Integer::sum);
        return new Click(key, why);
    }

    /** Clicks made since the client started, by rule ("hold", "pair", "guard"). */
    int clicks(String why) { return clicks.getOrDefault(why, 0); }

    /** A click Gates.java's own closer made on a gate kept here (a strict one: it stays in the closer's set until it reads shut). */
    void clicked(long key, long now) { Gate g = gates.get(key); if (g != null) g.clickedAt = now; }

    /** Clicked within the gap and not read shut since: no second click yet, by anyone. */
    boolean recent(long key, long now) { Gate g = gates.get(key); return g != null && g.clickedAt >= 0 && now - g.clickedAt < CLICK_GAP; }

    /** gates.release {shut}: the click at once when it can be made, so that the reply already reads the gate shut. */
    boolean shutNow(long key, long now, boolean busy) {
        Gate g = gates.get(key);
        if (g == null || !g.owed || !g.open || !click(g, now, busy)) return false;
        made(key, "hold");
        return true;
    }

    /**
     * One tick, after every tracked gate was looked at: the clicks to make now, each made by Gates.java at once.
     * `villagers`: the guarded gates with a villager in their box at this moment.
     */
    List<Click> tick(long now, boolean busy, Set<Long> villagers) {
        List<Click> out = new ArrayList<>();
        for (Gate g : gates.values()) {
            if (g.loaded) g.openTicks = g.open ? g.openTicks + 1 : 0;
            // a hold ends when its time is out, or when the bot has left the open gate (a click no longer reaches it):
            // from then on the gate is owed a shut click
            if (g.until >= 0 && (now >= g.until || (g.open && g.eye > REACH))) { g.until = -1; g.owed = g.open; }
            if (g.owed && g.loaded && !g.open) g.owed = false;
        }
        // the guard: open with no hold on it and a villager in its box. Shut on this tick (the bot in the gate's cell: as
        // soon as it is out)
        for (Guard gd : guards) {
            Gate g = gates.get(gd.gate());
            if (g.loaded && g.open && g.until < 0 && villagers.contains(gd.gate()) && click(g, now, busy)) out.add(made(gd.gate(), "guard"));
        }
        // the pair: both open (one just clicked counts as shut). The one farther from the bot is shut at once: no wait
        // until the bot is clear of it by 2.2, as the closer waits
        for (long[] p : pairs) {
            Gate a = gates.get(p[0]), b = gates.get(p[1]);
            if (!(a.loaded && a.open && a.clickedAt != now) || !(b.loaded && b.open && b.clickedAt != now)) continue;
            boolean second = b.feet > a.feet;
            if (click(second ? b : a, now, busy)) out.add(made(second ? p[1] : p[0], "pair"));
        }
        // what a hold's end left open: tried every tick until it reads shut
        for (Map.Entry<Long, Gate> e : gates.entrySet()) {
            Gate g = e.getValue();
            if (g.owed && g.open && click(g, now, busy)) out.add(made(e.getKey(), "hold"));
        }
        prune();
        return out;
    }
}
