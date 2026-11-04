package claudebridge;

import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalRunAway;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static claudebridge.Json.*;

/** Fighting, ported from the Node backend's src/combat.ts, run on the game tick. */
public final class Combat {
    private Combat() { }

    /** Not picked by 'hostile' (neutral until provoked, or not winnable with early gear); still attackable by name. */
    static final Set<String> NOT_PICKED_AS_HOSTILE = Set.of("enderman", "piglin", "zombified_piglin", "warden", "creaking", "wither",
        "ender_dragon", "elder_guardian", "giant");
    /** Mobs that hurt from a distance: worth raising a shield against. */
    static final Set<String> RANGED = Set.of("skeleton", "stray", "bogged", "parched", "pillager", "blaze", "ghast", "witch", "breeze",
        "shulker", "drowned");
    /** Food not to eat unless asked (harmful or precious). */
    static final Set<String> AVOID_FOOD = Set.of("rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "suspicious_stew",
        "chorus_fruit", "golden_apple", "enchanted_golden_apple", "golden_carrot");

    /** Bot is in a fight started by attack-entity: the Guardian reflexes stay out of it. */
    static volatile boolean fighting;

    static boolean isHostile(Entity e) {
        return e instanceof Enemy;
    }

    static boolean matches(Entity e, String query, LocalPlayer self) {
        if (e == self || !e.isAlive()) return false;
        String name = Names.entity(e);
        return switch (query) {
            case "hostile" -> isHostile(e) && !NOT_PICKED_AS_HOSTILE.contains(name);
            case "mob" -> e instanceof Mob;
            case "player" -> e instanceof Player;
            default -> !(e instanceof Player) && e instanceof LivingEntity && name.equals(query);
        };
    }

    static List<Entity> hostilesNear(double range) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        List<Entity> out = new ArrayList<>();
        for (Entity e : mc.level.entitiesForRendering()) if (e != p && e.isAlive() && isHostile(e) && e.distanceTo(p) <= range) out.add(e);
        out.sort(Comparator.comparingDouble(e -> e.distanceTo(p)));
        return out;
    }

    static String threatsText(double range) {
        LocalPlayer p = Minecraft.getInstance().player;
        List<String> t = new ArrayList<>();
        for (Entity e : hostilesNear(range)) t.add(Names.entity(e) + " " + Math.round(e.distanceTo(p)) + " blocks away");
        return String.join(", ", t);
    }

    // ---------------------------------------------------------------- gear

    private static final Map<String, Integer> TIER = Map.of("wooden", 0, "golden", 0, "stone", 1, "copper", 1, "iron", 2, "diamond", 3, "netherite", 4);
    private static final Map<String, Integer> WEAPON_KIND = Map.of("sword", 10, "axe", 8, "pickaxe", 4, "shovel", 3);
    private static final Pattern WEAPON = Pattern.compile("^([a-z]+)_(sword|axe|pickaxe|shovel)$");
    private static final Map<String, Integer> ARMOR_TIER = Map.of("leather", 1, "golden", 2, "copper", 2, "chainmail", 3, "iron", 4, "turtle", 4,
        "diamond", 5, "netherite", 6);
    private static final Pattern ARMOR = Pattern.compile("^([a-z]+)_(helmet|chestplate|leggings|boots)$");
    /** Inventory index of each armor piece's slot. */
    private static final Map<String, Integer> ARMOR_SLOT = Map.of("boots", 36, "leggings", 37, "chestplate", 38, "helmet", 39);

    static int weaponScore(String name) {
        Matcher m = WEAPON.matcher(name);
        if (!m.matches() || !TIER.containsKey(m.group(1))) return -1;
        return WEAPON_KIND.get(m.group(2)) + TIER.get(m.group(1));
    }

    /** Hold the best weapon carried (unless digging); fist when there is none. */
    static void holdWeapon() {
        Inventory inv = Minecraft.getInstance().player.getInventory();
        int best = -1, bestScore = -1;
        for (int i = 0; i < 36; i++) {
            ItemStack s = inv.getItem(i);
            if (s.isEmpty()) continue;
            int score = weaponScore(Names.item(s));
            if (score > bestScore) { best = i; bestScore = score; }
        }
        if (best >= 0 && best != inv.getSelectedSlot()) Interact.select(Names.item(inv.getItem(best)));
    }

    static int armorScore(ItemStack s) {
        if (s.isEmpty()) return 0;
        Matcher m = ARMOR.matcher(Names.item(s));
        return m.matches() && ARMOR_TIER.containsKey(m.group(1)) ? ARMOR_TIER.get(m.group(1)) : 0;
    }

    /** Wear the best armor carried, piece by piece; returns what was put on. */
    static List<String> equipBestArmor() {
        LocalPlayer p = Minecraft.getInstance().player;
        Inventory inv = p.getInventory();
        List<String> put = new ArrayList<>();
        for (var slot : ARMOR_SLOT.entrySet()) {
            int wornScore = armorScore(inv.getItem(slot.getValue()));
            int best = -1, bestScore = wornScore;
            for (int i = 0; i < 36; i++) {
                ItemStack s = inv.getItem(i);
                Matcher m = ARMOR.matcher(s.isEmpty() ? "" : Names.item(s));
                if (m.matches() && m.group(2).equals(slot.getKey()) && armorScore(s) > bestScore) { best = i; bestScore = armorScore(s); }
            }
            if (best < 0) continue;
            if (p.containerMenu != p.inventoryMenu) p.closeContainer();
            String name = Names.item(inv.getItem(best));
            int from = Interact.inventoryMenuSlot(best), to = Interact.inventoryMenuSlot(slot.getValue());
            Interact.click(p.inventoryMenu, from, 0, ContainerInput.PICKUP); // carry the new piece
            Interact.click(p.inventoryMenu, to, 0, ContainerInput.PICKUP);   // swap it with what is worn
            if (!p.inventoryMenu.getCarried().isEmpty()) Interact.click(p.inventoryMenu, from, 0, ContainerInput.PICKUP); // old piece back
            put.add(name);
        }
        return put;
    }

    /** Put a shield in an empty off-hand, if one is carried. */
    static boolean equipShield() {
        LocalPlayer p = Minecraft.getInstance().player;
        if (Names.item(p.getOffhandItem()).equals("shield") && !p.getOffhandItem().isEmpty()) return true;
        if (!p.getOffhandItem().isEmpty()) return false;
        int i = Interact.find(p.getInventory(), "shield");
        if (i < 0 || i > 35) return false;
        if (p.containerMenu != p.inventoryMenu) p.closeContainer();
        Interact.click(p.inventoryMenu, Interact.inventoryMenuSlot(i), 40, ContainerInput.SWAP);
        return true;
    }

    static boolean hasShield() {
        ItemStack off = Minecraft.getInstance().player.getOffhandItem();
        return !off.isEmpty() && Names.item(off).equals("shield");
    }

    static void shieldUp() {
        Minecraft mc = Minecraft.getInstance();
        mc.options.keyUse.setDown(true);
        if (!mc.player.isUsingItem()) mc.gameMode.useItem(mc.player, InteractionHand.OFF_HAND);
    }

    static void shieldDown() {
        Minecraft mc = Minecraft.getInstance();
        mc.options.keyUse.setDown(false);
        if (mc.player.isUsingItem()) mc.gameMode.releaseUsingItem(mc.player);
    }

    /** Best safe food carried (rotten flesh allowed at low health), or null. */
    static String chooseFood(boolean desperate) {
        Inventory inv = Minecraft.getInstance().player.getInventory();
        String best = null;
        float bestScore = -1;
        for (int i = 0; i < 36; i++) {
            ItemStack s = inv.getItem(i);
            var food = s.isEmpty() ? null : s.get(DataComponents.FOOD);
            if (food == null) continue;
            String name = Names.item(s);
            if (AVOID_FOOD.contains(name) && !(desperate && name.equals("rotten_flesh"))) continue;
            float score = food.nutrition() + food.saturation();
            if (score > bestScore) { best = name; bestScore = score; }
        }
        return best;
    }

    static void attack(LocalPlayer p, Entity e) {
        Minecraft mc = Minecraft.getInstance();
        p.lookAt(EntityAnchorArgument.Anchor.EYES, e.position().add(0, e.getBbHeight() * 0.8, 0));
        mc.gameMode.attack(p, e);
    }

    // ---------------------------------------------------------------- landed hits (fed by Events.onDamage)

    static volatile int victimId = -1;
    static volatile int landed;

    static void onDamage(int entityId, int causeId) {
        LocalPlayer p = Minecraft.getInstance().player;
        if (p != null && entityId == victimId && causeId == p.getId()) landed++;
    }

    // ---------------------------------------------------------------- the fight

    /**
     * attack-entity: chase and hit until the target dies; 'hostile' keeps going with the next monster while health
     * allows. Stops at low health (4 HP earlier when outnumbered) and takes cover. Replies with kills, swings, landed
     * hits, what vanished without dying (creeper blasts), what was out of reach, and the threats still around.
     */
    static void fight(BridgeServer.Call c, String query, double maxDistance, int timeoutTicks, float minHealth, boolean retreat) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer self = mc.player;
        Entity first = pick(query, maxDistance, Set.of());
        if (first == null) { c.ok(obj("outcome", "none")); return; }
        fighting = true;
        List<String> wore = equipBestArmor();
        boolean shield = equipShield();
        boolean multiple = query.equals("hostile");
        victimId = first.getId();
        landed = 0;
        Ticker.add(new Ticker.Task() {
            Entity victim = first;
            final java.util.HashSet<Integer> skip = new java.util.HashSet<>();
            final List<String> kills = new ArrayList<>(), vanished = new ArrayList<>(), unreachable = new ArrayList<>();
            final Map<String, Integer> swungWith = new LinkedHashMap<>();
            int age = 0, hits = 0, backOff = 0, chasedAt = -100, closestAt = 0;
            double closest = Double.MAX_VALUE;
            boolean died = false;
            BlockPos lastPos = first.blockPosition();

            @Override
            public boolean tick(Minecraft m) {
                age++;
                LocalPlayer p = m.player;
                if (p == null) return end("none");
                if (victim instanceof LivingEntity le && le.isDeadOrDying()) died = true;
                if (!victim.isAlive() || victim.isRemoved()) {
                    (died ? kills : vanished).add(Names.entity(victim) + (died ? "" : Names.entity(victim).equals("creeper") ? " (exploded)" : " (despawned)"));
                    lastPos = victim.blockPosition();
                    Entity next = multiple && p.getHealth() >= Math.max(12, minHealth + 6) ? pick(query, maxDistance, skip) : null;
                    if (next == null) return end("done");
                    newTarget(next);
                    return false;
                }
                float stopAt = hostilesNear(12).size() >= 2 ? minHealth + 4 : minHealth;
                if (p.getHealth() <= stopAt) return end("low_health");
                if (age > timeoutTicks) return end("timeout");
                double d = p.distanceTo(victim);
                if (d < closest - 1) { closest = d; closestAt = age; }
                if (age - closestAt > 240) { // not getting closer for 12 s
                    unreachable.add(Names.entity(victim));
                    skip.add(victim.getId());
                    Entity next = multiple ? pick(query, maxDistance, skip) : null;
                    if (next == null) return end(kills.isEmpty() ? "unreachable" : "done");
                    newTarget(next);
                    return false;
                }
                if (backOff > 0) { backOff--; if (shield) { p.lookAt(EntityAnchorArgument.Anchor.EYES, victim.getEyePosition()); shieldUp(); } return false; }

                boolean inReach = d <= 3.2 && p.hasLineOfSight(victim);
                if (!inReach) {
                    shieldDown();
                    if (age - chasedAt >= 10) { Processes.baritone().getCustomGoalProcess().setGoalAndPath(new GoalNear(victim.blockPosition(), 2)); chasedAt = age; }
                    return false;
                }
                if (Processes.active() != null) Processes.baritone().getPathingBehavior().cancelEverything();
                if (p.getAttackStrengthScale(0.5f) < 0.95f) {
                    // between swings: block what's coming if there's a shield
                    if (shield && (RANGED.contains(Names.entity(victim)) || Names.entity(victim).equals("creeper"))) { p.lookAt(EntityAnchorArgument.Anchor.EYES, victim.getEyePosition()); shieldUp(); }
                    return false;
                }
                shieldDown();
                holdWeapon();
                String held = p.getMainHandItem().isEmpty() ? "fist" : Names.item(p.getMainHandItem());
                attack(p, victim);
                hits++;
                swungWith.merge(held, 1, Integer::sum);
                closestAt = age; // swinging in reach is progress
                if (Names.entity(victim).equals("creeper")) {
                    // its fuse keeps burning within 7 blocks: get out to 8 behind the shield until the next swing
                    Processes.baritone().getCustomGoalProcess().setGoalAndPath(new GoalRunAway(8, victim.blockPosition()));
                    backOff = 25;
                }
                return false;
            }

            void newTarget(Entity next) {
                victim = next;
                victimId = next.getId();
                closest = Double.MAX_VALUE;
                closestAt = age;
                chasedAt = -100;
                died = false;
            }

            boolean end(String outcome) {
                shieldDown();
                Processes.baritone().getPathingBehavior().cancelEverything();
                fighting = false;
                victimId = -1;
                JsonObject r = obj("outcome", outcome, "kills", kills, "vanished", vanished, "unreachable", unreachable, "hits", hits,
                    "landed", landed, "swungWith", swungWith, "seconds", round(age / 20.0), "wore", wore, "target", Names.entity(victim),
                    "dropsAt", pos(lastPos));
                if (outcome.equals("low_health") && retreat) {
                    Guardian.takeCover(note -> {
                        r.addProperty("retreat", note);
                        r.addProperty("threats", threatsText(16));
                        r.addProperty("health", round(Minecraft.getInstance().player.getHealth()));
                        c.ok(r);
                    });
                } else {
                    r.addProperty("threats", threatsText(16));
                    r.addProperty("health", round(Minecraft.getInstance().player.getHealth()));
                    c.ok(r);
                }
                return true;
            }
        });
    }

    static Entity pick(String query, double maxDistance, Set<Integer> skip) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        Entity best = null;
        for (Entity e : mc.level.entitiesForRendering()) {
            if (skip.contains(e.getId()) || !matches(e, query, p) || e.distanceTo(p) > maxDistance) continue;
            if (best == null || e.distanceTo(p) < best.distanceTo(p)) best = e;
        }
        return best;
    }

    public static void register(BridgeServer s) {
        s.register("fight", true, (p, c) -> {
            if (fighting) throw new IllegalStateException("already fighting");
            fight(c, required(p, "target").toLowerCase().replace("minecraft:", ""), numParam(p, "maxDistance", 16),
                intParam(p, "timeoutMs", 30_000) / 50, (float) numParam(p, "minHealth", 6), !p.has("retreat") || p.get("retreat").getAsBoolean());
            return BridgeServer.LATER;
        });
    }
}
