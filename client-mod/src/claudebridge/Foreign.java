package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.SectionPos;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.status.ChunkStatus;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Pattern;

import static claudebridge.Json.*;

/**
 * Other players' builds round the bot, which it must not break (on a friend's server, and villages anywhere). Every
 * five seconds the chunks round the bot are looked through for blocks only a player (or a village, a mineshaft) puts
 * there: planks, glass, doors, beds, chests, crops, rails, wool... that the bot didn't place itself (its own are
 * Protection's positions) and that aren't in its own yard. Nearby ones make a zone: their box with a margin.
 *
 * A zone on the surface (a house, a farm, a pen, a village) is someone's place: near it every kind of block in it is
 * unbreakable for Baritone (Protection adds them to its no-break list: its mining and its paths leave the house, its
 * floor and the ground under it alone and go elsewhere), and so are the trees and crops people keep; Baritone places
 * nothing right by it, and the bot's own digs refuse a cell in it unless told to (force: a person asked for that block).
 * A zone under ground is mostly the world's own (a mineshaft, a dungeon, a stronghold, an ancient city) and now and
 * then someone's cellar: its own blocks stay unbroken, but the rock round it is anyone's to mine, or the bot's deep
 * trips would stall at every mineshaft.
 *
 * Stone, dirt, logs, leaves and the bot's throwaway blocks never mark a build: they're the world's, and the bot's own
 * scaffold is made of them.
 */
public final class Foreign {
    private Foreign() { }

    /** A marker as seen: where, what, and the most sky light beside it (15 out in the open, 0 in a cave or a cellar). */
    record Mark(BlockPos pos, Block block, int sky) { }

    static final class Zone {
        int x1, y1, z1, x2, y2, z2;
        int markers;
        /** on the surface (a house, a farm, a village); otherwise under ground (a mineshaft, a dungeon, a cellar) */
        boolean surface;
        /** the markers' kinds, and how many of each */
        final Map<String, Integer> kinds = new HashMap<>();
        /** the markers' blocks: what it's built of */
        final Set<Block> built = new LinkedHashSet<>();
        /** what Baritone mustn't break near it */
        final Set<Block> types = new LinkedHashSet<>();
        boolean contains(int x, int y, int z) { return x >= x1 && x <= x2 && y >= y1 && y <= y2 && z >= z1 && z <= z2; }
        /** horizontal distance from a point to the box (0 inside) */
        double flatDistance(int x, int z) {
            int dx = Math.max(0, Math.max(x1 - x, x - x2)), dz = Math.max(0, Math.max(z1 - z, z - z2));
            return Math.sqrt(dx * dx + dz * dz);
        }
        /** straight-line distance from a point to the box (0 inside): a mineshaft 80 blocks under the yard is far away */
        double distance(int x, int y, int z) {
            int dx = Math.max(0, Math.max(x1 - x, x - x2)), dy = Math.max(0, Math.max(y1 - y, y - y2)), dz = Math.max(0, Math.max(z1 - z, z - z2));
            return Math.sqrt((double) dx * dx + (double) dy * dy + (double) dz * dz);
        }
        /** its commonest marker */
        String sample() {
            String best = "";
            int n = 0;
            for (Map.Entry<String, Integer> e : kinds.entrySet()) if (e.getValue() > n) { best = e.getKey(); n = e.getValue(); }
            return best;
        }
    }

    private static final List<Zone> ZONES = new CopyOnWriteArrayList<>();
    /** How far round the bot it looks (horizontally; every height). */
    private static final int SCAN_RADIUS = 48;
    /** Markers this close together are one build; a zone on the surface is their box and this much more. */
    private static final int JOIN = 6, MARGIN = 4;
    /** An underground zone's margin: just round its own blocks (it mustn't reach up into the yard over it). */
    private static final int MARGIN_UNDER = 2;
    /**
     * A marker with this much sky light beside it is out in the open: a roof, a wall's outside, a fence, a crop. Caves,
     * cellars and mineshafts get none (however big the cave), while a house under a cliff or a sky build still gets
     * some from the side. A build is on the surface when a quarter of its markers are out in the open (a mineshaft:
     * half; one crossing a ravine is still the world's).
     */
    private static final int OPEN_SKY = 8;
    private static final int MAX_ZONES = 400, MAX_TYPE_SCAN = 200_000;

    /** What only a player (or a village, a mineshaft, a fortress) puts in the world. */
    static final Pattern MARKER = Pattern.compile("^(.*_planks|.*_slab|.*_stairs|.*_wall|.*_fence|.*_fence_gate|.*_door|.*_trapdoor"
        + "|.*_pressure_plate|.*_button|.*_sign|.*_wall_sign|.*_hanging_sign|.*_wall_hanging_sign|.*_bed|.*_carpet|.*_wool"
        + "|.*_banner|.*_wall_banner|.*_candle|candle|glass|glass_pane|.*_stained_glass|.*_stained_glass_pane|tinted_glass"
        + "|.*_concrete|.*_concrete_powder|.*_glazed_terracotta|.*shulker_box|bricks|.*_bricks|.*_tiles|smooth_stone"
        + "|polished_[a-z_]+|quartz_block|quartz_pillar|quartz_bricks|smooth_quartz|chiseled_[a-z_]+|cut_[a-z_]+|smooth_sandstone"
        + "|smooth_red_sandstone|stripped_[a-z_]+|chest|trapped_chest|barrel|furnace|blast_furnace|smoker|crafting_table|crafter"
        + "|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|cauldron|[a-z_]+_cauldron|composter|lectern|bell"
        + "|loom|cartography_table|smithing_table|fletching_table|grindstone|stonecutter|bookshelf|chiseled_bookshelf|jukebox"
        + "|note_block|beacon|ender_chest|respawn_anchor|lodestone|flower_pot|potted_[a-z_]+|decorated_pot|campfire|soul_campfire"
        + "|hopper|dropper|dispenser|observer|piston|sticky_piston|lever|repeater|comparator|redstone_wire|redstone_torch"
        + "|redstone_wall_torch|redstone_lamp|target|daylight_detector|tripwire_hook|torch|wall_torch|soul_torch|soul_wall_torch"
        + "|copper_torch|copper_wall_torch|lantern|soul_lantern|[a-z_]*copper_lantern|end_rod|jack_o_lantern|farmland|wheat"
        + "|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|hay_block|rail"
        + "|powered_rail|detector_rail|activator_rail|ladder|scaffolding|iron_bars|chain|iron_chain|[a-z_]*copper_chain|iron_door"
        + "|iron_trapdoor|nether_portal|tnt|slime_block|honey_block|[a-z_]*copper_bulb|[a-z_]*copper_grate|.*_shelf)$");

    /**
     * What a mineshaft is made of (its corridors, supports, rails, the chains and torches on its beams). A zone of these
     * and nothing else is a mineshaft unless most of it stands in the open: one crossing a ravine is still the world's.
     */
    private static final Pattern MINESHAFT = Pattern.compile("^(oak_planks|dark_oak_planks|spruce_planks|oak_fence|dark_oak_fence"
        + "|spruce_fence|rail|torch|wall_torch|chain|iron_chain)$");

    private static final Map<Block, Boolean> MARKS = new HashMap<>();
    private static final Map<Block, String> NAMES = new HashMap<>();

    static boolean marker(BlockState s) {
        if (s.isAir()) return false;
        return MARKS.computeIfAbsent(s.getBlock(), b -> MARKER.matcher(name(b)).matches());
    }

    private static String name(Block b) { return NAMES.computeIfAbsent(b, k -> Names.block(k.defaultBlockState())); }

    /** Inside someone else's build (its zone), on the surface or under it. */
    public static boolean inZone(BlockPos p) {
        for (Zone z : ZONES) if (z.contains(p.getX(), p.getY(), p.getZ())) return true;
        return false;
    }

    /**
     * Not the bot's to dig: anything in a zone on the surface (the house, its floor, the ground it stands on), or one of
     * the blocks an underground one is built of (a mineshaft's planks, a cellar's chest; the rock round it is anyone's).
     */
    public static boolean guarded(BlockPos p, BlockState s) {
        // what the bot put there itself is its own to take back (an emergency wall-in at a friend's, its scaffold)
        if (Protection.isOwn(p) || Guardian.WALL.contains(p)) return false;
        for (Zone z : ZONES) {
            if (!z.contains(p.getX(), p.getY(), p.getZ())) continue;
            if (z.surface || z.built.contains(s.getBlock())) return true;
        }
        return false;
    }

    /**
     * What people keep round their builds without a single crafted block by it: trees, crops grown in the open (a cane
     * patch by the river, a melon field), saplings. Near anyone's build the bot fells and harvests none of it.
     */
    private static final Pattern KEPT_RE = Pattern.compile("^(.*_log|.*_wood|.*_leaves|.*_sapling|.*_propagule|sugar_cane|bamboo"
        + "|pumpkin|carved_pumpkin|melon|cactus|sweet_berry_bush|cocoa|nether_wart|wheat|carrots|potatoes|beetroots|.*_mushroom_block"
        + "|mangrove_roots|muddy_mangrove_roots|azalea|flowering_azalea)$");
    private static List<Block> kept;

    private static List<Block> kept() {
        if (kept == null) {
            List<Block> out = new ArrayList<>();
            for (Block b : net.minecraft.core.registries.BuiltInRegistries.BLOCK) if (KEPT_RE.matcher(name(b)).matches()) out.add(b);
            kept = out;
        }
        return kept;
    }

    /**
     * The kinds of block in the zones near a point, and (by a build on the surface) the trees and crops people keep round
     * them: Baritone may break none of them while it's there.
     */
    static Set<Block> typesNear(BlockPos me, int radius) {
        Set<Block> out = new LinkedHashSet<>();
        boolean surface = false;
        for (Zone z : ZONES) {
            if (z.flatDistance(me.getX(), me.getZ()) > radius) continue;
            if (me.getY() < z.y1 - radius || me.getY() > z.y2 + radius) continue;
            out.addAll(z.types);
            surface |= z.surface;
        }
        if (surface) out.addAll(kept());
        return out;
    }

    /** How far the nearest build on the surface is, in a straight line (Infinity with none). */
    static double nearest(BlockPos me) {
        double best = Double.POSITIVE_INFINITY;
        for (Zone z : ZONES) if (z.surface) best = Math.min(best, z.distance(me.getX(), me.getY(), me.getZ()));
        return best;
    }

    static int count() { return ZONES.size(); }

    private static long cell(int x, int y, int z) {
        return BlockPos.asLong(Math.floorDiv(x, JOIN), Math.floorDiv(y, JOIN), Math.floorDiv(z, JOIN));
    }

    /** The markers last seen in each chunk looked at (chunk key -> markers), replaced each time it's looked at again. */
    private static final Map<Long, List<Mark>> BY_CHUNK = new HashMap<>();
    /** One of these alone is someone's (a stash chest in a field, a bed); other markers make a build from MIN_MARKERS up. */
    private static final Pattern STASH = Pattern.compile("^(chest|trapped_chest|barrel|.*shulker_box|.*_bed|furnace|blast_furnace|smoker|ender_chest)$");
    private static final int MIN_MARKERS = 4;

    /**
     * Look through the loaded chunks round the bot for markers, and rebuild the zones when what's there changed. Only
     * once Node has sent what the bot built and its home zone: before that its own yard looked like someone else's (a
     * zone over the whole homestead, and the bot dropped its own bed and chests). A chunk looked at again replaces what
     * was seen there, so nothing wrong sticks (the yard grows, a friend takes something down).
     */
    /** the tick of the last scan */
    private static long lastScan = Long.MIN_VALUE / 2;

    /** A scan now unless one ran in the last two seconds: what's asked about is never older than that. */
    private static void fresh(Minecraft mc) {
        if (Ticker.ticks() - lastScan < 40) return;
        try { scan(mc); } catch (RuntimeException e) { /* a chunk unloading under it: the zones as they were */ }
    }

    /**
     * Lit nether portals seen, by chunk: every one (the bot's own too), not only others'. A portal's frame is obsidian,
     * the very block the enchanting room's trip goes out to mine: no obsidian is broken near a lit portal, whoever's.
     */
    private static final Map<Long, List<BlockPos>> PORTALS = new HashMap<>();

    /** A lit nether portal within `radius` of p (as last scanned). */
    static boolean portalNear(BlockPos p, int radius) {
        long r2 = (long) radius * radius;
        for (List<BlockPos> l : PORTALS.values()) for (BlockPos q : l) if (q.distSqr(p) <= r2) return true;
        return false;
    }

    static void scan(Minecraft mc) {
        ClientLevel level = mc.level;
        if (mc.player == null || level == null || !Protection.synced()) return;
        lastScan = Ticker.ticks();
        BlockPos me = mc.player.blockPosition();
        boolean changed = false;
        BlockPos.MutableBlockPos side = new BlockPos.MutableBlockPos();
        for (int cx = (me.getX() - SCAN_RADIUS) >> 4; cx <= (me.getX() + SCAN_RADIUS) >> 4; cx++) {
            for (int cz = (me.getZ() - SCAN_RADIUS) >> 4; cz <= (me.getZ() + SCAN_RADIUS) >> 4; cz++) {
                LevelChunk ch = level.getChunkSource().getChunk(cx, cz, ChunkStatus.FULL, false);
                if (ch == null) continue;
                List<Mark> marks = new ArrayList<>();
                List<BlockPos> portals = new ArrayList<>();
                LevelChunkSection[] sections = ch.getSections();
                for (int si = 0; si < sections.length; si++) {
                    LevelChunkSection sec = sections[si];
                    if (sec == null || sec.hasOnlyAir() || !sec.getStates().maybeHas(Foreign::marker)) continue;
                    int by = SectionPos.sectionToBlockCoord(level.getSectionYFromSectionIndex(si));
                    for (int y = 0; y < 16; y++) for (int z = 0; z < 16; z++) for (int x = 0; x < 16; x++) {
                        BlockState st = sec.getBlockState(x, y, z);
                        if (!marker(st)) continue;
                        BlockPos at = new BlockPos((cx << 4) + x, by + y, (cz << 4) + z);
                        if (st.is(net.minecraft.world.level.block.Blocks.NETHER_PORTAL)) portals.add(at);
                        if (Protection.isOwn(at)) continue;
                        marks.add(new Mark(at, st.getBlock(), skyBeside(level, at, side)));
                    }
                }
                long key = (((long) cx) << 32) ^ (cz & 0xffffffffL);
                if (portals.isEmpty()) PORTALS.remove(key); else PORTALS.put(key, portals);
                List<Mark> before = BY_CHUNK.get(key);
                if (marks.isEmpty()) { if (before != null) { BY_CHUNK.remove(key); changed = true; } }
                else if (!marks.equals(before)) { BY_CHUNK.put(key, marks); changed = true; }
            }
        }
        if (changed) rebuild(level);
    }

    /** The most sky light in the six cells round a block (a solid block has none of its own). */
    private static int skyBeside(ClientLevel level, BlockPos at, BlockPos.MutableBlockPos p) {
        int best = 0;
        for (Direction d : Direction.values()) {
            best = Math.max(best, level.getBrightness(LightLayer.SKY, p.setWithOffset(at, d)));
            if (best >= 15) break;
        }
        return best;
    }

    /** The zones from every marker seen: groups of markers close together, each a box with a margin. */
    private static void rebuild(ClientLevel level) {
        Map<Long, List<Mark>> cells = new HashMap<>();
        for (List<Mark> l : BY_CHUNK.values()) for (Mark m : l) cells.computeIfAbsent(cell(m.pos().getX(), m.pos().getY(), m.pos().getZ()), k -> new ArrayList<>()).add(m);
        Map<String, Set<Block>> known = new HashMap<>();
        for (Zone o : ZONES) known.put(boxKey(o), o.types);
        List<Zone> next = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        for (Long start : cells.keySet()) {
            if (!seen.add(start)) continue;
            List<Mark> group = new ArrayList<>();
            ArrayDeque<Long> queue = new ArrayDeque<>(List.of(start));
            while (!queue.isEmpty()) {
                long c = queue.poll();
                group.addAll(cells.get(c));
                BlockPos cp = BlockPos.of(c);
                for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) for (int dz = -1; dz <= 1; dz++) {
                    long n = BlockPos.asLong(cp.getX() + dx, cp.getY() + dy, cp.getZ() + dz);
                    if (cells.containsKey(n) && seen.add(n)) queue.add(n);
                }
            }
            Zone z = new Zone();
            boolean stash = false, mineshaft = true;
            int open = 0;
            z.x1 = Integer.MAX_VALUE; z.y1 = Integer.MAX_VALUE; z.z1 = Integer.MAX_VALUE;
            z.x2 = Integer.MIN_VALUE; z.y2 = Integer.MIN_VALUE; z.z2 = Integer.MIN_VALUE;
            for (Mark m : group) {
                BlockPos p = m.pos();
                z.x1 = Math.min(z.x1, p.getX()); z.y1 = Math.min(z.y1, p.getY()); z.z1 = Math.min(z.z1, p.getZ());
                z.x2 = Math.max(z.x2, p.getX()); z.y2 = Math.max(z.y2, p.getY()); z.z2 = Math.max(z.z2, p.getZ());
                String n = name(m.block());
                z.kinds.merge(n, 1, Integer::sum);
                z.built.add(m.block());
                if (STASH.matcher(n).matches()) stash = true;
                if (!MINESHAFT.matcher(n).matches()) mineshaft = false;
                if (m.sky() >= OPEN_SKY) open++;
            }
            if (group.size() < MIN_MARKERS && !stash) continue; // a lone torch or rail isn't a build
            // on the surface: a fair part of it out in the open (a roof, walls, a fence, crops); a mineshaft only when most of it is
            z.surface = mineshaft ? open * 2 > group.size() : open * 4 >= group.size();
            if (z.surface) {
                // a margin round it, the ground it stands on, a little over its top
                z.x1 -= MARGIN; z.z1 -= MARGIN; z.x2 += MARGIN; z.z2 += MARGIN; z.y1 -= 3; z.y2 += MARGIN;
            } else {
                z.x1 -= MARGIN_UNDER; z.z1 -= MARGIN_UNDER; z.x2 += MARGIN_UNDER; z.z2 += MARGIN_UNDER; z.y1 -= 1; z.y2 += 1;
            }
            z.markers = group.size();
            next.add(z);
        }
        // boxes that overlap after their margins are one build (on the surface if either part is)
        boolean merged = true;
        while (merged) {
            merged = false;
            for (int i = 0; i < next.size() && !merged; i++) for (int j = i + 1; j < next.size() && !merged; j++) {
                Zone a = next.get(i), b = next.get(j);
                if (a.x1 > b.x2 || a.x2 < b.x1 || a.y1 > b.y2 || a.y2 < b.y1 || a.z1 > b.z2 || a.z2 < b.z1) continue;
                a.x1 = Math.min(a.x1, b.x1); a.y1 = Math.min(a.y1, b.y1); a.z1 = Math.min(a.z1, b.z1);
                a.x2 = Math.max(a.x2, b.x2); a.y2 = Math.max(a.y2, b.y2); a.z2 = Math.max(a.z2, b.z2);
                a.markers += b.markers;
                a.surface |= b.surface;
                for (Map.Entry<String, Integer> e : b.kinds.entrySet()) a.kinds.merge(e.getKey(), e.getValue(), Integer::sum);
                a.built.addAll(b.built);
                next.remove(j);
                merged = true;
            }
        }
        while (next.size() > MAX_ZONES) next.remove(next.size() - 1);
        for (Zone z : next) {
            Set<Block> t = known.get(boxKey(z));
            if (t != null) z.types.addAll(t); else typesOf(level, z);
            z.types.addAll(z.built); // what it's built of, even where its chunks aren't loaded now
        }
        ZONES.clear();
        ZONES.addAll(next);
    }

    private static String boxKey(Zone z) { return z.x1 + "," + z.y1 + "," + z.z1 + "," + z.x2 + "," + z.y2 + "," + z.z2 + "," + z.surface; }

    /**
     * What Baritone mustn't break near a zone. On the surface: every kind of block in it (air and fluids aside): its
     * walls, its floor, the ground under it. Under ground: only what it's built of (the rest is rock to mine).
     */
    private static void typesOf(ClientLevel level, Zone z) {
        z.types.clear();
        if (!z.surface) return; // rebuild adds what it's built of
        long volume = (long) (z.x2 - z.x1 + 1) * (z.y2 - z.y1 + 1) * (z.z2 - z.z1 + 1);
        int step = volume > MAX_TYPE_SCAN ? 2 : 1;
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        for (int x = z.x1; x <= z.x2; x += step) for (int y = z.y1; y <= z.y2; y += step) for (int zz = z.z1; zz <= z.z2; zz += step) {
            p.set(x, y, zz);
            if (!level.isLoaded(p)) continue;
            BlockState s = level.getBlockState(p);
            if (s.isAir() || !s.getFluidState().isEmpty() && s.getBlock() instanceof net.minecraft.world.level.block.LiquidBlock) continue;
            z.types.add(s.getBlock());
        }
    }

    /** A zone's commonest kinds, "name x count", most first. */
    private static JsonArray kindsOf(Zone z, int max) {
        JsonArray out = new JsonArray();
        z.kinds.entrySet().stream().sorted((a, b) -> b.getValue() - a.getValue()).limit(max).forEach(e -> out.add(e.getKey() + " x" + e.getValue()));
        return out;
    }

    public static void register(BridgeServer s) {
        // {} -> {zones: [{x1, y1, z1, x2, y2, z2, markers, surface, sample, kinds}]}
        s.register("foreign.zones", true, (p, c) -> {
            fresh(Minecraft.getInstance()); // the first ask on a new server comes right after Node's first sync
            JsonArray out = new JsonArray();
            for (Zone z : ZONES) {
                JsonObject o = obj("x1", z.x1, "y1", z.y1, "z1", z.z1, "x2", z.x2, "y2", z.y2, "z2", z.z2, "markers", z.markers, "surface", z.surface, "sample", z.sample());
                o.add("kinds", kindsOf(z, 6));
                out.add(o);
            }
            return obj("zones", out);
        });
        // {positions: [[x, y, z], ...]} -> {inside: [bool, ...]}: which are in someone else's build
        s.register("foreign.at", true, (p, c) -> {
            fresh(Minecraft.getInstance());
            JsonArray out = new JsonArray();
            JsonElement list = p.get("positions");
            if (list != null && list.isJsonArray()) {
                for (JsonElement e : list.getAsJsonArray()) {
                    JsonArray a = e.getAsJsonArray();
                    out.add(inZone(new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt())));
                }
            }
            return obj("inside", out);
        });
        // forget them all (the next scans find what's there again)
        s.register("foreign.clear", true, (p, c) -> { int n = ZONES.size(); ZONES.clear(); BY_CHUNK.clear(); return obj("cleared", n); });
        Ticker.every(new Ticker.Task() {
            int n = 0;
            @Override public boolean tick(Minecraft mc) {
                if (++n % 100 == 0) {
                    try { scan(mc); } catch (RuntimeException e) { /* a chunk unloading under it: next time */ }
                }
                return false;
            }
        });
    }

    /** For the status line: how many zones (and how many on the surface), and the nearest on the surface. */
    static JsonObject summary(BlockPos me) {
        double d = nearest(me);
        int surface = 0;
        for (Zone z : ZONES) if (z.surface) surface++;
        return obj("zones", ZONES.size(), "surface", surface, "nearest", Double.isInfinite(d) ? null : round(d));
    }
}
