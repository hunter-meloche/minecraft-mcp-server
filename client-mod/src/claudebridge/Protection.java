package claudebridge;

import baritone.api.BaritoneAPI;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Blocks the bot built (sent by the MCP server). Baritone has no per-position protection, and it walked through a
 * cabin wall rather than use the door; so once a second this sets Baritone's blocksToDisallowBreaking to the types of
 * the protected blocks within RADIUS of the bot. Our own dig and build processes lift the rule while they run, since
 * they break blocks on purpose.
 */
public final class Protection {
    private static final int RADIUS = 24;
    private static final Set<Long> POSITIONS = new HashSet<>();
    private static List<Block> original;
    private static int suspended = 0;

    private Protection() { }

    public static int count() {
        return POSITIONS.size();
    }

    public static void suspend() {
        suspended++;
        apply(List.of());
    }

    public static void resume() {
        if (suspended > 0) suspended--;
    }

    private static void apply(List<Block> types) {
        var setting = BaritoneAPI.getSettings().blocksToDisallowBreaking;
        if (original == null) original = new ArrayList<>(setting.value);
        List<Block> value = new ArrayList<>(original);
        for (Block b : types) if (!value.contains(b)) value.add(b);
        if (!value.equals(setting.value)) setting.value = value;
    }

    private static int idleWhileSuspended = 0;

    private static void tick(Minecraft mc) {
        // a process that ended without its end handler (its call was dropped) must not leave the rule lifted for good
        if (suspended > 0) {
            idleWhileSuspended = Processes.active() == null ? idleWhileSuspended + 1 : 0;
            if (idleWhileSuspended >= 5) { suspended = 0; idleWhileSuspended = 0; }
        }
        if (suspended > 0 || mc.player == null || mc.level == null) return;
        BlockPos me = mc.player.blockPosition();
        Set<Block> types = new LinkedHashSet<>();
        for (long l : POSITIONS) {
            BlockPos p = BlockPos.of(l);
            if (p.distManhattan(me) > RADIUS * 2 || p.distSqr(me) > RADIUS * RADIUS || !mc.level.isLoaded(p)) continue;
            var st = mc.level.getBlockState(p);
            if (!st.isAir()) types.add(st.getBlock());
        }
        apply(new ArrayList<>(types));
    }

    public static void register(BridgeServer s) {
        // the full list for the current dimension, replacing what was there
        s.register("protect.set", true, (p, c) -> {
            POSITIONS.clear();
            JsonElement list = p.get("positions");
            if (list != null && list.isJsonArray()) {
                for (JsonElement e : list.getAsJsonArray()) {
                    JsonArray a = e.getAsJsonArray();
                    POSITIONS.add(BlockPos.asLong(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()));
                }
            }
            JsonObject r = new JsonObject();
            r.addProperty("count", POSITIONS.size());
            return r;
        });
        s.register("protect.status", true, (p, c) -> {
            JsonObject r = new JsonObject();
            r.addProperty("count", POSITIONS.size());
            r.addProperty("suspended", suspended);
            JsonArray types = new JsonArray();
            for (Block b : BaritoneAPI.getSettings().blocksToDisallowBreaking.value) {
                types.add(Names.strip(b.builtInRegistryHolder().getRegisteredName()));
            }
            r.add("disallowBreaking", types);
            return r;
        });
        Ticker.every(new Ticker.Task() {
            int n = 0;
            @Override public boolean tick(Minecraft mc) {
                if (++n % 20 == 0) Protection.tick(mc);
                return false;
            }
        });
    }
}
