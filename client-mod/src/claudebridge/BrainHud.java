package claudebridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;

import static claudebridge.Json.obj;

/**
 * What the MCP server's brain (its autopilot) is doing, shown in the bot's own window: a line at the top left of the
 * HUD and the same in the window title (readable from the taskbar while the window is minimized). Display only:
 * nothing is sent to the server.
 */
public final class BrainHud {
    private BrainHud() { }

    private static volatile String text;
    private static volatile boolean titleStale;

    /** The window title, the brain's status and the bot's name first (the taskbar cuts long titles short). */
    public static String title(String base) {
        String t = text;
        if (t == null) return base;
        var user = Minecraft.getInstance().getUser();
        return t + " | " + (user == null ? "" : user.getName() + " | ") + base;
    }

    /** Drawn after the rest of the HUD. */
    public static void draw(GuiGraphicsExtractor g) {
        String t = text;
        Minecraft mc = Minecraft.getInstance();
        if (t == null || mc.player == null) return;
        var font = mc.font;
        int w = font.width(t);
        g.fill(2, 2, w + 8, 15, 0x90000000);
        g.text(font, t, 5, 5, 0xFFFFFFFF, true);
    }

    public static void register(BridgeServer s) {
        s.register("hud.set", true, (p, c) -> {
            String t = p.has("text") && !p.get("text").isJsonNull() ? p.get("text").getAsString() : null;
            if (t != null && t.length() > 120) t = t.substring(0, 117) + "...";
            if (!java.util.Objects.equals(t, text)) { text = t; titleStale = true; }
            return obj("ok", true);
        });
        // the title is set on the game thread, once per change
        Ticker.every(new Ticker.Task() {
            @Override public boolean tick(Minecraft mc) {
                if (titleStale) { titleStale = false; mc.updateTitle(); }
                return false;
            }
        });
    }
}
