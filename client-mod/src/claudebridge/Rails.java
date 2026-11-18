package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.vehicle.minecart.AbstractMinecart;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BaseRailBlock;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.PoweredRailBlock;
import net.minecraft.world.level.block.RedstoneTorchBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static claudebridge.Json.*;

/**
 * The rails home (P5e of the progression plan, the user's fallback when the boat finds no way: railroute.ts plans the
 * line): rails and powered rails laid with the shapes the plan has, the redstone torches that light them, the minecart put
 * on the line, and the cart watched as it goes. rail.place / rail.torch / cart.place / cart.status / cart.watch. The cart
 * is the bot's own as a boat is (Vehicle's set of uuids), so vehicle.mount, vehicle.take and vehicle.status take it too.
 *
 * Checked against the 26.3 jar (javap, and the jar's own RailState and rail blocks run on a scratch level against the
 * port below, many thousands of random layings: RailsBridgeCheck):
 * - A rail takes no shape from the hand. The item puts it down north_south, or east_west while the bot faces east or west
 *   (BaseRailBlock.getStateForPlacement), and at once RailState.place turns it to the rails beside it (a block up or down
 *   among them) that can still take a connection, fewer than two: straight to one, a curve to two at a right angle (not a
 *   powered rail: straight only), a slope toward one a block up; and each of those turns to it (connectTo). So the rail
 *   before a curve becomes the curve only once the rail after it is down, and the one under a step becomes the slope then.
 *   The line is laid in its order, each rail beside the last, and rail.place looks before it places, on the port: the
 *   rail before (`prev`) must come out as the plan has it, and this one as `shape` once a rail is down at the cell after
 *   (`next`; none: now). It refuses what would not, and what would turn any rail but those two (a rail of someone's).
 * - Taking a rail up turns no other: the removal only tells the neighbours, and a plain rail answers that only for a
 *   redstone source with three rails round it (RailBlock.updateState); a powered one only looks at its power again.
 * - A slope rail needs a block it can stand on at the side it rises to (BaseRailBlock.shouldBeRemoved): else it drops.
 * - The minecart item goes on any rail clicked (MinecartItem.useOn: the rails tag), the cart at the rail's middle, 1/16
 *   up (and half a block more on a slope). A cart takes in the first mob it runs into: no player, no iron golem, no cart,
 *   one rider only, the cart empty (OldMinecartBehavior.pushAndPickupEntities), within its box grown 0.2 sideways, but
 *   only while it moves at 0.1 a tick or more: put down still, it takes no one.
 * - Which minecart rules: OldMinecartBehavior, unless the world was made with the minecart_improvements experiment (a
 *   feature flag a world gets at its creation; AbstractMinecart.useExperimentalMovement reads level.enabledFeatures(),
 *   which the client has from the server: `newMovement` in every reply). Under it NewMinecartBehavior.pickupEntities
 *   takes a mob touching the cart at any speed, still or not, and the line's speeds (railroute.ts) were measured on the
 *   old rules: cart.place refuses on such a server unless asked (`newMovement: true`).
 * - A player in a still cart barely moves it (OldMinecartBehavior: 0.001 of the player's input a tick, and only under
 *   0.1): the line's carts go by its powered rails. The launch is the trigger torch beside the launch's powered rail: lit,
 *   the rail pushes a still cart off the solid block behind it (the stop). There is no push call: a cart that missed its
 *   villager is taken back up (vehicle.take) and put down again.
 * - Past the server's simulation distance (ClientLevel.getServerSimulationDistance, in chunks: cart.status says it) a
 *   cart is not ticked: it waits where it is, its speed kept, until a player comes near; past the client's sight it is
 *   gone from the client (cart.watch: "out of sight").
 */
public final class Rails {
    private Rails() { }

    /** How near (eye to the point clicked) a rail, a torch or a cart goes down: as Interact's place. */
    static final double REACH = 4.5;
    /** How far round a cell the port reads the rails: a neighbour's own connections reach two out, a block up or down. */
    static final int AROUND = 3;
    /** A cart takes a mob in only at this speed or more (OldMinecartBehavior: horizontalDistanceSqr >= 0.01). */
    static final double TAKE_SPEED = 0.1;
    /** A cart is at rest under this (blocks a tick) for REST_TICKS in a row. */
    static final double REST_SPEED = 0.005;
    static final int REST_TICKS = 10;

    // ---------------------------------------------------------------- pure rules: RailState, ported

    /** A rail as read: its shape (RailShape's name: north_south, ascending_east, south_west...) and whether it is straight only (a powered rail). */
    static final class Rail {
        String shape;
        final boolean straight;
        Rail(String shape, boolean straight) { this.shape = shape; this.straight = straight; }
    }

    /** The rails round a cell, by position: what the port reads and turns. */
    static final class Track {
        final Map<Long, Rail> at = new HashMap<>();
        Rail get(int x, int y, int z) { return at.get(BlockPos.asLong(x, y, z)); }
        String shape(int x, int y, int z) { Rail r = get(x, y, z); return r == null ? null : r.shape; }
        void put(int x, int y, int z, String shape, boolean straight) { at.put(BlockPos.asLong(x, y, z), new Rail(shape, straight)); }
        Track copy() {
            Track t = new Track();
            for (var e : at.entrySet()) t.at.put(e.getKey(), new Rail(e.getValue().shape, e.getValue().straight));
            return t;
        }
    }

    /** The shape a rail is put down with: east_west while the bot faces east or west, else north_south. Pure. */
    static String placedShape(boolean facingEastWest) { return facingEastWest ? "east_west" : "north_south"; }

    /** Whether a shape runs east and west (a straight one, or a slope that rises east or west). Pure. */
    static boolean eastWest(String shape) { return shape.equals("east_west") || shape.equals("ascending_east") || shape.equals("ascending_west"); }

    /** The side a slope rises to ({dx, dz}), or null for a level rail. Pure. */
    static int[] risesTo(String shape) {
        return switch (shape) {
            case "ascending_east" -> new int[] { 1, 0 };
            case "ascending_west" -> new int[] { -1, 0 };
            case "ascending_north" -> new int[] { 0, -1 };
            case "ascending_south" -> new int[] { 0, 1 };
            default -> null;
        };
    }

    /** RailState, on a Track (the jar's, step by step: the scratch check holds the two together). */
    private static final class State {
        final Track t;
        final int x, y, z;
        final boolean straight;
        final String shape;
        final List<int[]> conns = new ArrayList<>();

        State(Track t, int x, int y, int z) {
            this.t = t; this.x = x; this.y = y; this.z = z;
            Rail r = t.get(x, y, z);
            this.straight = r.straight;
            this.shape = r.shape;
            connectionsOf(shape);
        }

        void connectionsOf(String s) {
            conns.clear();
            switch (s) {
                case "north_south" -> { add(x, y, z - 1); add(x, y, z + 1); }
                case "east_west" -> { add(x - 1, y, z); add(x + 1, y, z); }
                case "ascending_east" -> { add(x - 1, y, z); add(x + 1, y + 1, z); }
                case "ascending_west" -> { add(x - 1, y + 1, z); add(x + 1, y, z); }
                case "ascending_north" -> { add(x, y + 1, z - 1); add(x, y, z + 1); }
                case "ascending_south" -> { add(x, y, z - 1); add(x, y + 1, z + 1); }
                case "south_east" -> { add(x + 1, y, z); add(x, y, z + 1); }
                case "south_west" -> { add(x - 1, y, z); add(x, y, z + 1); }
                case "north_west" -> { add(x - 1, y, z); add(x, y, z - 1); }
                case "north_east" -> { add(x + 1, y, z); add(x, y, z - 1); }
                default -> { }
            }
        }

        void add(int a, int b, int c) { conns.add(new int[] { a, b, c }); }

        boolean rail(int a, int b, int c) { return t.get(a, b, c) != null; }

        /** The rail at (a, b, c), or a block up, or a block down (RailState.getRail). */
        State railAt(int a, int b, int c) {
            if (rail(a, b, c)) return new State(t, a, b, c);
            if (rail(a, b + 1, c)) return new State(t, a, b + 1, c);
            if (rail(a, b - 1, c)) return new State(t, a, b - 1, c);
            return null;
        }

        void removeSoft() {
            for (int i = 0; i < conns.size(); i++) {
                int[] c = conns.get(i);
                State r = railAt(c[0], c[1], c[2]);
                if (r == null || !r.connectsTo(this)) conns.remove(i--);
                else conns.set(i, new int[] { r.x, r.y, r.z });
            }
        }

        boolean connectsTo(State o) { return hasConnection(o.x, o.z); }

        boolean hasConnection(int a, int c) {
            for (int[] k : conns) if (k[0] == a && k[2] == c) return true;
            return false;
        }

        boolean canConnectTo(State o) { return connectsTo(o) || conns.size() != 2; }

        void connectTo(State o) {
            conns.add(new int[] { o.x, o.y, o.z });
            boolean n = hasConnection(x, z - 1), s = hasConnection(x, z + 1), w = hasConnection(x - 1, z), e = hasConnection(x + 1, z);
            String to = null;
            if (n || s) to = "north_south";
            if (w || e) to = "east_west";
            if (!straight) {
                if (s && e && !n && !w) to = "south_east";
                if (s && w && !n && !e) to = "south_west";
                if (n && w && !s && !e) to = "north_west";
                if (n && e && !s && !w) to = "north_east";
            }
            to = slope(to);
            if (to == null) to = "north_south";
            t.get(x, y, z).shape = to;
        }

        /** A straight shape turned to a slope toward a rail a block up beside it (RailState's checks, in its order). */
        String slope(String to) {
            if ("north_south".equals(to)) {
                if (rail(x, y + 1, z - 1)) to = "ascending_north";
                if (rail(x, y + 1, z + 1)) to = "ascending_south";
            }
            if ("east_west".equals(to)) {
                if (rail(x + 1, y + 1, z)) to = "ascending_east";
                if (rail(x - 1, y + 1, z)) to = "ascending_west";
            }
            return to;
        }

        boolean neighbour(int a, int b, int c) {
            State r = railAt(a, b, c);
            if (r == null) return false;
            r.removeSoft();
            return r.canConnectTo(this);
        }

        void place(boolean powered, String current) {
            boolean n = neighbour(x, y, z - 1), s = neighbour(x, y, z + 1), w = neighbour(x - 1, y, z), e = neighbour(x + 1, y, z);
            String to = null;
            boolean ns = n || s, ew = w || e;
            if (ns && !ew) to = "north_south";
            if (ew && !ns) to = "east_west";
            boolean se = s && e, sw = s && w, ne = n && e, nw = n && w;
            if (!straight) {
                if (se && !n && !w) to = "south_east";
                if (sw && !n && !e) to = "south_west";
                if (nw && !s && !e) to = "north_west";
                if (ne && !s && !w) to = "north_east";
            }
            if (to == null) {
                if (ns && ew) to = current;
                else if (ns) to = "north_south";
                else if (ew) to = "east_west";
                if (!straight) {
                    if (powered) {
                        if (se) to = "south_east";
                        if (sw) to = "south_west";
                        if (ne) to = "north_east";
                        if (nw) to = "north_west";
                    } else {
                        if (nw) to = "north_west";
                        if (ne) to = "north_east";
                        if (sw) to = "south_west";
                        if (se) to = "south_east";
                    }
                }
            }
            to = slope(to);
            if (to == null) to = current;
            connectionsOf(to);
            t.get(x, y, z).shape = to;
            for (int i = 0; i < conns.size(); i++) {
                int[] c = conns.get(i);
                State r = railAt(c[0], c[1], c[2]);
                if (r == null) continue;
                r.removeSoft();
                if (r.canConnectTo(this)) r.connectTo(this);
            }
        }
    }

    /**
     * A rail put down at (x, y, z) on `t`, as the game does it: in with `placedShape`, then RailState.place (`powered`: a
     * signal reaches the cell, which picks among curves where three rails meet). Returns every rail whose shape changed,
     * by position, {before, after} (before null for the new one); `t` holds the shapes after. Pure.
     */
    static Map<Long, String[]> place(Track t, int x, int y, int z, boolean straight, String placedShape, boolean powered) {
        Map<Long, String> before = new HashMap<>();
        for (var e : t.at.entrySet()) before.put(e.getKey(), e.getValue().shape);
        t.put(x, y, z, placedShape, straight);
        new State(t, x, y, z).place(powered, placedShape);
        Map<Long, String[]> out = new LinkedHashMap<>();
        for (var e : t.at.entrySet()) {
            String was = before.get(e.getKey());
            if (was == null || !was.equals(e.getValue().shape)) out.put(e.getKey(), new String[] { was, e.getValue().shape });
        }
        return out;
    }

    /** A cell of the plan, with the shape it should end with (or, for `next`, whether its rail is straight only). */
    record Cell(int x, int y, int z, String shape, boolean straight) { }

    /** What a rail put down as asked would do (pure): the shapes now, the shape once the next is down, or why not. */
    record Judged(Map<Long, String[]> turned, String now, String once, String why) { }

    /**
     * Whether a rail put down at `me` (straight only for a powered rail, facing east or west or not) comes out as the plan
     * has it (pure): the rail before (`prev`, may be null) ends as its shape, no other rail turns, and this one is `want`
     * once a rail is down at `next` (null: now; want null: anything). The judgement and the shapes, or why not.
     */
    static Judged judge(Track t, Cell me, boolean facingEastWest, boolean powered, String want, Cell prev, Cell next) {
        Track after = t.copy();
        Map<Long, String[]> turned = place(after, me.x(), me.y(), me.z(), me.straight(), placedShape(facingEastWest), powered);
        String now = after.shape(me.x(), me.y(), me.z());
        long mine = BlockPos.asLong(me.x(), me.y(), me.z());
        long prevAt = prev == null ? Long.MIN_VALUE : BlockPos.asLong(prev.x(), prev.y(), prev.z());
        for (var e : turned.entrySet()) {
            if (e.getKey() == mine || e.getKey() == prevAt) continue;
            BlockPos p = BlockPos.of(e.getKey());
            return new Judged(turned, now, null, "it would turn the rail at " + p.toShortString() + " (" + e.getValue()[0] + " to " + e.getValue()[1] + ")");
        }
        if (prev != null && prev.shape() != null) {
            String p = after.shape(prev.x(), prev.y(), prev.z());
            if (p == null) return new Judged(turned, now, null, "no rail at " + prev.x() + ", " + prev.y() + ", " + prev.z() + " (the one before)");
            if (!p.equals(prev.shape())) return new Judged(turned, now, null, "the rail before at " + prev.x() + ", " + prev.y() + ", " + prev.z() + " would be " + p + ", not " + prev.shape());
        }
        String once = now;
        if (next != null) {
            Track then = after.copy();
            if (then.get(next.x(), next.y(), next.z()) == null) place(then, next.x(), next.y(), next.z(), next.straight(), placedShape(next.x() != me.x()), false);
            once = then.shape(me.x(), me.y(), me.z());
        }
        if (want != null && !want.equals(once)) {
            return new Judged(turned, now, once, "it would come out " + once + (next != null ? " once the next rail is down" : "") + ", not " + want);
        }
        return new Judged(turned, now, once, null);
    }

    /** Whether a cart moving `speed` blocks a tick takes in a mob it runs into: the old rules from 0.1, the experiment's at any speed. Pure. */
    static boolean takes(double speed, boolean newMovement) { return newMovement || speed >= TAKE_SPEED - 1e-9; }

    /** Where a cart put on a rail at (x, y, z) comes down (MinecartItem.useOn): the middle, 1/16 up, half a block more on a slope. Pure. */
    static double[] cartAt(int x, int y, int z, boolean slope) { return new double[] { x + 0.5, y + 0.0625 + (slope ? 0.5 : 0), z + 0.5 }; }

    // ---------------------------------------------------------------- live helpers

    /** The rails round `c` (AROUND each way), as the client sees them. */
    static Track read(Level level, BlockPos c) {
        Track t = new Track();
        for (int dx = -AROUND; dx <= AROUND; dx++) for (int dy = -AROUND; dy <= AROUND; dy++) for (int dz = -AROUND; dz <= AROUND; dz++) {
            BlockPos p = c.offset(dx, dy, dz);
            BlockState s = level.getBlockState(p);
            String shape = shapeOf(s);
            if (shape != null) t.put(p.getX(), p.getY(), p.getZ(), shape, ((BaseRailBlock) s.getBlock()).isStraight());
        }
        return t;
    }

    /** A rail's shape by its name, or null when the block is no rail. */
    static String shapeOf(BlockState s) {
        if (!BaseRailBlock.isRail(s) || !(s.getBlock() instanceof BaseRailBlock b)) return null;
        return s.getValue(b.getShapeProperty()).getSerializedName();
    }

    static boolean powered(BlockState s) { return s.hasProperty(PoweredRailBlock.POWERED) && s.getValue(PoweredRailBlock.POWERED); }

    /** What stands at `p`, as the brain's world.region reads it: the block, a rail's shape, a powered rail's power, a torch's light. */
    static JsonObject blockJson(Level level, BlockPos p) {
        BlockState s = level.getBlockState(p);
        JsonObject o = pos(p);
        o.addProperty("block", Names.block(s));
        String shape = shapeOf(s);
        if (shape != null) o.addProperty("shape", shape);
        if (s.hasProperty(PoweredRailBlock.POWERED)) o.addProperty("powered", s.getValue(PoweredRailBlock.POWERED));
        if (s.hasProperty(RedstoneTorchBlock.LIT)) o.addProperty("lit", s.getValue(RedstoneTorchBlock.LIT));
        return o;
    }

    static Cell cell(JsonObject p, String key, boolean withShape) {
        JsonElement e = p.get(key);
        if (e == null || !e.isJsonObject()) return null;
        JsonObject o = e.getAsJsonObject();
        BlockPos b = blockPos(o);
        String item = strParam(o, "item", "rail");
        return new Cell(b.getX(), b.getY(), b.getZ(), withShape ? strParam(o, "shape", null) : null, item.equals("powered_rail"));
    }

    /** The rails that turned, as the replies list them. */
    static JsonArray turnedJson(Map<Long, String[]> turned) {
        JsonArray a = new JsonArray();
        for (var e : turned.entrySet()) {
            JsonObject o = pos(BlockPos.of(e.getKey()));
            o.addProperty("from", e.getValue()[0]);
            o.addProperty("to", e.getValue()[1]);
            a.add(o);
        }
        return a;
    }

    /** The top face of the block under `at`, clicked as the item's use: in reach, or why not. */
    static Object topOf(LocalPlayer me, BlockPos below) {
        Vec3 hit = new Vec3(below.getX() + 0.5, below.getY() + 1.0, below.getZ() + 0.5);
        double d = me.getEyePosition().distanceTo(hit);
        if (d > REACH) return "too far (" + round(d) + ")";
        return new BlockHitResult(hit, Direction.UP, below, false);
    }

    static boolean newMovement(Level level) { return AbstractMinecart.useExperimentalMovement(level); }

    /** Use the item in hand on `click` after the look and the slot went out, then hand the world to `after` on later ticks. */
    interface After { boolean tick(Minecraft m, int age); }

    static void useThen(String item, BlockHitResult click, Float yaw, BridgeServer.Call c, After after) {
        Vehicle.cancelBaritone();
        LocalPlayer me = Handlers.player();
        if (me.containerMenu != me.inventoryMenu) me.closeContainer();
        // the Guardian's calm-time eat swaps the hand: none begins between the select and the use (one would make the use
        // refuse, "the hand holds bread", and the brain count the rail as a stop). Cleared on every way out of the task
        Interact.handsBusy = true;
        Interact.select(item);
        me.lookAt(EntityAnchorArgument.Anchor.EYES, click.getLocation());
        if (yaw != null) me.setYRot(yaw);
        Ticker.add(new Ticker.Task() {
            int age;
            boolean used;
            @Override public boolean tick(Minecraft m) {
                boolean done;
                try {
                    done = step(m);
                } catch (RuntimeException ex) {
                    c.fail(item + ": " + ex);
                    done = true;
                }
                if (done) Interact.handsBusy = false;
                return done;
            }

            boolean step(Minecraft m) {
                age++;
                if (m.player == null) { c.fail("not in a world"); return true; }
                if (!used) {
                    if (age < 3) return false; // the slot and the rotation go out first (the server reads the facing from them)
                    String held = Interact.nameOf(m.player.getMainHandItem());
                    if (!item.equals(held)) { c.ok(obj("ok", false, "placed", false, "reason", "the hand holds " + held + " at the use, not the " + item)); return true; }
                    m.gameMode.useItemOn(m.player, InteractionHand.MAIN_HAND, click);
                    used = true;
                    age = 0;
                    return false;
                }
                return after.tick(m, age);
            }
        });
    }

    /** Why the bot cannot put anything down now, or null. */
    static String busy(LocalPlayer me) {
        if (me.isPassenger()) return "riding a " + Names.entity(me.getVehicle()) + ": out first (vehicle.dismount)";
        if (Combat.fighting) return "a fight is on";
        return null;
    }

    // ---------------------------------------------------------------- the calls

    public static void register(BridgeServer s) {
        // {x, y, z, item?: "rail" | "powered_rail", shape?, prev?: {x, y, z, shape}, next?: {x, y, z, item?}, inVillage?,
        // dryRun?, facing?: "east" | "south"} -> {ok, placed, block, shape, powered, predicted, once, turned: [{x, y, z,
        // from, to}], prev?: {x, y, z, block, shape}, newMovement} | {ok: false, placed: false, reason, ...}. A rail on the
        // top of the block under (x, y, z), looked at first on the jar's own rules (see the notes): `shape` is what this
        // rail ends as once a rail is down at `next` (the line's cell after it, laid next; none: now), `prev` the rail laid
        // before it, which must end as its `shape`. Refused when it would not come out so, when it would turn any other
        // rail, when a slope it makes has nothing to rise onto, in someone's build (a zone) unless `inVillage` (the brain's
        // judge found the village free), and where nothing a rail stands on is (a rigid top). dryRun: the look only
        s.register("rail.place", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            Level level = mc.level;
            String item = Names.strip(strParam(p, "item", "rail"));
            if (!item.equals("rail") && !item.equals("powered_rail")) return obj("ok", false, "placed", false, "reason", "not a rail the line uses: " + item + " (rail or powered_rail)");
            BlockPos at = blockPos(p);
            if (!level.isLoaded(at)) return obj("ok", false, "placed", false, "reason", "not loaded");
            String why = busy(me);
            if (why != null) return obj("ok", false, "placed", false, "reason", why);
            BlockState there = level.getBlockState(at);
            if (shapeOf(there) != null) {
                JsonObject r = blockJson(level, at);
                r.addProperty("ok", false);
                r.addProperty("placed", false);
                r.addProperty("reason", "a rail there already (" + shapeOf(there) + ")");
                return r;
            }
            if (!Interact.replaceable(there)) return obj("ok", false, "placed", false, "reason", "occupied by " + Names.block(there));
            BlockPos below = at.below();
            if (!Block.canSupportRigidBlock(level, below)) return obj("ok", false, "placed", false, "reason", "nothing a rail stands on under it (" + Names.block(level.getBlockState(below)) + ")");
            boolean inVillage = p.has("inVillage") && p.get("inVillage").getAsBoolean();
            if (!inVillage && (Foreign.inZone(at) || Foreign.inZone(below))) return obj("ok", false, "placed", false, "reason", "in someone's build (a zone): rails go down there only by a village judged free (inVillage)");
            Cell prev = cell(p, "prev", true), next = cell(p, "next", false);
            String want = strParam(p, "shape", null);
            // the way the bot faces at the use (it matters only to a rail with no rail to turn to, or rails on both axes):
            // `facing`, else the plan's shape's way, else toward the rail before or after; the other way when only that
            // one comes out as the plan has it
            String facing = strParam(p, "facing", null);
            boolean ew = facing != null ? facing.equals("east") || facing.equals("west")
                : want != null && (eastWest(want) || want.equals("north_south") || risesTo(want) != null) ? eastWest(want)
                : prev != null ? prev.x() != at.getX() : next != null && next.x() != at.getX();
            Track t = read(level, at);
            boolean signal = level.hasNeighborSignal(at);
            Cell me0 = new Cell(at.getX(), at.getY(), at.getZ(), want, item.equals("powered_rail"));
            Judged j = judge(t, me0, ew, signal, want, prev, next);
            if (j.why() != null && facing == null) {
                Judged other = judge(t, me0, !ew, signal, want, prev, next);
                if (other.why() == null) { j = other; ew = !ew; }
            }
            JsonObject look = obj("predicted", j.now(), "once", j.once(), "turned", turnedJson(j.turned()), "newMovement", newMovement(level));
            if (j.why() != null) {
                look.addProperty("ok", false);
                look.addProperty("placed", false);
                look.addProperty("reason", j.why());
                return look;
            }
            // a slope it makes, here or the rail before, needs a block to stand on at the side it rises to (else it drops)
            for (var e : j.turned().entrySet()) {
                int[] up = risesTo(e.getValue()[1]);
                BlockPos q = BlockPos.of(e.getKey());
                if (up != null && !Block.canSupportRigidBlock(level, q.offset(up[0], 0, up[1]))) {
                    look.addProperty("ok", false);
                    look.addProperty("placed", false);
                    look.addProperty("reason", "the slope at " + q.toShortString() + " (" + e.getValue()[1] + ") would have nothing to rise onto: it would drop");
                    return look;
                }
                // and nothing turns that is not the bot's own (its yard, or what it built: Protection)
                if (e.getKey() != at.asLong() && !Protection.isOwn(q)) {
                    look.addProperty("ok", false);
                    look.addProperty("placed", false);
                    look.addProperty("reason", "it would turn the rail at " + q.toShortString() + ", which the bot did not lay");
                    return look;
                }
            }
            if (p.has("dryRun") && p.get("dryRun").getAsBoolean()) {
                look.addProperty("ok", true);
                look.addProperty("placed", false);
                look.addProperty("dryRun", true);
                return look;
            }
            if (Vehicle.count(me.getInventory(), item) == 0) return obj("ok", false, "placed", false, "reason", "no " + item + " carried");
            Object click = topOf(me, below);
            if (click instanceof String far) return obj("ok", false, "placed", false, "reason", far);
            float yaw = (ew ? Direction.EAST : Direction.SOUTH).toYRot();
            final Judged looked = j;
            useThen(item, (BlockHitResult) click, yaw, c, (m, age) -> {
                BlockState now = m.level.getBlockState(at);
                // the server's answer: the rail, then the shapes it turned (a tick or two after). The client's own
                // prediction of the use puts the rail down first as the item has it and turns nothing (updateDir does
                // nothing client side), so wait for the server's shapes, up to 1.5 s, before saying it came out otherwise
                if (age < 4) return false;
                BlockState before0 = prev == null ? null : m.level.getBlockState(new BlockPos(prev.x(), prev.y(), prev.z()));
                boolean settled = looked.now().equals(shapeOf(now)) && (prev == null || prev.shape() == null || prev.shape().equals(shapeOf(before0)));
                if (!settled && age < 30) return false;
                JsonObject r = blockJson(m.level, at);
                boolean placed = shapeOf(now) != null;
                r.addProperty("placed", placed);
                r.addProperty("predicted", looked.now());
                r.addProperty("once", looked.once());
                Track seen = read(m.level, at);
                Map<Long, String[]> turned = new LinkedHashMap<>();
                for (var e : seen.at.entrySet()) {
                    Rail was = t.at.get(e.getKey());
                    if (was == null || !was.shape.equals(e.getValue().shape)) turned.put(e.getKey(), new String[] { was == null ? null : was.shape, e.getValue().shape });
                }
                r.add("turned", turnedJson(turned));
                if (prev != null) r.add("prev", blockJson(m.level, new BlockPos(prev.x(), prev.y(), prev.z())));
                String reason = null;
                if (!placed) reason = "the server did not put it down (" + Names.block(now) + " there)";
                else if (!looked.now().equals(shapeOf(now))) reason = "it came out " + shapeOf(now) + ", not " + looked.now() + " as looked";
                else if (prev != null && prev.shape() != null && !prev.shape().equals(shapeOf(m.level.getBlockState(new BlockPos(prev.x(), prev.y(), prev.z()))))) {
                    reason = "the rail before came out " + shapeOf(m.level.getBlockState(new BlockPos(prev.x(), prev.y(), prev.z()))) + ", not " + prev.shape();
                }
                r.addProperty("ok", reason == null);
                if (reason != null) r.addProperty("reason", reason);
                r.addProperty("newMovement", newMovement(m.level));
                c.ok(r);
                return true;
            });
            return BridgeServer.LATER;
        });

        // {x, y, z, lights?: {x, y, z}, inVillage?} -> {ok, placed, block, lit, lights?: {x, y, z, block, shape, powered}} |
        // {ok: false, reason}. A redstone torch standing on the top of the block under (x, y, z) (never one on a wall: it
        // would light what the plan does not), and the powered rail it is for read after: lit (`ok` false when not). The
        // launch's trigger is one of these: put down last, the cart goes
        s.register("rail.torch", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            Level level = mc.level;
            BlockPos at = blockPos(p);
            if (!level.isLoaded(at)) return obj("ok", false, "placed", false, "reason", "not loaded");
            String why = busy(me);
            if (why != null) return obj("ok", false, "placed", false, "reason", why);
            BlockState there = level.getBlockState(at);
            if (!Interact.replaceable(there)) return obj("ok", false, "placed", false, "reason", "occupied by " + Names.block(there));
            BlockPos below = at.below();
            if (!Block.canSupportCenter(level, below, Direction.UP)) return obj("ok", false, "placed", false, "reason", "nothing a torch stands on under it (" + Names.block(level.getBlockState(below)) + ")");
            boolean inVillage = p.has("inVillage") && p.get("inVillage").getAsBoolean();
            if (!inVillage && (Foreign.inZone(at) || Foreign.inZone(below))) return obj("ok", false, "placed", false, "reason", "in someone's build (a zone)");
            JsonElement l = p.get("lights");
            BlockPos lights = l != null && l.isJsonObject() ? blockPos(l.getAsJsonObject()) : null;
            if (Vehicle.count(me.getInventory(), "redstone_torch") == 0) return obj("ok", false, "placed", false, "reason", "no redstone_torch carried");
            Object click = topOf(me, below);
            if (click instanceof String far) return obj("ok", false, "placed", false, "reason", far);
            useThen("redstone_torch", (BlockHitResult) click, null, c, (m, age) -> {
                BlockState now = m.level.getBlockState(at);
                boolean placed = now.getBlock() == net.minecraft.world.level.block.Blocks.REDSTONE_TORCH;
                if (age < 4) return false; // the rails it lights: a tick or two after
                if ((!placed || (lights != null && !powered(m.level.getBlockState(lights)))) && age < 30) return false;
                JsonObject r = blockJson(m.level, at);
                r.addProperty("placed", placed);
                String reason = placed ? null : "the server did not put it down (" + Names.block(now) + " there)";
                if (lights != null) {
                    JsonObject lj = blockJson(m.level, lights);
                    r.add("lights", lj);
                    if (reason == null && !powered(m.level.getBlockState(lights))) reason = "the rail at " + lights.toShortString() + " is not lit";
                }
                r.addProperty("ok", reason == null);
                if (reason != null) r.addProperty("reason", reason);
                c.ok(r);
                return true;
            });
            return BridgeServer.LATER;
        });

        // {x, y, z, inVillage?, newMovement?} -> {ok, id, uuid, position, passengers, own, newMovement} | {ok: false,
        // reason}. The minecart item used on the rail at (x, y, z): the cart comes down on it (still: on the old rules it
        // takes no one there) and is the bot's own from then (vehicle.mount, vehicle.take, vehicle.status take it).
        // Refused where a cart stands already, with no rail there, in someone's build unless `inVillage`, and on a server
        // with the minecart_improvements experiment unless `newMovement` (the line was planned on the old rules)
        s.register("cart.place", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            var level = mc.level;
            BlockPos at = blockPos(p);
            if (!level.isLoaded(at)) return obj("ok", false, "reason", "not loaded");
            String why = busy(me);
            if (why != null) return obj("ok", false, "reason", why);
            boolean fresh = newMovement(level);
            if (fresh && !(p.has("newMovement") && p.get("newMovement").getAsBoolean())) {
                return obj("ok", false, "newMovement", true, "reason", "the server runs the minecart_improvements experiment: its carts take a mob at any speed and run by other rules than the line was planned on (newMovement: true to go on)");
            }
            String shape = shapeOf(level.getBlockState(at));
            if (shape == null) return obj("ok", false, "reason", "no rail at " + at.toShortString() + " (" + Names.block(level.getBlockState(at)) + ")");
            boolean inVillage = p.has("inVillage") && p.get("inVillage").getAsBoolean();
            if (!inVillage && Foreign.inZone(at)) return obj("ok", false, "reason", "in someone's build (a zone)");
            double[] spot = cartAt(at.getX(), at.getY(), at.getZ(), risesTo(shape) != null);
            Vec3 down = new Vec3(spot[0], spot[1], spot[2]);
            for (Entity e : level.entitiesForRendering()) {
                if (e instanceof AbstractMinecart && e.position().distanceTo(down) < 1.0) return obj("ok", false, "reason", "a minecart on that rail already (" + e.getId() + ")");
            }
            if (Vehicle.count(me.getInventory(), "minecart") == 0) return obj("ok", false, "reason", "no minecart carried");
            Vec3 hitAt = new Vec3(at.getX() + 0.5, at.getY() + 0.1, at.getZ() + 0.5);
            double d = me.getEyePosition().distanceTo(hitAt);
            if (d > REACH) return obj("ok", false, "reason", "too far (" + round(d) + ")");
            Set<Integer> before = new HashSet<>();
            for (Entity e : level.entitiesForRendering()) if (e instanceof AbstractMinecart) before.add(e.getId());
            useThen("minecart", new BlockHitResult(hitAt, Direction.UP, at, false), null, c, new After() {
                Entity cart;
                int settle;
                @Override public boolean tick(Minecraft m, int age) {
                    if (cart == null) {
                        for (Entity e : m.level.entitiesForRendering()) {
                            if (e instanceof AbstractMinecart && !before.contains(e.getId()) && e.position().distanceTo(down) < 1.5) { cart = e; break; }
                        }
                        if (cart == null) {
                            if (age < 40) return false;
                            c.ok(obj("ok", false, "reason", "no minecart appeared"));
                            return true;
                        }
                        Vehicle.adopt(cart.getUUID());
                    }
                    if (++settle < 5) return false; // the passengers packet, under the experiment's rules
                    JsonObject r = Vehicle.json(cart, m.player);
                    r.addProperty("ok", true);
                    r.addProperty("newMovement", newMovement(m.level));
                    r.add("rail", blockJson(m.level, at));
                    c.ok(r);
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // {id?, uuid?} -> {carts: [{id, uuid, name, position, block, speed (blocks a tick), moving, passengers, own,
        // distance, rail?: {x, y, z, block, shape, powered}}], riding, newMovement, simulationDistance (chunks), takeSpeed}.
        // One cart (by id, or by the uuid cart.place gave: a restart forgot the set) or the bot's own within 128
        s.register("cart.status", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            int id = intParam(p, "id", -1);
            String uuid = strParam(p, "uuid", null);
            JsonArray carts = new JsonArray();
            for (Entity e : mc.level.entitiesForRendering()) {
                if (!(e instanceof AbstractMinecart cart)) continue;
                boolean asked = (id >= 0 && e.getId() == id) || (uuid != null && e.getUUID().toString().equals(uuid));
                if (asked) Vehicle.ownOr(e, uuid);
                if (!asked && (id >= 0 || uuid != null || !Vehicle.own(e) || e.distanceTo(me) > 128)) continue;
                carts.add(cartJson(mc.level, cart, me));
            }
            return obj("carts", carts, "riding", Vehicle.riding(me), "newMovement", newMovement(mc.level),
                "simulationDistance", mc.level.getServerSimulationDistance(), "takeSpeed", TAKE_SPEED);
        });

        // {id, uuid?, until?: "rest" | "took" | "either", timeoutMs?: 60000} -> {ok, reason, at, block, speed, maxSpeed,
        // travelled, seconds, passengers, took?: [ids], rail?}. reason: "took" (someone got in: `took`) | "at rest" (under
        // 0.005 a tick for half a second, after it moved or not) | "out of sight" (gone from the client: broken, or past
        // what the client is sent) | "timed out" | "cancelled" (the brain's cancel) | "died". Watches the cart: the
        // launch's torch lit, it says whether the villager got in, and where the cart came to rest
        s.register("cart.watch", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            int id = Integer.parseInt(required(p, "id"));
            Entity v = mc.level.getEntity(id);
            if (!(v instanceof AbstractMinecart)) return obj("ok", false, "reason", "no minecart with id " + id + " in sight");
            Vehicle.ownOr(v, strParam(p, "uuid", null));
            String until = strParam(p, "until", "either");
            if (!until.equals("rest") && !until.equals("took") && !until.equals("either")) throw new IllegalArgumentException("until must be rest, took or either");
            int timeout = Math.max(20, Math.min(10 * 60 * 20, intParam(p, "timeoutMs", 60_000) / 50));
            Set<Integer> riders = new HashSet<>();
            for (Entity q : v.getPassengers()) riders.add(q.getId());
            Ticker.add(new Ticker.Task() {
                int age, still;
                double max, travelled;
                Vec3 last = v.position();
                final long deaths = Events.deaths(), cancels = Processes.cancels;
                @Override public boolean tick(Minecraft m) {
                    try {
                        age++;
                        if (c.isDone()) return true;
                        if (m.player == null || m.level == null) { c.fail("not in a world"); return true; }
                        if (Processes.cancels != cancels) return end(m, "cancelled", null);
                        if (Events.deaths() != deaths) return end(m, "died", null);
                        if (v.isRemoved() || m.level.getEntity(id) != v) return end(m, "out of sight", null);
                        Vec3 now = v.position();
                        double step = Math.hypot(now.x - last.x, now.z - last.z);
                        last = now;
                        travelled += step;
                        max = Math.max(max, step);
                        JsonArray took = new JsonArray();
                        for (Entity q : v.getPassengers()) if (!riders.contains(q.getId())) took.add(q.getId());
                        if (!took.isEmpty() && !until.equals("rest")) return end(m, "took", took);
                        still = step < REST_SPEED ? still + 1 : 0;
                        if (still >= REST_TICKS && !until.equals("took")) return end(m, "at rest", took.isEmpty() ? null : took);
                        if (age > timeout) return end(m, "timed out", took.isEmpty() ? null : took);
                        return false;
                    } catch (RuntimeException ex) {
                        c.fail("cart.watch: " + ex);
                        return true;
                    }
                }

                boolean end(Minecraft m, String reason, JsonArray took) {
                    JsonObject r = obj("ok", !reason.equals("timed out") && !reason.equals("cancelled") && !reason.equals("died") && !reason.equals("out of sight"),
                        "reason", reason, "at", pos(last), "block", pos(BlockPos.containing(last)), "maxSpeed", round3(max), "travelled", round(travelled),
                        "seconds", round(age / 20.0), "passengers", Vehicle.passengers(v));
                    if (took != null) r.add("took", took);
                    if (!v.isRemoved() && m.level != null) {
                        r.addProperty("speed", round3(speedOf(v)));
                        BlockState rs = m.level.getBlockState(railUnder(v));
                        if (shapeOf(rs) != null) r.add("rail", blockJson(m.level, railUnder(v)));
                    }
                    c.ok(r);
                    return true;
                }
            });
            return BridgeServer.LATER;
        });
    }

    static double round3(double d) { return Math.round(d * 1000) / 1000.0; }

    /** The cart's speed now on the client (blocks a tick: where it is less where it was the tick before). */
    static double speedOf(Entity v) { return Math.hypot(v.getX() - v.xo, v.getZ() - v.zo); }

    /** The rail a cart is on: its own cell, or the one under (a cart on a slope sits half in the cell above). */
    static BlockPos railUnder(Entity v) {
        BlockPos b = v.blockPosition();
        Level level = v.level();
        if (shapeOf(level.getBlockState(b)) == null && shapeOf(level.getBlockState(b.below())) != null) return b.below();
        return b;
    }

    static JsonObject cartJson(Level level, AbstractMinecart cart, LocalPlayer me) {
        JsonObject o = Vehicle.json(cart, me);
        o.add("block", pos(cart.blockPosition()));
        double speed = speedOf(cart);
        o.addProperty("speed", round3(speed));
        o.addProperty("moving", speed >= REST_SPEED);
        BlockPos r = railUnder(cart);
        if (shapeOf(level.getBlockState(r)) != null) o.add("rail", blockJson(level, r));
        return o;
    }
}
