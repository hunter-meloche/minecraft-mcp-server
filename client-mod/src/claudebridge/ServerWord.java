package claudebridge;

import claudebridge.mixin.ClientLevelAccessor;
import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.network.HashedStack;
import net.minecraft.network.protocol.game.ServerboundContainerClickPacket;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * What the server said about a use, as opposed to what the client guessed. The client predicts a use at once: a bucket
 * fills or pours in its own world and hand the moment it is used. Live (Nov 14) three pickups of a source the client
 * predicted as filled left the source and an empty bucket on the server; the client went on showing a water bucket
 * until the next pour found none, and the tool said the bucket was used. So a bucket use waits for the server's word:
 *
 * - the blocks: the server answers every use with an ack of its sequence number (ServerGamePacketListenerImpl
 *   handleUseItem / handleUseItemOn, sent at the start of the connection's next tick), after the block changes the use
 *   made (broadcast in the level's tick, before it). On the ack the client puts back the server's state wherever it
 *   predicted otherwise (BlockStatePredictionHandler.endPredictionsUpTo). So after the ack the world is the server's.
 * - the hand: a use that changed the hand on the server sends the inventory at once (ServerPlayerGameMode.useItem:
 *   sendAllDataToRemote), or, while the server has the bot using an item (the shield up), in the player's tick just
 *   after the ack. A use that changed nothing sends nothing, so a hand the client changed with no word from the server
 *   is only the client's guess: the server is asked for its inventory (a click with a stale state id, which a vanilla
 *   server answers with the whole inventory: handleContainerClick, broadcastFullState), and the reply is what it sends.
 */
public final class ServerWord {
    private ServerWord() { }

    private static volatile int lastAck = -1;
    private static volatile ClientLevel ackLevel;
    private static volatile long handSyncs;

    // ---------------------------------------------------------------- from ClientPacketListenerMixin (game thread)

    public static void onAck(int sequence) {
        lastAck = sequence;
        ackLevel = Minecraft.getInstance().level;
    }

    /** The server sent the whole inventory of a menu (the player's slots are in every menu's content). */
    public static void onContent(int containerId) {
        LocalPlayer p = Minecraft.getInstance().player;
        if (p != null && (containerId == p.inventoryMenu.containerId || containerId == p.containerMenu.containerId)) handSyncs++;
    }

    /** The server sent one slot of a menu: counted when it is the hand's. */
    public static void onSlot(int containerId, int slot) {
        LocalPlayer p = Minecraft.getInstance().player;
        if (p == null) return;
        for (AbstractContainerMenu menu : new AbstractContainerMenu[] { p.inventoryMenu, p.containerMenu }) {
            if (menu.containerId != containerId || slot < 0 || slot >= menu.slots.size()) continue;
            var s = menu.getSlot(slot);
            if (s.container == p.getInventory() && s.getContainerSlot() == p.getInventory().getSelectedSlot()) { handSyncs++; return; }
        }
    }

    /** The server set one slot of the player's inventory directly. */
    public static void onInventorySlot(int slot) {
        LocalPlayer p = Minecraft.getInstance().player;
        if (p != null && slot == p.getInventory().getSelectedSlot()) handSyncs++;
    }

    // ---------------------------------------------------------------- for a use

    /** The sequence number the last use (or dig) went out with: the server acks it once it has handled the use. */
    static int sequence(ClientLevel level) {
        return ((ClientLevelAccessor) level).claudebridge$predictions().currentSequence();
    }

    static boolean acked(ClientLevel level, int sequence) {
        return ackLevel == level && lastAck >= sequence;
    }

    /** Times the server has said what the hand holds; compared before and after a use. */
    static long handSyncs() {
        return handSyncs;
    }

    /**
     * Ask the server for its inventory: a click outside the menu with nothing carried (a middle click, which does
     * nothing in survival nor out of a slot in creative: AbstractContainerMenu.doClick's CLONE needs a slot), sent with a
     * state id the server's cannot be, so it answers with the whole inventory as it has it. False when a container is
     * open or something is carried (the click would not be the no-op it must be).
     */
    static boolean resync(LocalPlayer pl) {
        AbstractContainerMenu menu = pl.inventoryMenu;
        if (pl.containerMenu != menu || !menu.getCarried().isEmpty()) return false;
        int stale = (menu.getStateId() + 16384) & 32767;
        pl.connection.send(new ServerboundContainerClickPacket(menu.containerId, stale, (short) -999, (byte) 0, ContainerInput.CLONE,
            new Int2ObjectOpenHashMap<>(), HashedStack.EMPTY));
        return true;
    }

    // ---------------------------------------------------------------- the fluid cells round a bucket's use

    /** A source of a fluid (a waterlogged block holds one) or powder snow; null for neither. */
    static String fluidOf(BlockState st) {
        if (Names.block(st).equals("powder_snow")) return "powder_snow";
        FluidState fs = st.getFluidState();
        if (fs.isEmpty() || !fs.isSource()) return null;
        return fs.is(FluidTags.WATER) ? "water" : fs.is(FluidTags.LAVA) ? "lava" : "fluid";
    }

    /** The sources in a box, by cell (BlockPos.asLong). */
    static Map<Long, String> fluids(ClientLevel level, BlockPos lo, BlockPos hi) {
        Map<Long, String> out = new HashMap<>();
        for (BlockPos q : BlockPos.betweenClosed(lo, hi)) {
            String f = fluidOf(level.getBlockState(q));
            if (f != null) out.put(q.asLong(), f);
        }
        return out;
    }

    record Cell(String fluid, int x, int y, int z) {
        String where() { return "(" + x + ", " + y + ", " + z + ")"; }
    }

    record Changes(List<Cell> appeared, List<Cell> vanished) { }

    /** Sources that came and went between two looks at the same box, nearest the given point first. */
    static Changes diff(Map<Long, String> before, Map<Long, String> after, double px, double py, double pz) {
        List<Cell> appeared = new ArrayList<>(), vanished = new ArrayList<>();
        for (var e : after.entrySet()) {
            if (e.getValue().equals(before.get(e.getKey()))) continue;
            BlockPos q = BlockPos.of(e.getKey());
            appeared.add(new Cell(e.getValue(), q.getX(), q.getY(), q.getZ()));
        }
        for (var e : before.entrySet()) {
            if (e.getValue().equals(after.get(e.getKey()))) continue;
            BlockPos q = BlockPos.of(e.getKey());
            vanished.add(new Cell(e.getValue(), q.getX(), q.getY(), q.getZ()));
        }
        java.util.Comparator<Cell> near = java.util.Comparator.comparingDouble(c ->
            (c.x() + 0.5 - px) * (c.x() + 0.5 - px) + (c.y() + 0.5 - py) * (c.y() + 0.5 - py) + (c.z() + 0.5 - pz) * (c.z() + 0.5 - pz));
        appeared.sort(near);
        vanished.sort(near);
        return new Changes(appeared, vanished);
    }

    /**
     * The reply's word on a bucket use, pure: `filled`, `poured at (x, y, z)`, or `nothing happened (the server did
     * not ...)`, from the hand before the use, the hand as the server has it after, the client's own guess, and the
     * sources that came and went once the server had answered. {@code answered}: the server acked the use;
     * {@code handKnown}: the hand after is the server's (it said so, or nothing changed and nothing needed saying).
     * {@code countBefore} and {@code countAfter}: the hand's stack before and after; {@code fullGained}: full buckets
     * the whole inventory gained (fullBuckets, after less before).
     */
    static String verdict(String held, String after, String guessed, Changes ch, boolean answered, boolean handKnown,
                          int countBefore, int countAfter, int fullGained) {
        String guess = guessed != null && !guessed.equals(after) ? "; the client had guessed " + guessed : "";
        if (!answered) return "nothing confirmed (no word from the server within 2 s" + (guessed != null && !guessed.equals(held) ? "; the client guessed " + guessed : "") + ")";
        if (!handKnown) return "nothing confirmed (the server sent no word on the hand; the client guessed " + after + ")";
        if (held.equals("bucket")) {
            // a fill from a stack of empties leaves the rest of the stack in the hand, one fewer, and puts the full
            // bucket in another slot, or drops it at the feet when there is no room (26.3 ItemUtils.createFilledResult).
            // The bot carries its empties stacked (bucketsFor makes several, the stash keeps them): read by the hand's
            // name alone, every such fill said "nothing happened"
            boolean fromStack = after.equals("bucket") && countAfter < countBefore;
            if (isFull(after) || fromStack) {
                Cell from = ch.vanished().isEmpty() ? null : ch.vanished().getFirst();
                String filled = "filled" + (from == null ? "" : " (the " + from.fluid() + " at " + from.where() + ")");
                return fromStack && fullGained <= 0 ? filled + "; no room for the full bucket: the server dropped it at the bot's feet" : filled;
            }
            return "nothing happened (the server did not fill the bucket" + guess + ")";
        }
        if (after.equals("bucket")) {
            if (ch.appeared().isEmpty()) return "poured (out of sight of the cells round the aim)";
            List<String> at = new ArrayList<>();
            for (Cell c : ch.appeared()) at.add(c.where());
            return "poured at " + String.join(" and ", at);
        }
        if (after.equals(held)) return "nothing happened (the server did not pour the " + held + guess + ")";
        return "nothing happened (the hand holds " + after + " now, not the " + held + ")";
    }

    private static boolean isFull(String item) {
        return item.endsWith("_bucket") && !item.equals("milk_bucket");
    }

    /** The full buckets anywhere in the inventory: a fill from a stack of empties puts its bucket in another slot. */
    static int fullBuckets(Inventory inv) {
        int n = 0;
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (!st.isEmpty() && isFull(Names.item(st))) n += st.getCount();
        }
        return n;
    }
}
