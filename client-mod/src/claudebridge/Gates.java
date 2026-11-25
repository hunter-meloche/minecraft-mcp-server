package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.npc.villager.AbstractVillager;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static claudebridge.Json.blockPos;
import static claudebridge.Json.intParam;
import static claudebridge.Json.obj;
import static claudebridge.Json.pos;
import static claudebridge.Json.round;
import static claudebridge.Json.strParam;

/**
 * Shut the gates and doors the bot opens, behind it. Baritone opens a fence gate or door to walk through and leaves
 * it open, which lets mobs into the fenced yard all day (the shelter only swept them shut at dusk). A gate or door
 * that opens while the bot is right next to it is taken as the bot's; once the bot is clear of it (and still within
 * reach) it is clicked shut, the way a player would. Doors a pressure plate holds open are left to the plate.
 * Paused while the brain needs a gate open (leading an animal into a pen): gates.auto {enabled: false}, which now
 * runs out by itself (forMs, two minutes at most), so a brain killed with the closer off no longer leaves it off.
 *
 * And the gates a villager must never find open (the fetch, live Nov 24: with the closer switched off for a villager
 * the bot's own walk left the yard's west gate open, the night that villager got out of the yard; and villagers left
 * the hall by its gate each of the three times it stood open with one awake inside). The rules are GateHolds' (pure,
 * held to a port in tests/client/gates-bridge.test.ts); this file reads the world for them and makes their clicks:
 * - gates.hold / gates.release: one gate kept open while the brain renews its hold; the bridge shuts it when the
 *   hold ends, and keeps trying. A hold never opens a gate.
 * - gates.strict / gates.status: gates the closer never forgets once it took them, each reported by its block state
 *   whoever opened it; pairs of which never both stand open; guards, a gate never open onto a villager in its box.
 * These hold with the closer on or off. Checked against the 26.3 jar (javap): MultiPlayerGameMode.useItemOn runs the
 * click on the client's own level before the server answers, and FenceGateBlock.useWithoutItem sets the block on the
 * level it is called on, so after a click the client reads the gate shut at once; Level.isLoaded tells a gate out of
 * sight (its cell reads air) from one that is gone.
 */
public final class Gates {
    private Gates() { }

    /** The holds, the strict set and gates.auto's timer: what is clicked shut beyond the closer's own rule. */
    private static final GateHolds HOLDS = new GateHolds();
    /** The dimension the strict gates stand in (the brain's home is in the overworld): elsewhere they are out of sight. */
    private static String dimension = "overworld";
    private static boolean wasEnabled = true;
    /** the last shut click said, and the tick it was said at */
    private static String said;
    private static long saidAt;
    /** Open states seen last tick, around the bot. */
    private static final Map<Long, Boolean> seen = new HashMap<>();
    /** The bot's open gates and doors (lower halves), with the tick they opened. */
    private static final Map<Long, Long> opened = new HashMap<>();
    private static final int R = 3;
    /** where the bot stood last tick, and for how many ticks */
    private static BlockPos stillAt;
    private static int stillFor;

    private static boolean gateOrDoor(BlockState s) {
        if (s.getBlock() instanceof FenceGateBlock) return true;
        return s.getBlock() instanceof DoorBlock && s.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.LOWER
            && !Names.block(s).equals("iron_door");
    }

    private static boolean open(BlockState s) {
        return s.hasProperty(BlockStateProperties.OPEN) && s.getValue(BlockStateProperties.OPEN);
    }

    private static boolean powered(BlockState s) {
        return s.hasProperty(BlockStateProperties.POWERED) && s.getValue(BlockStateProperties.POWERED);
    }

    /** Whether a gate's cell can be read at all: its dimension, and its chunk there. */
    private static boolean sees(Minecraft mc, BlockPos q) {
        return dimension.equals(Names.dimension(mc.level)) && mc.level.isLoaded(q);
    }

    /** A gate as GateHolds wants it read: its state, and where the bot is to it (the closer's own measures). */
    private static GateHolds.Sight sight(Minecraft mc, LocalPlayer p, BlockPos q) {
        // in another dimension the bot is nowhere near it, whatever its coordinates there say
        if (!dimension.equals(Names.dimension(mc.level))) return new GateHolds.Sight(q.asLong(), false, false, false, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, false);
        boolean loaded = mc.level.isLoaded(q);
        BlockState s = mc.level.getBlockState(q);
        boolean gate = loaded && gateOrDoor(s);
        Vec3 c = Vec3.atCenterOf(q);
        BlockPos me = p.blockPosition();
        boolean inside = q.equals(me) || q.equals(me.above()) || q.equals(me.below());
        return new GateHolds.Sight(q.asLong(), loaded, gate && open(s), gate && powered(s), p.getEyePosition().distanceTo(c), c.distanceTo(p.position()), inside);
    }

    /**
     * The closer's four skips, for the clicks of GateHolds: they delay a click, they never drop it. Sneaking by the key
     * or by Baritone's own input (which presses no key): a sneaking click goes to what the bot holds, and a block in
     * hand would be put down beside the gate.
     */
    private static boolean busy(Minecraft mc, LocalPlayer p) {
        return mc.gui.screen() != null || p.isUsingItem() || mc.gameMode.isDestroying() || mc.options.keyShift.isDown() || p.isShiftKeyDown();
    }

    /** A shut click on the side facing the bot, as the closer's own (the server checks the reach, not the look). */
    private static void click(Minecraft mc, LocalPlayer p, BlockPos q) {
        Vec3 c = Vec3.atCenterOf(q);
        Direction face = Direction.getApproximateNearest(p.position().x - c.x, 0, p.position().z - c.z);
        Vec3 hit = c.add(face.getStepX() * 0.5, 0, face.getStepZ() * 0.5);
        mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hit, face, q, false));
    }

    /** Every gate GateHolds keeps, read afresh (before its tick, and before a call answers by a gate's state). */
    private static void look(Minecraft mc, LocalPlayer p) {
        for (long k : HOLDS.tracked()) HOLDS.look(sight(mc, p, BlockPos.of(k)));
    }

    /** The holds' ends, the pairs and the guards: their clicks, made at once. With the closer on or off. */
    private static void rules(Minecraft mc, LocalPlayer p, long now) {
        if (HOLDS.tracked().isEmpty()) return;
        look(mc, p);
        // the guarded gates that read open with a villager standing in their box
        Set<Long> villagers = new HashSet<>();
        for (GateHolds.Guard g : HOLDS.guards()) {
            if (!HOLDS.open(g.gate())) continue;
            for (Entity e : mc.level.entitiesForRendering()) {
                if (!(e instanceof AbstractVillager) || !e.isAlive()) continue;
                BlockPos at = e.blockPosition();
                if (g.holds(at.getX(), at.getY(), at.getZ())) { villagers.add(g.gate()); break; }
            }
        }
        for (GateHolds.Click k : HOLDS.tick(now, busy(mc, p), villagers)) {
            BlockPos q = BlockPos.of(k.key());
            say(q.toShortString() + " (" + k.why() + ")", now);
            click(mc, p, q);
            // read again: a click that took reads shut at once (the client sets the block itself), and a gate read
            // shut may be clicked the very tick it opens again (Baritone's next click on a guarded gate)
            HOLDS.look(sight(mc, p, q));
        }
    }

    /**
     * A shut click of the rules, said: the same gate and rule once in five seconds (a walk that keeps opening a
     * guarded gate is shut out every few ticks; gates.status counts every click).
     */
    private static void say(String line, long now) {
        if (line.equals(said) && now - saidAt < 100) return;
        said = line;
        saidAt = now;
        System.out.println("[claudebridge] gates: shut " + line);
    }

    private static void tick(Minecraft mc) {
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null || mc.gameMode == null) return;
        long tick = Ticker.ticks();
        rules(mc, p, tick);
        boolean enabled = HOLDS.enabled(tick);
        if (enabled && !wasEnabled) System.out.println("[claudebridge] gates: the closer is on again by itself (its time off ran out, nobody switched it back on)");
        wasEnabled = enabled;
        if (!enabled) { opened.clear(); seen.clear(); return; }
        BlockPos me = p.blockPosition();
        Vec3 eye = p.getEyePosition();
        // shut in a doorway: a door a pressure plate held open closed on the bot as it stood in it (the plate let go),
        // and Baritone, pathing on, never opens a door it stands in: open it (the closer shuts it once it's through)
        stillFor = me.equals(stillAt) ? stillFor + 1 : 0;
        stillAt = me;
        // while a Baritone job is on (it may be failing to find a path out of the doorway, so not "pathing" as such)
        if ((stillFor == 20 || stillFor % 200 == 60) && Processes.active() != null) {
            for (BlockPos q : new BlockPos[]{me, me.above()}) {
                BlockState s = mc.level.getBlockState(q);
                BlockPos lower = s.getBlock() instanceof DoorBlock && s.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.UPPER ? q.below() : q;
                BlockState ls = mc.level.getBlockState(lower);
                if (!gateOrDoor(ls) || open(ls)) continue;
                Vec3 c = Vec3.atCenterOf(lower);
                mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(c, Direction.UP, lower, false));
                opened.put(lower.asLong(), Ticker.ticks());
                break;
            }
            // a closed door right next to it that its look can't click: Baritone opens a door by a right click on the
            // crosshair, aimed at the door's centre, and something in the bot's way with an outline but no collision
            // (a wall torch hung on the door's side of its head cell) takes the click. Nov 10, 12 and 23: a torch at
            // -549,64,2185 held the bot inside the storage house's south door for hours ("Could not reach ...: timed
            // out after 60s. Stopped at (-549, 63, 2185)" for shelter, smelt and every round). Click the door itself.
            for (Direction d : Direction.Plane.HORIZONTAL) {
                BlockPos lower = me.relative(d);
                BlockState ls = mc.level.getBlockState(lower);
                if (!(ls.getBlock() instanceof DoorBlock) || !gateOrDoor(ls) || open(ls)) continue;
                boolean clickable = false;
                for (BlockPos half : new BlockPos[]{lower, lower.above()}) {
                    BlockHitResult ray = mc.level.clip(new ClipContext(eye, Vec3.atCenterOf(half), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, p));
                    if (ray.getType() == HitResult.Type.MISS || ray.getBlockPos().equals(lower) || ray.getBlockPos().equals(lower.above())) clickable = true;
                }
                if (clickable) continue;
                Direction face = d.getOpposite();
                Vec3 hit = Vec3.atCenterOf(lower).add(face.getStepX() * 0.5, 0, face.getStepZ() * 0.5);
                System.out.println("[claudebridge] gates: the closed door at " + lower.toShortString() + " is out of the look's click (something in the way): opened it");
                mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hit, face, lower, false));
                opened.put(lower.asLong(), Ticker.ticks());
                break;
            }
        }
        // gates and doors that just opened next to the bot are its own
        Map<Long, Boolean> now = new HashMap<>();
        for (BlockPos q : BlockPos.betweenClosed(me.offset(-R, -1, -R), me.offset(R, 2, R))) {
            BlockState s = mc.level.getBlockState(q);
            if (!gateOrDoor(s)) continue;
            long k = q.asLong();
            boolean o = open(s);
            now.put(k, o);
            Boolean was = seen.get(k);
            if (o && was != null && !was && !powered(s) && Vec3.atCenterOf(q).distanceTo(p.position()) <= 2.5) opened.putIfAbsent(k, Ticker.ticks());
        }
        seen.clear();
        seen.putAll(now);
        // shut them once the bot is clear of them
        for (Iterator<Map.Entry<Long, Long>> it = opened.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<Long, Long> e = it.next();
            BlockPos q = BlockPos.of(e.getKey());
            // a strict gate is never forgotten for distance or age (the escape of Nov 24 was an open gate nobody
            // owned), nor while it is out of sight: it is clicked shut as soon as the rules below allow
            boolean strict = HOLDS.isStrict(e.getKey());
            if (strict && !sees(mc, q)) continue;
            BlockState s = mc.level.getBlockState(q);
            if (!gateOrDoor(s) || !open(s) || powered(s)) { it.remove(); continue; }
            // held open for the brain (gates.hold): left open while the hold lives. Its end is GateHolds' to shut
            if (HOLDS.held(e.getKey(), tick)) continue;
            Vec3 c = Vec3.atCenterOf(q);
            double d = c.distanceTo(p.position());
            if (!strict && (d > 6 || Ticker.ticks() - e.getValue() > 20 * 60)) { it.remove(); continue; } // out of reach: the shelter's sweep
            boolean inside = q.equals(me) || q.equals(me.above()) || q.equals(me.below());
            if (inside || d < 2.2 || eye.distanceTo(c) > 4.4) continue;
            if (mc.gui.screen() != null || p.isUsingItem() || mc.gameMode.isDestroying()) continue;
            // a click on the side facing the bot; no need to turn its head (the server checks the reach, not the look)
            Direction face = Direction.getApproximateNearest(p.position().x - c.x, 0, p.position().z - c.z);
            Vec3 hit = c.add(face.getStepX() * 0.5, 0, face.getStepZ() * 0.5);
            boolean sneaking = mc.options.keyShift.isDown();
            if (sneaking) continue; // a sneaking click with something in hand would use the item, not the gate
            if (HOLDS.recent(e.getKey(), tick)) continue; // clicked a moment ago (a pair's, a guard's, a hold's end): once
            mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hit, face, q, false));
            // a strict gate stays the closer's until it reads shut (a click that did nothing here is made again)
            if (strict) HOLDS.clicked(e.getKey(), tick); else it.remove();
        }
    }

    /** Why a hold cannot be taken on this cell (it is out of sight, or no gate), or null. */
    private static String notAGate(Minecraft mc, BlockPos q) {
        String here = Names.dimension(mc.level);
        if (!dimension.equals(here)) return "the bot is in " + here + ": the gates the bridge keeps are in " + dimension;
        if (!mc.level.isLoaded(q)) return "not loaded";
        BlockState s = mc.level.getBlockState(q);
        return gateOrDoor(s) ? null : "no gate or door at " + q.toShortString() + ": " + Names.block(s);
    }

    private static BlockPos cell(JsonObject o) {
        if (o == null || !o.has("x") || !o.has("y") || !o.has("z")) throw new IllegalArgumentException("a gate needs x, y, z");
        return blockPos(o);
    }

    public static void register(BridgeServer s) {
        // {enabled, forMs?} -> {enabled, autoOffLeftMs?}: shut the bot's gates and doors behind it (default on). Off
        // lasts forMs (two minutes at most, and by default), then the closer is on again by itself: the pens call again
        // while a walk lasts, and a brain killed with it off no longer leaves it off (the escape of Nov 24)
        s.register("gates.auto", true, (p, c) -> {
            boolean enabled = !p.has("enabled") || p.get("enabled").getAsBoolean();
            long now = Ticker.ticks();
            if (enabled) HOLDS.on(); else HOLDS.off(intParam(p, "forMs", GateHolds.MAX_OFF_MS), now);
            if (enabled) wasEnabled = true; // asked for: the tick says only a return by the timer
            JsonObject r = obj("enabled", enabled);
            if (!enabled) r.addProperty("autoOffLeftMs", HOLDS.offLeftMs(now));
            return r;
        });

        // {x, y, z, ms} -> {held, open, leftMs} | {held: false, open, leftMs: 0, reason}. Keep this gate open for ms
        // (30000 at most; again to renew): whoever opens it and from wherever, nothing shuts it while the hold lives.
        // Taken on a shut gate too (the brain holds a gate before the walk that opens it) and never opens one. When the
        // hold ends (its time out, gates.release, or the bot out of a click's reach of the open gate) the bridge
        // clicks it shut and keeps trying; out of reach it is "left open" in gates.status until the bot is back
        s.register("gates.hold", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = Handlers.player();
            BlockPos q = cell(p);
            long now = Ticker.ticks();
            String why = notAGate(mc, q);
            if (why != null) return obj("held", false, "open", false, "leftMs", 0, "reason", why);
            int ms = intParam(p, "ms", 0);
            if (ms <= 0) return obj("held", false, "open", open(mc.level.getBlockState(q)), "leftMs", 0, "reason", "ms: how long to hold it (" + GateHolds.MAX_HOLD_MS + " at most)");
            GateHolds.Sight at = sight(mc, pl, q);
            HOLDS.look(at);
            int left = HOLDS.hold(q.asLong(), ms, now);
            if (left <= 0) {
                return obj("held", false, "open", at.open(), "leftMs", 0,
                    "reason", "open and " + round(at.eye()) + " from the bot's eye, out of a click's reach (" + GateHolds.REACH + "): shut once the bot is by it");
            }
            return obj("held", true, "open", at.open(), "leftMs", left);
        });

        // {x, y, z, shut?: true} -> {released, open}. End a hold. shut: the gate is clicked shut now if that can be done
        // (the reply then reads it shut), else on the first tick it can, held before or not; without it an open gate is
        // the closer's again, shut once the bot is clear of it
        s.register("gates.release", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = Handlers.player();
            BlockPos q = cell(p);
            long key = q.asLong(), now = Ticker.ticks();
            boolean shut = p.has("shut") && p.get("shut").getAsBoolean();
            GateHolds.Sight at = sight(mc, pl, q);
            HOLDS.look(at);
            boolean last = HOLDS.open(key);
            boolean released = HOLDS.release(key, shut, now);
            if (shut && HOLDS.shutNow(key, now, busy(mc, pl))) {
                say(q.toShortString() + " (released)", now);
                click(mc, pl, q);
                HOLDS.look(sight(mc, pl, q));
            } else if (!shut && at.loaded() && at.open() && HOLDS.enabled(now)) {
                opened.putIfAbsent(key, now);
            }
            JsonObject r = obj("released", released, "open", at.loaded() ? sight(mc, pl, q).open() : last);
            if (!at.loaded()) r.addProperty("loaded", false);
            return r;
        });

        // {gates: [{x, y, z}...], pairs: [[{x, y, z}, {x, y, z}]...], guard: [{gate: {x, y, z}, box: {x1, y1, z1, x2, y2,
        // z2}}...], dimension?: "overworld"} -> {strict, pairs, guard}. The whole of it anew at every call (nothing given:
        // off). The brain sends it at every start and whenever gates.status counts another number than its own: these
        // sets die with the client
        s.register("gates.strict", true, (p, c) -> {
            List<Long> gates = new java.util.ArrayList<>();
            if (p.has("gates") && p.get("gates").isJsonArray()) for (var e : p.getAsJsonArray("gates")) gates.add(cell(e.getAsJsonObject()).asLong());
            List<long[]> pairs = new java.util.ArrayList<>();
            if (p.has("pairs") && p.get("pairs").isJsonArray()) {
                for (var e : p.getAsJsonArray("pairs")) {
                    JsonArray two = e.getAsJsonArray();
                    if (two.size() != 2) throw new IllegalArgumentException("a pair is two gates");
                    long a = cell(two.get(0).getAsJsonObject()).asLong(), b = cell(two.get(1).getAsJsonObject()).asLong();
                    if (a == b) throw new IllegalArgumentException("a pair is two gates, not one twice");
                    pairs.add(new long[] { a, b });
                }
            }
            List<GateHolds.Guard> guards = new java.util.ArrayList<>();
            if (p.has("guard") && p.get("guard").isJsonArray()) {
                for (var e : p.getAsJsonArray("guard")) {
                    JsonObject g = e.getAsJsonObject(), box = g.getAsJsonObject("box");
                    if (box == null) throw new IllegalArgumentException("a guard needs gate and box");
                    for (String k : new String[] { "x1", "y1", "z1", "x2", "y2", "z2" }) if (!box.has(k)) throw new IllegalArgumentException("a guard's box needs " + k);
                    guards.add(new GateHolds.Guard(cell(g.getAsJsonObject("gate")).asLong(), intParam(box, "x1", 0), intParam(box, "y1", 0), intParam(box, "z1", 0),
                        intParam(box, "x2", 0), intParam(box, "y2", 0), intParam(box, "z2", 0)));
                }
            }
            dimension = strParam(p, "dimension", "overworld");
            HOLDS.strict(gates.stream().mapToLong(Long::longValue).toArray(), pairs.toArray(new long[0][]), guards.toArray(new GateHolds.Guard[0]));
            Minecraft mc = Minecraft.getInstance();
            if (mc.player != null && mc.level != null) look(mc, mc.player);
            System.out.println("[claudebridge] gates: " + gates.size() + " strict, " + pairs.size() + " pair(s), " + guards.size() + " guard(s) in " + dimension);
            return obj("strict", HOLDS.strict().size(), "pairs", HOLDS.pairs(), "guard", HOLDS.guards().size());
        });

        // {} -> {enabled, autoOffLeftMs?, strict: [{x, y, z, open, loaded, heldMs, openTicks, leftOpen}], count, clicks:
        // {hold, pair, guard}}. Every strict gate by its block state, read now, whoever opened it (loaded: false: out of
        // sight, as last read). leftOpen: open, not held, and the bot out of a click's reach of it or the gate open for
        // 100 ticks. clicks: the shut clicks the rules have made since the client started
        s.register("gates.status", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            long now = Ticker.ticks();
            boolean world = mc.player != null && mc.level != null;
            if (world) look(mc, mc.player);
            JsonArray strict = new JsonArray();
            for (long k : HOLDS.strict()) {
                JsonObject o = pos(BlockPos.of(k));
                o.addProperty("open", HOLDS.open(k));
                o.addProperty("loaded", world && HOLDS.loaded(k));
                o.addProperty("heldMs", HOLDS.heldMs(k, now));
                o.addProperty("openTicks", HOLDS.openTicks(k));
                o.addProperty("leftOpen", HOLDS.leftOpen(k, now));
                strict.add(o);
            }
            JsonObject r = obj("enabled", HOLDS.enabled(now), "strict", strict, "count", strict.size(),
                "clicks", obj("hold", HOLDS.clicks("hold"), "pair", HOLDS.clicks("pair"), "guard", HOLDS.clicks("guard")));
            if (!HOLDS.enabled(now)) r.addProperty("autoOffLeftMs", HOLDS.offLeftMs(now));
            return r;
        });
        Ticker.every(new Ticker.Task() {
            @Override public boolean tick(Minecraft mc) {
                Gates.tick(mc);
                return false;
            }
        });
    }
}
