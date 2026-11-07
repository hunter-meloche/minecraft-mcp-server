package claudebridge;

import baritone.api.BaritoneAPI;

/**
 * Walking that changes nothing: Baritone's allowBreak and allowPlace off while a careful goto runs, so it finds a way
 * round on foot or not at all. Nested careful walks share one saved state; the settings come back when the last ends.
 */
public final class Careful {
    private Careful() { }

    private static int depth = 0;
    private static boolean savedBreak, savedPlace;

    public static synchronized void begin() {
        var s = BaritoneAPI.getSettings();
        if (depth++ == 0) { savedBreak = s.allowBreak.value; savedPlace = s.allowPlace.value; }
        s.allowBreak.value = false;
        s.allowPlace.value = false;
    }

    public static synchronized void end() {
        if (depth == 0) return;
        if (--depth > 0) return;
        var s = BaritoneAPI.getSettings();
        s.allowBreak.value = savedBreak;
        s.allowPlace.value = savedPlace;
    }
}
