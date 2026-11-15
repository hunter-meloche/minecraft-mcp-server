package claudebridge;

/**
 * A throw toward a point (item.toss: a gold ingot to a piglin): how far a thrown item flies and slides as the 26.3
 * server moves it, and the pitch whose throw comes to rest nearest the point. Pure, so a scratch check can hold it to
 * the game's own ItemEntity.
 *
 * Checked against the 26.3 jar. A player's throw, by Q (ServerPlayer.drop) or by the inventory's throw click
 * (AbstractContainerMenu's THROW: Player.drop(stack, true, PREDICTED)), is LivingEntity.createItemStackToDrop(stack,
 * false, true): the item starts at the player's x and z and the eye less 0.3, moving 0.3 along the look the server
 * has for the player and 0.1 up, plus a random push of up to 0.02 in any direction along the ground and up to 0.1 up
 * or down ((nextFloat - nextFloat) x 0.1); nothing may pick it up for 40 ticks (setPickUpDelay(40)). Each tick
 * (ItemEntity.tick, out of water and lava) gravity takes 0.04 off its rise first, then it moves (Entity.move: a landing
 * stops its fall, and the speed factor of what it is in, or else of the block under that, slows it: soul sand's and
 * honey's 0.4; an item's "block under" is a whole block down, ItemEntity.getBlockPosBelowThatAffectsMyMovement, so
 * soul sand slows a throw from a block above it on), then every axis keeps 0.98 of its speed, and on the ground also
 * the floor's friction (0.6 for nearly every block, slime 0.8, ice 0.98, blue ice 0.989). So a throw comes to rest at
 * most about 3.75 blocks out on stone (2.9 to 4.6 with the push), and a throw at the feet of a mob 3 away rests
 * about 2 out.
 */
final class Toss {
    private Toss() { }

    static final double SPEED = 0.3, LIFT = 0.1, GRAVITY = 0.04, DRAG = 0.98;
    /** The throw starts this far under the eye. */
    static final double BELOW_EYE = 0.3;
    /** The random push: up to this much up or down, and up to SIDE in any direction along the ground. */
    static final double JITTER_UP = 0.1, JITTER_SIDE = 0.02;
    /** Ticks before anything may pick a thrown item up (a piglin walks to it meanwhile, and takes it then). */
    static final int PICKUP_DELAY = 40;
    /** The pitches tried, looking down (positive, as Minecraft's xRot) to up. */
    static final double PITCH_DOWN = 80, PITCH_UP = -60, PITCH_STEP = 0.5;
    /**
     * The farthest the mean throw may come to rest from the point asked for and still be thrown (blocks): farther, and
     * the push leaves it out of a mob's pickup reach (its box grown 1, Mob.ITEM_PICKUP_REACH) now and then.
     */
    static final double MAX_MISS = 0.5;

    /**
     * The floor a throw comes down on: its friction and speed factor (Block.getFriction, getSpeedFactor), and how far its
     * top lies under its cell's top (soul sand's 2/16; 0 for a full block).
     */
    record Floor(double friction, double speed, double sink) {
        static final Floor STONE = new Floor(0.6, 1, 0);
    }

    /**
     * How far along the look (along the ground) a throw at this pitch comes to rest on a floor `drop` under its start
     * (the eye less 0.3, less the floor's height: negative for a floor above it), with `up` added to its rise and
     * `along` to its speed along the ground (the random push; 0 and 0 for the mean throw). NaN when it never comes down
     * onto that floor from above (a floor above it that the arc does not clear).
     */
    static double rest(double pitchDeg, double drop, Floor floor, double up, double along) {
        double t = Math.toRadians(pitchDeg);
        double v = SPEED * Math.cos(t) + along, vy = -SPEED * Math.sin(t) + LIFT + up;
        double x = 0, y = drop; // y: its height over the floor it is to land on
        boolean above = y > 0;
        boolean ground = false;
        for (int tick = 0; tick < 600; tick++) {
            if (!ground) {
                vy -= GRAVITY;
                double ny = y + vy;
                x += v;
                if (ny <= 0 && vy < 0) {
                    if (!above) return Double.NaN; // came down short of the floor's height: it hit the ledge's side
                    ground = true;
                    y = 0;
                    vy = 0;
                } else {
                    y = ny;
                    if (y > 0) above = true;
                }
                // the floor's speed factor, from a block over its cell on (and on it)
                if (ground || y < 1 + floor.sink()) v *= floor.speed();
                v *= DRAG * (ground ? floor.friction() : 1);
                vy *= DRAG;
            } else {
                x += v;
                v *= floor.speed() * DRAG * floor.friction();
                if (Math.abs(v) < 1e-4) break;
            }
        }
        return x;
    }

    /** A throw: the pitch to look at (degrees, down positive), and where its mean, shortest and longest throws rest. */
    record Aim(double pitch, double rest, double shortest, double longest) {
        double miss(double distance) { return Math.abs(rest - distance); }
    }

    /**
     * The pitch whose mean throw comes to rest nearest `distance` blocks out along the ground, on a floor `drop` under
     * the throw's start; `step`: that floor is not the thrower's own but a step up or down from it (a throw that
     * clips the edge between falls back or stops short of it, anywhere from the thrower on). Only the low arcs (from straight down to the pitch that throws farthest): a
     * high lob gets the same distance with a long flight, into a cave's roof or over the mob, and lands later. Null if
     * no pitch comes down on that floor at all.
     */
    static Aim aim(double distance, double drop, Floor floor, boolean step) {
        double bestPitch = Double.NaN, best = Double.NaN, far = -1;
        for (double p = PITCH_DOWN; p >= PITCH_UP - 1e-9; p -= PITCH_STEP) {
            double r = rest(p, drop, floor, 0, 0);
            if (Double.isNaN(r)) continue;
            if (r < far - 0.05) break; // past the farthest throw: the high arcs from here on
            far = Math.max(far, r);
            if (Double.isNaN(best) || Math.abs(r - distance) < Math.abs(best - distance)) { best = r; bestPitch = p; }
        }
        if (Double.isNaN(best)) return null;
        // the push's four corners (up or down, forward or back) bound where it may rest; across, it strays up to about
        // 0.02 / 0.3 of the distance either way
        double lo = Double.MAX_VALUE, hi = 0;
        boolean short_ = step;
        for (double up : new double[] { -JITTER_UP, JITTER_UP }) for (double along : new double[] { -JITTER_SIDE, JITTER_SIDE }) {
            double r = rest(bestPitch, drop, floor, up, along);
            if (Double.isNaN(r)) { short_ = true; continue; }
            lo = Math.min(lo, r);
            hi = Math.max(hi, r);
        }
        if (hi == 0) hi = best;
        return new Aim(bestPitch, best, short_ ? 0 : Math.min(lo, best), Math.max(hi, best));
    }

    /**
     * The cells to look into for lava or fire before a throw: along the line from `start` (the throw's) by `along` (a
     * unit step along the ground), anywhere from the aim's shortest throw to its longest and a block either side
     * (across, the push strays up to about 0.02 / 0.3 of the distance: 0.3 at 4), at the height of the cell it rests in
     * and of its floor, from `floorY` (the point's feet) to `ownY` (the bot's feet: the same, or a step up or down, where
     * a short throw rests on the bot's own floor).
     */
    static java.util.Set<net.minecraft.core.BlockPos> restCells(net.minecraft.world.phys.Vec3 start, net.minecraft.world.phys.Vec3 along, Aim aim,
        double floorY, double ownY) {
        int yHi = (int) Math.floor(Math.max(floorY, ownY)), yLo = (int) Math.floor(Math.min(floorY, ownY)) - 1;
        java.util.Set<net.minecraft.core.BlockPos> out = new java.util.LinkedHashSet<>();
        for (double r = aim.shortest(); r <= aim.longest() + 0.5; r += 0.5) {
            double at = Math.min(r, aim.longest());
            double cx = start.x + along.x * at, cz = start.z + along.z * at;
            for (int ox = -1; ox <= 1; ox++) for (int oz = -1; oz <= 1; oz++) for (int y = yLo; y <= yHi; y++) {
                out.add(net.minecraft.core.BlockPos.containing(cx + ox, y, cz + oz));
            }
        }
        return out;
    }

    /** The yaw (Minecraft's: 0 looks south, +z; 90 west, -x) that looks from (x, z) along (dx, dz). */
    static float yaw(double dx, double dz) {
        return (float) Math.toDegrees(Math.atan2(-dx, dz));
    }
}
