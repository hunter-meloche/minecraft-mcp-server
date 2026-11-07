package claudebridge;

import baritone.api.BaritoneAPI;

/**
 * Baritone's allowBreak and allowPlace, held off for two reasons. A careful goto (walking that changes nothing: it finds
 * a way round on foot or not at all) turns both off; being in or right by someone else's build (Foreign) turns placing
 * off, so its pillars and bridges don't litter a friend's base. The settings as they were come back when neither holds;
 * nested careful walks share one saved state.
 */
public final class Careful {
    private Careful() { }

    private static int depth = 0;
    private static boolean foreign = false;
    /** the settings before either reason touched them (null while untouched) */
    private static Boolean baseBreak, basePlace;

    private static void apply() {
        var s = BaritoneAPI.getSettings();
        if (depth == 0 && !foreign) {
            if (baseBreak != null) { s.allowBreak.value = baseBreak; s.allowPlace.value = basePlace; baseBreak = basePlace = null; }
            return;
        }
        if (baseBreak == null) { baseBreak = s.allowBreak.value; basePlace = s.allowPlace.value; }
        s.allowBreak.value = depth > 0 ? false : baseBreak;
        s.allowPlace.value = depth > 0 || foreign ? false : basePlace;
    }

    public static synchronized void begin() { depth++; apply(); }

    public static synchronized void end() {
        if (depth == 0) return;
        depth--;
        apply();
    }

    /** In or right by someone else's build (or not any more): no placing there. */
    public static synchronized void setForeign(boolean near) {
        if (near == foreign) return;
        foreign = near;
        apply();
    }
}
