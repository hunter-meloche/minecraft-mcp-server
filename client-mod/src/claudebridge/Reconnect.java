package claudebridge;

import claudebridge.mixin.DisconnectedScreenAccessor;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.DisconnectedScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.contents.TranslatableContents;

import java.util.Set;

import static claudebridge.Json.obj;

/**
 * Back on the server after it went away: a restart, a crash, a dropped connection, a full server. The bot rejoins by
 * itself after 30 s, then 1, 2 and 5 minutes, and every 5 minutes after that. Never after being sent away on purpose:
 * kicked (with or without a reason), banned, not on the whitelist, idle too long, logged in elsewhere. Then it stays
 * off until someone asks it back (server.rejoin), and the status says why. It can also leave when asked (server.leave).
 */
public final class Reconnect {
    private Reconnect() { }

    /**
     * Reasons worth trying again for (translation keys, as the 26.3 language file has them): the server went away or the
     * line dropped; nobody sent the bot away. Kicks for flying, spam or the packet rate are left out too: they mean
     * something is wrong, and rejoining every few minutes would only fill the chat with joins and leaves.
     */
    private static final Set<String> RETRY = Set.of("multiplayer.disconnect.server_shutdown", "multiplayer.disconnect.server_full",
        "multiplayer.disconnect.generic", "multiplayer.disconnect.slow_login", "disconnect.timeout", "disconnect.lost",
        "disconnect.endOfStream", "disconnect.genericReason", "disconnect.packetError", "disconnect.unknownHost",
        "connect.failed", "connect.failed.transfer");
    private static final long[] WAIT_SECONDS = {30, 60, 120, 300};

    /** the server last played on ("host:port"); at first the one the game was launched to join */
    private static String server = launchServer();
    /** the disconnected screen already dealt with */
    private static DisconnectedScreen handled;
    private static String reason, key;
    private static boolean retry;
    private static long nextTry;
    private static int attempts;

    /** The server the launcher told the game to join (--quickPlayMultiplayer host:port): rejoinable even if the first try failed. */
    private static String launchServer() {
        String[] args = System.getProperty("sun.java.command", "").split(" ");
        for (int i = 0; i + 1 < args.length; i++) if (args[i].equals("--quickPlayMultiplayer") && !args[i + 1].isBlank()) return args[i + 1];
        return null;
    }

    static boolean retryable(Component reason) {
        return reason.getContents() instanceof TranslatableContents t && RETRY.contains(t.getKey());
    }

    private static void tick(Minecraft mc) {
        if (mc.player != null && mc.level != null) {
            ServerData d = mc.getCurrentServer();
            if (d != null && d.ip != null && !d.ip.isBlank()) server = d.ip;
            attempts = 0;
            handled = null;
            reason = key = null;
            return;
        }
        if (mc.gui.screen() instanceof DisconnectedScreen ds && ds != handled) {
            handled = ds;
            Component r = ((DisconnectedScreenAccessor) ds).claudebridge$details().reason();
            reason = r.getString();
            key = r.getContents() instanceof TranslatableContents t ? t.getKey() : null;
            retry = retryable(r);
            long wait = WAIT_SECONDS[Math.min(attempts, WAIT_SECONDS.length - 1)];
            nextTry = Ticker.ticks() + wait * 20;
            ClaudeBridge.server.emit("disconnected", obj("reason", reason, "key", key, "rejoin", retry && server != null, "inSeconds", retry ? wait : null));
        }
        if (handled != null && mc.gui.screen() == handled && retry && server != null && Ticker.ticks() >= nextTry) connect(mc);
    }

    /** Join the server again, from the disconnected screen. */
    private static void connect(Minecraft mc) {
        attempts++;
        handled = null; // if this fails too, the next disconnected screen is a new one
        ConnectScreen.startConnecting(new TitleScreen(), mc, ServerAddress.parseString(server), new ServerData("server", server, ServerData.Type.OTHER), false, null);
    }

    /** For the status while off the server: why, and whether (and when) it rejoins by itself. Null before it ever joined. */
    static JsonObject summary() {
        if (reason == null) return null;
        boolean coming = retry && server != null;
        return obj("reason", reason, "key", key, "rejoin", coming, "inSeconds", coming ? Math.max(0, (nextTry - Ticker.ticks()) / 20) : null);
    }

    public static void register(BridgeServer s) {
        // {} -> {rejoining, server?, reason?}: back onto the server it was on (after a kick, once the people there agree)
        s.register("server.rejoin", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.player != null && mc.level != null) return obj("rejoining", false, "reason", "already on the server");
            if (server == null) return obj("rejoining", false, "reason", "it hasn't been on a server yet");
            if (!(mc.gui.screen() instanceof DisconnectedScreen)) return obj("rejoining", false, "reason", "already connecting");
            attempts = 0;
            connect(mc);
            return obj("rejoining", true, "server", server);
        });
        // {rejoin?} -> {left, rejoin}: off the server, politely (someone asked it to go); with rejoin, dropped and back
        // by itself in 30 s (a fresh connection for a stuck client)
        s.register("server.leave", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.getConnection() == null) return obj("left", false, "reason", "not on a server");
            boolean back = p.has("rejoin") && p.get("rejoin").getAsBoolean();
            mc.getConnection().getConnection().disconnect(back ? Component.translatable("multiplayer.disconnect.generic") : Component.literal("Left when asked to"));
            return obj("left", true, "rejoin", back);
        });
        Ticker.every(new Ticker.Task() {
            int n = 0;
            @Override public boolean tick(Minecraft mc) {
                if (++n % 20 == 0) Reconnect.tick(mc);
                return false;
            }
        });
    }
}
