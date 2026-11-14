package claudebridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.effect.MobEffects;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.hurtingprojectile.LargeFireball;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The dimension the bot is in, and the reflexes the Nether needs (the Guardian, Combat and DefendProcess call these).
 * Each rule is a small pure method, so a scratch check can hold it to its cases; the live glue reads the world for it.
 *
 * Checked against the 26.3 jar: ghasts, phantoms and vexes fly (Ghast and Phantom are Mobs, Vex a Monster that never
 * lands), a blaze flies or stands; a ghast's fireball is a LargeFireball (1 x 1, explosion power 1), and a player's
 * attack on it turns it along the attacker's look (Player.attack: deflectProjectile, AIM_DEFLECT on the
 * redirectable_projectile tag, whatever the attack strength); the server takes an attack up to the entity interaction
 * range (3) plus 3 from the eye, and the bot swings only within the 3 a vanilla client reaches. Neutral mobs: Bee,
 * IronGolem, PolarBear, Wolf, Enderman and ZombifiedPiglin are NeutralMob; piglins and brutes go by their brain; all of
 * them set the synced aggressive flag (Mob.setAggressive: PiglinAi, PiglinBruteAi, MeleeAttackGoal) or, for an enderman,
 * its creepy flag, while they have an attack target. A sword's sweep needs an item in ItemTags.SWORDS (Player.
 * isSweepAttack): an axe or a pickaxe never sweeps. Piglins leave alone a player wearing any of ItemTags.
 * PIGLIN_SAFE_ARMOR (the four golden pieces). Beds (and 26.3's straw bed) explode outside the overworld: the Nether's
 * and the End's bed_rule says destroy_on_use. Explosion resistance: cobblestone, cobbled deepslate, stone bricks,
 * stone, deepslate, blackstone, andesite, diorite, granite and tuff 6, end stone 9; netherrack 0.4, dirt 0.5, sand
 * 0.5, gravel 0.6, basalt 4.2, planks 3.
 */
public final class Nether {
    private Nether() { }

    // ---------------------------------------------------------------- the dimension

    /** The client's level as of this tick ("overworld", "the_nether", "the_end"); read from any thread. */
    private static volatile String here = "overworld";

    static String here() { return here; }

    static boolean inNether() { return "the_nether".equals(here); }

    /** The tick the dimension last changed (the client's start counts as one). */
    private static volatile long changedAt;

    static long ticksSinceChange() { return Ticker.ticks() - changedAt; }

    /** Every tick, and at once when the server moves the bot (Events.onRespawn): what changes with the dimension. */
    static void noteDimension(Minecraft mc) {
        String now = Names.dimension(mc.level);
        if (now == null || now.equals(here)) return;
        String was = here;
        here = now;
        changedAt = Ticker.ticks();
        System.out.println("[claudebridge] dimension: " + was + " -> " + now);
        throwaway(now);
        Foreign.dimensionChanged();
        Protection.refresh();
    }

    /** The throwaway blocks ClaudeBridge configured (the overworld's), kept to put back. */
    private static List<net.minecraft.world.item.Item> overworldThrowaway;

    /**
     * Baritone's pillars and bridges in the Nether only of blocks a ghast's fireball does not blow away: the configured
     * list less what is not blast-proof (netherrack, which Baritone mines everywhere there and would bridge with).
     */
    private static void throwaway(String dim) {
        var setting = baritone.api.BaritoneAPI.getSettings().acceptableThrowawayItems;
        if (overworldThrowaway == null) overworldThrowaway = new ArrayList<>(setting.value);
        List<net.minecraft.world.item.Item> want = new ArrayList<>();
        for (var item : overworldThrowaway) {
            Block b = Block.byItem(item);
            if (coverOk(dim, b.getExplosionResistance(), b instanceof net.minecraft.world.level.block.FallingBlock)) want.add(item);
        }
        setting.value = want;
    }

    // ---------------------------------------------------------------- (b) no chase

    /** Never on the ground: a chase for melee goes on under it for good. */
    static final Set<String> FLYING = Set.of("ghast", "phantom", "vex");
    /** Baritone's own fall limit (maxFallHeightNoWater): a drop deeper than this between the bot and a target is no way. */
    static final int MAX_FALL = 3;

    /**
     * Why the bot must not walk after this target for melee, or null when it may: a flying mob (a blaze off the
     * ground), one standing by lava (the knockback of the fight, a step too far), one across a drop deeper than
     * Baritone falls. It is let go: the shield up, the fight's own "not getting closer" rule gives it up.
     */
    static String noChase(String mob, boolean onGround, boolean lavaNear, int fall) {
        if (FLYING.contains(mob) || (mob.equals("blaze") && !onGround)) return "flying";
        if (lavaNear) return "by lava";
        if (fall > MAX_FALL) return "across a drop of " + fall;
        return null;
    }

    /**
     * The deepest single fall walking a line of cells: `levels[i]` the feet level the walk stands at in the i-th cell
     * (Integer.MIN_VALUE: no floor within reach under it), from `startY`. A step up is no fall, and a slope down a block
     * at a time never adds up to one.
     */
    static int maxFall(int startY, int[] levels) {
        int at = startY, worst = 0;
        for (int y : levels) {
            if (y == Integer.MIN_VALUE) return Math.max(worst, FALL_SCAN + 1);
            if (y < at) worst = Math.max(worst, at - y);
            at = y;
        }
        return worst;
    }

    /** How far under a cell the walk looks for a floor. */
    static final int FALL_SCAN = 6;

    /** Live: lava within `r` of a cell (across, and a block above and below its feet). */
    static boolean lavaNear(net.minecraft.world.level.Level level, BlockPos at, int r) {
        for (int dx = -r; dx <= r; dx++) for (int dz = -r; dz <= r; dz++) for (int dy = -1; dy <= 1; dy++) {
            if (level.getFluidState(at.offset(dx, dy, dz)).is(net.minecraft.tags.FluidTags.LAVA)) return true;
        }
        return false;
    }

    /** A cell a player can stand in: something to stand on under it, its feet and head clear of anything solid or fluid. */
    static boolean standable(net.minecraft.world.level.Level level, BlockPos feet) {
        BlockState floor = level.getBlockState(feet.below());
        if (floor.getCollisionShape(level, feet.below()).isEmpty() || !floor.getFluidState().isEmpty()) return false;
        return clear(level, feet) && clear(level, feet.above());
    }

    private static boolean clear(net.minecraft.world.level.Level level, BlockPos p) {
        BlockState s = level.getBlockState(p);
        return s.getCollisionShape(level, p).isEmpty() && s.getFluidState().isEmpty();
    }

    /** Live: the deepest fall on the straight walk from the bot's feet to the target's (Baritone falls at most MAX_FALL). */
    static int fallBetween(net.minecraft.world.level.Level level, Vec3 from, Vec3 to) {
        double dx = to.x - from.x, dz = to.z - from.z, len = Math.hypot(dx, dz);
        int steps = (int) Math.ceil(len / 0.5);
        int start = (int) Math.floor(from.y + 0.01);
        List<Integer> levels = new ArrayList<>();
        int at = start;
        BlockPos last = BlockPos.containing(from);
        for (int i = 1; i <= steps; i++) {
            double t = i / (double) steps;
            BlockPos col = BlockPos.containing(from.x + dx * t, at, from.z + dz * t);
            if (col.getX() == last.getX() && col.getZ() == last.getZ()) continue;
            last = col;
            int found = Integer.MIN_VALUE;
            if (standable(level, new BlockPos(col.getX(), at + 1, col.getZ()))) found = at + 1; // a step up
            else if (!clear(level, new BlockPos(col.getX(), at, col.getZ()))) found = at; // a wall: the walk goes round it, no fall
            else {
                // the floor under the walk: the first block below its feet (a low roof over it is no drop)
                for (int y = at; y >= at - FALL_SCAN; y--) {
                    if (!clear(level, new BlockPos(col.getX(), y - 1, col.getZ()))) { found = y; break; }
                }
            }
            levels.add(found);
            if (found != Integer.MIN_VALUE) at = found;
            else break;
        }
        int[] arr = new int[levels.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = levels.get(i);
        return maxFall(start, arr);
    }

    /**
     * Live: the reason not to chase this target, or null. Flying counts everywhere (a phantom is the overworld's); the
     * lava and the drop only in the Nether. In the overworld the brain's own hunts go by #id (a cow across a 4-block
     * cliff, a sheep by a lava pool) and Baritone walks round to them as it always has: the straight line's drop is no
     * way to judge a path there, and refused they were booked as hunted with nothing killed.
     */
    static String chaseRefusal(LocalPlayer p, Entity target) {
        var level = p.level();
        return noChase(Names.entity(target), target.onGround(), inNether(), () -> lavaNear(level, target.blockPosition(), 2),
            () -> fallBetween(level, p.position(), target.position()));
    }

    /** noChase for the dimension the bot is in: the lava and the drop asked for (the scans run) only in the Nether. */
    static String noChase(String mob, boolean onGround, boolean nether, java.util.function.BooleanSupplier lavaNear,
                          java.util.function.IntSupplier fall) {
        return nether ? noChase(mob, onGround, lavaNear.getAsBoolean(), fall.getAsInt()) : noChase(mob, onGround, false, 0);
    }

    // ---------------------------------------------------------------- (c) fireballs

    enum Fireball { NONE, LOOK, SWING, SHIELD }

    /** A ghast's fireball this close (eye to its box) and coming at the bot is the reflex's. */
    static final double FIREBALL_RANGE = 5;

    /**
     * What to do about a ghast's fireball `distance` from the eye, coming at the bot at `closing` blocks a tick: hit it
     * once when in reach (it flies back along the bot's look), else hold the shield toward it (a shield takes an
     * explosion from the front), else at least face it so the swing is aimed when it comes into reach.
     */
    static Fireball fireball(double distance, double closing, double reach, boolean swung, boolean shield) {
        if (distance > FIREBALL_RANGE || closing <= 0) return Fireball.NONE;
        if (distance <= reach && !swung) return Fireball.SWING;
        return shield ? Fireball.SHIELD : Fireball.LOOK;
    }

    private static final Set<Integer> SWUNG = new HashSet<>();
    private static final Map<Integer, Double> LAST_DISTANCE = new HashMap<>();
    private static boolean shieldForFireball;

    /**
     * The fireball reflex, every tick from the Guardian: true when it took the hands this tick (the melee reflex and the
     * shield guard wait).
     */
    static boolean deflect(Minecraft mc, LocalPlayer p) {
        Vec3 eye = p.getEyePosition();
        LargeFireball best = null;
        double bestD = Double.MAX_VALUE, bestClosing = 0;
        Map<Integer, Double> seen = new HashMap<>();
        for (Entity e : mc.level.entitiesForRendering()) {
            if (!(e instanceof LargeFireball fb) || !fb.isAlive()) continue;
            double d = Math.sqrt(fb.getBoundingBox().distanceToSqr(eye));
            if (d > FIREBALL_RANGE + 3) continue;
            seen.put(fb.getId(), d);
            Vec3 to = eye.subtract(fb.getBoundingBox().getCenter());
            double closing = to.lengthSqr() < 1e-6 ? 1 : fb.getDeltaMovement().dot(to.normalize());
            Double before = LAST_DISTANCE.get(fb.getId());
            // (its motion as the client has it; a fireball the client has not moved yet: by its distance a tick ago)
            if (Math.abs(closing) < 1e-3 && before != null) closing = before - d;
            if (d <= FIREBALL_RANGE && closing > 0 && d < bestD) { best = fb; bestD = d; bestClosing = closing; }
        }
        LAST_DISTANCE.clear();
        LAST_DISTANCE.putAll(seen);
        SWUNG.retainAll(seen.keySet());
        Fireball act = best == null ? Fireball.NONE : fireball(bestD, bestClosing, p.entityInteractionRange(), SWUNG.contains(best.getId()), Combat.hasShield());
        if (act != Fireball.SHIELD && shieldForFireball) { Combat.shieldDown(); shieldForFireball = false; }
        if (act == Fireball.NONE) return false;
        Vec3 at = best.getBoundingBox().getCenter();
        p.lookAt(EntityAnchorArgument.Anchor.EYES, at);
        if (act == Fireball.SWING) {
            // the server turns it along the look it has for the bot: the look goes out first, then the hit
            p.connection.send(new net.minecraft.network.protocol.game.ServerboundMovePlayerPacket.Rot(p.getYRot(), p.getXRot(), p.onGround(), p.horizontalCollision));
            mc.gameMode.attack(p, best); // (no swing animation, as Combat.attack: the server needs none)
            SWUNG.add(best.getId());
            Guardian.note("hit a ghast's fireball back (" + Json.round(bestD) + " blocks off)");
        } else if (act == Fireball.SHIELD) {
            Combat.shieldUp();
            shieldForFireball = true;
        }
        return true;
    }

    // ---------------------------------------------------------------- (d) neutral mobs

    /** Neutral until angered, by name (piglins go by their brain, not NeutralMob; a brute's is the same rule). */
    static final Set<String> NEUTRAL = Set.of("zombified_piglin", "piglin", "piglin_brute", "enderman");

    /** Never attacked unless it is after the bot: these, any NeutralMob (bees, wolves, golems, polar bears), villagers. */
    static boolean neutral(String name, boolean neutralMob, boolean villager) {
        return NEUTRAL.contains(name) || neutralMob || villager;
    }

    /**
     * Neutral mobs whose anger, with the bot the nearest player, says they are after the bot: a brute only (it goes for a
     * player on sight anyway). The synced aggressive or creepy flag cannot say at whom, and the others fight mobs too: a
     * zombified piglin turns on whatever hurt it, its whole group alerted (a skeleton's stray arrow by the home portal,
     * a golem's hit), an enderman on an endermite or a mob that hurt it, a piglin hunts hoglins, a golem and a wolf fight
     * other mobs, a bee its hive's robber. For them only a hit on the bot says so, as before P2a: a swing at a zombified
     * piglin fighting a skeleton would turn the group on the bot.
     */
    static final Set<String> ANGRY_ONLY_AT_PLAYERS = Set.of("piglin_brute");

    /**
     * Whether the bot may hit it: anything not neutral; a neutral one only when it is after the bot: it hurt the bot in
     * the last 10 s, or (one angry only at players) it is angry with the bot the nearest player to it.
     */
    static boolean mayAttack(String name, boolean neutral, boolean hurtUs, boolean angry, boolean botNearest) {
        return !neutral || hurtUs || (angry && botNearest && ANGRY_ONLY_AT_PLAYERS.contains(name));
    }

    /** A neighbour a sword's sweep would hit and anger (or hurt): a neutral mob, a villager, a golem. */
    static boolean sweepAngers(String name, boolean neutralMob, boolean villager, boolean golem) {
        return neutral(name, neutralMob, villager) || golem;
    }

    /** How far from the target a neighbour keeps the sword in the pocket (the sweep reaches a block or so). */
    static final double SWEEP_NEAR = 6;

    /** Live: whether it is a neutral one (by name, NeutralMob, a villager or wandering trader). */
    static boolean neutral(Entity e) {
        return neutral(Names.entity(e), e instanceof net.minecraft.world.entity.NeutralMob, e instanceof net.minecraft.world.entity.npc.villager.AbstractVillager);
    }

    /** Live: angry at someone (an attack target), as the client sees it. */
    static boolean angry(Entity e) {
        if (e instanceof net.minecraft.world.entity.monster.Enderman en && en.isCreepy()) return true;
        return e instanceof net.minecraft.world.entity.Mob m && m.isAggressive();
    }

    /** Live: the bot is the nearest player to it (within 16): an angry one near it is most likely after it. */
    static boolean botNearest(Entity e, LocalPlayer p) {
        double mine = e.distanceTo(p);
        if (mine > 16) return false;
        for (Player other : p.level().players()) if (other != p && other.isAlive() && !other.isSpectator() && e.distanceTo(other) < mine) return false;
        return true;
    }

    /** Live: the bot may hit this one (see mayAttack). */
    static boolean mayAttack(Entity e, LocalPlayer p) {
        boolean n = neutral(e);
        return mayAttack(Names.entity(e), n, n && Guardian.recentAttacker(e), n && angry(e), n && botNearest(e, p));
    }

    /** Live: a neighbour within SWEEP_NEAR of the target that a sweep would anger. */
    static boolean sweepWouldAnger(Entity target, LocalPlayer p) {
        if (target == null) return false;
        for (Entity e : p.level().getEntities(target, target.getBoundingBox().inflate(SWEEP_NEAR))) {
            if (e == p || !e.isAlive() || !(e instanceof net.minecraft.world.entity.LivingEntity)) continue;
            if (sweepAngers(Names.entity(e), e instanceof net.minecraft.world.entity.NeutralMob,
                e instanceof net.minecraft.world.entity.npc.villager.AbstractVillager, e instanceof net.minecraft.world.entity.animal.golem.AbstractGolem)) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- (e) blast-proof blocks

    /** Blast-proof enough for a ghast's fireball (power 1): the stone family's 6 and up, and a block that stays put. */
    static boolean blastProof(float resistance, boolean falls) {
        return resistance >= 6f && !falls;
    }

    /** A block the bot may put down as cover or a pillar in this dimension: in the Nether only a blast-proof one. */
    static boolean coverOk(String dimension, float resistance, boolean falls) {
        return !"the_nether".equals(dimension) || blastProof(resistance, falls);
    }

    /** Live: the item's block, by coverOk, in the dimension the bot is in (an item that is no block: not as cover there). */
    static boolean coverOk(String item) {
        if (!inNether()) return true;
        var it = net.minecraft.core.registries.BuiltInRegistries.ITEM.getValue(net.minecraft.resources.Identifier.withDefaultNamespace(item));
        Block b = Block.byItem(it);
        if (b == net.minecraft.world.level.block.Blocks.AIR) return false;
        return coverOk(here, b.getExplosionResistance(), b instanceof net.minecraft.world.level.block.FallingBlock);
    }

    // ---------------------------------------------------------------- (f) beds

    /** Why a bed is not to be used here, or null: outside the overworld a bed explodes when used (26.3's bed_rule). */
    static String bedRefusal(String dimension, boolean bed) {
        if (!bed || "overworld".equals(dimension)) return null;
        return "a bed explodes outside the overworld (" + dimension + ")";
    }

    static boolean isBed(BlockState s) {
        return s.getBlock() instanceof net.minecraft.world.level.block.AbstractBedBlock;
    }

    // ---------------------------------------------------------------- (a) the golden helmet

    /**
     * How good a helmet is to wear here: in the Nether a golden one first (piglins leave a player in gold be), else the
     * piece's own rank; back in the overworld the best helmet wins again by its rank.
     */
    static int helmetRank(String item, int rank, boolean nether) {
        return nether && "golden_helmet".equals(item) ? 1_000_000 + rank : rank;
    }

    // ---------------------------------------------------------------- (g) fire resistance

    /** Drink a potion of fire resistance now: burning or in lava, without the effect, one carried, not drinking already. */
    static boolean drinkFireResistance(boolean onFire, boolean inLava, boolean effect, boolean carried, boolean drinking) {
        return (onFire || inLava) && !effect && carried && !drinking;
    }

    /** A drinkable potion (not a splash or lingering one: those are thrown) that gives fire resistance, by its contents. */
    static boolean fireResistancePotion(ItemStack st) {
        if (st.isEmpty() || !st.is(Items.POTION)) return false;
        var contents = st.get(net.minecraft.core.component.DataComponents.POTION_CONTENTS);
        return contents != null && givesFireResistance(contents);
    }

    /** Its contents give fire resistance (the potion's own effects or added ones): never by its name, "potion" for all. */
    static boolean givesFireResistance(net.minecraft.world.item.alchemy.PotionContents contents) {
        for (var e : contents.getAllEffects()) if (e.is(MobEffects.FIRE_RESISTANCE)) return true;
        return false;
    }

    /** The inventory index (0-35) of a potion of fire resistance, or -1. */
    static int fireResistanceSlot(Inventory inv) {
        for (int i = 0; i < 36; i++) if (fireResistancePotion(inv.getItem(i))) return i;
        return -1;
    }

    /** A potion being drunk by the reflex: the other reflexes keep their hands off the selected slot and the use key. */
    static volatile boolean drinking;
    private static long nextDrinkTry;

    /** The fire resistance hook, every tick from the Guardian. */
    static void fireResistance(Minecraft mc, LocalPlayer p) {
        if (drinking || Ticker.ticks() < nextDrinkTry) return;
        boolean onFire = p.isOnFire(), inLava = p.isInLava();
        if (!onFire && !inLava) return;
        boolean effect = p.hasEffect(MobEffects.FIRE_RESISTANCE);
        int slot = effect ? -1 : fireResistanceSlot(p.getInventory());
        if (!drinkFireResistance(onFire, inLava, effect, slot >= 0, drinking)) return;
        drinking = true;
        Interact.using = true;
        EatPause.eating = true; // a Baritone job stops for the drink
        Guardian.shieldGuardDown();
        if (Combat.shieldKey()) Combat.shieldDown();
        String why = inLava ? "in lava" : "on fire";
        try {
            Interact.select("potion", slot);
        } catch (RuntimeException e) {
            endDrink(mc, "could not take the potion of fire resistance in hand: " + e.getMessage());
            return;
        }
        Ticker.add(new Ticker.Task() {
            int age;
            boolean started;
            @Override public boolean tick(Minecraft m) {
                age++;
                LocalPlayer me = m.player;
                if (me == null) { endDrink(m, null); return true; }
                if (age == 2) { // after the selected slot has gone out
                    m.gameMode.useItem(me, InteractionHand.MAIN_HAND);
                    m.options.keyUse.setDown(true); // a potion is drunk over time: the use stops when the key comes up
                }
                if (me.isUsingItem()) started = true;
                boolean has = me.hasEffect(MobEffects.FIRE_RESISTANCE);
                if (!has && !(started && !me.isUsingItem()) && age < 70) return false;
                endDrink(m, has ? "drank a potion of fire resistance (" + why + ")" : "tried to drink a potion of fire resistance (" + why + ") but it did not take");
                return true;
            }
        });
    }

    private static void endDrink(Minecraft mc, String note) {
        mc.options.keyUse.setDown(false);
        if (mc.player != null && mc.player.isUsingItem()) mc.gameMode.releaseUsingItem(mc.player);
        Interact.using = false;
        EatPause.eating = false;
        drinking = false;
        nextDrinkTry = Ticker.ticks() + 100;
        if (note != null) Guardian.note(note);
    }

    public static void register() {
        Ticker.every(mc -> { noteDimension(mc); return false; });
    }
}
