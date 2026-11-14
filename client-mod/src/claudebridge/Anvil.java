package claudebridge;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.AnvilMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.HashSet;
import java.util.Set;

import static claudebridge.Interact.click;
import static claudebridge.Interact.player;
import static claudebridge.Json.*;

/**
 * Anvils through the normal menu packets, the way the enchanting table is driven (Enchanting.java): open the anvil,
 * put the piece in its input slot and an enchanted book, the diamonds of a repair or a second piece in the other,
 * read the result and its cost as the server works them out, shift-click the result into the pockets (the server
 * takes the levels then, and may wear the anvil down a stage), close. The menu stays open between calls; anvil.close
 * shift-clicks whatever is still in it back into the pockets and closes it (container.close only closes it: the
 * server hands back what is left).
 */
public final class Anvil {
    private Anvil() { }

    /**
     * Menu slots (26.3 AnvilMenu, an ItemCombinerMenu: INPUT_SLOT 0, ADDITIONAL_SLOT 1, RESULT_SLOT 2, then
     * addStandardInventorySlots): 0 the piece, 1 the book or the repair material, 2 the result, then the player's 27
     * main slots and 9 hotbar slots.
     */
    static final int INPUT = 0, ADDITIONAL = 1, RESULT = 2, OWN_SLOTS = 3;
    /**
     * From this cost on the anvil refuses ("Too Expensive!"): AnvilMenu.createResult empties the result at 40 and up
     * outside creative, and leaves the cost showing.
     */
    static final int TOO_EXPENSIVE = 40;

    /** The anvil anvil.open last opened: anvil.take reads its block after a take (it may be chipped, damaged or gone). */
    private static BlockPos openAt;

    /** An anvil in any state of wear (the game's #anvil tag: it opens the same menu). */
    static boolean isAnvil(String block) {
        return block.equals("anvil") || block.equals("chipped_anvil") || block.equals("damaged_anvil");
    }

    /**
     * Whether the result can be taken: the menu's own rule (AnvilMenu.mayPickup: the cost above 0 and the level at
     * least the cost, or creative), a result there (none at 40 and up), and a free pocket slot for the shift-click.
     */
    static boolean canTake(boolean hasResult, int cost, int level, boolean infinite, boolean room) {
        return hasResult && room && cost > 0 && (infinite || level >= cost);
    }

    static AnvilMenu menu() {
        if (!(player().containerMenu instanceof AnvilMenu menu)) throw new IllegalStateException("no anvil open (anvil.open first)");
        return menu;
    }

    /** A slot's stack with what tells it from others of its name (enchantments, damage, repairCost), or null. */
    static JsonObject detail(ItemStack st) {
        return st.isEmpty() ? null : Handlers.withDetail(obj("name", Names.item(st), "count", st.getCount()), st);
    }

    /** What the anvil shows: the two inputs, the result and its cost, and whether it can be taken now. */
    static JsonObject status() {
        LocalPlayer pl = player();
        if (!(pl.containerMenu instanceof AnvilMenu menu)) return obj("open", false);
        ItemStack result = menu.getSlot(RESULT).getItem();
        int cost = menu.getCost();
        boolean room = pl.getInventory().getFreeSlot() >= 0;
        return obj("open", true, "input", detail(menu.getSlot(INPUT).getItem()), "additional", detail(menu.getSlot(ADDITIONAL).getItem()),
            "result", detail(result), "cost", cost, "tooExpensive", cost >= TOO_EXPENSIVE, "xpLevel", pl.experienceLevel,
            "canTake", canTake(!result.isEmpty(), cost, pl.experienceLevel, pl.hasInfiniteMaterials(), room));
    }

    public static void register(BridgeServer s) {
        s.register("anvil.status", true, (p, c) -> status());

        // an anvil, chipped_anvil or damaged_anvil within 4.5 blocks: right-click its top and wait for the menu
        s.register("anvil.open", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            String block = Names.block(mc.level.getBlockState(at));
            if (!isAnvil(block)) throw new IllegalArgumentException("no anvil at " + at.toShortString() + " (" + block + ")");
            Vec3 hit = Interact.faceCenter(at, Direction.UP); // the anvil's top is a full block high
            double d = pl.getEyePosition().distanceTo(hit);
            if (d > 4.5) throw new IllegalStateException("anvil too far to open (" + round(d) + " blocks, max 4.5)");
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, at, false));
            openAt = at.immutable();
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (m.player == null) { c.fail("not in a world"); return true; }
                    if (m.player.containerMenu instanceof AnvilMenu) {
                        JsonObject r = status();
                        r.addProperty("anvil", block);
                        c.ok(r);
                        return true;
                    }
                    if (++age > 40) { c.fail("the anvil did not open"); return true; }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // put `count` (default 1, at most a stack) of an item from the pockets into the anvil's `which` slot: the piece
        // into "input"; an enchanted book, the diamonds of a repair or a second piece into "additional". For a repair
        // put as many diamonds as it needs: the server uses no more than it takes to mend the piece, but each one used
        // is a level more. `slot` (inventory index 0-35) picks one of several by the name (Interact.pick): the first
        // diamond_pickaxe by name may be the mended one, the first enchanted_book the one with unbreaking; with no
        // `name`, whatever that slot holds. Whatever the anvil's slot held goes back to the pockets first. The server
        // works the result and its cost out a tick or two later: the reply waits for them
        s.register("anvil.put", true, (p, c) -> {
            LocalPlayer pl = player();
            AnvilMenu menu = menu();
            String which = required(p, "which");
            int target = switch (which) {
                case "input" -> INPUT;
                case "additional" -> ADDITIONAL;
                default -> throw new IllegalArgumentException("which must be input or additional");
            };
            int want = Math.max(1, Math.min(64, intParam(p, "count", 1)));
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the anvil first");
            var inv = pl.getInventory();
            int asked = intParam(p, "slot", -1);
            String named = strParam(p, "name", null);
            String name = named != null ? named.replace("minecraft:", "")
                : asked >= 0 && asked < 36 && !inv.getItem(asked).isEmpty() ? Names.item(inv.getItem(asked)) : null;
            if (name == null) throw new IllegalArgumentException("name, or a pocket slot (0-35) that holds something, required");
            if (Interact.pick(k -> Interact.nameOf(inv.getItem(k)), 36, name, -1) < 0) throw new IllegalArgumentException("no " + name + " in inventory");
            if (!menu.getSlot(target).getItem().isEmpty()) click(menu, target, 0, ContainerInput.QUICK_MOVE);
            if (!menu.getSlot(target).getItem().isEmpty()) throw new IllegalStateException("could not clear the anvil's " + which + " slot (inventory full?)");
            // looked up after the clearing: the slot may have moved if it was the one just taken out
            int i = Interact.pick(k -> Interact.nameOf(inv.getItem(k)), 36, name, asked);
            if (i < 0) throw new IllegalArgumentException("no " + name + " in inventory");
            int source = Interact.containerMenuSlot(OWN_SLOTS, i);
            click(menu, source, 0, ContainerInput.PICKUP); // carry the stack
            if (want >= menu.getCarried().getCount()) click(menu, target, 0, ContainerInput.PICKUP); // all of it
            else for (int n = 0; n < want; n++) click(menu, target, 1, ContainerInput.PICKUP); // one at a time
            if (!menu.getCarried().isEmpty()) click(menu, source, 0, ContainerInput.PICKUP); // the rest back
            JsonObject put = detail(menu.getSlot(target).getItem());
            // the result comes from the server: once it shows (or the cost says too expensive) and holds for 3 ticks;
            // with both slots filled and none after half a second, the two don't combine. With one slot empty there is
            // none to wait for
            Ticker.add(new Ticker.Task() {
                int age = 0, stable = 0;
                String last = "";
                @Override public boolean tick(Minecraft m) {
                    if (!(m.player != null && m.player.containerMenu instanceof AnvilMenu mm)) { c.fail("the anvil closed"); return true; }
                    age++;
                    ItemStack r = mm.getSlot(RESULT).getItem();
                    String now = (r.isEmpty() ? "-" : Names.item(r) + " x" + r.getCount()) + " @" + mm.getCost();
                    stable = now.equals(last) ? stable + 1 : 0;
                    last = now;
                    boolean both = !mm.getSlot(INPUT).getItem().isEmpty() && !mm.getSlot(ADDITIONAL).getItem().isEmpty();
                    boolean shown = !r.isEmpty() || mm.getCost() >= TOO_EXPENSIVE;
                    if ((age >= 3 && stable >= 2 && (shown || !both)) || age >= 10) {
                        JsonObject reply = status();
                        reply.addProperty("which", which);
                        reply.add("put", put == null ? com.google.gson.JsonNull.INSTANCE : put);
                        c.ok(reply);
                        return true;
                    }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // shift-click the result into the pockets: the server takes `cost` levels, uses up the piece and the book (or
        // as many diamonds as the repair took: the rest stay in the additional slot until the close hands them back),
        // and wears the anvil down a stage 12% of the time (AnvilMenu.onTake: anvil, chipped, damaged, gone). The
        // client's own menu does all that at once, ahead of the server: the reply waits half a second for the server
        // to put it right if it refused, then reads the pockets, the level and the anvil's block
        s.register("anvil.take", true, (p, c) -> {
            LocalPlayer pl = player();
            AnvilMenu menu = menu();
            ItemStack result = menu.getSlot(RESULT).getItem().copy();
            int cost = menu.getCost();
            if (result.isEmpty()) {
                throw new IllegalStateException(cost >= TOO_EXPENSIVE ? "too expensive (cost " + cost + "; the anvil refuses 40 and up)"
                    : "no result in the anvil (put the piece and the book or material first, or the two don't combine)");
            }
            boolean infinite = pl.hasInfiniteMaterials();
            if (!infinite && pl.experienceLevel < cost) throw new IllegalStateException("needs level " + cost + ", has " + pl.experienceLevel);
            if (pl.getInventory().getFreeSlot() < 0) throw new IllegalStateException("no free pocket slot for the " + Names.item(result));
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the anvil first");
            int levelBefore = pl.experienceLevel;
            int additionalBefore = menu.getSlot(ADDITIONAL).getItem().getCount();
            var inv = pl.getInventory();
            Set<Integer> already = new HashSet<>();
            for (int i = 0; i < 36; i++) if (ItemStack.isSameItemSameComponents(inv.getItem(i), result)) already.add(i);
            BlockPos at = openAt;
            click(menu, RESULT, 0, ContainerInput.QUICK_MOVE);
            // what the take used of the additional slot, as the client's menu worked it out with the click (onTake runs
            // on both sides): 1 book, or the diamonds the repair took
            int used = additionalBefore - menu.getSlot(ADDITIONAL).getItem().getCount();
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pp = m.player;
                    if (pp == null) { c.fail("not in a world"); return true; }
                    age++;
                    var in = pp.getInventory();
                    int slot = -1;
                    for (int i = 0; i < 36 && slot < 0; i++) if (!already.contains(i) && ItemStack.isSameItemSameComponents(in.getItem(i), result)) slot = i;
                    boolean open = pp.containerMenu instanceof AnvilMenu;
                    boolean stillThere = open && !((AnvilMenu) pp.containerMenu).getSlot(RESULT).getItem().isEmpty();
                    // the server's word: the piece in the pockets, the result slot empty, the levels gone (a refused take
                    // comes back as the result in its slot and the pockets without it)
                    boolean taken = slot >= 0 && !stillThere && (infinite || pp.experienceLevel < levelBefore);
                    if (age < 10 || (!taken && age < 30)) return false;
                    String block = at == null ? null : Names.block(m.level.getBlockState(at));
                    if (!taken) {
                        c.ok(obj("ok", false, "reason", "the server did not hand the result over", "item", Names.item(result), "cost", cost,
                            "levelBefore", levelBefore, "levelAfter", pp.experienceLevel, "anvil", block, "open", open));
                        return true;
                    }
                    JsonObject r = Handlers.withDetail(obj("ok", true, "item", Names.item(result), "count", result.getCount(), "slot", slot), result);
                    r.add("enchantments", Enchanting.enchantments(result)); // always there: [] for a plain piece
                    r.addProperty("cost", cost);
                    r.addProperty("used", used);
                    r.addProperty("levelBefore", levelBefore);
                    r.addProperty("levelAfter", pp.experienceLevel);
                    r.addProperty("anvil", block); // anvil, chipped_anvil, damaged_anvil, or air: worn out
                    r.addProperty("open", open);    // the server shuts the menu of an anvil that broke
                    c.ok(r);
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        s.register("anvil.close", true, (p, c) -> {
            LocalPlayer pl = player();
            boolean was = pl.containerMenu instanceof AnvilMenu;
            // the anvil only: the close of a run the brain gave up can come late, and must not shut the chest the next
            // job has open
            if (pl.containerMenu instanceof AnvilMenu menu) {
                // a job left untaken (no result, too dear, not wanted) still has the piece and the book or diamonds in
                // it: shift-clicked back into the pockets first, here and on the server alike. The game client's
                // AnvilMenu has no level access (ContainerLevelAccess.NULL), so its close hands nothing back; only the
                // server's does, a tick or more later, and the worn piece wearHeldAgain looks for at once was not
                // there yet ("not worn again: anvil.close put nothing on", then on again a second later)
                for (int k : new int[] { INPUT, ADDITIONAL }) if (!menu.getSlot(k).getItem().isEmpty()) click(menu, k, 0, ContainerInput.QUICK_MOVE);
                pl.closeContainer(); // the server hands back whatever found no room in the pockets
            }
            // a piece armor.unequip took off for the anvil goes back on now, mended or with its book if it took
            return obj("ok", true, "wasOpen", was, "wore", Guardian.wearHeldAgain(pl, "anvil"));
        });
    }
}
