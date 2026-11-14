package claudebridge;

import baritone.api.BaritoneAPI;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

import static claudebridge.Json.intParam;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Blocks the bot built (sent by the MCP server). Baritone has no per-position protection, and it walked through a
 * cabin wall rather than use the door; so once a second this sets Baritone's blocksToDisallowBreaking to the types of
 * the protected blocks within RADIUS of the bot. Our own dig and build processes lift the rule while they run, since
 * they break blocks on purpose. It also keeps Baritone's paths from placing blocks by the yard fence (fenceScaffold).
 */
public final class Protection {
    private static final int RADIUS = 24;
    /** this close to someone else's build (or in it) Baritone places no blocks */
    private static final int FOREIGN_NO_PLACE = 8;
    private static final Set<Long> POSITIONS = new HashSet<>();
    private static List<Block> original;
    private static int suspended = 0;
    /** what the bot built and its home zone have come from Node: until then nothing can be told apart as someone else's */
    private static boolean positionsSynced, zoneSynced;

    static boolean synced() { return positionsSynced && zoneSynced; }
    static boolean positionsSynced() { return positionsSynced; }
    static boolean zoneSynced() { return zoneSynced; }

    private Protection() { }

    public static int count() {
        return POSITIONS.size();
    }

    /** Blocks an explicit dig is after: the one kind of furniture that may be broken while the rule is lifted. */
    private static final List<Block> digging = new ArrayList<>();

    /**
     * Lift the rule for our own dig or build. Furniture the bot built (doors, beds, chests, ...) stays unbreakable
     * anyway, except the block a dig is after: with the outside pressure plate gone, Baritone broke the cabin door
     * to get through while a level-area had the rule lifted, instead of opening it.
     */
    public static void suspend(Block target) {
        suspended++;
        if (target != null) digging.add(target);
        apply(furnitureNear(Minecraft.getInstance()));
    }

    public static void resume(Block target) {
        if (suspended > 0) suspended--;
        if (target != null) digging.remove(target);
        if (suspended == 0) digging.clear();
    }

    static boolean furniture(Block b) {
        return b instanceof net.minecraft.world.level.block.DoorBlock || b instanceof net.minecraft.world.level.block.TrapDoorBlock
            || b instanceof net.minecraft.world.level.block.FenceGateBlock || b instanceof net.minecraft.world.level.block.FenceBlock
            || b instanceof net.minecraft.world.level.block.BedBlock
            || b instanceof net.minecraft.world.level.block.AbstractChestBlock<?> || b instanceof net.minecraft.world.level.block.BarrelBlock
            || b instanceof net.minecraft.world.level.block.CraftingTableBlock || b instanceof net.minecraft.world.level.block.AbstractFurnaceBlock;
    }

    /**
     * The furniture types among the protected blocks near the bot, less what a dig is after; and whatever is in other
     * players' builds nearby (Foreign): a lift for our own work never reaches a friend's house.
     */
    private static List<Block> furnitureNear(Minecraft mc) {
        if (mc.player == null || mc.level == null) return List.of();
        BlockPos me = mc.player.blockPosition();
        Set<Block> types = new LinkedHashSet<>();
        for (long l : POSITIONS) {
            BlockPos p = BlockPos.of(l);
            if (p.distManhattan(me) > RADIUS * 2 || p.distSqr(me) > RADIUS * RADIUS || !mc.level.isLoaded(p)) continue;
            Block b = mc.level.getBlockState(p).getBlock();
            if (furniture(b) && !digging.contains(b)) types.add(b);
        }
        types.addAll(Foreign.typesNear(me, RADIUS));
        portalGuard(me, types);
        return new ArrayList<>(types);
    }

    /** By a lit nether portal (anyone's), its frame can't break: obsidian stays unbreakable whatever a lift allows. */
    private static void portalGuard(BlockPos me, Set<Block> types) {
        if (Foreign.portalNear(me, RADIUS)) { types.add(Blocks.OBSIDIAN); types.add(Blocks.CRYING_OBSIDIAN); }
    }

    /** Obsidian next to a lit portal: its frame (an explicit dig refuses it). */
    static boolean portalFrame(BlockPos p, BlockState st) {
        return (st.is(Blocks.OBSIDIAN) || st.is(Blocks.CRYING_OBSIDIAN)) && Foreign.portalNear(p, 3);
    }

    /** The bot's own: a block it built, or anywhere in its home zone (its yard). */
    static boolean isOwn(BlockPos p) {
        return POSITIONS.contains(p.asLong()) || nearZone(p);
    }

    private static void apply(List<Block> types) {
        var setting = BaritoneAPI.getSettings().blocksToDisallowBreaking;
        if (original == null) original = new ArrayList<>(setting.value);
        List<Block> value = new ArrayList<>(original);
        for (Block b : types) if (!value.contains(b)) value.add(b);
        if (!value.equals(setting.value)) setting.value = value;
    }

    /**
     * The home zone: a column of radius `zoneRadius` around (zoneX, zoneZ), any depth. Baritone's miner goes for the
     * nearest ore it knows of, and it knows them all (the client sees every block in loaded chunks), so it kept digging
     * holes in the lawn. While the bot is in or near the zone, the ground and ore types can't be broken at all: the
     * miner then ignores them (it prunes what it may not break) and mines somewhere else.
     */
    private static boolean zoneSet;
    private static int zoneX, zoneZ, zoneRadius;
    /** or a rectangle (the yard): x1..x2, z1..z2 */
    private static boolean zoneRect;
    private static int zoneX1, zoneZ1, zoneX2, zoneZ2;
    /** How far past the zone's edge the rule still holds (Baritone breaks up to about 5 blocks away). */
    private static final int ZONE_MARGIN = 6;
    private static final List<Block> GROUND = List.of(
        Blocks.GRASS_BLOCK, Blocks.DIRT, Blocks.COARSE_DIRT, Blocks.ROOTED_DIRT, Blocks.PODZOL, Blocks.MYCELIUM, Blocks.DIRT_PATH,
        Blocks.FARMLAND, Blocks.MUD, Blocks.CLAY, Blocks.GRAVEL, Blocks.SAND, Blocks.RED_SAND, Blocks.SANDSTONE,
        Blocks.STONE, Blocks.DEEPSLATE, Blocks.GRANITE, Blocks.DIORITE, Blocks.ANDESITE, Blocks.TUFF, Blocks.CALCITE,
        Blocks.COAL_ORE, Blocks.DEEPSLATE_COAL_ORE, Blocks.IRON_ORE, Blocks.DEEPSLATE_IRON_ORE, Blocks.COPPER_ORE,
        Blocks.DEEPSLATE_COPPER_ORE, Blocks.GOLD_ORE, Blocks.DEEPSLATE_GOLD_ORE, Blocks.REDSTONE_ORE, Blocks.DEEPSLATE_REDSTONE_ORE,
        Blocks.LAPIS_ORE, Blocks.DEEPSLATE_LAPIS_ORE, Blocks.DIAMOND_ORE, Blocks.DEEPSLATE_DIAMOND_ORE, Blocks.EMERALD_ORE,
        Blocks.DEEPSLATE_EMERALD_ORE);

    static boolean nearZone(BlockPos p) {
        if (!zoneSet) return false;
        // the yard's rectangle: a circle round home as wide as its farthest corner covered seven times the yard once it
        // grew long, and Baritone, never allowed to dig while in it, found no path to any ore
        if (zoneRect) return p.getX() >= zoneX1 - ZONE_MARGIN && p.getX() <= zoneX2 + ZONE_MARGIN && p.getZ() >= zoneZ1 - ZONE_MARGIN && p.getZ() <= zoneZ2 + ZONE_MARGIN;
        double dx = p.getX() - zoneX, dz = p.getZ() - zoneZ;
        return dx * dx + dz * dz <= (double) (zoneRadius + ZONE_MARGIN) * (zoneRadius + ZONE_MARGIN);
    }

    /** Whether the miner has asked yet (the client log says so once), and when the log last told what it left out. */
    private static volatile boolean mineAsked;
    private static volatile long mineSaid;

    /**
     * Baritone's mine targets, less the ground and ore in the home zone's column (MineTargetMixin: before its miner sorts
     * them and keeps the nearest 64). The rule above holds only while the bot stands in or near the zone, so from outside
     * it the ore under the yard was a target like any other, and often the nearest: the miner tunnelled toward it, came
     * into the margin, could break nothing there, and gave up ("Unable to find any path"). Live, 6 of 15 deep trips for
     * iron ended so, every one at the same spot 13 under the yard. Off the list, it mines the ore outside the column; if
     * all it knows lies in the column it explores for more (exploreForBlocks), which can take the whole round.
     * What the zone lets be broken stays a target: what isn't ground or ore (the yard's trees), a narrow lift's kind, and
     * everything while our own dig or build has the rule lifted.
     */
    public static List<BlockPos> mineTargets(List<BlockPos> locs) {
        if (!mineAsked) { mineAsked = true; System.out.println("[claudebridge] mine: ground and ore in the home zone's column are no targets"); }
        Minecraft mc = Minecraft.getInstance();
        var level = mc == null ? null : mc.level;
        if (level == null) return locs;
        // (the miner prunes on its own thread too, and reads the world there as this does; a chunk not loaded is kept:
        // the yard's chunks load long before the bot comes near it)
        List<BlockPos> kept = mineTargets(locs, p -> level.isLoaded(p) ? level.getBlockState(p).getBlock() : null);
        if (kept != locs && System.currentTimeMillis() - mineSaid > 60_000) {
            mineSaid = System.currentTimeMillis();
            System.out.println("[claudebridge] mine: " + (locs.size() - kept.size()) + " target(s) in the home zone's column left out");
        }
        return kept;
    }

    /** The same with the block at a place given (null: not known, kept). The list itself when nothing comes off. */
    static List<BlockPos> mineTargets(List<BlockPos> locs, java.util.function.Function<BlockPos, Block> blockAt) {
        if (!zoneSet || suspended > 0) return locs;
        List<BlockPos> kept = null;
        for (int i = 0; i < locs.size(); i++) {
            BlockPos p = locs.get(i);
            boolean off = nearZone(p) && zoneForbids(blockAt, p);
            if (off && kept == null) kept = new ArrayList<>(locs.subList(0, i));
            else if (!off && kept != null) kept.add(p);
        }
        return kept == null ? locs : kept;
    }

    private static boolean zoneForbids(java.util.function.Function<BlockPos, Block> blockAt, BlockPos p) {
        try {
            Block b = blockAt.apply(p);
            return b != null && GROUND.contains(b) && !only.contains(b);
        } catch (RuntimeException e) {
            // (read off the main thread while the chunk or the narrow lift changed: kept, as Baritone would have it)
            return false;
        }
    }

    /** Baritone's cost of what can't be done (ActionCosts.COST_INF). */
    public static final double COST_INF = 1_000_000;
    /** How far across the ground from the yard's fence ring, inside or outside, Baritone's paths place nothing. */
    private static final int FENCE_BAND = 2;
    /** and up to how far over the fence (its posts): the scaffold found east of the north gate went up to 4 over it */
    private static final int FENCE_OVER = 4;
    /**
     * At least this share of the ring's cells must hold something of the bot's at the fence's height: a stray block on
     * the line (a path, a lamp) is no fence. While the ring is rebuilt round a grown yard, its old three sides lie on
     * the new line and are enough.
     */
    private static final int FENCE_SHARE = 4;

    /** The fence's band: x1..x2, z1..z2 the ring (the zone's rectangle), y1..y2 the heights (the yard's ground and up). */
    record Band(int x1, int z1, int x2, int z2, int y1, int y2) {
        boolean has(int x, int y, int z) {
            if (y < y1 || y > y2 || x < x1 - FENCE_BAND || x > x2 + FENCE_BAND || z < z1 - FENCE_BAND || z > z2 + FENCE_BAND) return false;
            // inside the yard only as deep as the band: past it the lawn is the yard's own
            return x <= x1 + FENCE_BAND || x >= x2 - FENCE_BAND || z <= z1 + FENCE_BAND || z >= z2 - FENCE_BAND;
        }

        @Override public String toString() {
            return "x " + x1 + ".." + x2 + ", z " + z1 + ".." + z2 + " (" + FENCE_BAND + " either side), y " + y1 + ".." + y2;
        }
    }

    /** null: no ring known (no rectangle, or nothing of the bot's on its line yet). Read on Baritone's path thread. */
    private static volatile Band band;
    private static volatile boolean scaffoldAsked;
    /** places refused since the client log last said how many */
    private static final java.util.concurrent.atomic.AtomicInteger refused = new java.util.concurrent.atomic.AtomicInteger();
    private static long refusedSaid;

    /**
     * Whether the place each thread's path search is costing lies in the fence's band (placingAt, from the start of
     * the cost; fenceScaffold reads it at its returns). Each thread its own: Baritone's path thread costs the next
     * path while the client thread checks the one it walks, with the same context.
     */
    private static final ThreadLocal<boolean[]> BY_THE_FENCE = ThreadLocal.withInitial(() -> new boolean[1]);

    /** Where a block Baritone weighs placing while it paths would go (FenceScaffoldMixin, as the cost starts). */
    public static void placingAt(int x, int y, int z) {
        Band b = band;
        BY_THE_FENCE.get()[0] = b != null && b.has(x, y, z);
    }

    /**
     * Whether that block (a pillar, a bridge, a step up) is ruled out: one in the yard fence's band. Climbing over the
     * fence on cobblestone was cheaper than the walk round to a gate, so the bot left stairs over the gates and pillars
     * along the fence. `cost` is what Baritone made of it: never stays never, and 0 is the builder's own block (what
     * its schematic wants there, and the bot carries; a plain path never costs a block 0), which it still places.
     * Called for every place a path search weighs: on Baritone's path thread, and on the client's as it checks the path
     * it walks.
     */
    public static boolean fenceScaffold(double cost) {
        if (!scaffoldAsked) { scaffoldAsked = true; System.out.println("[claudebridge] path: no throwaway blocks within " + FENCE_BAND + " of the yard fence"); }
        boolean[] by = BY_THE_FENCE.get();
        if (!by[0]) return false;
        by[0] = false;
        if (cost <= 0 || cost >= COST_INF) return false;
        refused.incrementAndGet();
        return true;
    }

    /**
     * The band, from the zone's rectangle (its edge is the fence ring) and the bot's own blocks on that line: the height
     * most of them stand at is the fence's (its posts and gates; torches stand on some, the ground was filled under a
     * few), and the yard's ground is one under it. Node sends the rectangle without a height, and the record holds the
     * fence whether or not its chunks are loaded. No rectangle or no fence on its line: no band.
     */
    static Band bandOf(boolean rect, int x1, int z1, int x2, int z2, java.util.Collection<Long> positions) {
        if (!rect || x2 < x1 || z2 < z1) return null;
        Map<Integer, Integer> at = new HashMap<>();
        for (long l : positions) {
            int x = BlockPos.getX(l), z = BlockPos.getZ(l);
            boolean line = ((z == z1 || z == z2) && x >= x1 && x <= x2) || ((x == x1 || x == x2) && z >= z1 && z <= z2);
            if (line) at.merge(BlockPos.getY(l), 1, Integer::sum);
        }
        int fence = 0, most = 0;
        // (a tie goes to the lower: a torch on every post is no fence a block higher)
        for (var e : at.entrySet()) if (e.getValue() > most || (e.getValue() == most && e.getKey() < fence)) { fence = e.getKey(); most = e.getValue(); }
        int cells = 2 * (x2 - x1) + 2 * (z2 - z1);
        if (most == 0 || most * FENCE_SHARE < cells) return null;
        return new Band(x1, z1, x2, z2, fence - 1, fence + FENCE_OVER);
    }

    /** The band again after the zone or the bot's blocks changed (the client log says when it moves). */
    private static void bandAgain() {
        Band b = zoneSet ? bandOf(zoneRect, zoneX1, zoneZ1, zoneX2, zoneZ2, POSITIONS) : null;
        if (java.util.Objects.equals(b, band)) return;
        band = b;
        System.out.println("[claudebridge] path: " + (b == null ? "no yard fence known: paths may place anywhere again" : "paths place nothing by the yard fence: " + b));
    }

    /** Once a minute at most, how many places by the fence the path searches had refused (each search weighs many). */
    private static void sayRefused() {
        if (refused.get() == 0 || System.currentTimeMillis() - refusedSaid < 60_000) return;
        refusedSaid = System.currentTimeMillis();
        System.out.println("[claudebridge] path: " + refused.getAndSet(0) + " place(s) by the yard fence refused in path searches");
    }

    private static int idleWhileSuspended = 0;

    /**
     * A narrow lift: the rule holds for every protected type but the one block kind a dig is after. The build job's
     * clears dig a stray cobblestone with Baritone's help when no floor spot reaches it, and with the whole rule lifted
     * Baritone broke the storage house's new planks and logs on its way there (the next package built them again).
     */
    private static final List<Block> only = new ArrayList<>();
    private static int idleWhileNarrow = 0;

    public static void allowOnly(Block target) { only.add(target); }

    public static void endAllowOnly(Block target) { only.remove(target); }

    /** The blocks of these names ("oak_log", "grass_block"): what a narrow lift for a whole job lets Baritone break. */
    static List<Block> named(java.util.Collection<String> names) {
        Set<String> want = new HashSet<>();
        for (String n : names) want.add(Names.strip(n).replaceAll("\\[.*$", ""));
        List<Block> out = new ArrayList<>();
        for (Block b : net.minecraft.core.registries.BuiltInRegistries.BLOCK) if (want.contains(Names.block(b.defaultBlockState()))) out.add(b);
        return out;
    }

    private static void tick(Minecraft mc) {
        sayRefused();
        // a process that ended without its end handler (its call was dropped) must not leave the rule lifted for good
        if (suspended > 0) {
            idleWhileSuspended = Processes.active() == null ? idleWhileSuspended + 1 : 0;
            if (idleWhileSuspended >= 5) { suspended = 0; idleWhileSuspended = 0; }
        }
        if (suspended > 0) { apply(furnitureNear(mc)); return; }
        if (!only.isEmpty()) {
            idleWhileNarrow = Processes.active() == null ? idleWhileNarrow + 1 : 0;
            if (idleWhileNarrow >= 5) { only.clear(); idleWhileNarrow = 0; }
        }
        if (mc.player == null || mc.level == null) return;
        BlockPos me = mc.player.blockPosition();
        // in or right by someone else's build: Baritone places nothing (no pillars or bridges left at a friend's base)
        Careful.setForeign(Foreign.nearest(me) <= FOREIGN_NO_PLACE);
        Set<Block> types = new LinkedHashSet<>();
        for (long l : POSITIONS) {
            BlockPos p = BlockPos.of(l);
            if (p.distManhattan(me) > RADIUS * 2 || p.distSqr(me) > RADIUS * RADIUS || !mc.level.isLoaded(p)) continue;
            var st = mc.level.getBlockState(p);
            if (!st.isAir()) types.add(st.getBlock());
        }
        if (nearZone(me)) types.addAll(GROUND);
        types.removeAll(only);
        // other players' builds nearby: every kind in them, whatever a narrow lift allows
        types.addAll(Foreign.typesNear(me, RADIUS));
        portalGuard(me, types);
        apply(new ArrayList<>(types));
    }

    /** Apply the rule now (a narrow lift starting or ending shouldn't wait for the next second's tick). */
    static void refresh() { tick(Minecraft.getInstance()); }

    public static void register(BridgeServer s) {
        // the full list for the current dimension, replacing what was there
        s.register("protect.set", true, (p, c) -> {
            POSITIONS.clear();
            positionsSynced = true;
            JsonElement list = p.get("positions");
            if (list != null && list.isJsonArray()) {
                for (JsonElement e : list.getAsJsonArray()) {
                    JsonArray a = e.getAsJsonArray();
                    POSITIONS.add(BlockPos.asLong(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()));
                }
            }
            bandAgain();
            JsonObject r = new JsonObject();
            r.addProperty("count", POSITIONS.size());
            return r;
        });
        // the home zone: {x, z, radius}; radius 0 clears it
        s.register("protect.zone", true, (p, c) -> {
            // {x, z, radius} a circle (radius 0 clears it), or {x1, z1, x2, z2} a rectangle
            zoneSynced = true;
            zoneRect = p.has("x1");
            if (zoneRect) {
                zoneX1 = intParam(p, "x1", 0); zoneZ1 = intParam(p, "z1", 0); zoneX2 = intParam(p, "x2", 0); zoneZ2 = intParam(p, "z2", 0);
                zoneSet = true;
            } else {
                zoneRadius = intParam(p, "radius", 0);
                zoneSet = zoneRadius > 0;
                if (zoneSet) { zoneX = intParam(p, "x", 0); zoneZ = intParam(p, "z", 0); }
            }
            bandAgain();
            JsonObject r = new JsonObject();
            r.addProperty("set", zoneSet);
            return r;
        });
        s.register("protect.status", true, (p, c) -> {
            JsonObject r = new JsonObject();
            r.addProperty("zone", !zoneSet ? null : zoneRect ? zoneX1 + "," + zoneZ1 + ".." + zoneX2 + "," + zoneZ2 : zoneX + "," + zoneZ + " r" + zoneRadius);
            r.addProperty("count", POSITIONS.size());
            r.addProperty("suspended", suspended);
            Band fence = band;
            r.addProperty("fenceBand", fence == null ? null : fence.toString());
            JsonArray types = new JsonArray();
            for (Block b : BaritoneAPI.getSettings().blocksToDisallowBreaking.value) {
                types.add(Names.strip(b.builtInRegistryHolder().getRegisteredName()));
            }
            r.add("disallowBreaking", types);
            return r;
        });
        Ticker.every(new Ticker.Task() {
            int n = 0;
            @Override public boolean tick(Minecraft mc) {
                if (++n % 20 == 0) Protection.tick(mc);
                return false;
            }
        });
    }
}
