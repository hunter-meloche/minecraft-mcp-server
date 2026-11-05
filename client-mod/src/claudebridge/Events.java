package claudebridge;

import net.minecraft.client.Minecraft;
import net.minecraft.network.protocol.game.ClientboundDamageEventPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerCombatKillPacket;
import net.minecraft.world.entity.Entity;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/** Game happenings the mixins report; pushed to Node as bridge events. */
public final class Events {
    private static final int BARITONE_LOG_LINES = 40;
    private static final Deque<String> BARITONE_LOG = new ArrayDeque<>();
    private static long baritoneLogSeq;

    private Events() { }

    static BridgeServer server() {
        return ClaudeBridge.server;
    }

    /** The bot was hurt: what kind of damage (registry name), and who caused it, if anyone. */
    public static void onDamage(ClientboundDamageEventPacket packet) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;
        Combat.onDamage(packet.entityId(), packet.sourceCauseId()); // landed hits in a fight
        if (packet.entityId() != mc.player.getId()) return;
        Guardian.onSelfHurt(packet.sourceCauseId());
        String cause = packet.sourceType().getRegisteredName().replace("minecraft:", "");
        Entity source = packet.sourceCauseId() >= 0 && mc.level != null ? mc.level.getEntity(packet.sourceCauseId()) : null;
        String sourceName = source == null ? null : Names.entity(source);
        // the health update arrives just after the damage event: report the health a couple of ticks later
        Ticker.add(new Ticker.Task() {
            int wait = 2;
            @Override public boolean tick(Minecraft m) {
                if (--wait > 0) return false;
                server().emit("hurt", Json.obj("cause", cause, "source", sourceName,
                    "health", m.player == null ? null : Json.round(m.player.getHealth())));
                return true;
            }
        });
    }

    /** The bot died. Respawn right away (as mineflayer does) and report where and why. */
    public static void onCombatKill(ClientboundPlayerCombatKillPacket packet) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || packet.playerId() != mc.player.getId()) return;
        server().emit("death", Json.obj("message", packet.message().getString(), "at", Json.pos(mc.player.blockPosition())));
        Ticker.add(new Ticker.Task() {
            int wait = 10;
            @Override public boolean tick(Minecraft m) {
                if (--wait > 0) return false;
                if (m.player != null) m.player.respawn();
                m.gui.setScreen(null); // 26.x: screens live on Gui
                return true;
            }
        });
    }

    public static void onRespawn() {
        // the new position arrives a moment later: report it from a later tick
        Ticker.add(new Ticker.Task() {
            int wait = 20;
            @Override public boolean tick(Minecraft m) {
                if (--wait > 0) return false;
                if (m.player != null) server().emit("respawn", Json.obj("at", Json.pos(m.player.blockPosition())));
                return true;
            }
        });
    }

    public static void onChat(String text) {
        server().emit("chat", Json.obj("text", text));
    }

    /** A system message from the server: its translation key (null if not translatable) and text. */
    public record SystemMessage(long seq, String key, String text, boolean overlay) { }

    private static final int SYSTEM_LOG_LINES = 20;
    private static final Deque<SystemMessage> SYSTEM_LOG = new ArrayDeque<>();
    private static long systemSeq;

    /**
     * Every system message, overlay (action bar) ones included, kept with its translation key: overlay lines never
     * reach the chat box, and the key says why a bed refused us whatever the client's language.
     */
    public static synchronized void onSystemMessage(net.minecraft.network.chat.Component message, boolean overlay) {
        String key = message.getContents() instanceof net.minecraft.network.chat.contents.TranslatableContents t ? t.getKey() : null;
        SYSTEM_LOG.addLast(new SystemMessage(++systemSeq, key, message.getString(), overlay));
        while (SYSTEM_LOG.size() > SYSTEM_LOG_LINES) SYSTEM_LOG.removeFirst();
    }

    public static synchronized long systemSeq() {
        return systemSeq;
    }

    /** System messages that arrived after sequence number {@code since}, oldest first. */
    public static synchronized List<SystemMessage> systemMessagesSince(long since) {
        List<SystemMessage> out = new ArrayList<>();
        for (SystemMessage m : SYSTEM_LOG) if (m.seq() > since) out.add(m);
        return out;
    }

    /** Baritone's own messages, kept so a finished process can report what Baritone said. */
    public static synchronized void onBaritoneMessage(String text) {
        BARITONE_LOG.addLast(text);
        baritoneLogSeq++;
        while (BARITONE_LOG.size() > BARITONE_LOG_LINES) BARITONE_LOG.removeFirst();
    }

    public static synchronized long baritoneLogSeq() {
        return baritoneLogSeq;
    }

    /** Baritone messages logged after sequence number {@code since}. */
    public static synchronized List<String> baritoneMessagesSince(long since) {
        int n = (int) Math.min(BARITONE_LOG.size(), baritoneLogSeq - since);
        List<String> all = new ArrayList<>(BARITONE_LOG);
        return all.subList(all.size() - n, all.size());
    }
}
