package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.tags.EntityTypeTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.vehicle.DismountHelper;
import net.minecraft.world.entity.vehicle.VehicleEntity;
import net.minecraft.world.entity.vehicle.boat.AbstractBoat;
import net.minecraft.world.entity.vehicle.minecart.AbstractMinecart;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BaseFireBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

import static claudebridge.Json.*;

/**
 * Boats for the villager move (P5c; minecarts for its rails fallback later): a boat put down against an unemployed
 * villager takes it into its back seat, the bot gets in front and steers it home, gets out in the hall, and breaks the
 * boat back into its item. vehicle.place / mount / drive / dismount / take, and vehicle.status. The bot rides, mounts and
 * breaks only its own boats: the ones vehicle.place put down (by uuid, which the brain keeps: a restart forgets the set
 * here, and mount and take accept the uuid back). vehicle.take's hit is the only attack this file makes.
 *
 * Checked against the 26.3 jar (javap, and the game's own boat and minecart code run on a scratch level):
 * - Who gets in. Each server tick a boat takes into an empty seat any mob within 0.2 of its box (AbstractBoat.tick): a
 *   LivingEntity narrower than the boat (1.375; a villager 0.6, a baby 0.3: babies too), not riding anything, not of
 *   the cannot_be_pushed_onto_boats tag (players, fish, squid, dolphins, tadpoles, the elder guardian, creakings,
 *   nautili, the sulfur cube); never an iron golem (1.4 wide). But only while no player sits in front: a boat with a
 *   player at the helm pushes mobs away instead. So the villager goes in first, and a boat put down against it takes it
 *   at once: no luring (villagers follow no one, emeralds or not), no pushing. And it takes whoever else stands that
 *   close too (a baby beside it): vehicle.place {for} refuses a spot where the boat would take anyone but that one.
 * - The bot steers. A player who boards a boat whose first passenger is no player is put in front (Entity.addPassenger,
 *   server side), only a player in front steers (AbstractBoat.getControllingPassenger), and the client gets the
 *   server's seat order in the passengers packet. The keys drive it: LocalPlayer.rideTick hands left/right/forward/back
 *   to AbstractBoat.setInput; the boat turns by its own heading (the bot's look is held within 105 of it), not the look.
 * - On land a ridden boat moves, slowly. Each tick its speed is multiplied by the ground's friction (0.6 on most blocks,
 *   0.98 on ice) where water's is 0.9, and the paddle adds 0.04: 2 blocks a second on grass, 8 on water. It climbs
 *   nothing: a boat steps up 0 (Entity.maxUpStep, not overridden), not a slab, not a carpet, not the 1/16 from a path
 *   block up onto grass, and not out of water onto a bank at the water's own level (the bank's top stands above the
 *   floating boat's bottom). Downhill it falls, and the fall lands on its passengers as their own fall damage
 *   (propagateFallToPassengers), unless over water.
 * - The ways in and out are two blocks wide: the boat's box is 1.375 across (0.5625 high), so no 1-wide gap lets it by.
 *   Two high is enough: the seated bot's eye stands 1.21 over the boat's bottom, the villager's behind it 1.81 (an eye
 *   inside a block suffocates).
 * - Villagers cannot be leashed (AbstractVillager.canBeLeashed answers false): hence the boat.
 * - Boats can be (26.x): a lead in hand on the click ties the boat to the bot, shears cut its leads, and a sneaking click
 *   ties every mob on the bot's leads to it (Entity.interact); a sneaking click never boards either
 *   (AbstractBoat.interact). So the click goes with a harmless hand (Merchant.harmless) and the shift key up.
 * - Out: shift (Player.rideTick, server side). The game puts the bot 1.27 out from the boat's centre the way the bot
 *   faces (Entity.getCollisionHorizontalEscapeVector over the boat's width times root 2), on the floor there or a block
 *   below where a standing player fits, never over water; else on top of the boat. For 60 ticks after, no one gets in
 *   again (Entity.canRide: boardingCooldown).
 * - Breaking it: a hit adds ten times its damage to the boat's (an axe's 7 and up: one hit), which wears off 1 a tick;
 *   over 40 it breaks into its item (VehicleEntity.hurtServer, destroy; with the entity_drops gamerule) and whoever sat in
 *   it gets out where it was. A sword's sweep (a sword's only: Player.isSweepAttack, ItemTags.SWORDS) hurts every living
 *   thing within a block of the boat, the villager beside it among them: never a sword, nor a mace, a trident or a spear
 *   (the server drops a spear's attack packet: PIERCING_WEAPON).
 * - Minecarts (the rails fallback: planned, not built). A moving empty minecart takes the first non-player, non-golem
 *   mob it runs into (OldMinecartBehavior.pushAndPickupEntities: horizontal speed over 0.1 a tick), one passenger only;
 *   a powered rail adds 0.06 a tick along the way a cart moves at all, with any passenger or none, and pushes a still one
 *   off a solid block beside it (0.02); an unpowered one brakes. NewMinecartBehavior is the minecart_improvements
 *   experiment's, off on a vanilla server whose world was not made with it.
 */
public final class Vehicle {
    private Vehicle() { }

    /** How near (eye to box) a boat must be to get into or to break: the bot's own reach is 3, the server allows 3 more. */
    static final double REACH = 4.0;
    /** A boat's box (AbstractBoat's entity type: 1.375 x 0.5625). */
    static final double BOAT_WIDTH = 1.375, BOAT_HEIGHT = 0.5625;
    /** How far from the boat's box a mob is taken in (AbstractBoat.tick: the box grown 0.2 sideways, 0.01 less high). */
    static final double TAKE_GROW = 0.2;
    /** Water's friction on a boat (floatBoat: IN_WATER 0.9). */
    static final double WATER_FRICTION = 0.9;
    /** The steering's dead band: no key for a heading this near (degrees). */
    static final double DEAD = 2.0;
    /** Paddle only while heading within this of the way to go (degrees): beyond it, turn first. */
    static final double PADDLE_WITHIN = 45.0;
    /** The point steered at lies this far on along the line (blocks): back to the line the route was checked along. */
    static final double LOOK = 3.0;
    /** The yaws tried to get out at stay within this of the boat's heading (the seat holds the look within 105). */
    static final float OUT_SPREAD = 100f;
    /** No one gets in again this soon after getting out (Entity.boardingCooldown). */
    static final int BOARDING_COOLDOWN = 60;

    /** The boats vehicle.place put down (their entity uuids): the only ones the bot gets into or breaks. */
    private static final Set<UUID> OWN = ConcurrentHashMap.newKeySet();
    private static long lastOutTick = -1000;
    private static boolean leaving;

    // ---------------------------------------------------------------- pure rules

    /** A boat that seats two, by its item: a boat of any wood or the bamboo raft, never a chest one (it seats one). Pure. */
    static boolean twoSeats(String item) {
        if (item == null) return false;
        return (item.endsWith("_boat") || item.endsWith("_raft")) && !item.contains("chest");
    }

    /**
     * The hand for the hit that breaks the boat (vehicle.take), from the 36 pockets' item names (null: empty): an axe
     * (one hit), else a pickaxe, else a shovel, else an empty hotbar slot, else any carried thing that is no weapon (a
     * fist's hit). Never a sword (its sweep hurts the villager beside the boat), a mace, a trident or a spear, nor a full
     * bucket or a fire starter. -1: nothing will do. Pure.
     */
    static int takeHand(String[] names) {
        for (String kind : new String[] { "_axe", "_pickaxe", "_shovel" }) {
            int best = -1, bestTier = -1;
            for (int k = 0; k < names.length && k < 36; k++) {
                String n = names[k];
                if (n == null || !n.endsWith(kind)) continue; // ("_pickaxe" does not end with "_axe")
                int tier = tier(n);
                if (tier > bestTier) { best = k; bestTier = tier; }
            }
            if (best >= 0) return best;
        }
        for (int k : new int[] { 1, 2, 3, 4, 5, 6, 7, 0, 8 }) if (k < names.length && names[k] == null) return k;
        for (int k = 0; k < names.length && k < 36; k++) if (names[k] != null && !weapon(names[k]) && !Hazards.isHazard(names[k])) return k;
        return -1;
    }

    private static int tier(String tool) {
        String t = tool.substring(0, tool.lastIndexOf('_'));
        return switch (t) {
            case "netherite" -> 5;
            case "diamond" -> 4;
            case "iron" -> 3;
            case "copper" -> 2;
            case "stone" -> 1;
            default -> 0;
        };
    }

    /** What must not be in hand at the hit: a sword (it sweeps), a mace, a trident, a spear. Pure. */
    static boolean weapon(String item) {
        return item != null && (item.endsWith("_sword") || item.endsWith("_spear") || item.equals("mace") || item.equals("trident"));
    }

    /**
     * Where the game puts a passenger who gets out of a vehicle `vehicleWidth` wide (already times root 2 for a boat),
     * facing `yRot`: the offset from the vehicle's centre (Entity.getCollisionHorizontalEscapeVector, which is protected).
     * Pure.
     */
    static double[] escape(double vehicleWidth, double passengerWidth, float yRot) {
        double d = (vehicleWidth + passengerWidth + 1.0E-5F) / 2.0;
        float f = -Mth.sin(yRot * Mth.DEG_TO_RAD);
        float g = Mth.cos(yRot * Mth.DEG_TO_RAD);
        float h = Math.max(Math.abs(f), Math.abs(g));
        return new double[] { f * d / h, g * d / h };
    }

    /**
     * The yaws to try getting out of a boat at: the wanted one first (held within OUT_SPREAD of the boat's heading),
     * then every 15 degrees either side of it, nearest first, as far as the seat lets the look turn. Pure.
     */
    static float[] outYaws(float boatYaw, float want) {
        float rel = Mth.clamp(Mth.wrapDegrees(want - boatYaw), -OUT_SPREAD, OUT_SPREAD);
        List<Float> out = new ArrayList<>();
        out.add(boatYaw + rel);
        for (int k = 15; k <= 2 * (int) OUT_SPREAD; k += 15) {
            for (int s : new int[] { 1, -1 }) {
                float r = rel + s * k;
                if (r >= -OUT_SPREAD && r <= OUT_SPREAD) out.add(boatYaw + r);
            }
        }
        float[] a = new float[out.size()];
        for (int i = 0; i < a.length; i++) a[i] = Mth.wrapDegrees(out.get(i));
        return a;
    }

    /** The yaw that faces from (x, z) toward (tx, tz) (the game's: 0 is south, 90 west). Pure. */
    static float yawTo(double x, double z, double tx, double tz) {
        return (float) Math.toDegrees(Math.atan2(-(tx - x), tz - z));
    }

    /**
     * The point to steer at: on the line from (fx, fz) to (tx, tz), `look` blocks on from the point of it nearest the boat
     * at (px, pz), never past its end: a boat pushed off the line comes back to it, since the route was checked along it.
     * Pure.
     */
    static double[] aim(double fx, double fz, double tx, double tz, double px, double pz, double look) {
        double lx = tx - fx, lz = tz - fz, len = Math.hypot(lx, lz);
        if (len < 1e-6) return new double[] { tx, tz };
        double ux = lx / len, uz = lz / len;
        double along = Math.max(0, (px - fx) * ux + (pz - fz) * uz);
        double t = Math.min(len, along + look);
        return new double[] { fx + ux * t, fz + uz * t };
    }

    /** How far (px, pz) is off the line from (fx, fz) to (tx, tz), sideways. Pure. */
    static double offLine(double fx, double fz, double tx, double tz, double px, double pz) {
        double lx = tx - fx, lz = tz - fz, len = Math.hypot(lx, lz);
        if (len < 1e-6) return Math.hypot(px - fx, pz - fz);
        return Math.abs((px - fx) * lz - (pz - fz) * lx) / len;
    }

    /** How far a boat glides (or turns on) with no key held: the sum of `v` times friction^n, friction / (1 - friction). Pure. */
    static double coast(double v, double friction) {
        double f = Math.max(0, Math.min(0.99, friction));
        return v * f / (1 - f);
    }

    /** One tick's keys while driving. */
    record Keys(boolean left, boolean right, boolean forward) { }

    /**
     * The keys for one tick of the drive. `err`: the way to the aim point less the boat's heading (degrees, -180..180);
     * `rate`: how far the heading turned in the last tick; `friction`: the boat's now (water 0.9, the ground's on land),
     * which also slows its turn, so it turns on by rate * coast after the keys let go; `dist`: blocks to the end;
     * `speed`: blocks a tick now; `within`: the end is reached this near. Turn while the heading would still end up more
     * than DEAD off; paddle while it is within PADDLE_WITHIN and the glide would not carry the boat to the end anyway.
     * Pure.
     */
    static Keys keys(double err, double rate, double friction, double dist, double speed, double within) {
        double settles = err - coast(rate, friction);
        boolean right = settles > DEAD, left = settles < -DEAD;
        boolean forward = Math.abs(err) < PADDLE_WITHIN && dist - coast(speed, friction) > within * 0.5;
        return new Keys(left, right, forward);
    }

    /** The look ahead starts this far on from the boat's centre (its nose is 0.69 on: half its 1.375). */
    static final double NOSE = 1.2;

    /**
     * The cells the drive looks at: along (hx, hz) (a unit heading) from NOSE to `reach` blocks on from (x, z), at height
     * y, every half block, each once, nearest first. Pure.
     */
    static List<BlockPos> aheadCells(double x, double y, double z, double hx, double hz, double reach) {
        List<BlockPos> out = new ArrayList<>();
        for (double d = NOSE; d <= Math.max(NOSE, reach) + 1e-9; d += 0.5) {
            BlockPos b = BlockPos.containing(x + hx * d, y, z + hz * d);
            if (!out.contains(b)) out.add(b);
        }
        return out;
    }

    /** One tick of the drive: the keys to hold, or why it stops (`stop`, at `cell`); `ahead`: the first cell looked at. */
    record Decision(Keys keys, String stop, BlockPos cell, BlockPos ahead) { }

    /**
     * One tick of vehicle.drive, for a boat at (x, y, z) (y its bottom) heading `yaw`, which turned `rate` in the last
     * tick and moves (vx, vz) a tick with `friction` (water's, or the ground's on land), on the line from (fx, fz) to
     * (tx, tz). It steers at the aim point on the line; it looks at the columns ahead the way the boat moves, from just
     * past its nose to as far as it would glide on with no paddle (not past the end): on water it glides 9 times its
     * speed and nothing brakes a boat (the back key takes off 0.005 a tick), so whatever lies in that reach must stop the
     * drive now. At the boat's bottom: a step it would have to climb shows at its own level. Still, it looks the way it
     * faces once it is turned near enough to paddle (it turns on the spot first). Pure but for `cell`.
     */
    static Decision decide(Function<BlockPos, Ground> cell, double fx, double fz, double tx, double tz, double x, double y, double z,
                           float yaw, double rate, double vx, double vz, double friction, double within, int maxDrop) {
        double dist = Math.hypot(tx - x, tz - z), speed = Math.hypot(vx, vz);
        double[] goal = aim(fx, fz, tx, tz, x, z, LOOK);
        double err = Mth.wrapDegrees(yawTo(x, z, goal[0], goal[1]) - yaw);
        BlockPos first = null;
        boolean moving = speed > 0.02;
        if (moving || Math.abs(err) < PADDLE_WITHIN) {
            double hx = moving ? vx / speed : -Mth.sin(yaw * Mth.DEG_TO_RAD), hz = moving ? vz / speed : Mth.cos(yaw * Mth.DEG_TO_RAD);
            double reach = Math.min(NOSE + coast(speed, friction), NOSE + dist);
            for (BlockPos c : aheadCells(x, y + 0.01, z, hx, hz, reach)) {
                String why = ahead(cell, c, maxDrop);
                if (why != null) return new Decision(null, why, c, first);
                if (first == null) first = c;
            }
        }
        return new Decision(keys(err, rate, friction, dist, speed, within), null, null, first);
    }

    /**
     * A cell as the drive's look ahead judges it. FLOOR: a block whose top is no higher than the boat's bottom (the next
     * path block for a boat on a path, farmland, a carpet it sits on): under it, not in its way.
     */
    enum Ground { OPEN, FLOOR, SOLID, WATER, LAVA, UNLOADED }

    /** Why the drive waits rather than stops: a cell it looks at is not loaded yet. */
    static final String NOT_LOADED = "the way ahead is not loaded";

    /**
     * What lies in the column `ahead` (its cell at the boat's level) for a boat: null when it may go on; else why not. A
     * block there standing over the boat's bottom ("a step up": the boat climbs nothing; one whose top is under it, a
     * FLOOR, is the ground it goes on), lava or fire there or under it, or a drop deeper than `maxDrop` to the first floor
     * below (water anywhere down breaks the fall, so it counts as a floor of 0). Pure.
     */
    static String ahead(Function<BlockPos, Ground> cell, BlockPos ahead, int maxDrop) {
        Ground at = cell.apply(ahead);
        if (at == Ground.UNLOADED) return NOT_LOADED;
        if (at == Ground.LAVA) return "lava or fire ahead";
        if (at == Ground.SOLID) return "a step up ahead (a boat climbs nothing)";
        if (at == Ground.WATER || at == Ground.FLOOR) return null;
        for (int k = 0; k <= maxDrop; k++) {
            Ground below = cell.apply(ahead.below(k + 1));
            if (below == Ground.UNLOADED) return NOT_LOADED;
            if (below == Ground.LAVA) return "lava or fire ahead";
            if (below == Ground.SOLID || below == Ground.FLOOR || below == Ground.WATER) return null;
        }
        return "a drop of more than " + maxDrop + " ahead";
    }

    /**
     * Live: a cell for the look ahead of a boat whose bottom is at `bottom`. Anything with a collision box is solid before
     * its water (a waterlogged slab or fence stops a boat as a dry one does), but a floor when its top is no higher than
     * the boat's bottom: a boat put down on a path block (15/16 high) looks at its own row, where the next path block
     * stood as "a step up" and every drive off a path or farmland stopped before it moved. The 1/16 from a path up onto
     * grass is still a step.
     */
    static Ground ground(Level level, BlockPos p, double bottom) {
        if (!level.isLoaded(p)) return Ground.UNLOADED;
        BlockState s = level.getBlockState(p);
        if (s.getFluidState().is(FluidTags.LAVA) || s.getBlock() instanceof BaseFireBlock) return Ground.LAVA;
        var shape = s.getCollisionShape(level, p);
        if (!shape.isEmpty()) return p.getY() + shape.max(Direction.Axis.Y) <= bottom + FLOOR_EPS ? Ground.FLOOR : Ground.SOLID;
        return s.getFluidState().is(FluidTags.WATER) ? Ground.WATER : Ground.OPEN;
    }

    /** How near the boat's bottom a block's top counts as under it (the boat rests on it to a hair). */
    static final double FLOOR_EPS = 1e-3;

    // ---------------------------------------------------------------- live helpers

    static boolean own(Entity e) {
        return e instanceof VehicleEntity && OWN.contains(e.getUUID());
    }

    /** Own, or the uuid the brain remembered from vehicle.place (a restart forgot the set): then own again. */
    static boolean ownOr(Entity e, String uuid) {
        if (own(e)) return true;
        if (uuid != null && e instanceof VehicleEntity && e.getUUID().toString().equals(uuid)) { OWN.add(e.getUUID()); return true; }
        return false;
    }

    static JsonArray passengers(Entity v) {
        JsonArray out = new JsonArray();
        for (Entity q : v.getPassengers()) {
            JsonObject o = obj("id", q.getId(), "name", Names.entity(q));
            if (q instanceof LivingEntity le) o.addProperty("baby", le.isBaby());
            Merchant.describe(o, q);
            out.add(o);
        }
        return out;
    }

    static JsonObject json(Entity v, LocalPlayer me) {
        JsonObject o = obj("id", v.getId(), "uuid", v.getUUID().toString(), "name", Names.entity(v), "position", pos(v.position()),
            "yaw", round(v.getYRot()), "own", own(v), "passengers", passengers(v));
        if (me != null) o.addProperty("distance", round(Math.sqrt(v.getBoundingBox().distanceToSqr(me.getEyePosition()))));
        return o;
    }

    /** world.entities: a vehicle's own flag and who rides it (the passengers' ids, front seat first). */
    static void describe(JsonObject o, Entity e) {
        if (!(e instanceof VehicleEntity v)) return;
        if (own(v)) {
            o.addProperty("own", true);
            o.addProperty("uuid", v.getUUID().toString());
        }
        if (!v.getPassengers().isEmpty()) {
            JsonArray ids = new JsonArray();
            for (Entity q : v.getPassengers()) ids.add(q.getId());
            o.add("passengers", ids);
        }
    }

    /** status: what the bot rides, its seat (0 in front) and whether it steers; null when on foot. */
    static JsonObject riding(LocalPlayer me) {
        Entity v = me.getVehicle();
        if (v == null) return null;
        JsonObject o = json(v, null);
        o.addProperty("seat", v.getPassengers().indexOf(me));
        o.addProperty("controlling", v.getControllingPassenger() == me);
        return o;
    }

    /** The mobs a boat put down at `bottom` (its box's bottom centre) would take in at once (AbstractBoat.tick's rule). */
    static List<Entity> wouldTake(Level level, Vec3 bottom) {
        AABB box = boatBox(bottom).inflate(TAKE_GROW, -0.01, TAKE_GROW);
        List<Entity> out = new ArrayList<>();
        for (Entity e : level.getEntities((Entity) null, box, x -> true)) {
            if (!(e instanceof LivingEntity) || e instanceof Player || e.isPassenger() || !e.isAlive()) continue;
            if (e.getBbWidth() >= BOAT_WIDTH || e.is(EntityTypeTags.CANNOT_BE_PUSHED_ONTO_BOATS)) continue;
            out.add(e);
        }
        return out;
    }

    static AABB boatBox(Vec3 bottom) {
        double h = BOAT_WIDTH / 2;
        return new AABB(bottom.x - h, bottom.y, bottom.z - h, bottom.x + h, bottom.y + BOAT_HEIGHT, bottom.z + h);
    }

    static void releaseKeys(Minecraft m) {
        m.options.keyUp.setDown(false);
        m.options.keyDown.setDown(false);
        m.options.keyLeft.setDown(false);
        m.options.keyRight.setDown(false);
        m.options.keyJump.setDown(false);
        m.options.keySprint.setDown(false);
    }

    static void cancelBaritone() {
        if (Processes.active() != null) Processes.baritone().getPathingBehavior().cancelEverything();
    }

    /**
     * Where the game would put the bot if it got out now facing `yaw`, or null when that spot will not do (water under
     * it, or no room for a standing player): AbstractBoat.getDismountLocationForPassenger, without its pose change.
     */
    static Vec3 outSpot(Level level, AbstractBoat boat, Player me, float yaw) {
        double[] v = escape(boat.getBbWidth() * Mth.SQRT_OF_TWO, me.getBbWidth(), yaw);
        double x = boat.getX() + v[0], z = boat.getZ() + v[1];
        BlockPos top = BlockPos.containing(x, boat.getBoundingBox().maxY, z), under = top.below();
        if (level.getFluidState(under).is(FluidTags.WATER)) return null;
        for (BlockPos b : new BlockPos[] { top, under }) {
            double floor = level.getBlockFloorHeight(b);
            if (!DismountHelper.isBlockFloorValid(floor)) continue;
            Vec3 at = new Vec3(x, b.getY() + floor, z);
            if (DismountHelper.canDismountTo(level, at, me, Pose.STANDING)) return at;
        }
        return null;
    }

    /** Out of whatever the bot rides, now (the Guardian's emergency: no cover can go up round a boat). Shift until off. */
    static void leave(Minecraft mc, String why) {
        if (leaving || mc.player == null || !mc.player.isPassenger()) return;
        leaving = true;
        Guardian.note(why + ": out of the " + Names.entity(mc.player.getVehicle()));
        releaseKeys(mc);
        mc.options.keyShift.setDown(true);
        Ticker.add(new Ticker.Task() {
            int age;
            @Override public boolean tick(Minecraft m) {
                if (m.player != null && m.player.isPassenger() && ++age < 20) return false;
                m.options.keyShift.setDown(false);
                lastOutTick = Ticker.ticks();
                leaving = false;
                return true;
            }
        });
    }

    /**
     * How far from a mob's centre the boat's centre goes, along one axis, to take it (pure): the boat's box just clear of
     * the mob's (the two half widths: 0.9875 for a villager) and halfway into the 0.2 a boat takes a mob from (TAKE_GROW).
     * Boxes are square to the axes, so along one axis only: on a diagonal, 1.1 off still meets the villager's box.
     */
    static double besideBy(double mobWidth) { return BOAT_WIDTH / 2 + mobWidth / 2 + TAKE_GROW / 2; }

    /**
     * The four points a boat could go down at beside a mob standing at (mx, mz) (pure): besideBy along +x, -x, +z and -z,
     * the one nearest the bot at (px, pz) first (each is judged on the ground and against the bot's own box after).
     */
    static List<double[]> besideSpots(double mx, double mz, double mobWidth, double px, double pz) {
        double d = besideBy(mobWidth);
        List<double[]> out = new ArrayList<>(List.of(new double[] { mx + d, mz }, new double[] { mx - d, mz }, new double[] { mx, mz + d }, new double[] { mx, mz - d }));
        out.sort((a, b) -> Double.compare(Math.hypot(a[0] - px, a[1] - pz), Math.hypot(b[0] - px, b[1] - pz)));
        return out;
    }

    /** A spot for the boat item's use: the point aimed at, where the boat comes down (its box's bottom centre), what it takes. */
    record Spot(Vec3 aimAt, Vec3 bottom, JsonArray took) { }

    /**
     * Where a boat put down beside `mob` comes down and takes it, as the game's boat item and boat would (a Spot), or why
     * none of the four sides will do: the first side, nearest the bot, with a floor at the mob's feet (within half a
     * block: a path beside grass, a slab), in reach, the item's ray meeting that floor, room for the boat's box (no block,
     * no mob, not the bot itself: BoatItem.use refuses a box any of them is in), and the mob within the take's reach and
     * no other one.
     */
    static Object beside(Level level, Player me, Entity mob, boolean inVillage) {
        List<String> why = new ArrayList<>();
        for (double[] q : besideSpots(mob.getX(), mob.getZ(), mob.getBbWidth(), me.getX(), me.getZ())) {
            String side = q[0] > mob.getX() ? "east" : q[0] < mob.getX() ? "west" : q[1] > mob.getZ() ? "south" : "north";
            Object r = besideAt(level, me, mob, q[0], q[1], inVillage);
            if (r instanceof Spot spot) return spot;
            why.add(side + ": " + r);
        }
        return "no spot beside the " + Names.entity(mob) + " for a boat (" + String.join("; ", why) + ")";
    }

    /** One side of `beside`: the boat's centre at (x, z), at the mob's feet. A Spot, or why not. */
    static Object besideAt(Level level, Player me, Entity mob, double x, double z, boolean inVillage) {
        double feet = mob.getY();
        BlockPos floor = null;
        double top = 0;
        for (BlockPos b : new BlockPos[] { BlockPos.containing(x, feet + 0.49, z), BlockPos.containing(x, feet - 0.01, z) }) {
            if (floor != null) break;
            if (!level.isLoaded(b)) return "not loaded";
            BlockState st = level.getBlockState(b);
            double t;
            if (level.getFluidState(b).is(FluidTags.WATER) && st.getCollisionShape(level, b).isEmpty()) {
                if (!level.getFluidState(b).isSource()) return "flowing water";
                t = b.getY() + level.getFluidState(b).getHeight(level, b);
            } else if (!st.getCollisionShape(level, b).isEmpty()) {
                t = b.getY() + st.getShape(level, b).max(Direction.Axis.Y);
            } else continue;
            if (t > feet + 0.5) return "a block there (" + Names.block(st) + ")";
            if (t < feet - 0.5) return "nothing to put a boat on (a drop)";
            floor = b;
            top = t;
        }
        if (floor == null) return "nothing to put a boat on (a drop)";
        if (!inVillage && (Foreign.inZone(floor) || Foreign.inZone(floor.above()))) return "in someone's build (a zone)";
        return spotAt(level, me, floor, new Vec3(x, top, z), mob);
    }

    /**
     * The boat item's use aimed at `aimAt` on the top face of `floor` (or the water there): in reach, the item's ray (with
     * fluids: water stops it) meeting that block, or a plant on it with nothing to hit; room for the boat's box where the
     * ray meets it; with `mob`, the take reaching it and no one else. A Spot, or why not.
     */
    static Object spotAt(Level level, Player me, BlockPos floor, Vec3 aimAt, Entity mob) {
        Vec3 eye = me.getEyePosition();
        double dist = eye.distanceTo(aimAt);
        if (dist > me.blockInteractionRange()) return "too far (" + round(dist) + ")";
        Vec3 end = eye.add(aimAt.subtract(eye).normalize().scale(me.blockInteractionRange()));
        BlockHitResult ray = level.clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.ANY, me));
        BlockPos hitPos = ray.getType() == HitResult.Type.BLOCK ? ray.getBlockPos() : null;
        boolean plantOn = hitPos != null && hitPos.equals(floor.above()) && level.getBlockState(hitPos).getCollisionShape(level, hitPos).isEmpty();
        if (hitPos == null || (!hitPos.equals(floor) && !plantOn)) {
            return "the look meets " + (hitPos == null ? "nothing" : Names.block(level.getBlockState(hitPos)) + " at " + hitPos.toShortString()) + " first, not " + floor.toShortString();
        }
        Vec3 bottom = ray.getLocation();
        AABB box = boatBox(bottom);
        if (!level.noCollision(box)) return "no room for a boat (a block or a boat in the way)";
        // what the game's own check counts and the entity-less one above does not (AbstractBoat.canVehicleCollide: what can
        // be collided with or pushed): a mob, a player, the bot itself
        List<Entity> inRoom = level.getEntities((Entity) null, box, x -> !x.isSpectator() && (x.isPushable() || x.canBeCollidedWith(me)));
        if (!inRoom.isEmpty()) {
            Entity e = inRoom.get(0);
            return "the " + Names.entity(e) + (e == me ? " (the bot itself)" : " (" + e.getId() + ")") + " in the boat's room";
        }
        List<Entity> takes = wouldTake(level, bottom);
        JsonArray took = new JsonArray();
        for (Entity e : takes) {
            JsonObject o = obj("id", e.getId(), "name", Names.entity(e), "baby", ((LivingEntity) e).isBaby());
            Merchant.describe(o, e);
            took.add(o);
        }
        if (mob != null) {
            if (!takes.contains(mob)) return "too far from the " + Names.entity(mob) + " to take it in";
            for (Entity e : takes) if (e != mob) return "the boat would take the " + Names.entity(e) + " (" + e.getId() + ") too";
        }
        return new Spot(aimAt, bottom, took);
    }

    /** The boat on the top face of block `at` (or the water there), as vehicle.place without `for` puts it. A Spot, or why not. */
    static Object onBlock(Level level, Player me, BlockPos at, boolean inVillage) {
        if (!inVillage && (Foreign.inZone(at) || Foreign.inZone(at.above()))) {
            return "in someone's build (a zone): a boat goes down there only for a village judged free (inVillage)";
        }
        double top;
        if (level.getFluidState(at).is(FluidTags.WATER)) top = level.getFluidState(at).getHeight(level, at);
        else {
            BlockState st = level.getBlockState(at);
            var shape = st.getShape(level, at);
            if (shape.isEmpty() || st.getCollisionShape(level, at).isEmpty()) return "nothing to put a boat on at " + at.toShortString() + " (" + Names.block(st) + ")";
            top = shape.max(Direction.Axis.Y);
        }
        return spotAt(level, me, at, new Vec3(at.getX() + 0.5, at.getY() + top, at.getZ() + 0.5), null);
    }

    // ---------------------------------------------------------------- the calls

    public static void register(BridgeServer s) {
        // {} -> {riding: {...} | null, own: [{id, uuid, name, position, yaw, own, passengers: [{id, name, baby, profession...}],
        // distance}] (own boats within 64)}
        s.register("vehicle.status", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            JsonArray own = new JsonArray();
            for (Entity e : mc.level.entitiesForRendering()) if (own(e) && e.distanceTo(me) <= 64) own.add(json(e, me));
            return obj("riding", riding(me), "own", own);
        });

        // {item?: "oak_boat", x?, y?, z?, for?: entity id, inVillage?: true} -> {ok, id, uuid, position, yaw, passengers,
        // boarded: the first passenger's id or null, tookIt, took: what the spot would take before the use, aim} | {ok:
        // false, reason}. A use along the look, as the boat item does it (BoatItem.use: the boat goes down where the look's
        // ray meets a block or water, within 4.5, facing the bot's way). `for`: the mob it is for (a villager): the spot is
        // picked here, on the tick of the use, from where the mob is then: beside it, the boat's box just clear of the
        // mob's and within the 0.2 a boat takes a mob from (on it, the game refuses the boat: BoatItem.use's
        // Level.noCollision(boat, box) counts a villager in the box), refused when the boat would take anyone else too (a
        // baby beside it, a cat), and `tookIt` says whether it took that one. Without `for`: on the top face of block
        // (x, y, z), or on the water there. `inVillage`: the brain's courtesy judge found this village free to take from;
        // without it no boat goes down inside anyone's build (a zone)
        s.register("vehicle.place", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            String item = Names.strip(strParam(p, "item", "oak_boat"));
            if (!twoSeats(item)) return obj("ok", false, "reason", "not a boat that seats two: " + item + " (a chest boat seats one)");
            if (me.isPassenger()) return obj("ok", false, "reason", "riding a " + Names.entity(me.getVehicle()) + ": out first (vehicle.dismount)");
            if (Combat.fighting) return obj("ok", false, "reason", "a fight is on");
            // by its own name: with none carried, Interact.select falls back to a name holding it (a dark_oak_boat for "oak_boat")
            if (count(me.getInventory(), item) == 0) return obj("ok", false, "reason", "no " + item + " carried");
            var level = mc.level;
            boolean inVillage = flag(p, "inVillage");
            int forId = intParam(p, "for", -1);
            Entity mob = forId >= 0 ? level.getEntity(forId) : null;
            if (forId >= 0 && (mob == null || mob.isRemoved() || !(mob instanceof LivingEntity))) return obj("ok", false, "reason", "no creature with id " + forId + " nearby");
            if (mob != null && mob.isPassenger()) return obj("ok", false, "reason", "the " + Names.entity(mob) + " rides a " + Names.entity(mob.getVehicle()));
            BlockPos at = mob != null ? mob.blockPosition() : blockPos(p);
            if (!level.isLoaded(at)) return obj("ok", false, "reason", "not loaded");
            Object first = mob != null ? beside(level, me, mob, inVillage) : onBlock(level, me, at, inVillage);
            if (first instanceof String why) return obj("ok", false, "reason", why);
            JsonArray took = ((Spot) first).took();
            Set<Integer> before = new HashSet<>();
            for (Entity e : level.entitiesForRendering()) if (e instanceof AbstractBoat) before.add(e.getId());
            cancelBaritone();
            if (me.containerMenu != me.inventoryMenu) me.closeContainer();
            Interact.select(item);
            me.lookAt(EntityAnchorArgument.Anchor.EYES, ((Spot) first).aimAt());
            Ticker.add(new Ticker.Task() {
                int age, settle = -1;
                String result;
                Spot spot = (Spot) first;
                Entity boat;

                @Override public boolean tick(Minecraft m) {
                    try {
                        age++;
                        if (m.player == null) { c.fail("not in a world"); return true; }
                        if (result == null) {
                            if (age < 3) return false; // the slot goes out first (the use packet carries the look itself)
                            String held = Interact.nameOf(m.player.getMainHandItem());
                            if (!item.equals(held)) { c.ok(obj("ok", false, "reason", "the hand holds " + held + " at the use, not the " + item)); return true; }
                            // the spot again from where the mob is now: it wanders, and a tenth of a block either way
                            // puts the boat on it (refused) or out of the take's reach
                            if (mob != null) {
                                if (mob.isRemoved() || mob.isPassenger()) { c.ok(obj("ok", false, "reason", "the " + Names.entity(mob) + " is gone or rides something")); return true; }
                                Object now = beside(m.level, m.player, mob, inVillage);
                                if (now instanceof String why) { c.ok(obj("ok", false, "reason", why)); return true; }
                                spot = (Spot) now;
                            }
                            m.player.lookAt(EntityAnchorArgument.Anchor.EYES, spot.aimAt());
                            result = String.valueOf(m.gameMode.useItem(m.player, InteractionHand.MAIN_HAND));
                            return false;
                        }
                        if (boat == null) {
                            for (Entity e : m.level.entitiesForRendering()) {
                                if (e instanceof AbstractBoat && !before.contains(e.getId()) && e.position().distanceTo(spot.bottom()) < 2) { boat = e; break; }
                            }
                            if (boat == null) {
                                if (age < 40) return false;
                                c.ok(obj("ok", false, "reason", "no boat appeared (" + result + ")", "took", took));
                                return true;
                            }
                            OWN.add(boat.getUUID());
                            settle = 0;
                        }
                        // who it took: the server's passengers packet, a tick or so after the boat
                        if (++settle < 10 && boat.getPassengers().isEmpty()) return false;
                        JsonObject r = json(boat, m.player);
                        r.addProperty("ok", true);
                        Entity firstIn = boat.getFirstPassenger();
                        r.addProperty("boarded", firstIn == null ? null : firstIn.getId());
                        if (forId >= 0) r.addProperty("tookIt", firstIn != null && firstIn.getId() == forId);
                        r.add("took", took);
                        r.add("aim", pos(spot.aimAt()));
                        r.addProperty("result", result);
                        c.ok(r);
                        return true;
                    } catch (RuntimeException ex) {
                        c.fail("vehicle.place: " + ex);
                        return true;
                    }
                }
            });
            return BridgeServer.LATER;
        });

        // {id, uuid?} -> {ok, id, seat (0 in front), controlling, passengers} | {ok: false, reason}. Into the bot's own boat
        // (or a minecart) within 4: the use click on it with a harmless hand, the shift key up. It goes in front when the
        // one already in it is no player, and steers then
        s.register("vehicle.mount", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            int id = Integer.parseInt(required(p, "id"));
            Entity v = mc.level.getEntity(id);
            if (v == null || v.isRemoved()) return obj("ok", false, "reason", "no entity with id " + id + " nearby");
            boolean boat = v instanceof AbstractBoat, cart = v instanceof AbstractMinecart mc0 && mc0.isRideable();
            if (!boat && !cart) return obj("ok", false, "reason", "a " + Names.entity(v) + " is no boat nor minecart");
            if (me.getVehicle() == v) return obj("ok", true, "already", true, "id", id, "seat", v.getPassengers().indexOf(me), "controlling", v.getControllingPassenger() == me, "passengers", passengers(v));
            if (me.isPassenger()) return obj("ok", false, "reason", "riding a " + Names.entity(me.getVehicle()) + ": out first");
            if (!ownOr(v, strParam(p, "uuid", null))) return obj("ok", false, "reason", "not the bot's own " + Names.entity(v) + " (only what vehicle.place put down)");
            for (Entity q : v.getPassengers()) if (q instanceof Player) return obj("ok", false, "reason", "someone is in it (" + q.getName().getString() + ")");
            if (v.getPassengers().size() >= (boat ? 2 : 1)) return obj("ok", false, "reason", "no seat free");
            double dist = Math.sqrt(v.getBoundingBox().distanceToSqr(me.getEyePosition()));
            if (dist > REACH) return obj("ok", false, "reason", "too far: " + round(dist) + " blocks (max " + REACH + ")");
            if (Combat.fighting) return obj("ok", false, "reason", "a fight is on");
            var inv = me.getInventory();
            String[] hotbar = new String[9];
            for (int k = 0; k < 9; k++) hotbar[k] = Interact.nameOf(inv.getItem(k));
            int hand = Merchant.handSlot(hotbar, inv.getSelectedSlot());
            if (hand < 0) return obj("ok", false, "reason", "no empty or harmless hotbar slot to click with");
            cancelBaritone();
            if (me.containerMenu != me.inventoryMenu) me.closeContainer();
            mc.options.keyShift.setDown(false);
            inv.setSelectedSlot(hand);
            me.lookAt(EntityAnchorArgument.Anchor.EYES, v.getBoundingBox().getCenter());
            long sinceOut = Ticker.ticks() - lastOutTick;
            Ticker.add(new Ticker.Task() {
                int age;
                boolean clicked;
                @Override public boolean tick(Minecraft m) {
                    try {
                        age++;
                        LocalPlayer pl = m.player;
                        if (pl == null) { c.fail("not in a world"); return true; }
                        if (!clicked) {
                            if (age < 3) return false;
                            if (v.isRemoved()) { c.ok(obj("ok", false, "reason", "it is gone")); return true; }
                            if (pl.isShiftKeyDown()) { if (age < 20) return false; c.ok(obj("ok", false, "reason", "still sneaking")); return true; }
                            String held = Interact.nameOf(pl.getMainHandItem());
                            if (!Merchant.harmless(held)) { c.ok(obj("ok", false, "reason", "the hand holds " + held + " at the click")); return true; }
                            Vec3 from = pl.getEyePosition();
                            AABB bb = v.getBoundingBox();
                            Vec3 hitAt = bb.contains(from) ? from : bb.clip(from, bb.getCenter()).orElse(bb.getCenter());
                            m.gameMode.interact(pl, v, new EntityHitResult(v, hitAt), InteractionHand.MAIN_HAND); // a use: never an attack
                            clicked = true;
                            return false;
                        }
                        if (pl.getVehicle() == v) {
                            c.ok(obj("ok", true, "id", v.getId(), "seat", v.getPassengers().indexOf(pl), "controlling", v.getControllingPassenger() == pl,
                                "passengers", passengers(v)));
                            return true;
                        }
                        if (age < 40) return false;
                        c.ok(obj("ok", false, "reason", sinceOut < BOARDING_COOLDOWN + 40 ? "the server did not let it in (out of a seat " + sinceOut / 20
                            + " s ago: no one gets in again for 3 s)" : "the server did not let it in"));
                        return true;
                    } catch (RuntimeException ex) {
                        c.fail("vehicle.mount: " + ex);
                        return true;
                    }
                }
            });
            return BridgeServer.LATER;
        });

        // {to: {x, z}, within?: 1.5, timeoutMs?: 120000, maxDrop?: 2, maxOff?: 3, stopOnLand?: false} -> {ok, reason, at,
        // block, distance, offLine (the most it strayed), seconds, speed, onLand, passengers, ahead?: {name, x, y, z}}.
        // reason: "arrived" | "a step up ahead (a boat climbs nothing)" | "lava or fire ahead" | "a drop of more than N
        // ahead" | "stuck" | "off the line" | "on land" (stopOnLand) | "hurt" | "the way ahead is not loaded" (5 s of it) |
        // "timed out" | "not steering" | "died" | "cancelled" (the bridge's `cancel`: the brain stopped the run).
        // Steers the boat the bot sits in front of along the straight line from where it is to `to`: the keys, no
        // pathing. It stops before anything a boat cannot cross or should not (see ahead), and where the boat stalls
        s.register("vehicle.drive", true, (p, c) -> {
            LocalPlayer me = Handlers.player();
            if (!(me.getVehicle() instanceof AbstractBoat boat)) return obj("ok", false, "reason", "not in a boat");
            if (boat.getControllingPassenger() != me) return obj("ok", false, "reason", "not steering (the bot is not in the front seat)");
            JsonElement t = p.get("to");
            if (t == null || !t.isJsonObject()) throw new IllegalArgumentException("missing parameter: to {x, z}");
            double tx = numParam(t.getAsJsonObject(), "x", Double.NaN), tz = numParam(t.getAsJsonObject(), "z", Double.NaN);
            if (Double.isNaN(tx) || Double.isNaN(tz)) throw new IllegalArgumentException("to needs x and z");
            double within = Math.max(0.5, numParam(p, "within", 1.5));
            int timeout = Math.max(20, Math.min(15 * 60 * 20, intParam(p, "timeoutMs", 120_000) / 50));
            int maxDrop = Math.max(0, Math.min(3, intParam(p, "maxDrop", 2)));
            double maxOff = Math.max(1, numParam(p, "maxOff", 3));
            boolean stopOnLand = flag(p, "stopOnLand");
            double fx = boat.getX(), fz = boat.getZ();
            cancelBaritone();
            Minecraft.getInstance().options.keyShift.setDown(false);
            Ticker.add(new Ticker.Task() {
                int age, stillTicks, unloaded;
                double worstOff, lastX = fx, lastZ = fz;
                final long deaths = Events.deaths();
                // the brain's `cancel` (a run stopped: survival, its timeout, the LLM, autonomy off), as Processes' own
                // tickers watch it: else the boat steered on to the leg's end, minutes, the stopped run waiting on it
                final long cancels = Processes.cancels;
                @Override public boolean tick(Minecraft m) {
                    try {
                        age++;
                        LocalPlayer pl = m.player;
                        if (c.isDone()) { releaseKeys(m); return true; }
                        if (Processes.cancels != cancels) return end(m, "cancelled", null);
                        if (Events.deaths() != deaths) return end(m, "died", null);
                        if (pl == null || pl.getVehicle() != boat || boat.isRemoved()) return end(m, "not steering", null);
                        if (boat.getControllingPassenger() != pl) return end(m, "not steering", null);
                        double x = boat.getX(), z = boat.getZ();
                        if (Math.hypot(tx - x, tz - z) <= within) return end(m, "arrived", null);
                        if (age > timeout) return end(m, "timed out", null);
                        if (pl.getHealth() <= 10 && Guardian.hurtRecently(20)) return end(m, "hurt", null);
                        double off = offLine(fx, fz, tx, tz, x, z);
                        worstOff = Math.max(worstOff, off);
                        if (off > maxOff) return end(m, "off the line", null);
                        boolean onLand = boat.onGround();
                        if (stopOnLand && onLand) return end(m, "on land", null);
                        double friction = onLand ? boat.getGroundFriction() : WATER_FRICTION;
                        double bottom = boat.getY();
                        Decision d = decide(b -> ground(m.level, b, bottom), fx, fz, tx, tz, x, bottom, z, boat.getYRot(),
                            Mth.wrapDegrees(boat.getYRot() - boat.yRotO), boat.getDeltaMovement().x, boat.getDeltaMovement().z, friction, within, maxDrop);
                        if (NOT_LOADED.equals(d.stop())) {
                            releaseKeys(m);
                            if (++unloaded > 100) return end(m, NOT_LOADED, d.cell());
                            return false;
                        }
                        unloaded = 0;
                        if (d.stop() != null) return end(m, d.stop(), d.cell());
                        Keys k = d.keys();
                        BlockPos aheadCell = d.ahead();
                        m.options.keyLeft.setDown(k.left());
                        m.options.keyRight.setDown(k.right());
                        m.options.keyUp.setDown(k.forward());
                        m.options.keyDown.setDown(false);
                        // stalled: paddling and getting nowhere for 2 s (a corner of the boat on a block, a mob in the way)
                        if (age % 20 == 0) {
                            boolean moved = Math.hypot(x - lastX, z - lastZ) > 0.15;
                            stillTicks = moved || !k.forward() ? 0 : stillTicks + 20;
                            lastX = x;
                            lastZ = z;
                            if (stillTicks >= 40) return end(m, "stuck", aheadCell);
                        }
                        return false;
                    } catch (RuntimeException ex) {
                        releaseKeys(m);
                        c.fail("vehicle.drive: " + ex);
                        return true;
                    }
                }

                boolean end(Minecraft m, String reason, BlockPos cell) {
                    releaseKeys(m);
                    LocalPlayer pl = m.player;
                    JsonObject r = obj("ok", reason.equals("arrived"), "reason", reason, "at", pos(boat.position()), "block", pos(boat.blockPosition()),
                        "distance", round(Math.hypot(tx - boat.getX(), tz - boat.getZ())), "offLine", round(worstOff), "seconds", round(age / 20.0),
                        "speed", round(boat.getDeltaMovement().horizontalDistance() * 20), "onLand", boat.onGround(), "passengers", passengers(boat));
                    if (cell != null && m.level != null) {
                        JsonObject a = pos(cell);
                        a.addProperty("name", Names.block(m.level.getBlockState(cell)));
                        r.add("ahead", a);
                    }
                    if (pl != null) r.addProperty("health", round(pl.getHealth()));
                    c.ok(r);
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // {toward?: {x, z}, force?: false} -> {ok, wasRiding, at, block, expected?: {x, y, z}, from: the vehicle's id} |
        // {ok: false, reason}. Out of the boat (or minecart): shift. Out of a boat the game puts the bot a step out the way
        // it faces: it first faces the way nearest `toward` (else the way it looks) where a standing player fits, never
        // over water; none: refused unless `force` (then on top of the boat, as the game does)
        s.register("vehicle.dismount", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            Entity v = me.getVehicle();
            if (v == null) return obj("ok", true, "wasRiding", false);
            Vec3 expected = null;
            if (v instanceof AbstractBoat boat) {
                JsonElement t = p.get("toward");
                float want = t != null && t.isJsonObject() ? yawTo(boat.getX(), boat.getZ(), numParam(t.getAsJsonObject(), "x", boat.getX()), numParam(t.getAsJsonObject(), "z", boat.getZ()))
                    : me.getYRot();
                Float yaw = null;
                for (float y : outYaws(boat.getYRot(), want)) {
                    Vec3 at = outSpot(mc.level, boat, me, y);
                    if (at != null) { yaw = y; expected = at; break; }
                }
                if (yaw == null && !flag(p, "force")) return obj("ok", false, "reason", "no safe cell to step out to (water or walls all round the boat)");
                if (yaw != null) me.setYRot(yaw);
            }
            Vec3 exp = expected;
            releaseKeys(mc);
            cancelBaritone();
            Ticker.add(new Ticker.Task() {
                int age, off = -1;
                @Override public boolean tick(Minecraft m) {
                    try {
                        age++;
                        LocalPlayer pl = m.player;
                        if (pl == null) { m.options.keyShift.setDown(false); c.fail("not in a world"); return true; }
                        if (off < 0) {
                            if (age < 3) return false; // the look goes out first (a riding player sends it every tick)
                            if (pl.isPassenger()) {
                                m.options.keyShift.setDown(true);
                                if (age < 40) return false;
                                m.options.keyShift.setDown(false);
                                c.ok(obj("ok", false, "reason", "still in the " + Names.entity(v) + " after 2 s of shift"));
                                return true;
                            }
                            m.options.keyShift.setDown(false);
                            lastOutTick = Ticker.ticks();
                            off = age;
                            return false;
                        }
                        if (age - off < 4) return false; // the server's teleport to where it put the bot
                        JsonObject r = obj("ok", true, "wasRiding", true, "from", v.getId(), "at", pos(pl.position()), "block", pos(pl.blockPosition()));
                        if (exp != null) r.add("expected", pos(exp));
                        c.ok(r);
                        return true;
                    } catch (RuntimeException ex) {
                        m.options.keyShift.setDown(false);
                        c.fail("vehicle.dismount: " + ex);
                        return true;
                    }
                }
            });
            return BridgeServer.LATER;
        });

        // {id, uuid?} -> {ok, hits, item, pickedUp, drop?: {x, y, z}, passengersOut: [ids]} | {ok: false, reason}. The bot's
        // own boat (or minecart) broken back into its item: hits from an axe (else a pickaxe, a shovel, a bare hand; never
        // a sword: its sweep would hit the villager beside it), each with the attack meter full, then the drop picked up
        // (a step or two to it when it did not come by itself). Whoever sat in it gets out where it stood
        s.register("vehicle.take", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer me = Handlers.player();
            int id = Integer.parseInt(required(p, "id"));
            Entity v = mc.level.getEntity(id);
            if (v == null || v.isRemoved()) return obj("ok", false, "reason", "no entity with id " + id + " nearby");
            if (!(v instanceof VehicleEntity)) return obj("ok", false, "reason", "a " + Names.entity(v) + " is no boat nor minecart");
            if (!ownOr(v, strParam(p, "uuid", null))) return obj("ok", false, "reason", "not the bot's own " + Names.entity(v) + " (only what vehicle.place put down)");
            if (me.getVehicle() == v) return obj("ok", false, "reason", "riding it: out first (vehicle.dismount)");
            for (Entity q : v.getPassengers()) if (q instanceof Player) return obj("ok", false, "reason", "someone is in it (" + q.getName().getString() + ")");
            double dist = Math.sqrt(v.getBoundingBox().distanceToSqr(me.getEyePosition()));
            if (dist > REACH) return obj("ok", false, "reason", "too far: " + round(dist) + " blocks (max " + REACH + ")");
            if (Combat.fighting) return obj("ok", false, "reason", "a fight is on");
            var inv = me.getInventory();
            String[] names = new String[36];
            for (int k = 0; k < 36; k++) names[k] = Interact.nameOf(inv.getItem(k));
            int hand = takeHand(names);
            if (hand < 0) return obj("ok", false, "reason", "nothing to hit with but weapons that sweep");
            cancelBaritone();
            if (me.containerMenu != me.inventoryMenu) me.closeContainer();
            if (names[hand] == null) inv.setSelectedSlot(hand);
            else Interact.select(names[hand], hand);
            String drop = dropName(v);
            int countBefore = count(inv, drop);
            List<Integer> riders = new ArrayList<>();
            for (Entity q : v.getPassengers()) riders.add(q.getId());
            UUID uuid = v.getUUID();
            Ticker.add(new Ticker.Task() {
                int age, hits, gone = -1, walk;
                Vec3 last = v.position();
                ItemEntity item;
                @Override public boolean tick(Minecraft m) {
                    try {
                        age++;
                        LocalPlayer pl = m.player;
                        if (pl == null) { releaseKeys(m); c.fail("not in a world"); return true; }
                        if (gone < 0) {
                            if (v.isRemoved()) { gone = age; OWN.remove(uuid); return false; }
                            last = v.position();
                            if (age > 160 || hits >= 12) { c.ok(obj("ok", false, "reason", "still whole after " + hits + " hits", "hits", hits)); return true; }
                            if (age < 3 || pl.getAttackStrengthScale(0.5f) < 0.95f) return false;
                            String held = Interact.nameOf(pl.getMainHandItem());
                            // the hand again at the hit: the Guardian may have taken a sword up meanwhile
                            if (weapon(held) || Hazards.isHazard(held)) { c.ok(obj("ok", false, "reason", "the hand holds " + held + " at the hit", "hits", hits)); return true; }
                            if (Math.sqrt(v.getBoundingBox().distanceToSqr(pl.getEyePosition())) > REACH) { c.ok(obj("ok", false, "reason", "it moved out of reach", "hits", hits)); return true; }
                            pl.lookAt(EntityAnchorArgument.Anchor.EYES, v.getBoundingBox().getCenter());
                            m.gameMode.attack(pl, v); // (no swing, as Combat.attack: the server needs none)
                            hits++;
                            return false;
                        }
                        // broken: its item, picked up where it fell (the pickup waits 10 ticks; the bot's reach for it is a
                        // block about its box), else a few steps to it
                        int got = count(pl.getInventory(), drop) - countBefore;
                        if (got > 0) return done(m, true);
                        if (item == null || item.isRemoved()) {
                            item = null;
                            for (Entity e : m.level.entitiesForRendering()) {
                                if (e instanceof ItemEntity ie && !ie.getItem().isEmpty() && Names.item(ie.getItem()).equals(drop) && ie.position().distanceTo(last) < 3) { item = ie; break; }
                            }
                        }
                        if (age - gone < 20) return false;
                        if (item != null && walk < 60 && item.position().distanceTo(pl.position()) < 4) {
                            walk++;
                            double dx = item.getX() - pl.getX(), dz = item.getZ() - pl.getZ();
                            pl.setYRot((float) Math.toDegrees(Math.atan2(-dx, dz)));
                            m.options.keyUp.setDown(Math.hypot(dx, dz) > 0.3);
                            m.options.keyJump.setDown(pl.horizontalCollision);
                            return false;
                        }
                        return done(m, false);
                    } catch (RuntimeException ex) {
                        releaseKeys(m);
                        c.fail("vehicle.take: " + ex);
                        return true;
                    }
                }

                boolean done(Minecraft m, boolean picked) {
                    releaseKeys(m);
                    JsonArray out = new JsonArray();
                    for (int r : riders) out.add(r);
                    JsonObject r = obj("ok", true, "hits", hits, "item", drop, "pickedUp", picked, "passengersOut", out);
                    if (!picked && item != null && !item.isRemoved()) r.add("drop", pos(item.position()));
                    c.ok(r);
                    return true;
                }
            });
            return BridgeServer.LATER;
        });
    }

    /** The item a vehicle breaks into (its pick result: the boat's own wood, a minecart). */
    static String dropName(Entity v) {
        var st = v.getPickResult();
        return st == null || st.isEmpty() ? Names.entity(v) : Names.item(st);
    }

    static int count(net.minecraft.world.entity.player.Inventory inv, String name) {
        int n = 0;
        for (int k = 0; k < 36; k++) if (!inv.getItem(k).isEmpty() && Names.item(inv.getItem(k)).equals(name)) n += inv.getItem(k).getCount();
        return n;
    }

    private static boolean flag(JsonObject p, String name) {
        return p.has(name) && !p.get(name).isJsonNull() && p.get(name).getAsBoolean();
    }
}
