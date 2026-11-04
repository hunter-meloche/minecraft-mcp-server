package claudebridge;

import baritone.api.BaritoneAPI;
import baritone.api.IBaritone;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * Long-running Baritone work (goto, mine, build) as one bridge call: start it, then watch it every tick and reply when
 * it is over — finished, failed, paused for materials, cancelled or timed out — with what Baritone said meanwhile.
 */
public final class Processes {
    private Processes() { }

    public static IBaritone baritone() {
        return BaritoneAPI.getProvider().getPrimaryBaritone();
    }

    /** Name of the Baritone process in control, or null when Baritone is idle. */
    public static String active() {
        IBaritone b = baritone();
        String p = b.getPathingControlManager().mostRecentInControl().filter(pr -> pr.isActive()).map(pr -> pr.displayName()).orElse(null);
        return p != null ? p : b.getPathingBehavior().isPathing() ? "pathing" : null;
    }

    /**
     * Watch the process just started. {@code onEnd} builds the reply from the end state; "reason" is set to
     * "done", "timeout", "paused" (builder waiting for materials) or "cancelled".
     */
    /** Bumped by the bridge's cancel call, so a watched process stopped on request ends as "cancelled", not "done". */
    public static volatile long cancels = 0;

    public static void watch(BridgeServer.Call call, long logSeqAtStart, int timeoutTicks, Function<String, JsonObject> onEnd) {
        watch(call, logSeqAtStart, timeoutTicks, () -> false, onEnd);
    }

    /** As above, and also ends the process ("done") as soon as `enough` says so. */
    public static void watch(BridgeServer.Call call, long logSeqAtStart, int timeoutTicks, java.util.function.BooleanSupplier enough,
                             Function<String, JsonObject> onEnd) {
        long cancelsAtStart = cancels;
        Ticker.add(new Ticker.Task() {
            int age = 0;
            int idle = 0;
            boolean seenActive = false;

            @Override
            public boolean tick(Minecraft mc) {
                if (call.isDone()) return true; // cancelled through another call
                age++;
                String reason = null;
                String now = active();
                if (now != null) { seenActive = true; idle = 0; } else idle++;
                if (cancels != cancelsAtStart) reason = "cancelled";
                else if (enough.getAsBoolean()) { reason = "done"; baritone().getPathingBehavior().cancelEverything(); }
                else if (baritone().getBuilderProcess().isPaused()) reason = "paused";
                else if (seenActive && idle >= 5) reason = "done";
                else if (!seenActive && age >= 60) reason = "done"; // never started (nothing to do, or refused at once)
                else if (age >= timeoutTicks) reason = "timeout";
                if (reason == null) return false;
                if (reason.equals("timeout") || reason.equals("paused")) baritone().getPathingBehavior().cancelEverything();
                JsonObject result = onEnd.apply(reason);
                result.addProperty("reason", reason);
                result.addProperty("seconds", Json.round(age / 20.0));
                result.add("baritone", Json.toTree(Events.baritoneMessagesSince(logSeqAtStart)));
                call.ok(result);
                return true;
            }
        });
    }

    /** Item name -> count over the whole inventory. */
    public static Map<String, Integer> inventoryCounts(Minecraft mc) {
        Map<String, Integer> counts = new HashMap<>();
        if (mc.player == null) return counts;
        var inv = mc.player.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            var s = inv.getItem(i);
            if (!s.isEmpty()) counts.merge(Names.item(s), s.getCount(), Integer::sum);
        }
        return counts;
    }

    /** What was added between two inventory snapshots. */
    public static Map<String, Integer> gained(Map<String, Integer> before, Map<String, Integer> after) {
        Map<String, Integer> gained = new HashMap<>();
        after.forEach((k, v) -> { int d = v - before.getOrDefault(k, 0); if (d > 0) gained.put(k, d); });
        return gained;
    }
}
