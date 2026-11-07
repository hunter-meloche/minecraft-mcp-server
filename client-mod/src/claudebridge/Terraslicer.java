package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import static claudebridge.Json.*;

/**
 * Terraslicer's calls: the build job's toolpath carried out the way a player does it (the same packets: vanilla servers
 * see a player placing blocks). place.batch places a station's blocks one after another from where the bot stands, at
 * the vanilla right-click cadence (one every 4 ticks, the use key held), instead of a call per block; pillar is the
 * jump-and-place-under-the-feet climb onto scaffold.
 */
public final class Terraslicer {
    private Terraslicer() { }

    public static void register(BridgeServer s) {
        // {actions: [{x, y, z, item, face?, axis?, facing?, top?}], cadenceTicks?} -> {results: [{placed, block?, reason?}]}
        s.register("place.batch", true, (p, c) -> {
            JsonArray acts = p.getAsJsonArray("actions");
            int cadence = Math.max(3, intParam(p, "cadenceTicks", 4));
            JsonArray results = new JsonArray();
            Ticker.add(new Ticker.Task() {
                int i = 0, wait = 0;
                Interact.Aim aim = null;
                @Override public boolean tick(Minecraft m) {
                    if (c.isDone()) return true;
                    if (m.player == null || m.level == null) { c.fail("not in a world"); return true; }
                    if (aim != null) {
                        wait--;
                        // the click a tick after aiming (the rotation goes out first), the result at the end of the cadence
                        if (wait == cadence - 2) m.gameMode.useItemOn(m.player, InteractionHand.MAIN_HAND, aim.click);
                        if (wait > 0) return false;
                        BlockState now = m.level.getBlockState(aim.target);
                        results.add(obj("placed", !Interact.replaceable(now), "block", Names.block(now), "face", aim.face));
                        aim = null;
                    }
                    // the next one: aimed now, or skipped with the reason (on to the one after, next tick)
                    while (i < acts.size()) {
                        JsonObject a = acts.get(i++).getAsJsonObject();
                        try {
                            Interact.Aim next = Interact.aimPlace(m.player, a);
                            if (next.reason == null) { aim = next; wait = cadence; return false; }
                            results.add(obj("placed", false, "reason", next.reason));
                        } catch (Exception e) {
                            results.add(obj("placed", false, "reason", e.getMessage()));
                        }
                    }
                    c.ok(obj("results", results));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // {count, item} -> {placed, at}: look down, jump, place under the feet at the top of the jump (the cell the feet
        // just left, against the block it stood on), land on it; `count` times. Stops at the first step that fails.
        s.register("pillar", true, (p, c) -> {
            int count = Math.max(1, intParam(p, "count", 1));
            String item = required(p, "item");
            Ticker.add(new Ticker.Task() {
                int done = 0, age = 0, phase = 0;
                double base;
                BlockPos floor;
                @Override public boolean tick(Minecraft m) {
                    if (c.isDone()) { m.options.keyJump.setDown(false); return true; }
                    LocalPlayer pl = m.player;
                    if (pl == null || m.level == null) { c.fail("not in a world"); return true; }
                    age++;
                    if (phase == 0) {
                        if (!pl.onGround()) { if (age > 20) return fail(m, "not standing on anything"); return false; }
                        try { Interact.select(item); } catch (Exception e) { return fail(m, e.getMessage()); }
                        base = pl.getY();
                        floor = pl.blockPosition().below();
                        pl.setXRot(90f);
                        m.options.keyJump.setDown(true);
                        phase = 1; age = 0;
                        return false;
                    }
                    if (phase == 1) {
                        pl.setXRot(90f);
                        // above the cell the feet were in: the block can go there now
                        if (pl.getY() > base + 1.02) {
                            m.options.keyJump.setDown(false);
                            Vec3 hit = new Vec3(floor.getX() + 0.5, floor.getY() + 1.0, floor.getZ() + 0.5);
                            m.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, floor, false));
                            phase = 2; age = 0;
                        } else if (age > 14) return fail(m, "the jump didn't get high enough (head room?)");
                        return false;
                    }
                    // landed on the new block, or fell back without it
                    if (pl.onGround() && age > 2) {
                        BlockPos placed = floor.above();
                        if (Interact.replaceable(m.level.getBlockState(placed))) return fail(m, "the block didn't go in under the feet");
                        done++;
                        if (done >= count) { c.ok(obj("placed", done, "at", pos(pl.blockPosition()))); return true; }
                        phase = 0; age = 0;
                        return false;
                    }
                    if (age > 30) return fail(m, "never landed");
                    return false;
                }
                private boolean fail(Minecraft m, String why) {
                    m.options.keyJump.setDown(false);
                    c.ok(obj("placed", done, "reason", why, "at", pos(m.player.blockPosition())));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });
    }
}
