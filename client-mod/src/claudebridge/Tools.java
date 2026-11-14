package claudebridge;

import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ContainerInput;

import java.util.ArrayList;
import java.util.List;

/**
 * Keeps the best shovel, axe and sword in the hotbar. Baritone's auto-tool only picks from the hotbar and only keeps a
 * pickaxe there (slot 0), so with the shovel in the backpack it dug dirt with a diamond pickaxe. Uses slots 1-7, never
 * Baritone's slot 0 (pickaxe) or 8 (building blocks).
 */
public final class Tools {
    private Tools() { }

    private static final String[] KINDS = {"shovel", "axe", "sword"};

    static String kindOf(String item) {
        if (item.endsWith("_shovel")) return "shovel";
        if (item.endsWith("_axe")) return "axe"; // not _pickaxe: that ends with "_pickaxe"
        if (item.endsWith("_sword")) return "sword";
        if (item.endsWith("_pickaxe")) return "pickaxe";
        if (item.endsWith("_hoe")) return "hoe";
        return null;
    }

    /** Material rank: gold digs fast but wears out in 32 uses, so it ranks below stone. */
    static int tier(String item) {
        if (item.startsWith("netherite_")) return 6;
        if (item.startsWith("diamond_")) return 5;
        if (item.startsWith("iron_")) return 4;
        if (item.startsWith("stone_")) return 3;
        if (item.startsWith("golden_")) return 2;
        if (item.startsWith("wooden_")) return 1;
        return 0;
    }

    /**
     * The hotbar slot to break `state` with: the item that breaks it fastest (a real gain over the bare hand), the
     * cheaper tier on a tie; with no such tool, an item that doesn't wear (an empty hand, blocks, food), since a
     * pickaxe on dirt or a shovel on stone is no faster than a fist and only loses durability. Swords only for what
     * they cut fast (cobwebs). -1: leave the hand as it is (every hotbar slot holds a tool and none helps).
     */
    public static int slotFor(Inventory inv, net.minecraft.world.level.block.state.BlockState state) {
        int best = -1;
        float bestSpeed = 1.0f;
        int bestTier = Integer.MAX_VALUE;
        for (int i = 0; i < 9; i++) {
            var st = inv.getItem(i);
            if (st.isEmpty()) continue;
            float speed = st.getDestroySpeed(state);
            String n = Names.item(st);
            if ("sword".equals(kindOf(n)) && speed < 10f) continue;
            if (state.requiresCorrectToolForDrops() && !st.isCorrectToolForDrops(state)) continue; // breaks it, drops nothing
            if (speed <= 1.0f) continue;
            int t = tier(n);
            if (speed > bestSpeed || (speed == bestSpeed && t < bestTier)) { best = i; bestSpeed = speed; bestTier = t; }
        }
        if (best >= 0) return best;
        // no tool for it: the hand, or anything that doesn't wear out; but not a full bucket or a fire starter (Hazards):
        // a bucket wears no more than a fist, so grass dug on the way would keep the water bucket in hand, or take one
        // up, for the walk that follows (the walks with a full bucket in hand are what poured it at the doors)
        int sel = inv.getSelectedSlot();
        if (!inv.getItem(sel).isDamageableItem() && !Hazards.isHazard(Names.item(inv.getItem(sel)))) return sel;
        for (int i = 0; i < 9; i++) if (inv.getItem(i).isEmpty()) return i;
        for (int i = 0; i < 9; i++) if (!inv.getItem(i).isDamageableItem() && !Hazards.isHazard(Names.item(inv.getItem(i)))) return i;
        return -1;
    }

    /** Hold the right thing for the block about to be (or being) broken; called as each dig starts and goes on. */
    public static void holdFor(net.minecraft.core.BlockPos pos) {
        var mc = net.minecraft.client.Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;
        Inventory inv = mc.player.getInventory();
        int slot = slotFor(inv, mc.level.getBlockState(pos));
        if (slot >= 0 && slot != inv.getSelectedSlot()) inv.setSelectedSlot(slot);
    }

    /** Move the best tool of each kind into the hotbar if it isn't there; returns what moved. */
    static List<String> keepInHotbar(LocalPlayer p) {
        List<String> moved = new ArrayList<>();
        if (p.containerMenu != p.inventoryMenu) return moved;
        Inventory inv = p.getInventory();
        for (String kind : KINDS) {
            int best = -1, bestTier = -1;
            for (int i = 0; i < 36; i++) {
                var st = inv.getItem(i);
                if (st.isEmpty()) continue;
                String n = Names.item(st);
                if (!kind.equals(kindOf(n))) continue;
                int t = tier(n);
                if (t > bestTier || (t == bestTier && i < 9 && best >= 9)) { best = i; bestTier = t; }
            }
            if (best < 0 || (best >= 1 && best <= 7)) continue; // none, or already where Baritone can use it
            int target = -1;
            for (int k = 1; k <= 7 && target < 0; k++) if (inv.getItem(k).isEmpty()) target = k;
            for (int k = 1; k <= 7 && target < 0; k++) {
                // a hotbar slot holding something that isn't a tool (blocks, food, ...), and not the one in hand
                if (k != inv.getSelectedSlot() && kindOf(Names.item(inv.getItem(k))) == null) target = k;
            }
            if (target < 0) continue;
            Interact.click(p.inventoryMenu, Interact.inventoryMenuSlot(best), target, ContainerInput.SWAP);
            moved.add(Names.item(inv.getItem(target)));
        }
        return moved;
    }
}
