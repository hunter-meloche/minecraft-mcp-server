package claudebridge;

import baritone.api.pathing.goals.GoalRunAway;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

import static claudebridge.Json.*;

/**
 * Reflexes that run beside whatever else the bot does, every tick (ported from src/auto-defend.ts and src/bunker.ts):
 * hazard escape (out of air under water, in lava), emergency cover at low health under attack, a melee reflex on
 * hostiles in reach, a shield guard while idle, and a gear check. Notes go to Node as "guardian" events.
 */
public final class Guardian {
    private Guardian() { }

    static volatile boolean enabled = true;
    private static boolean busy;          // wall-in / eating / fleeing in progress
    private static boolean shieldRaised;  // by the shield guard
    private static String escaping;       // "water" | "lava" | null
    private static long lastHurtTick = -1000;
    private static final Map<Integer, Long> attackers = new HashMap<>(); // entity id -> tick it last hurt us
    private static final Map<String, Long> recentNotes = new HashMap<>();

    static void note(String text) {
        long now = Ticker.ticks();
        Long last = recentNotes.get(text);
        if (last != null && now - last < 600) return; // same note within 30 s: once
        recentNotes.put(text, now);
        ClaudeBridge.server.emit("guardian", obj("note", text));
    }

    /** Fed by Events.onDamage when the bot itself is hurt. */
    static void onSelfHurt(int causeId) {
        lastHurtTick = Ticker.ticks();
        if (causeId >= 0) attackers.put(causeId, Ticker.ticks());
    }

    // ---------------------------------------------------------------- per tick

    static void tick(Minecraft mc) {
        LocalPlayer p = mc.player;
        if (!enabled || p == null || mc.level == null || mc.gameMode == null) return;
        String mode = mc.gameMode.getPlayerMode().name();
        if (mode.equals("CREATIVE") || mode.equals("SPECTATOR")) return;
        hazards(mc, p);
        if (Combat.fighting || busy || Interact.using) return;
        waterFooting(mc, p);

        // emergency: low and still being hurt -> wall in (or run) and eat
        // (checks for a standing shelter, not where one was: the lab found a bot back in its old cell with the
        // shelter gone, and the reflex did nothing)
        if (p.getHealth() <= 6 && Ticker.ticks() - lastHurtTick < 60 && !sheltered(mc, p.blockPosition())) {
            busy = true;
            shieldGuardDown();
            float h = p.getHealth();
            takeCover(result -> {
                busy = false;
                note("health " + round(h) + " and under attack: " + result);
            });
            return;
        }

        Entity melee = meleeTarget(p);
        if (melee != null && p.getAttackStrengthScale(0.5f) >= 0.95f) {
            shieldGuardDown();
            if (!mc.gameMode.isDestroying()) Combat.holdWeapon();
            Combat.attack(p, melee);
            note("auto-defend hit " + Names.entity(melee));
        } else {
            shieldGuard(mc, p, melee);
        }
        if (Ticker.ticks() % 40 == 0 && mc.gui.screen() == null && !mc.gameMode.isDestroying()) {
            List<String> put = new ArrayList<>(Combat.equipBestArmor());
            if (Combat.equipShield() && !shieldWorn) { put.add("shield"); }
            shieldWorn = Combat.hasShield();
            if (!put.isEmpty()) note("put on " + String.join(", ", put));
            List<String> tools = Tools.keepInHotbar(p);
            if (!tools.isEmpty()) note("moved " + String.join(", ", tools) + " to the hotbar (auto-tool picks from there)");
            keepFed(p, melee);
        }
    }

    private static boolean shieldWorn;
    private static final java.util.Set<String> RAW = java.util.Set.of("cod", "salmon", "beef", "porkchop", "chicken", "mutton", "rabbit", "potato");
    private static boolean eating;

    /**
     * Eat when it matters: hurt with food below 18 means no healing at all (the bot sat at 3 HP for minutes with food
     * 17), and food at 6 or less means no sprinting. And top up whenever the bar has room for the food without waste:
     * waiting for 6 left the bot standing about at food 8 with bread in its pocket, one bad fight from no healing.
     * A Baritone job is paused for it only when hurt or below 15.
     */
    private static void keepFed(LocalPlayer p, Entity melee) {
        int food = p.getFoodData().getFoodLevel();
        boolean hurt = p.getHealth() < p.getMaxHealth() - 1;
        if (eating || Interact.using || Interact.handsBusy || melee != null) return;
        // during a Baritone job only when it matters (hurt): the job is paused for the bite (EatPause)
        boolean job = Processes.active() != null && !"Eating".equals(Processes.active());
        String choice = Combat.chooseFood(false);
        if (choice == null) return;
        boolean room = food <= 20 - Combat.nutrition(choice);
        if (job ? !(hurt && food < 18) && food > 14 : !((hurt && food < 18) || food <= 6 || room)) return;
        // raw meat and fish give a third of what cooked does: keep them for the furnace unless really hungry
        if (food > 6 && RAW.contains(choice)) return;
        eating = true;
        if (job) EatPause.eating = true;
        // give Baritone a tick to pause before taking the hand
        Ticker.add(new Ticker.Task() {
            int w = job ? 3 : 1;
            @Override public boolean tick(Minecraft m) {
                if (--w > 0) return false;
                eatThen("", r -> { eating = false; EatPause.eating = false; note((hurt ? "ate to heal: " : food <= 6 ? "ate (hungry): " : "ate (topping up): ") + r); });
                return true;
            }
        });
    }

    static boolean recentAttacker(Entity e) {
        Long t = attackers.get(e.getId());
        return t != null && Ticker.ticks() - t < 200;
    }

    static Entity meleeTarget(LocalPlayer p) {
        Entity best = null;
        for (Entity e : Minecraft.getInstance().level.entitiesForRendering()) {
            if (e == p || !e.isAlive() || e.distanceTo(p) > 3.2 || !p.hasLineOfSight(e)) continue;
            boolean hostile = Combat.isHostile(e) && !Combat.NOT_PICKED_AS_HOSTILE.contains(Names.entity(e));
            if (!hostile && !(recentAttacker(e) && !(e instanceof Player))) continue;
            if (best == null || e.distanceTo(p) < best.distanceTo(p)) best = e;
        }
        return best;
    }

    static void shieldGuard(Minecraft mc, LocalPlayer p, Entity melee) {
        boolean idle = Processes.active() == null && !mc.gameMode.isDestroying();
        Entity threat = melee;
        if (threat == null) {
            for (Entity e : mc.level.entitiesForRendering()) {
                if (e == p || !e.isAlive() || !recentAttacker(e) || Ticker.ticks() - attackers.get(e.getId()) > 120) continue;
                double d = e.distanceTo(p);
                if (d > 3.2 && d <= 24 && (threat == null || d < threat.distanceTo(p))) threat = e;
            }
        }
        if (!Combat.hasShield() || !idle || threat == null) { shieldGuardDown(); return; }
        p.lookAt(EntityAnchorArgument.Anchor.EYES, threat.getEyePosition());
        if (!shieldRaised) note("raised shield against " + Names.entity(threat));
        Combat.shieldUp();
        shieldRaised = true;
    }

    static void shieldGuardDown() {
        if (shieldRaised) Combat.shieldDown();
        shieldRaised = false;
    }

    static void hazards(Minecraft mc, LocalPlayer p) {
        String hazard = null;
        int air = Math.max(0, p.getAirSupply()) * 20 / Math.max(1, p.getMaxAirSupply());
        if (p.isInLava()) hazard = "lava";
        else if (p.isUnderWater() && (air <= surfaceAt(mc, p) || "water".equals(escaping))) hazard = p.getAirSupply() >= p.getMaxAirSupply() && !p.isUnderWater() ? null : "water";
        if (hazard != null && !hazard.equals(escaping)) {
            mc.options.keyJump.setDown(true);
            note(hazard.equals("water") ? "out of air under water (" + air + "/20): swimming up" : "in lava: jumping out");
        } else if (hazard == null && escaping != null) {
            mc.options.keyJump.setDown(false);
            mc.options.keyUp.setDown(false);
            mc.options.keySprint.setDown(false);
        }
        if ("lava".equals(hazard)) {
            // jumping alone doesn't climb out of a pit (seen in the lab): head for the nearest dry ground too
            BlockPos dry = nearestDryGround(mc, p, 4);
            if (dry != null) {
                Vec3 c = Vec3.atBottomCenterOf(dry);
                p.lookAt(EntityAnchorArgument.Anchor.EYES, new Vec3(c.x, p.getEyeY(), c.z));
                mc.options.keyUp.setDown(true);
                mc.options.keySprint.setDown(true);
            }
        }
        escaping = hazard;
    }

    /**
     * Air (of 20) at which to head up: enough to swim through the water overhead (about 2 blocks a second) with 2 s
     * to spare. A flat 12 of 20 brought the bot up after 5 s under a 3-deep pond, before it could break the block it
     * dove for, over and over.
     */
    static int surfaceAt(Minecraft mc, LocalPlayer p) {
        BlockPos at = BlockPos.containing(p.getEyePosition());
        int depth = 0;
        while (depth < 24 && !mc.level.getFluidState(at.above(depth)).isEmpty()) depth++;
        double seconds = depth / 2.0 + 2;
        return Math.max(4, Math.min(14, (int) Math.ceil(seconds * 20 / 15)));
    }

    /** The closest cell a player can stand in (solid below, two free non-liquid cells) that isn't lava, or null. */
    static BlockPos nearestDryGround(Minecraft mc, LocalPlayer p, int radius) {
        BlockPos feet = p.blockPosition();
        BlockPos best = null;
        double bestD = Double.MAX_VALUE;
        for (int dx = -radius; dx <= radius; dx++) for (int dz = -radius; dz <= radius; dz++) for (int dy = -1; dy <= 2; dy++) {
            BlockPos c = feet.offset(dx, dy, dz);
            var below = mc.level.getBlockState(c.below());
            var at = mc.level.getBlockState(c);
            var head = mc.level.getBlockState(c.above());
            if (below.isAir() || !below.getFluidState().isEmpty() || Interact.replaceable(below)) continue;
            if (!at.getFluidState().isEmpty() || !head.getFluidState().isEmpty()) continue;
            if (!Interact.replaceable(at) || !Interact.replaceable(head)) continue;
            double d = Vec3.atBottomCenterOf(c).distanceTo(p.position());
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    // ---------------------------------------------------------------- cover

    private static final String[] COVER = {"dirt", "cobblestone", "cobbled_deepslate", "netherrack", "andesite", "diorite", "granite", "tuff",
        "stone", "deepslate", "coarse_dirt", "rooted_dirt", "blackstone", "basalt", "end_stone", "mud_bricks", "packed_mud"};

    static String coverBlock() {
        Inventory inv = Minecraft.getInstance().player.getInventory();
        for (String name : COVER) { int i = Interact.find(inv, name); if (i >= 0 && i < 36 && Names.item(inv.getItem(i)).equals(name)) return name; }
        for (int i = 0; i < 36; i++) { ItemStack s = inv.getItem(i); if (!s.isEmpty() && Names.item(s).endsWith("_planks")) return Names.item(s); }
        return null;
    }

    static int coverCount() {
        Inventory inv = Minecraft.getInstance().player.getInventory();
        int n = 0;
        for (int i = 0; i < 36; i++) {
            ItemStack s = inv.getItem(i);
            if (s.isEmpty()) continue;
            String name = Names.item(s);
            if (name.endsWith("_planks") || java.util.Arrays.asList(COVER).contains(name)) n += s.getCount();
        }
        return n;
    }

    /** Place one cover block at {@code cell} if there is something to place it against; true when the cell ends up solid. */
    static boolean placeCover(BlockPos cell) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        if (!Interact.replaceable(mc.level.getBlockState(cell))) return true;
        String block = coverBlock();
        if (block == null) return false;
        Interact.select(block);
        for (Direction toRef : new Direction[]{Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP}) {
            BlockPos ref = cell.relative(toRef);
            var rs = mc.level.getBlockState(ref);
            if (Interact.replaceable(rs) || Interact.isActivatable(Names.block(rs))) continue;
            Direction face = toRef.getOpposite();
            Vec3 hit = Interact.faceCenter(ref, face);
            p.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hit, face, ref, false));
            if (!Interact.replaceable(mc.level.getBlockState(cell))) return true;
        }
        return false;
    }

    private static int floatingBreak;

    /**
     * Mining while afloat is hopeless: a block breaks 5 times slower in water and 5 times slower again off the ground,
     * and the bobbing carries the bot out of reach mid-block, so Baritone keeps starting on another one (the user saw
     * it switch blocks over and over while it swam; a 6-minute coal trip came back with nothing). After half a second
     * of breaking afloat, put a block under its feet: standing, it mines at water speed and stays put.
     */
    private static void waterFooting(Minecraft mc, LocalPlayer p) {
        // counted over a window, not in a row: Baritone lets go of the block for a tick now and then while it re-aims
        if (!p.isInWater() || p.onGround() || !mc.gameMode.isDestroying()) { floatingBreak = Math.max(0, floatingBreak - 1); return; }
        if ((floatingBreak += 2) < 20) return;
        floatingBreak = 0;
        BlockPos below = p.blockPosition().below();
        // not the block it is digging (down through the floor)
        if (mc.hitResult instanceof BlockHitResult hit && hit.getBlockPos().equals(below)) return;
        if (!Interact.replaceable(mc.level.getBlockState(below))) return; // floor there already: just bobbing above it
        if (placeCover(below)) note("put a block under its feet to mine from (breaking while afloat in water)");
    }

    static final Direction[] SIDES = {Direction.EAST, Direction.WEST, Direction.SOUTH, Direction.NORTH};

    /**
     * Close the bot in: step to the middle of its cell (its body at an edge blocks wall placement), then blocks on four
     * sides at feet and head height, a support on top of one side, and the roof. One placement per tick.
     */
    /** The cells the last wall-in filled (and where the bot stood), so the brain can dig its way out again by day. */
    static final List<BlockPos> WALL = new ArrayList<>();
    static BlockPos wallFeet;

    /**
     * Boxed in where it stands (four sides at feet and head height and a roof): the cells to dig to get out, the wall
     * it built if it built this one, else none (the brain picks the way out). Null when not boxed in.
     */
    static JsonArray boxedIn(Minecraft m) {
        LocalPlayer p = m.player;
        if (p == null || m.level == null) return null;
        BlockPos feet = p.blockPosition();
        if (!sheltered(m, feet)) return null;
        JsonArray cells = new JsonArray();
        if (feet.equals(wallFeet)) for (BlockPos c : WALL) if (!Interact.replaceable(m.level.getBlockState(c))) cells.add(pos(c));
        return cells;
    }

    static void wallIn(Consumer<JsonObject> done) {
        Processes.baritone().getPathingBehavior().cancelEverything();
        WALL.clear();
        wallFeet = null;
        Ticker.add(new Ticker.Task() {
            int age = 0, step = 0, placed = 0, solid = 0;
            BlockPos feet;
            final List<BlockPos> cells = new ArrayList<>();
            final JsonArray gaps = new JsonArray();

            @Override
            public boolean tick(Minecraft m) {
                LocalPlayer p = m.player;
                age++;
                if (feet == null) {
                    Vec3 c = Vec3.atBottomCenterOf(p.blockPosition());
                    double off = Math.hypot(c.x - p.getX(), c.z - p.getZ());
                    if (off > 0.12 && age < 30) {
                        p.lookAt(EntityAnchorArgument.Anchor.EYES, new Vec3(c.x, p.getEyeY(), c.z));
                        m.options.keyUp.setDown(age % 2 == 1); // short steps so it doesn't overshoot
                        return false;
                    }
                    m.options.keyUp.setDown(false);
                    if (age < 35 && !p.onGround()) return false; // let it land if it stepped into a hole
                    feet = p.blockPosition();
                    wallFeet = feet;
                    for (Direction d : SIDES) cells.add(feet.relative(d));
                    for (Direction d : SIDES) cells.add(feet.relative(d).above());
                    return false;
                }
                if (step < cells.size()) {
                    BlockPos cell = cells.get(step++);
                    boolean was = !Interact.replaceable(m.level.getBlockState(cell));
                    if (!was && !hasReference(m, cell) && Interact.replaceable(m.level.getBlockState(cell.below())) && placeCover(cell.below())) WALL.add(cell.below()); // nothing to place against: support it
                    if (was) solid++;
                    else if (placeCover(cell)) { placed++; WALL.add(cell); }
                    else gaps.add(pos(cell));
                    return false;
                }
                BlockPos roof = feet.above(2);
                if (Interact.replaceable(m.level.getBlockState(roof))) {
                    boolean neighbour = false;
                    for (Direction d : SIDES) if (!Interact.replaceable(m.level.getBlockState(roof.relative(d))) && !Interact.isActivatable(Names.block(m.level.getBlockState(roof.relative(d))))) neighbour = true;
                    if (!neighbour) for (Direction d : SIDES) if (!Interact.replaceable(m.level.getBlockState(feet.relative(d).above())) && placeCover(roof.relative(d))) { placed++; WALL.add(roof.relative(d)); break; }
                    if (placeCover(roof)) { placed++; WALL.add(roof); } else gaps.add(pos(roof));
                } else solid++;
                done.accept(obj("at", pos(feet), "placed", placed, "alreadySolid", solid, "gaps", gaps));
                return true;
            }
        });
    }

    /** Is the bot already closed in at {@code feet}: four sides at feet and head height and a roof? */
    static boolean sheltered(Minecraft m, BlockPos feet) {
        for (Direction d : SIDES) {
            if (Interact.replaceable(m.level.getBlockState(feet.relative(d))) || Interact.replaceable(m.level.getBlockState(feet.relative(d).above()))) return false;
        }
        return !Interact.replaceable(m.level.getBlockState(feet.above(2)));
    }

    static boolean hasReference(Minecraft m, BlockPos cell) {
        for (Direction d : Direction.values()) {
            var s = m.level.getBlockState(cell.relative(d));
            if (!Interact.replaceable(s) && !Interact.isActivatable(Names.block(s))) return true;
        }
        return false;
    }

    static String describeShelter(JsonObject r) {
        JsonObject at = r.getAsJsonObject("at");
        String where = "(" + at.get("x").getAsInt() + ", " + at.get("y").getAsInt() + ", " + at.get("z").getAsInt() + ")";
        JsonArray gaps = r.getAsJsonArray("gaps");
        if (gaps.isEmpty()) return "walled in at " + where + " (" + r.get("placed").getAsInt() + " block(s) placed)";
        return "walled in at " + where + " with " + gaps.size() + " gap(s) left (" + r.get("placed").getAsInt() + " placed)";
    }

    /** Low health: wall in when there are blocks for it, otherwise run from the threats; then eat. */
    static void takeCover(Consumer<String> done) {
        Combat.shieldDown();
        if (coverCount() >= 5) {
            wallIn(r -> eatThen(describeShelter(r), done));
            return;
        }
        List<Entity> threats = Combat.hostilesNear(16);
        if (threats.isEmpty()) { eatThen("", done); return; }
        BlockPos[] from = threats.stream().map(Entity::blockPosition).toArray(BlockPos[]::new);
        Processes.baritone().getCustomGoalProcess().setGoalAndPath(new GoalRunAway(14, from));
        String first = Names.entity(threats.get(0));
        Ticker.add(new Ticker.Task() {
            int age = 0;
            @Override public boolean tick(Minecraft m) {
                if (++age < 160 && !Combat.hostilesNear(10).isEmpty()) return false;
                Processes.baritone().getPathingBehavior().cancelEverything();
                int still = Combat.hostilesNear(10).size();
                eatThen(still > 0 ? "fled but " + still + " hostile(s) still close" : "fled from " + first, done);
                return true;
            }
        });
    }

    /** Eat the best food there is (rotten flesh when desperate), then report. */
    static void eatThen(String before, Consumer<String> done) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        String food = p.getFoodData().getFoodLevel() >= 20 ? null : Combat.chooseFood(p.getHealth() <= 10);
        if (food == null) {
            done.accept(before.isEmpty() ? (p.getFoodData().getFoodLevel() >= 20 ? "not hungry" : "no safe food to eat") : before + (p.getFoodData().getFoodLevel() >= 20 ? "" : ", no safe food to eat"));
            return;
        }
        int foodBefore = p.getFoodData().getFoodLevel();
        Interact.select(food);
        Interact.using = true;
        mc.gameMode.useItem(p, InteractionHand.MAIN_HAND);
        mc.options.keyUse.setDown(true);
        Ticker.add(new Ticker.Task() {
            int age = 0, settle = -1;
            boolean started;
            @Override public boolean tick(Minecraft m) {
                age++;
                if (settle < 0) {
                    if (m.player.isUsingItem()) started = true;
                    if (!(started && !m.player.isUsingItem()) && age < 80) return false;
                    m.options.keyUse.setDown(false);
                    Interact.using = false;
                    settle = 6; // the server's food update arrives a few ticks after the bite
                    return false;
                }
                if (--settle > 0 && m.player.getFoodData().getFoodLevel() <= foodBefore) return false;
                // say "ate" only when food went up: interrupted bites (item swapped, swimming) were reported as eaten
                boolean ate = m.player.getFoodData().getFoodLevel() > foodBefore;
                done.accept((before.isEmpty() ? "" : before + ", ") + (ate ? "ate " + food : "tried to eat " + food + " but was interrupted"));
                return true;
            }
        });
    }

    public static void register(BridgeServer s) {
        Ticker.every(mc -> { tick(mc); return false; });
        s.register("guardian.set", true, (p, c) -> {
            enabled = p.get("enabled").getAsBoolean();
            if (!enabled) { shieldGuardDown(); Minecraft.getInstance().options.keyJump.setDown(false); escaping = null; }
            return obj("enabled", enabled);
        });
        s.register("guardian.status", true, (p, c) -> {
            LocalPlayer pl = Handlers.player();
            List<String> armor = new ArrayList<>();
            for (int i = 39; i >= 36; i--) { ItemStack st = pl.getInventory().getItem(i); if (!st.isEmpty()) armor.add(Names.item(st)); }
            if (!pl.getOffhandItem().isEmpty()) armor.add(Names.item(pl.getOffhandItem()));
            return obj("enabled", enabled, "armor", armor);
        });
        s.register("wallin", true, (p, c) -> {
            if (coverCount() == 0) return obj("error", "no blocks to wall in with");
            busy = true;
            wallIn(r -> { busy = false; c.ok(r); });
            return BridgeServer.LATER;
        });
    }
}
