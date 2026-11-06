package claudebridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import static claudebridge.Json.obj;

/**
 * Shut the gates and doors the bot opens, behind it. Baritone opens a fence gate or door to walk through and leaves
 * it open, which lets mobs into the fenced yard all day (the shelter only swept them shut at dusk). A gate or door
 * that opens while the bot is right next to it is taken as the bot's; once the bot is clear of it (and still within
 * reach) it is clicked shut, the way a player would. Doors a pressure plate holds open are left to the plate.
 * Paused while the brain needs a gate open (leading an animal into a pen).
 */
public final class Gates {
    private Gates() { }

    private static boolean enabled = true;
    /** Open states seen last tick, around the bot. */
    private static final Map<Long, Boolean> seen = new HashMap<>();
    /** The bot's open gates and doors (lower halves), with the tick they opened. */
    private static final Map<Long, Long> opened = new HashMap<>();
    private static final int R = 3;
    /** where the bot stood last tick, and for how many ticks */
    private static BlockPos stillAt;
    private static int stillFor;

    private static boolean gateOrDoor(BlockState s) {
        if (s.getBlock() instanceof FenceGateBlock) return true;
        return s.getBlock() instanceof DoorBlock && s.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.LOWER
            && !Names.block(s).equals("iron_door");
    }

    private static boolean open(BlockState s) {
        return s.hasProperty(BlockStateProperties.OPEN) && s.getValue(BlockStateProperties.OPEN);
    }

    private static boolean powered(BlockState s) {
        return s.hasProperty(BlockStateProperties.POWERED) && s.getValue(BlockStateProperties.POWERED);
    }

    private static void tick(Minecraft mc) {
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null || mc.gameMode == null) return;
        if (!enabled) { opened.clear(); seen.clear(); return; }
        BlockPos me = p.blockPosition();
        Vec3 eye = p.getEyePosition();
        // shut in a doorway: a door a pressure plate held open closed on the bot as it stood in it (the plate let go),
        // and Baritone, pathing on, never opens a door it stands in: open it (the closer shuts it once it's through)
        stillFor = me.equals(stillAt) ? stillFor + 1 : 0;
        stillAt = me;
        // while a Baritone job is on (it may be failing to find a path out of the doorway, so not "pathing" as such)
        if ((stillFor == 20 || stillFor % 200 == 60) && Processes.active() != null) {
            for (BlockPos q : new BlockPos[]{me, me.above()}) {
                BlockState s = mc.level.getBlockState(q);
                BlockPos lower = s.getBlock() instanceof DoorBlock && s.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.UPPER ? q.below() : q;
                BlockState ls = mc.level.getBlockState(lower);
                if (!gateOrDoor(ls) || open(ls)) continue;
                Vec3 c = Vec3.atCenterOf(lower);
                mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(c, Direction.UP, lower, false));
                opened.put(lower.asLong(), Ticker.ticks());
                break;
            }
        }
        // gates and doors that just opened next to the bot are its own
        Map<Long, Boolean> now = new HashMap<>();
        for (BlockPos q : BlockPos.betweenClosed(me.offset(-R, -1, -R), me.offset(R, 2, R))) {
            BlockState s = mc.level.getBlockState(q);
            if (!gateOrDoor(s)) continue;
            long k = q.asLong();
            boolean o = open(s);
            now.put(k, o);
            Boolean was = seen.get(k);
            if (o && was != null && !was && !powered(s) && Vec3.atCenterOf(q).distanceTo(p.position()) <= 2.5) opened.putIfAbsent(k, Ticker.ticks());
        }
        seen.clear();
        seen.putAll(now);
        // shut them once the bot is clear of them
        for (Iterator<Map.Entry<Long, Long>> it = opened.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<Long, Long> e = it.next();
            BlockPos q = BlockPos.of(e.getKey());
            BlockState s = mc.level.getBlockState(q);
            if (!gateOrDoor(s) || !open(s) || powered(s)) { it.remove(); continue; }
            Vec3 c = Vec3.atCenterOf(q);
            double d = c.distanceTo(p.position());
            if (d > 6 || Ticker.ticks() - e.getValue() > 20 * 60) { it.remove(); continue; } // out of reach: the shelter's sweep
            boolean inside = q.equals(me) || q.equals(me.above()) || q.equals(me.below());
            if (inside || d < 2.2 || eye.distanceTo(c) > 4.4) continue;
            if (mc.gui.screen() != null || p.isUsingItem() || mc.gameMode.isDestroying()) continue;
            // a click on the side facing the bot; no need to turn its head (the server checks the reach, not the look)
            Direction face = Direction.getApproximateNearest(p.position().x - c.x, 0, p.position().z - c.z);
            Vec3 hit = c.add(face.getStepX() * 0.5, 0, face.getStepZ() * 0.5);
            boolean sneaking = mc.options.keyShift.isDown();
            if (sneaking) continue; // a sneaking click with something in hand would use the item, not the gate
            mc.gameMode.useItemOn(p, InteractionHand.MAIN_HAND, new BlockHitResult(hit, face, q, false));
            it.remove();
        }
    }

    public static void register(BridgeServer s) {
        // {enabled}: shut the bot's gates and doors behind it (default on)
        s.register("gates.auto", true, (p, c) -> {
            enabled = !p.has("enabled") || p.get("enabled").getAsBoolean();
            return obj("enabled", enabled);
        });
        Ticker.every(new Ticker.Task() {
            @Override public boolean tick(Minecraft mc) {
                Gates.tick(mc);
                return false;
            }
        });
    }
}
