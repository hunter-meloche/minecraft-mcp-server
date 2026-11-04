package claudebridge;

import net.minecraft.client.Minecraft;
import org.lwjgl.sdl.SDLHints;
import org.lwjgl.sdl.SDLVideo;

/**
 * The bot's game window stays out of the user's way (-Dclaudebridge.passive=true, the launcher's default): it opens
 * without taking focus and minimized, never grabs the mouse, and ignores mouse and keyboard input, so a stray click or
 * key press can't turn the bot's camera or press its keys. The bot is driven through the bridge, which needs none of it.
 * The window can still be restored to watch.
 */
public final class Passive {
    public static final boolean ENABLED = Boolean.getBoolean("claudebridge.passive");
    private static int minimizeChecks = 0;

    private Passive() { }

    /** Before the window is created: don't activate it when it's shown. */
    public static void beforeWindow() {
        if (!ENABLED) return;
        try {
            SDLHints.SDL_SetHint(SDLHints.SDL_HINT_WINDOW_ACTIVATE_WHEN_SHOWN, "0");
            SDLHints.SDL_SetHint(SDLHints.SDL_HINT_WINDOW_ACTIVATE_WHEN_RAISED, "0");
        } catch (Throwable t) {
            System.err.println("[claudebridge] could not set SDL window hints: " + t);
        }
    }

    public static void minimize(long handle) {
        if (!ENABLED || handle == 0) return;
        try {
            SDLVideo.SDL_MinimizeWindow(handle);
        } catch (Throwable t) {
            System.err.println("[claudebridge] could not minimize the window: " + t);
        }
    }

    /** Start-up may show or restore the window again (loading, joining): keep it minimized for the first 30 seconds. */
    static void register() {
        if (!ENABLED) return;
        Ticker.every(new Ticker.Task() {
            int n = 0;
            @Override public boolean tick(Minecraft mc) {
                if (minimizeChecks >= 30 || ++n % 20 != 0) return false;
                minimizeChecks++;
                if (mc.getWindow() != null && !mc.getWindow().isIconified()) minimize(mc.getWindow().handle());
                return false;
            }
        });
    }
}
