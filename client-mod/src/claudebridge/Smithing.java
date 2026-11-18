package claudebridge;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.SmithingMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.HashSet;
import java.util.Set;

import static claudebridge.Interact.click;
import static claudebridge.Interact.player;
import static claudebridge.Json.*;

/**
 * Smithing tables through the normal menu packets, the way the anvil is driven (Anvil.java): open the table, put the
 * template, the base piece and the addition in, read the result as the server works it out, shift-click it into the
 * pockets, close. For the netherite upgrade (P6 of the progression plan): the netherite_upgrade_smithing_template, a
 * diamond piece and a netherite_ingot give the netherite piece.
 *
 * Checked against the 26.3 jar. The upgrade is data driven (data/minecraft/recipe/netherite_chestplate_smithing.json
 * and the rest: type minecraft:smithing_transform, the template, a diamond base, the addition #netherite_tool_materials,
 * which holds netherite_ingot alone), and SmithingTransformRecipe.assemble builds the result with the base's own
 * components (TransmuteRecipe.createWithOriginalComponents): the enchantments, the damage and the anvil's repair cost
 * all carry over. The take uses one of each of the three (SmithingMenu.onTake shrinks every input slot by one). The
 * menu works its result out on the server only (createResult asks a ServerLevel's recipes; the game client's menu
 * clears it on every change), so the result shows a round trip after each put; a table with all three filled and no
 * result says so in a data slot (hasRecipeError). Unlike the anvil there are no levels to pay and no wear.
 *
 * The menu stays open between calls; smith.close shift-clicks whatever is still in it back into the pockets and
 * closes it (the client's menu has no level access, so its own close hands nothing back: only the server's does, a
 * tick or more later), and puts back on a piece armor.unequip took off for it (Guardian.wearHeldAgain).
 */
public final class Smithing {
    private Smithing() { }

    /**
     * Menu slots (26.3 SmithingMenu, an ItemCombinerMenu: TEMPLATE_SLOT 0, BASE_SLOT 1, ADDITIONAL_SLOT 2, RESULT_SLOT
     * 3, then addStandardInventorySlots): 0 the template, 1 the base piece, 2 the addition (the ingot), 3 the result,
     * then the player's 27 main slots and 9 hotbar slots. Each input slot takes only what the synced recipe property
     * sets allow (RecipePropertySet SMITHING_TEMPLATE, SMITHING_BASE, SMITHING_ADDITION: the slot's mayPlace).
     */
    static final int TEMPLATE = 0, BASE = 1, ADDITION = 2, RESULT = 3, OWN_SLOTS = 4;

    /**
     * Ticks a put waits at most for the server's result once all three are in: the game client's menu empties the
     * result on every click (it has no recipes to work it out from), and the server's comes a round trip and a tick
     * later. The anvil's 10 (Anvil.java) were enough there only because its client works the result out itself.
     */
    static final int RESULT_TICKS = 20;
    /**
     * The fewest ticks a put waits once all three are in: the "no recipe" data slot the client still shows may be the
     * server's word on what the table held before this put (a replaced base), and the new word is a round trip away.
     */
    static final int MIN_FULL_TICKS = 6;

    /** The table smith.open last opened, for the replies. */
    private static BlockPos openAt;

    /** Which of the table's slots a put goes into, pure: "template", "base" or "addition"; anything else is refused. */
    static int target(String which) {
        if (which == null) throw new IllegalArgumentException("which required: template, base or addition");
        return switch (which) {
            case "template" -> TEMPLATE;
            case "base" -> BASE;
            case "addition" -> ADDITION;
            default -> throw new IllegalArgumentException("which must be template, base or addition, not " + which);
        };
    }

    /** A slot's name in the replies. */
    static String slotName(int k) {
        return switch (k) {
            case TEMPLATE -> "template";
            case BASE -> "base";
            case ADDITION -> "addition";
            default -> "result";
        };
    }

    /**
     * Why a put is refused, pure, or null when it may go: the table's own rule for the slot ({@code mayPlace}: the
     * menu's slot, read from the recipe property sets the server synced), never a list of names of our own.
     */
    static String refusal(int target, String item, boolean mayPlace) {
        if (mayPlace) return null;
        return switch (target) {
            case TEMPLATE -> "no smithing recipe takes " + item + " as its template (netherite_upgrade_smithing_template, an armor trim)";
            case BASE -> "no smithing recipe takes " + item + " as its base (the netherite upgrade takes a diamond piece)";
            default -> "no smithing recipe takes " + item + " as its addition (netherite_ingot, a trim material)";
        };
    }

    /**
     * Whether a put's reply may go at this tick, pure. With a slot still empty there is no result to wait for: the
     * slots unchanged for 2 ticks from the 3rd on (or 10 at most). With all three in: the server's word, a result or
     * its "no recipe", unchanged for 2 ticks and not before MIN_FULL_TICKS, or RESULT_TICKS at most.
     */
    static boolean answered(int age, int stable, boolean all, boolean shown) {
        if (!all) return (age >= 3 && stable >= 2) || age >= 10;
        return (age >= MIN_FULL_TICKS && stable >= 2 && shown) || age >= RESULT_TICKS;
    }

    /** Whether the result can be taken, pure: one there (the server's), and a free pocket slot for the shift-click. */
    static boolean canTake(boolean hasResult, boolean room) {
        return hasResult && room;
    }

    /**
     * Why a take is refused for what the result is, pure, or null: with {@code expect} given, a result of another name
     * (an armor trim where the brain wanted the netherite piece) is left where it is.
     */
    static String wrongResult(String expect, String result) {
        if (expect == null || expect.equals(result)) return null;
        return "the result is " + result + ", not the " + expect + " asked for";
    }

    /**
     * The pocket slot a put takes from, pure, or -1: with a pocket slot asked for (0-35), that slot and no other, only
     * while it holds the name; with none, the first slot of the name. Never another piece of the name in its place: the
     * Guardian wears a piece armor.unequip took off again while the bot is hurt, and Interact.pick's fall back would
     * then put a spare diamond piece of that name in (an old fire-protection one, a cursed one) and spend the template
     * and the ingot on it, the protection 4 piece never smithed.
     */
    static int source(java.util.function.IntFunction<String> nameAt, String name, int asked) {
        if (asked >= 0 && asked < 36) return name.equals(nameAt.apply(asked)) ? asked : -1;
        return Interact.pick(nameAt, 36, name, -1);
    }

    /** What a put says when {@link #source} finds nothing (it holds "no <name> in inventory": the brain reads that). */
    static String noSource(String name, int asked) {
        return "no " + name + " in inventory" + (asked >= 0 && asked < 36 ? " slot " + asked : "");
    }

    static SmithingMenu menu() {
        if (!(player().containerMenu instanceof SmithingMenu menu)) throw new IllegalStateException("no smithing table open (smith.open first)");
        return menu;
    }

    /** A slot's stack with what tells it from others of its name (enchantments, damage, repairCost), or JSON null. */
    static com.google.gson.JsonElement detail(ItemStack st) {
        return st.isEmpty() ? JsonNull.INSTANCE : Handlers.withDetail(obj("name", Names.item(st), "count", st.getCount()), st);
    }

    static int freePockets(LocalPlayer pl) {
        int n = 0;
        for (int i = 0; i < 36; i++) if (pl.getInventory().getItem(i).isEmpty()) n++;
        return n;
    }

    /**
     * What the table shows, as the server synced it: the three inputs, the result, {@code noRecipe} (all three in and
     * no recipe takes them: the menu's hasRecipeError, the server's word), whether the result can be taken now, and
     * the free pocket slots.
     */
    static JsonObject status() {
        LocalPlayer pl = player();
        if (!(pl.containerMenu instanceof SmithingMenu menu)) return obj("open", false);
        ItemStack result = menu.getSlot(RESULT).getItem();
        int free = freePockets(pl);
        return obj("open", true, "at", openAt == null ? null : pos(openAt), "template", detail(menu.getSlot(TEMPLATE).getItem()),
            "base", detail(menu.getSlot(BASE).getItem()), "addition", detail(menu.getSlot(ADDITION).getItem()), "result", detail(result),
            "noRecipe", menu.hasRecipeError(), "canTake", canTake(!result.isEmpty(), free > 0), "freePockets", free);
    }

    public static void register(BridgeServer s) {
        s.register("smith.status", true, (p, c) -> status());

        // a smithing_table within 4.5 blocks: right-click its top and wait for the menu. Any hand will do: the table's
        // own use takes the click first (Hazards.TAKES_CLICK), but not a sneaking one
        s.register("smith.open", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            String block = Names.block(mc.level.getBlockState(at));
            if (!block.equals("smithing_table")) throw new IllegalArgumentException("no smithing_table at " + at.toShortString() + " (" + block + ")");
            Vec3 hit = Interact.faceCenter(at, Direction.UP); // a full block: its top
            double d = pl.getEyePosition().distanceTo(hit);
            if (d > 4.5) throw new IllegalStateException("smithing table too far to open (" + round(d) + " blocks, max 4.5)");
            // a sneaking click with something in hand skips the table's own use and goes to the item
            if (pl.isShiftKeyDown() || mc.options.keyShift.isDown()) throw new IllegalStateException("sneaking: the click would go to the item in hand, not the table");
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, at, false));
            openAt = at.immutable();
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (m.player == null) { c.fail("not in a world"); return true; }
                    // a tick or two more for the data slot (no recipe), which comes after the menu's contents
                    if (m.player.containerMenu instanceof SmithingMenu) {
                        if (++age >= 2) {
                            JsonObject r = status();
                            r.addProperty("block", block);
                            c.ok(r);
                            return true;
                        }
                        return false;
                    }
                    if (++age > 40) { c.fail("the smithing table did not open"); return true; }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // put `count` (default 1, at most a stack) of an item from the pockets into the table's `which` slot: the
        // netherite_upgrade_smithing_template into "template", the diamond piece into "base", the netherite_ingot into
        // "addition". `slot` (inventory index 0-35) is the one taken from (source: that slot only, never another of
        // the name): the piece armor.unequip just took off, not a spare of its name; with no `name`, whatever that slot
        // holds. Refused before anything moves when the table's slot does not take the item (its mayPlace). Whatever the
        // slot held goes back to the pockets first. The server works the result out a round trip later: with all three in, the reply waits
        // for it or the server's "no recipe" (answered)
        s.register("smith.put", true, (p, c) -> {
            LocalPlayer pl = player();
            SmithingMenu menu = menu();
            int target = target(strParam(p, "which", null));
            int want = Math.max(1, Math.min(64, intParam(p, "count", 1)));
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the smithing table first");
            var inv = pl.getInventory();
            int asked = intParam(p, "slot", -1);
            String named = strParam(p, "name", null);
            String name = named != null ? named.replace("minecraft:", "")
                : asked >= 0 && asked < 36 && !inv.getItem(asked).isEmpty() ? Names.item(inv.getItem(asked)) : null;
            if (name == null) throw new IllegalArgumentException("name, or a pocket slot (0-35) that holds something, required");
            int i = source(k -> Interact.nameOf(inv.getItem(k)), name, asked);
            if (i < 0) throw new IllegalArgumentException(noSource(name, asked));
            String why = refusal(target, name, menu.getSlot(target).mayPlace(inv.getItem(i)));
            if (why != null) throw new IllegalStateException(why);
            if (!menu.getSlot(target).getItem().isEmpty()) click(menu, target, 0, ContainerInput.QUICK_MOVE);
            if (!menu.getSlot(target).getItem().isEmpty()) throw new IllegalStateException("could not clear the table's " + slotName(target) + " slot (inventory full?)");
            // looked up after the clearing: the slot may have moved if it was the one just taken out
            i = source(k -> Interact.nameOf(inv.getItem(k)), name, asked);
            if (i < 0) throw new IllegalArgumentException(noSource(name, asked));
            int source = Interact.containerMenuSlot(OWN_SLOTS, i);
            click(menu, source, 0, ContainerInput.PICKUP); // carry the stack
            if (want >= menu.getCarried().getCount()) click(menu, target, 0, ContainerInput.PICKUP); // all of it
            else for (int n = 0; n < want; n++) click(menu, target, 1, ContainerInput.PICKUP); // one at a time
            if (!menu.getCarried().isEmpty()) click(menu, source, 0, ContainerInput.PICKUP); // the rest back
            com.google.gson.JsonElement put = detail(menu.getSlot(target).getItem());
            Ticker.add(new Ticker.Task() {
                int age = 0, stable = 0;
                String last = "";
                @Override public boolean tick(Minecraft m) {
                    if (!(m.player != null && m.player.containerMenu instanceof SmithingMenu mm)) { c.fail("the smithing table closed"); return true; }
                    age++;
                    ItemStack r = mm.getSlot(RESULT).getItem();
                    boolean all = true;
                    StringBuilder seen = new StringBuilder();
                    for (int k = 0; k < RESULT; k++) {
                        ItemStack st = mm.getSlot(k).getItem();
                        all &= !st.isEmpty();
                        seen.append(st.isEmpty() ? "-" : Names.item(st) + " x" + st.getCount()).append('|');
                    }
                    seen.append(r.isEmpty() ? "-" : Names.item(r)).append(mm.hasRecipeError() ? " no recipe" : "");
                    stable = seen.toString().equals(last) ? stable + 1 : 0;
                    last = seen.toString();
                    if (answered(age, stable, all, !r.isEmpty() || mm.hasRecipeError())) {
                        JsonObject reply = status();
                        reply.addProperty("which", slotName(target));
                        reply.add("put", put);
                        c.ok(reply);
                        return true;
                    }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // shift-click the result into the pockets: the server uses one template, the base piece and one ingot
        // (SmithingMenu.onTake). `expect` (an item name): take it only if the result is that (a trim template left in
        // would trim the piece instead). The client's menu does the take at once, ahead of the server: the reply waits
        // half a second for the server to put it right if it refused, then reads the pockets: the piece by its slot,
        // with the enchantments it kept
        s.register("smith.take", true, (p, c) -> {
            LocalPlayer pl = player();
            SmithingMenu menu = menu();
            ItemStack result = menu.getSlot(RESULT).getItem().copy();
            if (result.isEmpty()) {
                throw new IllegalStateException(menu.hasRecipeError() ? "no smithing recipe takes the " + Names.item(menu.getSlot(BASE).getItem())
                    + " with what else is in the table" : "no result in the smithing table (put the template, the piece and the ingot first)");
            }
            String expect = strParam(p, "expect", null);
            String wrong = wrongResult(expect == null ? null : expect.replace("minecraft:", ""), Names.item(result));
            if (wrong != null) throw new IllegalStateException(wrong);
            if (freePockets(pl) == 0) throw new IllegalStateException("no free pocket slot for the " + Names.item(result));
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the smithing table first");
            String from = Names.item(menu.getSlot(BASE).getItem());
            var inv = pl.getInventory();
            Set<Integer> already = new HashSet<>();
            for (int i = 0; i < 36; i++) if (ItemStack.isSameItemSameComponents(inv.getItem(i), result)) already.add(i);
            click(menu, RESULT, 0, ContainerInput.QUICK_MOVE);
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pp = m.player;
                    if (pp == null) { c.fail("not in a world"); return true; }
                    age++;
                    var in = pp.getInventory();
                    int slot = -1;
                    for (int i = 0; i < 36 && slot < 0; i++) if (!already.contains(i) && ItemStack.isSameItemSameComponents(in.getItem(i), result)) slot = i;
                    boolean open = pp.containerMenu instanceof SmithingMenu;
                    boolean stillThere = open && !((SmithingMenu) pp.containerMenu).getSlot(RESULT).getItem().isEmpty();
                    // the server's word: the piece in the pockets and the result slot empty (a refused take comes back
                    // as the result in its slot, the base in its own, and the pockets without the new piece)
                    boolean taken = slot >= 0 && !stillThere;
                    if (age < 10 || (!taken && age < 30)) return false;
                    if (!taken) {
                        c.ok(obj("ok", false, "reason", "the server did not hand the result over", "item", Names.item(result), "from", from, "open", open));
                        return true;
                    }
                    JsonObject r = Handlers.withDetail(obj("ok", true, "item", Names.item(result), "count", result.getCount(), "slot", slot), result);
                    r.add("enchantments", Enchanting.enchantments(result)); // always there: [] for a plain piece
                    r.addProperty("from", from);
                    r.addProperty("open", open);
                    c.ok(r);
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        s.register("smith.close", true, (p, c) -> {
            LocalPlayer pl = player();
            boolean was = pl.containerMenu instanceof SmithingMenu;
            // the smithing table only: the close of a run the brain gave up can come late, and must not shut the chest
            // the next job has open
            if (pl.containerMenu instanceof SmithingMenu menu) {
                // a job left untaken (no recipe, not wanted) still has the template, the piece and the ingot in it:
                // shift-clicked back into the pockets first, here and on the server alike. The game client's menu has
                // no level access (ContainerLevelAccess.NULL), so its close hands nothing back; only the server's does,
                // a tick or more later, and the piece wearHeldAgain looks for at once would not be there yet (the
                // anvil's "not worn again: anvil.close put nothing on")
                for (int k : new int[] { TEMPLATE, BASE, ADDITION }) if (!menu.getSlot(k).getItem().isEmpty()) click(menu, k, 0, ContainerInput.QUICK_MOVE);
                pl.closeContainer(); // the server hands back whatever found no room in the pockets
            }
            // a piece armor.unequip took off for the table goes back on now: the netherite piece if the take went
            // through (Combat.armorRank: netherite outranks diamond), the diamond one if not
            return obj("ok", true, "wasOpen", was, "wore", Guardian.wearHeldAgain(pl, "smithing table"));
        });
    }
}
