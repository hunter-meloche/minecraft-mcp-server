package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.EnchantmentMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.EnchantmentHelper;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.List;
import java.util.Set;

import static claudebridge.Interact.click;
import static claudebridge.Interact.player;
import static claudebridge.Json.*;

/**
 * Enchanting tables through the normal menu packets: open the table, put an item and lapis in, read the three offers the
 * server syncs (cost, clue enchantment and its level, as the screen shows them), press an offer's button, take the item
 * back. The menu stays open between calls; enchant.close (or container.close) closes it, and the server hands back
 * whatever is still in the table.
 */
public final class Enchanting {
    private Enchanting() { }

    /** Menu slots: 0 the item, 1 the lapis, then the player's 27 main slots and 9 hotbar slots. */
    private static final int ITEM = 0, LAPIS = 1, OWN_SLOTS = 2;

    static EnchantmentMenu menu() {
        if (!(player().containerMenu instanceof EnchantmentMenu menu)) throw new IllegalStateException("no enchanting table open (enchant.open first)");
        return menu;
    }

    static String enchantName(Minecraft mc, int id) {
        if (id < 0) return null;
        return mc.level.registryAccess().lookupOrThrow(Registries.ENCHANTMENT).get(id)
            .map(h -> Names.strip(h.getRegisteredName())).orElse(null);
    }

    static JsonArray enchantments(ItemStack st) {
        JsonArray out = new JsonArray();
        // getEnchantmentsForCrafting: an enchanted book's stored enchantments, otherwise the item's own
        for (var en : EnchantmentHelper.getEnchantmentsForCrafting(st).entrySet()) {
            out.add(obj("name", Names.strip(en.getKey().getRegisteredName()), "level", en.getIntValue()));
        }
        return out;
    }

    static int lapisInInventory(LocalPlayer pl) {
        int n = 0;
        for (int i = 0; i < 36; i++) {
            ItemStack st = pl.getInventory().getItem(i);
            if (!st.isEmpty() && Names.item(st).equals("lapis_lazuli")) n += st.getCount();
        }
        return n;
    }

    /** What the table shows: the item and lapis in it, the three offers, and the player's level. */
    static JsonObject status() {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer pl = player();
        if (!(pl.containerMenu instanceof EnchantmentMenu menu)) return obj("open", false);
        ItemStack item = menu.getSlot(ITEM).getItem();
        int lapis = menu.getGoldCount();
        boolean creative = pl.getAbilities().instabuild;
        JsonArray offers = new JsonArray();
        for (int i = 0; i < 3; i++) {
            int cost = menu.costs[i];
            String clue = enchantName(mc, menu.enchantClue[i]);
            // the server's own checks in EnchantmentMenu.clickMenuButton: lapis >= slot+1 and level >= cost (and >= slot+1)
            boolean can = cost > 0 && !item.isEmpty() && (creative || (lapis >= i + 1 && pl.experienceLevel >= cost && pl.experienceLevel >= i + 1));
            offers.add(obj("slot", i, "cost", cost, "enchant", clue, "level", clue == null ? null : menu.levelClue[i],
                "lapisCost", i + 1, "levelsTaken", i + 1, "available", can));
        }
        return obj("open", true, "item", Interact.stack(item), "lapis", lapis, "offers", offers,
            "xpLevel", pl.experienceLevel, "lapisInInventory", lapisInInventory(pl));
    }

    public static void register(BridgeServer s) {
        s.register("enchant.status", true, (p, c) -> status());

        s.register("enchant.open", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            String block = Names.block(mc.level.getBlockState(at));
            if (!block.equals("enchanting_table")) throw new IllegalArgumentException("no enchanting_table at " + at.toShortString() + " (" + block + ")");
            Vec3 hit = Vec3.atBottomCenterOf(at).add(0, 0.75, 0); // the table's top is 12/16 high
            if (pl.getEyePosition().distanceTo(hit) > 4.5) throw new IllegalStateException("enchanting table too far to open (" + round(pl.getEyePosition().distanceTo(hit)) + " blocks, max 4.5)");
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, at, false));
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (m.player == null) { c.fail("not in a world"); return true; }
                    if (m.player.containerMenu instanceof EnchantmentMenu) { c.ok(status()); return true; }
                    if (++age > 40) { c.fail("the enchanting table did not open"); return true; }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // put an item (one; from inventory index `slot` if given and it holds that item) into the table and top the
        // lapis slot up (to `lapis`, default 3), then read the offers. Lapis goes in here: a second put of lapis_lazuli
        // would clear the item slot and set lapis in it
        s.register("enchant.put", true, (p, c) -> {
            LocalPlayer pl = player();
            EnchantmentMenu menu = menu();
            String name = required(p, "name").replace("minecraft:", "");
            int lapisWanted = Math.max(0, Math.min(64, intParam(p, "lapis", 3)));
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the menu first");
            var inv = pl.getInventory();
            if (Interact.pick(k -> Interact.nameOf(inv.getItem(k)), 36, name, -1) < 0) throw new IllegalArgumentException("no " + name + " in inventory");
            // whatever is in the item slot goes back to the inventory first
            if (!menu.getSlot(ITEM).getItem().isEmpty()) click(menu, ITEM, 0, ContainerInput.QUICK_MOVE);
            if (!menu.getSlot(ITEM).getItem().isEmpty()) throw new IllegalStateException("could not clear the item slot (inventory full?)");
            // `slot` (inventory index 0-35) picks one of several by the same name: the first diamond_pickaxe by name
            // may be the one already enchanted, which gets no offers (looked up after the clearing: the slot may have
            // moved if it was the one just taken out)
            int i = Interact.pick(k -> Interact.nameOf(inv.getItem(k)), 36, name, intParam(p, "slot", -1));
            if (i < 0) throw new IllegalArgumentException("no " + name + " in inventory");
            String put = Names.item(pl.getInventory().getItem(i));
            int source = Interact.containerMenuSlot(OWN_SLOTS, i);
            click(menu, source, 0, ContainerInput.PICKUP); // carry the stack
            click(menu, ITEM, 1, ContainerInput.PICKUP);   // drop one (the slot holds one item)
            if (!menu.getCarried().isEmpty()) click(menu, source, 0, ContainerInput.PICKUP); // the rest back
            // lapis: one at a time from the inventory until the slot holds lapisWanted (or the lapis runs out)
            for (int k = 0; k < 36 && menu.getGoldCount() < lapisWanted; k++) {
                ItemStack st = pl.getInventory().getItem(k);
                if (st.isEmpty() || !Names.item(st).equals("lapis_lazuli")) continue;
                int from = Interact.containerMenuSlot(OWN_SLOTS, k);
                click(menu, from, 0, ContainerInput.PICKUP);
                while (!menu.getCarried().isEmpty() && menu.getGoldCount() < lapisWanted) {
                    int before = menu.getGoldCount();
                    click(menu, LAPIS, 1, ContainerInput.PICKUP);
                    if (menu.getGoldCount() == before) break;
                }
                if (!menu.getCarried().isEmpty()) click(menu, from, 0, ContainerInput.PICKUP);
            }
            // the offers come from the server (it rolls them from the enchantment seed and the bookshelves) a tick or
            // two later: wait until a cost shows up, or give up after a second (an item that can't be enchanted)
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (!(m.player != null && m.player.containerMenu instanceof EnchantmentMenu mm)) { c.fail("the enchanting table closed"); return true; }
                    age++;
                    boolean synced = mm.costs[0] > 0 || mm.costs[1] > 0 || mm.costs[2] > 0;
                    if ((synced && age >= 3) || age >= 20) {
                        JsonObject r = status();
                        r.addProperty("put", put);
                        r.addProperty("enchantable", synced);
                        c.ok(r);
                        return true;
                    }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // press an offer's button (slot 0-2), wait for the enchanted item, shift-click it back into the inventory
        s.register("enchant.choose", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            EnchantmentMenu menu = menu();
            int slot = Integer.parseInt(required(p, "slot"));
            if (slot < 0 || slot > 2) throw new IllegalArgumentException("slot must be 0, 1 or 2");
            ItemStack before = menu.getSlot(ITEM).getItem().copy();
            if (before.isEmpty()) throw new IllegalStateException("no item in the table (enchant.put first)");
            int cost = menu.costs[slot];
            if (cost <= 0) throw new IllegalStateException("offer " + slot + " is empty (not enchantable, or too few bookshelves for this slot)");
            boolean creative = pl.getAbilities().instabuild;
            if (!creative && menu.getGoldCount() < slot + 1) throw new IllegalStateException("needs " + (slot + 1) + " lapis_lazuli in the table, has " + menu.getGoldCount());
            if (!creative && pl.experienceLevel < cost) throw new IllegalStateException("needs level " + cost + ", has " + pl.experienceLevel);
            int levelBefore = pl.experienceLevel;
            String clue = enchantName(mc, menu.enchantClue[slot]);
            mc.gameMode.handleInventoryButtonClick(menu.containerId, slot);
            Ticker.add(new Ticker.Task() {
                int age = 0;
                boolean taken = false;
                ItemStack result = ItemStack.EMPTY;
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pp = m.player;
                    if (pp == null) { c.fail("not in a world"); return true; }
                    if (!(pp.containerMenu instanceof EnchantmentMenu mm)) { c.fail("the enchanting table closed"); return true; }
                    age++;
                    if (!taken) {
                        ItemStack now = mm.getSlot(ITEM).getItem();
                        boolean enchanted = !now.isEmpty() && EnchantmentHelper.hasAnyEnchantments(now);
                        if (!enchanted && age < 20) return false;
                        if (!enchanted) {
                            c.ok(obj("ok", false, "reason", "the server did not enchant it", "item", Interact.stack(now), "levelBefore", levelBefore,
                                "levelAfter", pp.experienceLevel));
                            return true;
                        }
                        result = now.copy();
                        click(mm, ITEM, 0, ContainerInput.QUICK_MOVE);
                        taken = true;
                        age = 0;
                        return false;
                    }
                    if (age < 3) return false; // let the server confirm the shift-click
                    c.ok(obj("ok", true, "item", Names.item(result), "enchantments", enchantments(result), "clue", clue,
                        "inInventory", mm.getSlot(ITEM).getItem().isEmpty(), "levelBefore", levelBefore, "levelAfter", pp.experienceLevel,
                        "lapisLeft", mm.getGoldCount()));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        s.register("enchant.close", true, (p, c) -> {
            LocalPlayer pl = player();
            boolean was = pl.containerMenu instanceof EnchantmentMenu;
            // the table only: the close of a run the brain gave up can come late (it waited on enchant.choose), and
            // must not shut the chest the next job has open
            if (was) pl.closeContainer(); // the server returns the item and lapis left in it
            // the table has had the piece armor.unequip took off (or the run gave up): put it back on now, the
            // enchanted piece if it took, not when the Guardian next looks. With auto-defend off its gear check never
            // runs, and the chore would take all four pieces off, one a run, with nothing to wear them again
            Set<Integer> held = Guardian.releaseGear();
            JsonArray wore = new JsonArray();
            if (!held.isEmpty() && pl.containerMenu == pl.inventoryMenu) {
                for (String n : Combat.equipBestArmor(true, held)) wore.add(n);
                // a piece still in the table (no offer) comes back from the server a tick or two after the close
                Ticker.add(new Ticker.Task() {
                    int age;
                    @Override public boolean tick(Minecraft mc) {
                        if (++age % 10 != 0) return false;
                        LocalPlayer me = mc.player;
                        if (me != null && me.containerMenu == me.inventoryMenu) {
                            List<String> put = Combat.equipBestArmor(true, held);
                            if (!put.isEmpty()) Guardian.note("put on " + String.join(", ", put) + " (back from the table)");
                        }
                        return age >= 40;
                    }
                });
            }
            return obj("ok", true, "wasOpen", was, "wore", wore);
        });
    }
}
