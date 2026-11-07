package claudebridge;

import baritone.api.BaritoneAPI;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;

import static claudebridge.Json.intParam;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Blocks the bot built (sent by the MCP server). Baritone has no per-position protection, and it walked through a
 * cabin wall rather than use the door; so once a second this sets Baritone's blocksToDisallowBreaking to the types of
 * the protected blocks within RADIUS of the bot. Our own dig and build processes lift the rule while they run, since
 * they break blocks on purpose.
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
        return new ArrayList<>(types);
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

    private static void tick(Minecraft mc) {
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
            JsonObject r = new JsonObject();
            r.addProperty("set", zoneSet);
            return r;
        });
        s.register("protect.status", true, (p, c) -> {
            JsonObject r = new JsonObject();
            r.addProperty("zone", !zoneSet ? null : zoneRect ? zoneX1 + "," + zoneZ1 + ".." + zoneX2 + "," + zoneZ2 : zoneX + "," + zoneZ + " r" + zoneRadius);
            r.addProperty("count", POSITIONS.size());
            r.addProperty("suspended", suspended);
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
