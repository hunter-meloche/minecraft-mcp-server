package claudebridge;

import baritone.api.pathing.goals.GoalNear;
import baritone.api.pathing.goals.GoalRunAway;
import baritone.api.process.IBaritoneProcess;
import baritone.api.process.PathingCommand;
import baritone.api.process.PathingCommandType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.Entity;

/**
 * Defend during any Baritone job (mine, goto, build): while a hostile is close (within 4 blocks, or within 8 and it hit
 * us in the last 10 s), this higher-priority process takes control, so Baritone pauses the job instead of mining on
 * while a zombie hits the bot (it died that way), and resumes it afterwards. Melee mobs in reach: stand still and let
 * the Guardian's melee reflex swing. Further away or ranged (skeletons, pillagers): close in. Creepers: back off.
 * Off at 6 HP or less (the emergency wall-in / flee handles that), during attack-entity fights, and when auto-defend
 * is off.
 */
public final class DefendProcess implements IBaritoneProcess {
    private Entity target;
    /** after a kill: walk over its drops (spider string for a bed, bones, ...) for a few seconds before handing back */
    private net.minecraft.world.phys.Vec3 lootAt;
    private int lootTicks;

    private net.minecraft.world.entity.item.ItemEntity lootNear(LocalPlayer p) {
        if (lootAt == null) return null;
        net.minecraft.world.entity.item.ItemEntity best = null;
        for (Entity e : Minecraft.getInstance().level.entitiesForRendering()) {
            if (e instanceof net.minecraft.world.entity.item.ItemEntity it && it.isAlive() && it.position().distanceTo(lootAt) < 3
                && (best == null || it.distanceTo(p) < best.distanceTo(p))) best = it;
        }
        return best;
    }

    private static boolean recentlyHitUs(Entity e) {
        return Guardian.recentAttacker(e);
    }

    private Entity pick(LocalPlayer p) {
        Entity best = null;
        double bestD = Double.MAX_VALUE;
        for (Entity e : Minecraft.getInstance().level.entitiesForRendering()) {
            if (e == p || !e.isAlive() || !Combat.isHostile(e) || Combat.NOT_PICKED_AS_HOSTILE.contains(Names.entity(e))) continue;
            double d = e.distanceTo(p);
            if (d > 8 || !p.hasLineOfSight(e)) continue;
            if (d > 4 && !recentlyHitUs(e)) continue;
            if (d < bestD) { best = e; bestD = d; }
        }
        return best;
    }

    @Override
    public boolean isActive() {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        if (!Guardian.enabled || Combat.fighting || p == null || mc.level == null || mc.gameMode == null) { target = null; return false; }
        String mode = mc.gameMode.getPlayerMode().name();
        if (mode.equals("CREATIVE") || mode.equals("SPECTATOR") || p.getHealth() <= 6) { target = null; return false; }
        if (target != null && target.isRemoved() && (target instanceof net.minecraft.world.entity.LivingEntity le) && le.isDeadOrDying()) {
            lootAt = target.position(); lootTicks = 60;
        } else if (target != null && !target.isAlive()) { lootAt = target.position(); lootTicks = 60; }
        target = pick(p);
        if (target != null) return true;
        if (lootTicks > 0 && --lootTicks > 0 && lootNear(p) != null) return true;
        lootAt = null;
        return false;
    }

    @Override
    public PathingCommand onTick(boolean calcFailed, boolean isSafeToCancel) {
        LocalPlayer p = Minecraft.getInstance().player;
        if (target == null && p != null) {
            var item = lootNear(p);
            if (item != null) return new PathingCommand(new baritone.api.pathing.goals.GoalBlock(item.blockPosition()), PathingCommandType.SET_GOAL_AND_PATH);
        }
        if (target == null || p == null) return new PathingCommand(null, PathingCommandType.REQUEST_PAUSE);
        String name = Names.entity(target);
        if (name.equals("creeper")) {
            return new PathingCommand(new GoalRunAway(7, target.blockPosition()), PathingCommandType.SET_GOAL_AND_PATH);
        }
        Combat.holdWeapon();
        if (target.distanceTo(p) <= 2.8 && !calcFailed) {
            // in reach: hold still; the melee reflex swings when the attack meter is full
            return new PathingCommand(null, PathingCommandType.REQUEST_PAUSE);
        }
        return new PathingCommand(new GoalNear(target.blockPosition(), 1), PathingCommandType.SET_GOAL_AND_PATH);
    }

    @Override public boolean isTemporary() { return true; }
    @Override public void onLostControl() { target = null; }
    @Override public double priority() { return 100; }
    @Override public String displayName0() { return target == null ? (lootAt != null ? "Defend: picking up drops" : "Defend") : "Defend against " + Names.entity(target); }
}
