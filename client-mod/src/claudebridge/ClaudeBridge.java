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
        Interact.register(server);
        Enchanting.register(server);
        Signs.register(server);
        Gates.register(server);
        Combat.register(server);
        Guardian.register(server);
        Protection.register(server);
        BrainHud.register(server);
        Passive.register();
        Processes.baritone().getPathingControlManager().registerProcess(new DefendProcess());
        Processes.baritone().getPathingControlManager().registerProcess(new EatPause());
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
        s.blocksToAvoid.value.add(net.minecraft.world.level.block.Blocks.SWEET_BERRY_BUSH); // it hurts: 5 hits on one walk
        // scaffold with stone-type blocks only: dirt is worth keeping for farmland and fills (Baritone climbed a hill on
        // the bot's last 8 dirt, which a level-area fill then lacked)
        s.acceptableThrowawayItems.value = new java.util.ArrayList<>(java.util.List.of(net.minecraft.world.item.Items.COBBLESTONE,
            net.minecraft.world.item.Items.COBBLED_DEEPSLATE, net.minecraft.world.item.Items.NETHERRACK, net.minecraft.world.item.Items.ANDESITE,
            net.minecraft.world.item.Items.DIORITE, net.minecraft.world.item.Items.GRANITE, net.minecraft.world.item.Items.TUFF));
        // no random aim: Baritone nudges the yaw up to 2 degrees every tick by default to look human, enough to slip off
        // a block seen at an angle and reset the breaking progress (the bot kept restarting blocks)
        s.randomLooking.value = 0.0;
        s.randomLooking113.value = 0.0;
        // on, so Baritone plans with the best tool: off, it costed every block by whatever was in hand (a sword), digging
        // through stone looked endless, and it found no path to any ore. The tool actually used is still ours:
        // DestroyToolMixin picks it as each dig starts and goes on, after Baritone's choice (which broke ties by slot
        // order and dug dirt with the pickaxe)
        s.autoTool.value = true;
        // use a tool until it breaks: with the saver on, Baritone left a nearly worn-out axe alone and chopped wood with
        // the pickaxe or the shovel instead, and the axe never broke, so nothing told the kit to make another
        s.itemSaver.value = false;
        s.allowInventory.value = true; // let the builder (and tool choice) use items outside the hotbar; without it a build stalls silently
        // build-structure writes structure_void where a directional block goes (stairs facing out over a wall can't be
        // placed from where Baritone stands) and places those itself afterwards; Baritone leaves those cells alone
        s.buildSkipBlocks.value.add(net.minecraft.world.level.block.Blocks.STRUCTURE_VOID);
        // fence and wall connections follow the neighbours, gates open and doors swing: compare the block, not those
        // (a fence that would connect never matched its unconnected schematic state, and the builder stalled on it)
        s.buildIgnoreProperties.value.addAll(java.util.List.of("north", "south", "east", "west", "waterlogged", "open", "in_wall", "powered", "hinge"));
        s.chatControl.value = false; // only this bridge controls the bot, not chat from other players
        Consumer<Component> previous = s.logger.value;
        s.logger.value = message -> {
            Events.onBaritoneMessage(message.getString());
            previous.accept(message);
        };
    }
}
