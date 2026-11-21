package claudebridge;

import baritone.api.pathing.goals.GoalBlock;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.NetherPortalBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.function.Predicate;

import static claudebridge.Json.*;

/**
 * Nether portals: going through one on foot (portal.enter), the lit ones round the bot (portal.list), and the ones the
 * brain says are its own (portal.own: its home portal, later its Nether-side one), which nothing counts as someone
 * else's build.
 *
 * Checked against the 26.3 jar: a player stands in a portal for the players_nether_portal_default_delay gamerule (80
 * ticks; 0 in creative) before the server moves it (PortalProcessor: a tick inside counts one, a tick outside takes 4
 * off); arrived, it stands in the portal at the other end, and while it stays there the 10-tick cooldown starts again
 * every tick (Entity.setAsInsidePortal): it never goes straight back. It must step out and in again for that. The
 * server's respawn packet keeps all data on a dimension change (KEEP_ALL_DATA), and the client then waits for the new
 * level (LevelLoadingScreen, ClientPacketListener.hasClientLoaded). The other end is the nearest portal (by distSqr, a
 * lower one on a tie) within 16 of the scaled point going to the Nether, 128 going to the overworld (a square in x and
 * z, any height: PortalForcer.findClosestPortalPosition); none there, the server builds one. A portal block has no
 * collision, so Baritone would walk through one on any path: it is on Baritone's avoid list (ClaudeBridge), and only
 * portal.enter's own walk takes it off for the way in.
 */
public final class Portal {
    private Portal() { }

    // ---------------------------------------------------------------- portals as shapes

    /** One portal: its blocks grouped. lo: the lowest corner; axis: the one it spans along; width along it; height. */
    record Shape(BlockPos lo, Direction.Axis axis, int width, int height, List<BlockPos> blocks) {
        BlockPos hi() {
            return axis == Direction.Axis.X ? lo.offset(width - 1, height - 1, 0) : lo.offset(0, height - 1, width - 1);
        }

        boolean contains(BlockPos p) {
            BlockPos h = hi();
            return p.getX() >= lo.getX() && p.getX() <= h.getX() && p.getY() >= lo.getY() && p.getY() <= h.getY() && p.getZ() >= lo.getZ() && p.getZ() <= h.getZ();
        }

        /** Its bottom row: the cells a walk goes into and out from. */
        List<BlockPos> bottom() {
            List<BlockPos> out = new ArrayList<>();
            for (BlockPos b : blocks) if (b.getY() == lo.getY()) out.add(b);
            return out;
        }

        /** The two ways out of it: across its plane. */
        Direction[] sides() {
            return axis == Direction.Axis.X ? new Direction[]{Direction.NORTH, Direction.SOUTH} : new Direction[]{Direction.WEST, Direction.EAST};
        }

        Vec3 center() {
            BlockPos h = hi();
            return new Vec3((lo.getX() + h.getX() + 1) / 2.0, (lo.getY() + h.getY() + 1) / 2.0, (lo.getZ() + h.getZ() + 1) / 2.0);
        }

        /** Straight-line distance from a point to its nearest block (0 inside). */
        double distance(Vec3 p) {
            BlockPos h = hi();
            return Math.sqrt(new AABB(lo.getX(), lo.getY(), lo.getZ(), h.getX() + 1, h.getY() + 1, h.getZ() + 1).distanceToSqr(p));
        }

        JsonObject json() {
            return obj("x", lo.getX(), "y", lo.getY(), "z", lo.getZ(), "axis", axis.getName(), "width", width, "height", height,
                "blocks", blocks.size(), "center", pos(center()));
        }
    }

    /**
     * Portal blocks (each with its axis) grouped into portals: neighbours in the plane of their axis (along it and up and
     * down), of the same axis. Pure.
     */
    static List<Shape> group(Map<BlockPos, Direction.Axis> blocks) {
        List<Shape> out = new ArrayList<>();
        Set<BlockPos> seen = new HashSet<>();
        for (var start : blocks.entrySet()) {
            if (!seen.add(start.getKey())) continue;
            Direction.Axis axis = start.getValue();
            List<BlockPos> part = new ArrayList<>();
            ArrayDeque<BlockPos> queue = new ArrayDeque<>(List.of(start.getKey()));
            while (!queue.isEmpty()) {
                BlockPos b = queue.poll();
                part.add(b);
                for (Direction d : new Direction[]{Direction.UP, Direction.DOWN,
                    axis == Direction.Axis.X ? Direction.EAST : Direction.SOUTH, axis == Direction.Axis.X ? Direction.WEST : Direction.NORTH}) {
                    BlockPos n = b.relative(d);
                    if (blocks.get(n) == axis && seen.add(n)) queue.add(n);
                }
            }
            int x1 = Integer.MAX_VALUE, y1 = Integer.MAX_VALUE, z1 = Integer.MAX_VALUE, x2 = Integer.MIN_VALUE, y2 = Integer.MIN_VALUE, z2 = Integer.MIN_VALUE;
            for (BlockPos b : part) {
                x1 = Math.min(x1, b.getX()); y1 = Math.min(y1, b.getY()); z1 = Math.min(z1, b.getZ());
                x2 = Math.max(x2, b.getX()); y2 = Math.max(y2, b.getY()); z2 = Math.max(z2, b.getZ());
            }
            part.sort(Comparator.comparingInt((BlockPos b) -> b.getY()).thenComparingInt(b -> b.getX()).thenComparingInt(b -> b.getZ()));
            int width = axis == Direction.Axis.X ? x2 - x1 + 1 : z2 - z1 + 1;
            out.add(new Shape(new BlockPos(x1, y1, z1), axis, width, y2 - y1 + 1, List.copyOf(part)));
        }
        return out;
    }

    /** The lit portal blocks in the loaded chunks within `range` (horizontally) of a point, with their axes. */
    static Map<BlockPos, Direction.Axis> scan(ClientLevel level, BlockPos me, int range) {
        Map<BlockPos, Direction.Axis> out = new LinkedHashMap<>();
        for (int cx = (me.getX() - range) >> 4; cx <= (me.getX() + range) >> 4; cx++) {
            for (int cz = (me.getZ() - range) >> 4; cz <= (me.getZ() + range) >> 4; cz++) {
                LevelChunk ch = level.getChunkSource().getChunk(cx, cz, ChunkStatus.FULL, false);
                if (ch == null) continue;
                LevelChunkSection[] sections = ch.getSections();
                for (int si = 0; si < sections.length; si++) {
                    LevelChunkSection sec = sections[si];
                    if (sec == null || sec.hasOnlyAir() || !sec.getStates().maybeHas(s -> s.is(Blocks.NETHER_PORTAL))) continue;
                    int by = SectionPos.sectionToBlockCoord(level.getSectionYFromSectionIndex(si));
                    for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) for (int x = 0; x < 16; x++) {
                        BlockState st = sec.getBlockState(x, y, z);
                        if (!st.is(Blocks.NETHER_PORTAL)) continue;
                        BlockPos at = new BlockPos((cx << 4) + x, by + y, (cz << 4) + z);
                        if (Math.abs(at.getX() - me.getX()) > range || Math.abs(at.getZ() - me.getZ()) > range) continue;
                        out.put(at, st.getValue(NetherPortalBlock.AXIS));
                    }
                }
            }
        }
        return out;
    }

    /** The portal a block belongs to: that block's, or the nearest portal block's within `near` of it; null if none. */
    static Shape shapeAt(ClientLevel level, BlockPos at, int near) {
        BlockPos found = null;
        double best = Double.MAX_VALUE;
        for (BlockPos p : BlockPos.betweenClosed(at.offset(-near, -near, -near), at.offset(near, near, near))) {
            if (!level.isLoaded(p) || !level.getBlockState(p).is(Blocks.NETHER_PORTAL)) continue;
            double d = p.distSqr(at);
            if (d < best) { best = d; found = p.immutable(); }
        }
        if (found == null) return null;
        // the whole portal: a flood fill from that block (a portal is at most 21 x 21)
        Map<BlockPos, Direction.Axis> blocks = new HashMap<>();
        Direction.Axis axis = level.getBlockState(found).getValue(NetherPortalBlock.AXIS);
        ArrayDeque<BlockPos> queue = new ArrayDeque<>(List.of(found));
        blocks.put(found, axis);
        while (!queue.isEmpty() && blocks.size() < 21 * 21) {
            BlockPos b = queue.poll();
            for (Direction d : Direction.values()) {
                BlockPos n = b.relative(d);
                if (blocks.containsKey(n) || !level.isLoaded(n)) continue;
                BlockState s = level.getBlockState(n);
                if (s.is(Blocks.NETHER_PORTAL) && s.getValue(NetherPortalBlock.AXIS) == axis) { blocks.put(n, axis); queue.add(n); }
            }
        }
        for (Shape s : group(blocks)) if (s.blocks().contains(found)) return s;
        return null;
    }

    // ---------------------------------------------------------------- its own portals

    /** The portals the brain says are its own, by dimension: a position each (a block of it, or a frame cell by it). */
    private static final Map<String, List<BlockPos>> OWN = new ConcurrentHashMap<>();
    private static volatile boolean ownSynced;

    static boolean ownSynced() { return ownSynced; }

    /** Pure: a portal is its own when a registered position lies in it or by it (its frame), or it stands in the home zone. */
    static boolean own(Shape s, List<BlockPos> registered, Predicate<BlockPos> inHomeZone) {
        BlockPos lo = s.lo().offset(-1, -1, -1), hi = s.hi().offset(1, 1, 1);
        for (BlockPos r : registered) {
            if (r.getX() >= lo.getX() && r.getX() <= hi.getX() && r.getY() >= lo.getY() && r.getY() <= hi.getY() && r.getZ() >= lo.getZ() && r.getZ() <= hi.getZ()) return true;
        }
        for (BlockPos b : s.blocks()) if (inHomeZone.test(b)) return true;
        return false;
    }

    static boolean own(String dimension, Shape s) {
        return own(s, OWN.getOrDefault(dimension, List.of()), b -> Protection.inHomeZone(dimension, b));
    }

    /** The blocks of its own portals standing in this level (the build scan leaves them out of anyone's build). */
    static Set<BlockPos> ownBlocks(ClientLevel level, String dimension) {
        List<BlockPos> mine = OWN.get(dimension);
        if (mine == null || mine.isEmpty() || level == null || !dimension.equals(Names.dimension(level))) return Set.of();
        Set<BlockPos> out = new HashSet<>();
        for (BlockPos r : mine) {
            Shape s = shapeAt(level, r, 1);
            if (s != null && own(s, mine, b -> false)) out.addAll(s.blocks());
        }
        return out;
    }

    static JsonArray ownJson() {
        JsonArray out = new JsonArray();
        for (var e : OWN.entrySet()) for (BlockPos b : e.getValue()) out.add(obj("dimension", e.getKey(), "x", b.getX(), "y", b.getY(), "z", b.getZ()));
        return out;
    }

    // ---------------------------------------------------------------- the step out

    /** A cell, as the step out judges it. */
    enum Cell { OPEN, FLOOR, LAVA_FIRE, PORTAL, OTHER }

    /** Where the step out goes: through `via` (one out) to `to` (two out), on that side. */
    record StepOut(BlockPos via, BlockPos to, Direction side) { }

    static boolean passable(Cell c) { return c == Cell.OPEN || c == Cell.PORTAL; }

    /** A cell to stand in: a floor under it, its feet and head open (not in a portal). */
    static boolean standable(Function<BlockPos, Cell> cell, BlockPos feet) {
        return cell.apply(feet.below()) == Cell.FLOOR && cell.apply(feet) == Cell.OPEN && cell.apply(feet.above()) == Cell.OPEN;
    }

    /** One walking step from `a` to `b` (feet): a block up or down at most, with head room for the jump or the drop. */
    static boolean step(Function<BlockPos, Cell> cell, BlockPos a, BlockPos b) {
        int dy = b.getY() - a.getY();
        if (Math.abs(dy) > 1 || !standable(cell, b)) return false;
        if (dy == 1 && !passable(cell.apply(a.above(2)))) return false;
        return dy != -1 || passable(cell.apply(b.above(2)));
    }

    /** No lava or fire within 1 of the cell's feet and head. */
    static boolean safe(Function<BlockPos, Cell> cell, BlockPos feet) {
        for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) for (int dy = -1; dy <= 2; dy++) {
            if (cell.apply(feet.offset(dx, dy, dz)) == Cell.LAVA_FIRE) return false;
        }
        return true;
    }

    /**
     * Where to step out of a portal just arrived in: two blocks out across its plane from a bottom cell (the one nearest
     * the bot first), on a floor with two open cells over it, no lava or fire within 1, by a walk of plain steps (a block
     * up or down). The preferred side first, then the other. Null: neither side has such a cell: stand still. Pure.
     */
    static StepOut stepOut(Shape portal, double fromX, double fromZ, Function<BlockPos, Cell> cell, Direction prefer) {
        List<BlockPos> cols = new ArrayList<>(portal.bottom());
        cols.sort(Comparator.comparingDouble(b -> Math.hypot(b.getX() + 0.5 - fromX, b.getZ() + 0.5 - fromZ)));
        Direction[] sides = portal.sides();
        if (prefer == sides[1]) sides = new Direction[]{sides[1], sides[0]};
        for (Direction side : sides) {
            for (BlockPos p : cols) {
                for (int dy1 : new int[]{0, -1, 1}) {
                    BlockPos via = p.relative(side).offset(0, dy1, 0);
                    if (!step(cell, p, via)) continue;
                    for (int dy2 : new int[]{0, -1, 1}) {
                        BlockPos to = via.relative(side).offset(0, dy2, 0);
                        if (step(cell, via, to) && safe(cell, to)) return new StepOut(via, to, side);
                    }
                }
            }
        }
        return null;
    }

    /**
     * Out of a portal only to go in again (portal.enter started in it): a cell a step out across its plane from a bottom
     * cell (the one nearest the bot first) to stand in for a moment, and that bottom cell to walk out from. Fire or lava
     * beside it is no bar here, only in it (standable): the body stands in the cell's middle, and staying in the portal
     * can never take the bot through. Null: no cell beside it at all. Pure.
     *
     * Nov 20: fire on the netherrack by its Nether portal (one beside the east column, two a step out of the west's)
     * left stepOut no cell, and the bot stood in the portal 20 s a try, stranded down there for good.
     */
    static StepOut stepAside(Shape portal, double fromX, double fromZ, Function<BlockPos, Cell> cell) {
        List<BlockPos> cols = new ArrayList<>(portal.bottom());
        cols.sort(Comparator.comparingDouble(b -> Math.hypot(b.getX() + 0.5 - fromX, b.getZ() + 0.5 - fromZ)));
        for (BlockPos p : cols) {
            for (Direction side : portal.sides()) {
                for (int dy : new int[]{0, -1, 1}) {
                    BlockPos via = p.relative(side).offset(0, dy, 0);
                    if (step(cell, p, via)) return new StepOut(via, p, side);
                }
            }
        }
        return null;
    }

    /** Live: a cell of the level as the step out judges it. */
    static Cell cell(Level level, BlockPos p) {
        if (!level.isLoaded(p)) return Cell.OTHER;
        BlockState s = level.getBlockState(p);
        if (s.is(Blocks.NETHER_PORTAL)) return Cell.PORTAL;
        if (s.getFluidState().is(FluidTags.LAVA) || s.getBlock() instanceof net.minecraft.world.level.block.BaseFireBlock) return Cell.LAVA_FIRE;
        if (!s.getFluidState().isEmpty()) return Cell.OTHER;
        if (s.getCollisionShape(level, p).isEmpty()) {
            // open, but not a trap: a cobweb holds, a berry bush and a wither rose hurt, powder snow swallows
            return s.is(Blocks.COBWEB) || s.is(Blocks.SWEET_BERRY_BUSH) || s.is(Blocks.WITHER_ROSE) || s.is(Blocks.POWDER_SNOW) ? Cell.OTHER : Cell.OPEN;
        }
        // a floor that hurts to stand on is no floor
        if (s.is(Blocks.MAGMA_BLOCK) || s.getBlock() instanceof net.minecraft.world.level.block.CampfireBlock) return Cell.OTHER;
        return s.isFaceSturdy(level, p, Direction.UP) ? Cell.FLOOR : Cell.OTHER;
    }

    /**
     * The player's box as the server reads it for the blocks it is in: 26.3 Entity.checkInsideBlocks deflates it by
     * 1e-5, so a face flush with a portal cell is not in it. Undeflated, a box pushed against the obsidian sill from
     * lower ground (feet a block below the portal's bottom, maxZ exactly on the portal's plane) "touched" the portal
     * block above the sill: the walk took it for in, stood still, and the server never counted a tick (Nov 20-21: the
     * way back from nether (-78, 90, 259), "in the portal: yes", timed out 20 s in it, again and again).
     */
    static AABB serverBox(LocalPlayer p) {
        return p.getBoundingBox().deflate(1.0E-5);
    }

    /** Whether the player's box is in a portal block (where the server counts its time in the portal). */
    static boolean inside(LocalPlayer p) {
        AABB box = serverBox(p);
        for (BlockPos b : BlockPos.betweenClosed(BlockPos.containing(box.minX, box.minY, box.minZ), BlockPos.containing(box.maxX, box.maxY, box.maxZ))) {
            if (p.level().getBlockState(b).is(Blocks.NETHER_PORTAL)) return true;
        }
        return false;
    }

    static boolean insideOf(LocalPlayer p, Shape s) {
        AABB box = serverBox(p);
        for (BlockPos b : BlockPos.betweenClosed(BlockPos.containing(box.minX, box.minY, box.minZ), BlockPos.containing(box.maxX, box.maxY, box.maxZ))) {
            if (s.contains(b) && p.level().getBlockState(b).is(Blocks.NETHER_PORTAL)) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- the walk through

    /** Baritone walks through portal blocks only on portal.enter's own way in (they are on its avoid list otherwise). */
    private static void avoidPortals(boolean avoid) {
        var setting = baritone.api.BaritoneAPI.getSettings().blocksToAvoid;
        List<net.minecraft.world.level.block.Block> now = new ArrayList<>(setting.value);
        boolean has = now.contains(Blocks.NETHER_PORTAL);
        if (avoid == has) return;
        if (avoid) now.add(Blocks.NETHER_PORTAL); else now.remove(Blocks.NETHER_PORTAL);
        setting.value = now;
    }

    private static void releaseKeys(Minecraft m) {
        m.options.keyUp.setDown(false);
        m.options.keyJump.setDown(false);
        m.options.keySprint.setDown(false);
    }

    /** Walk with the keys toward a cell's centre (no pathing: a step or two); true once in the cell, near its centre. */
    private static boolean steer(Minecraft m, LocalPlayer me, BlockPos to) {
        return steer(m, me, to, 0.3);
    }

    /** The same, `within` of the centre (0.15: the body clear of the cells beside it). */
    private static boolean steer(Minecraft m, LocalPlayer me, BlockPos to, double within) {
        double dx = to.getX() + 0.5 - me.getX(), dz = to.getZ() + 0.5 - me.getZ();
        if (Math.hypot(dx, dz) < within && me.blockPosition().getX() == to.getX() && me.blockPosition().getZ() == to.getZ()) { releaseKeys(m); return true; }
        me.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
        m.options.keyUp.setDown(true);
        m.options.keySprint.setDown(false);
        m.options.keyJump.setDown(me.horizontalCollision && to.getY() > me.getBlockY() - 1);
        return false;
    }

    private static final int LEAVE = -1, WALK = 0, STEER_IN = 1, STAND = 2, LOAD = 3, STEP = 4;

    /** Ticks out of a portal before going in again: the server's cooldown (10 for a player) must run out first. */
    private static final int OUT_BEFORE_IN = 20;

    /**
     * Into the portal and through it: a careful walk (nothing placed or broken) into a bottom cell of it, standing still
     * there until the level changes, the new level's load, then two steps out of the portal at the other end. Already
     * standing in it (arrived and never stepped out): a step out first, since the server lets no one go back who has
     * not left it.
     */
    static void enter(BridgeServer.Call c, Shape portal, BlockPos asked, String from, int timeoutTicks, double[] toward) {
        Ticker.add(new Ticker.Task() {
            int age, phase = WALK, idle, steerAge, outAge, loadAge, settle, stepAge, inside, leaveAge, leaveSteer;
            boolean walking, seenActive, everInside, atLeaveFrom;
            final long seq = Events.baritoneLogSeq(), deaths = Events.deaths();
            BlockPos entry, leaveTo, leaveFrom;
            Shape arrived;
            StepOut out;
            BlockPos arrivalBlock;

            @Override public boolean tick(Minecraft m) {
                age++;
                LocalPlayer me = m.player;
                if (c.isDone()) { endWalk(m); releaseKeys(m); return true; }
                // a death moves the bot too (the Nether's to the overworld's spawn): that is no trip through the portal
                if (Events.deaths() != deaths) return fail(m, "died on the way");
                String now = Names.dimension(m.level);
                if (phase < LOAD && now != null && !now.equals(from)) { endWalk(m); releaseKeys(m); phase = LOAD; }
                if (me == null || m.level == null) {
                    if (phase >= LOAD && ++loadAge < 600) return false;
                    return fail(m, "not in a world");
                }
                switch (phase) {
                    case LEAVE -> {
                        // out to a cell beside the portal, a moment there, then in again
                        if (!insideOf(me, portal) && me.blockPosition().equals(leaveTo)) {
                            releaseKeys(m);
                            if (++leaveAge >= OUT_BEFORE_IN) phase = WALK;
                            return false;
                        }
                        if (++leaveSteer > 60) { releaseKeys(m); return fail(m, "could not step out of the portal to go in again"); }
                        // through its own column first: straight across, not cornerwise past what burns beside the cell
                        if (!atLeaveFrom && (me.blockPosition().equals(leaveFrom) || !insideOf(me, portal))) atLeaveFrom = true;
                        steer(m, me, atLeaveFrom ? leaveTo : leaveFrom, 0.15);
                    }
                    case WALK -> {
                        // the block asked for when it is a bottom cell (`portal:frame`), else the bottom cell nearest the bot
                        if (entry == null) entry = portal.bottom().contains(asked) ? asked : nearest(portal.bottom(), me.position());
                        if (age == 1 && insideOf(me, portal)) {
                            StepOut away = stepAside(portal, me.getX(), me.getZ(), b -> cell(m.level, b));
                            if (away != null) { leaveTo = away.via(); leaveFrom = away.to(); phase = LEAVE; return false; }
                        }
                        if (insideOf(me, portal)) { endWalk(m); phase = STAND; return false; }
                        if (!walking) {
                            walking = true;
                            avoidPortals(false);
                            Careful.begin();
                            Processes.baritone().getCustomGoalProcess().setGoalAndPath(new GoalBlock(entry));
                            return false;
                        }
                        if (Processes.active() != null) { seenActive = true; idle = 0; } else idle++;
                        boolean ended = (seenActive && idle >= 5) || (!seenActive && age >= 60);
                        if (age > timeoutTicks) return fail(m, "no way to the portal (timed out on the way)");
                        if (!ended) return false;
                        endWalk(m);
                        if (Math.hypot(entry.getX() + 0.5 - me.getX(), entry.getZ() + 0.5 - me.getZ()) <= 2.5 && Math.abs(entry.getY() - me.getY()) <= 1.5) { phase = STEER_IN; return false; }
                        return fail(m, "no way to the portal");
                    }
                    case STEER_IN -> {
                        if (insideOf(me, portal)) { releaseKeys(m); phase = STAND; return false; }
                        if (++steerAge > 80) { releaseKeys(m); return fail(m, "no way to the portal (could not step in)"); }
                        steer(m, me, entry);
                    }
                    case STAND -> {
                        if (insideOf(me, portal)) {
                            releaseKeys(m);
                            everInside = true;
                            inside++;
                            // standing still for the server's count: no path of anyone's walks it out again (the
                            // Guardian's defence aside: a fight takes it out, and it comes back in after)
                            String act = Processes.active();
                            if (act != null && !act.startsWith("Defend")) Processes.baritone().getPathingBehavior().cancelEverything();
                        } else if (++outAge > 80) {
                            releaseKeys(m);
                            return fail(m, "pushed out of the portal");
                        } else {
                            steer(m, me, entry); // pushed out (a mob, a knock): back in
                        }
                        // 80 ticks in it is the server's default: 20 s in it, or the time asked for gone and then some, is
                        // a portal that does not take the bot
                        if (inside >= 400 || age > timeoutTicks + 400) { releaseKeys(m); return fail(m, "timed out in the portal (" + inside / 20 + " s in it)"); }
                    }
                    case LOAD -> {
                        loadAge++;
                        var conn = m.getConnection();
                        boolean loaded = conn != null && conn.hasClientLoaded() && m.level.isLoaded(me.blockPosition());
                        if (!loaded && loadAge < 600) return false;
                        if (++settle < 10 && loaded) return false;
                        arrived = shapeAt(m.level, me.blockPosition(), 2);
                        arrivalBlock = arrived == null ? null : nearest(arrived.blocks(), me.position());
                        if (arrived != null && loaded) out = stepOut(arrived, me.getX(), me.getZ(), b -> cell(m.level, b), side(arrived, toward, me));
                        phase = STEP;
                        if (out == null) return done(m, false, loaded ? null : "the new level was still loading");
                    }
                    case STEP -> {
                        stepAge++;
                        BlockPos goal = me.blockPosition().equals(out.via()) || stepAge > 25 || pastVia(me, arrived, out) ? out.to() : out.via();
                        if (goal == out.to() && steer(m, me, out.to()) && me.blockPosition().equals(out.to())) return done(m, true, null);
                        if (goal == out.via()) steer(m, me, out.via());
                        if (stepAge > 60) { releaseKeys(m); return done(m, me.blockPosition().equals(out.to()), "the step out did not get all the way"); }
                    }
                    default -> { return fail(m, "lost track"); }
                }
                return false;
            }

            /** Already a block or more out of the portal's plane toward the side: on to the second cell. */
            boolean pastVia(LocalPlayer me, Shape s, StepOut o) {
                Direction side = o.side();
                double plane = side.getAxis() == Direction.Axis.Z ? s.lo().getZ() + 0.5 : s.lo().getX() + 0.5;
                double at = side.getAxis() == Direction.Axis.Z ? me.getZ() : me.getX();
                return (at - plane) * side.getAxisDirection().getStep() >= 1.2;
            }

            void endWalk(Minecraft m) {
                if (walking) {
                    walking = false;
                    Careful.end();
                    if (Processes.active() != null) Processes.baritone().getPathingBehavior().cancelEverything();
                }
                avoidPortals(true);
            }

            boolean fail(Minecraft m, String why) {
                endWalk(m);
                releaseKeys(m);
                LocalPlayer me = m.player;
                c.ok(obj("ok", false, "reason", why, "from", from, "dimension", Names.dimension(m.level), "position", me == null ? null : pos(me.position()),
                    "inPortal", me != null && inside(me), "everInside", everInside, "baritone", Json.toTree(Events.baritoneMessagesSince(seq))));
                return true;
            }

            boolean done(Minecraft m, boolean stepped, String note) {
                endWalk(m);
                releaseKeys(m);
                LocalPlayer me = m.player;
                JsonObject r = obj("ok", true, "from", from, "dimension", Names.dimension(m.level), "position", me == null ? null : pos(me.position()),
                    "block", me == null ? null : pos(me.blockPosition()), "portal", arrivalBlock == null ? null : pos(arrivalBlock),
                    "arrived", arrived == null ? null : arrived.json(), "stepped", stepped, "seconds", round(age / 20.0));
                if (out != null) r.add("steppedTo", pos(out.to()));
                if (note != null) r.addProperty("note", note);
                c.ok(r);
                return true;
            }
        });
    }

    static BlockPos nearest(List<BlockPos> cells, Vec3 from) {
        BlockPos best = null;
        double bestD = Double.MAX_VALUE;
        for (BlockPos b : cells) {
            double d = Vec3.atBottomCenterOf(b).distanceToSqr(from);
            if (d < bestD) { bestD = d; best = b; }
        }
        return best;
    }

    /**
     * The side to step out on first: the one nearer the point asked for (where the brain goes next), else the one the bot
     * faces as it arrives (the server turns it as it entered).
     */
    static Direction side(Shape s, double[] toward, LocalPlayer me) {
        Direction[] sides = s.sides();
        Vec3 c = s.center();
        double a = toward != null ? (toward[0] - c.x) * sides[0].getStepX() + (toward[1] - c.z) * sides[0].getStepZ()
            : me.getLookAngle().x * sides[0].getStepX() + me.getLookAngle().z * sides[0].getStepZ();
        return a >= 0 ? sides[0] : sides[1];
    }

    public static void register(BridgeServer s) {
        // {x, y, z, timeoutMs?, toward?: {x, z}} -> {ok, from, dimension, position, block, portal: {x,y,z} (the portal
        // block it arrived in), arrived (that portal), stepped, steppedTo} or {ok: false, reason: "not a portal" | "no way
        // to the portal" | "timed out in the portal (N s in it)" | ...}. The block given, or the nearest portal block
        // within 3 of it (a frame cell will do). `toward`: at the far end, step out on the side nearer that point first
        // (judged against the portal there, which has its own axis).
        s.register("portal.enter", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = Handlers.player();
            String from = Names.dimension(mc.level);
            BlockPos asked = blockPos(p);
            Shape portal = shapeAt(mc.level, asked, 3);
            if (portal == null) return obj("ok", false, "reason", "not a portal", "from", from, "dimension", from, "position", pos(pl.position()));
            int timeoutTicks = Math.max(200, intParam(p, "timeoutMs", 60_000) / 50);
            JsonElement t = p.get("toward");
            double[] toward = t != null && t.isJsonObject() && t.getAsJsonObject().has("x") && t.getAsJsonObject().has("z")
                ? new double[]{numParam(t.getAsJsonObject(), "x", 0), numParam(t.getAsJsonObject(), "z", 0)} : null;
            enter(c, portal, asked, from, timeoutTicks, toward);
            return BridgeServer.LATER;
        });

        // {range?} -> {dimension, portals: [{x, y, z (lowest corner), axis, width, height, blocks, center, distance, own}]}, nearest first
        s.register("portal.list", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = Handlers.player();
            int range = Math.max(1, Math.min(256, intParam(p, "range", 96)));
            String dim = Names.dimension(mc.level);
            List<Shape> shapes = group(scan(mc.level, pl.blockPosition(), range));
            shapes.sort(Comparator.comparingDouble(sh -> sh.distance(pl.position())));
            JsonArray out = new JsonArray();
            for (Shape sh : shapes) {
                JsonObject o = sh.json();
                o.addProperty("distance", round(sh.distance(pl.position())));
                o.addProperty("own", own(dim, sh));
                out.add(o);
            }
            return obj("dimension", dim, "portals", out);
        });

        // its own portals, set by the brain as the protection is: {portals: [{dimension, x, y, z}]} the whole list (an empty
        // one clears it), or {dimension, x, y, z} one more; -> {own: [...]}. A position is any block of the portal, or a
        // frame cell by it (the `portal:frame` landmark)
        s.register("portal.own", true, (p, c) -> {
            JsonElement list = p.get("portals");
            if (list != null && list.isJsonArray()) {
                Map<String, List<BlockPos>> next = new HashMap<>();
                for (JsonElement e : list.getAsJsonArray()) {
                    if (!e.isJsonObject()) continue;
                    JsonObject o = e.getAsJsonObject();
                    next.computeIfAbsent(Names.strip(strParam(o, "dimension", "overworld")), k -> new ArrayList<>()).add(blockPos(o));
                }
                OWN.clear();
                for (var e : next.entrySet()) OWN.put(e.getKey(), List.copyOf(e.getValue()));
            } else if (p.has("x")) {
                String dim = Names.strip(strParam(p, "dimension", Nether.here()));
                BlockPos at = blockPos(p);
                List<BlockPos> now = new ArrayList<>(OWN.getOrDefault(dim, List.of()));
                if (!now.contains(at)) now.add(at);
                OWN.put(dim, List.copyOf(now));
            }
            ownSynced = true;
            return obj("own", ownJson());
        });
    }
}
