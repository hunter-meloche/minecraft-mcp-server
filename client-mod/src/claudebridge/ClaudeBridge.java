package claudebridge;

import baritone.api.BaritoneAPI;
import baritone.api.Settings;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.network.chat.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Consumer;

/**
 * Entry point of the bridge mod: lets the Minecraft MCP server drive this client (and Baritone) over a loopback
 * JSON-RPC connection. Configuration comes from system properties set by the launcher:
 *   claudebridge.port       loopback port (default 25599)
 *   claudebridge.tokenFile  file holding the token a connection must present first
 *   claudebridge.offline    true: offline account (see OfflineLoginMixin)
 */
public class ClaudeBridge implements ClientModInitializer {
    static BridgeServer server;

    @Override
    public void onInitializeClient() {
        int port = Integer.getInteger("claudebridge.port", 25599);
        String token;
        try {
            String file = System.getProperty("claudebridge.tokenFile");
            token = file == null ? null : Files.readString(Path.of(file)).trim();
        } catch (Exception e) {
            token = null;
        }
        if (token == null || token.isBlank()) {
            System.out.println("[claudebridge] no token (claudebridge.tokenFile): bridge disabled");
            return;
        }
        server = new BridgeServer(port, token);
        Handlers.register(server);
        configureBaritone();
        server.start();
    }

    /** Safer movement defaults (same choices as the mineflayer backend), and capture Baritone's messages. */
    private static void configureBaritone() {
        Settings s = BaritoneAPI.getSettings();
        s.allowParkour.value = false;
        s.allowParkourPlace.value = false;
        s.maxFallHeightNoWater.value = 3;
        s.avoidance.value = true;
        s.chatControl.value = false; // only this bridge controls the bot, not chat from other players
        Consumer<Component> previous = s.logger.value;
        s.logger.value = message -> {
            Events.onBaritoneMessage(message.getString());
            previous.accept(message);
        };
    }
}
