package claudebridge;

import net.minecraft.client.Minecraft;

import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** Work that runs once per client tick, on the game thread (driven by MinecraftTickMixin). */
public final class Ticker {
    /** A task; return true when it is finished and should be removed. */
    public interface Task {
        boolean tick(Minecraft mc);
    }

    private static final List<Task> TASKS = new CopyOnWriteArrayList<>();
    private static final List<Task> ALWAYS = new CopyOnWriteArrayList<>();
    private static long ticks;

    private Ticker() { }

    public static void add(Task task) {
        TASKS.add(task);
    }

    /** A task that runs every tick for the life of the client (reflexes, event polling). */
    public static void every(Task task) {
        ALWAYS.add(task);
    }

    public static long ticks() {
        return ticks;
    }

    public static void tick(Minecraft mc) {
        ticks++;
        for (Task t : ALWAYS) {
            try { t.tick(mc); } catch (Exception e) { System.out.println("[claudebridge] tick task failed: " + e); }
        }
        for (Iterator<Task> it = TASKS.iterator(); it.hasNext(); ) {
            Task t = it.next();
            boolean done;
            try { done = t.tick(mc); } catch (Exception e) { System.out.println("[claudebridge] tick task failed: " + e); done = true; }
            if (done) TASKS.remove(t);
        }
    }
}
