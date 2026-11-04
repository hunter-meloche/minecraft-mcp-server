package claudebridge;

import com.google.gson.JsonObject;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.StackedItemContents;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.AbstractFurnaceMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.display.RecipeDisplayEntry;
import net.minecraft.world.item.crafting.display.ShapedCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.ShapelessCraftingRecipeDisplay;
import net.minecraft.world.item.crafting.display.SlotDisplayContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

import static claudebridge.Json.*;

/**
 * Hands-on interaction through the normal client paths (the same packets a player's clicks send): selecting and
 * equipping items, looking, moving keys, placing, digging (Baritone walks into reach), eating, crafting via the
 * recipe book, and furnace menus.
 */
public final class Interact {
    private Interact() { }

    // Right-clicking these uses them instead of placing against them (same list as the Node side).
    private static final Pattern ACTIVATABLE = Pattern.compile(
        "^(crafting_table|crafter|(blast_)?furnace|smoker|(trapped_)?chest|ender_chest|barrel|.*shulker_box|hopper|dispenser|dropper|brewing_stand|"
            + "enchanting_table|(chipped_|damaged_)?anvil|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|beacon|"
            + "bell|note_block|jukebox|lever|respawn_anchor|.*_(door|trapdoor|fence_gate|bed|button|sign|hanging_sign))$");

    static LocalPlayer player() {
        return Handlers.player();
    }

    /** An item is being used through the bridge ("use"/eating): reflexes keep their hands off the use key. */
    static volatile boolean using;

    static boolean isActivatable(String blockName) {
        return ACTIVATABLE.matcher(blockName).matches();
    }

    // ---------------------------------------------------------------- inventory slots

    /** Inventory index of the item (exact name first, then a name containing it), or -1. */
    static int find(Inventory inv, String name) {
        String q = name.replace("minecraft:", "");
        for (int i = 0; i < inv.getContainerSize(); i++) if (!inv.getItem(i).isEmpty() && Names.item(inv.getItem(i)).equals(q)) return i;
        for (int i = 0; i < 36; i++) if (!inv.getItem(i).isEmpty() && Names.item(inv.getItem(i)).contains(q)) return i;
        return -1;
    }

    /** Slot of an inventory index in the player's own inventory menu (hotbar 36-44, armor 5-8, off-hand 45). */
    static int inventoryMenuSlot(int i) {
        if (i < 9) return 36 + i;
        if (i < 36) return i;
        if (i < 40) return 8 - (i - 36);
        return 45;
    }

    /** Slot of an inventory index in a container menu with {@code containerSlots} slots of its own before the player's. */
    static int containerMenuSlot(int containerSlots, int i) {
        return i < 9 ? containerSlots + 27 + i : containerSlots + (i - 9);
    }

    static void click(AbstractContainerMenu menu, int slot, int button, ContainerInput input) {
        Minecraft mc = Minecraft.getInstance();
        mc.gameMode.handleContainerInput(menu.containerId, slot, button, input, mc.player);
    }

    /** Put the item in the main hand (moving it to the hotbar if needed); returns the inventory index now held. */
    public static int select(String name) {
        LocalPlayer p = player();
        Inventory inv = p.getInventory();
        int i = find(inv, name);
        if (i < 0) throw new IllegalArgumentException("no " + name + " in inventory");
        if (i < 9) { inv.setSelectedSlot(i); return i; }
        if (i > 35) throw new IllegalArgumentException(name + " is worn; take it off first");
        if (p.containerMenu != p.inventoryMenu) p.closeContainer();
        int h = inv.getSuitableHotbarSlot();
        click(p.inventoryMenu, inventoryMenuSlot(i), h, ContainerInput.SWAP);
        inv.setSelectedSlot(h);
        return h;
    }

    // ---------------------------------------------------------------- blocks

    static boolean replaceable(BlockState s) {
        return s.isAir() || s.canBeReplaced();
    }

    static Vec3 faceCenter(BlockPos ref, Direction face) {
        return Vec3.atCenterOf(ref).add(face.getUnitVec3().scale(0.5));
    }

    public static void register(BridgeServer s) {
        s.register("item.select", true, (p, c) -> obj("held", select(required(p, "name"))));

        s.register("item.equip", true, (p, c) -> {
            LocalPlayer pl = player();
            String name = required(p, "name");
            String dest = strParam(p, "destination", "hand");
            if (dest.equals("hand")) return obj("slot", select(name));
            int i = find(pl.getInventory(), name);
            if (i < 0) throw new IllegalArgumentException("no " + name + " in inventory");
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            if (dest.equals("off-hand")) click(pl.inventoryMenu, inventoryMenuSlot(i), 40, ContainerInput.SWAP);
            else click(pl.inventoryMenu, inventoryMenuSlot(i), 0, ContainerInput.QUICK_MOVE); // armor goes to its slot
            return obj("ok", true);
        });

        s.register("look", true, (p, c) -> {
            player().lookAt(EntityAnchorArgument.Anchor.EYES, new Vec3(numParam(p, "x", 0), numParam(p, "y", 0), numParam(p, "z", 0)));
            return obj("ok", true);
        });

        s.register("keys", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            String dir = required(p, "key");
            KeyMapping key = switch (dir) {
                case "forward" -> mc.options.keyUp;
                case "back" -> mc.options.keyDown;
                case "left" -> mc.options.keyLeft;
                case "right" -> mc.options.keyRight;
                case "jump" -> mc.options.keyJump;
                default -> throw new IllegalArgumentException("unknown key " + dir);
            };
            int ticks = Math.max(1, intParam(p, "ms", 100) / 50);
            key.setDown(true);
            Ticker.add(new Ticker.Task() {
                int left = ticks;
                @Override public boolean tick(Minecraft m) {
                    if (--left > 0) return false;
                    key.setDown(false);
                    c.ok(obj("at", pos(m.player.blockPosition())));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // walk (or swim) straight at a nearby point, no pathfinding: for drops Baritone can't path to, such as one floating
        // in water. Ends within half a block (horizontally) of it, or at the timeout.
        s.register("steer", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            double tx = Double.parseDouble(required(p, "x")), ty = Double.parseDouble(required(p, "y")), tz = Double.parseDouble(required(p, "z"));
            int timeout = intParam(p, "timeoutMs", 5000) / 50;
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pl = m.player;
                    double dx = tx - pl.getX(), dz = tz - pl.getZ();
                    double dist = Math.sqrt(dx * dx + dz * dz);
                    boolean done = dist < 0.5 || ++age >= timeout;
                    if (!done) {
                        pl.setYRot((float) (Math.toDegrees(Math.atan2(-dx, dz))));
                        m.options.keyUp.setDown(true);
                        // keep the head up in water, and hop small steps on land
                        m.options.keyJump.setDown(pl.isInWater() ? pl.getY() < ty + 0.2 : pl.horizontalCollision);
                        return false;
                    }
                    m.options.keyUp.setDown(false);
                    m.options.keyJump.setDown(false);
                    c.ok(obj("reached", dist < 0.5, "distance", Json.round(dist), "at", pos(pl.blockPosition())));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        s.register("place", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos target = blockPos(p);
            if (!replaceable(mc.level.getBlockState(target))) {
                return obj("placed", false, "reason", "occupied by " + Names.block(mc.level.getBlockState(target)));
            }
            if (pl.blockPosition().equals(target) || pl.blockPosition().above().equals(target)) {
                return obj("placed", false, "reason", "the bot is standing there");
            }
            List<Direction> order = new ArrayList<>(List.of(Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP));
            String preferred = strParam(p, "face", null);
            if (preferred != null && Direction.byName(preferred) != null) { order.remove(Direction.byName(preferred)); order.addFirst(Direction.byName(preferred)); }
            for (Direction toRef : order) {
                BlockPos ref = target.relative(toRef);
                BlockState rs = mc.level.getBlockState(ref);
                if (replaceable(rs) || ACTIVATABLE.matcher(Names.block(rs)).matches()) continue;
                Direction face = toRef.getOpposite(); // the reference block's face that points at the target
                // click a side face low, so stairs and slabs come out as bottom halves (the exact middle is a coin toss)
                Vec3 hit = faceCenter(ref, face).add(0, face.getAxis().isHorizontal() ? -0.25 : 0, 0);
                if (pl.getEyePosition().distanceTo(hit) > 4.5) return obj("placed", false, "reason", "too far", "distance", round(pl.getEyePosition().distanceTo(hit)));
                pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
                // directional blocks (stairs, doors, furnaces...) take the way the player faces: turn to `facing` if asked
                Direction facing = Direction.byName(strParam(p, "facing", ""));
                if (facing != null && facing.getAxis().isHorizontal()) pl.setYRot(facing.toYRot());
                String faceName = toRef.getSerializedName();
                BlockHitResult click = new BlockHitResult(hit, face, ref, false);
                // the server reads the rotation from the last movement packet, which the client sends on its next tick: place after it
                Ticker.add(new Ticker.Task() {
                    int wait = 5;
                    @Override public boolean tick(Minecraft m) {
                        wait--;
                        if (wait == 3) m.gameMode.useItemOn(m.player, InteractionHand.MAIN_HAND, click);
                        if (wait > 0) return false;
                        BlockState now = m.level.getBlockState(target);
                        c.ok(obj("placed", !replaceable(now), "block", Names.block(now), "face", faceName));
                        return true;
                    }
                });
                return BridgeServer.LATER;
            }
            return obj("placed", false, "reason", "nothing solid next to it to place against");
        });

        s.register("dig", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            BlockPos target = blockPos(p);
            BlockState before = mc.level.getBlockState(target);
            if (before.isAir()) return obj("dug", false, "reason", "air");
            long seq = Events.baritoneLogSeq();
            Protection.suspend(); // breaking this one is the point (it may be a protected block the user asked to dig)
            Processes.baritone().getBuilderProcess().clearArea(target, target); // walks into reach, picks the tool, digs
            Processes.watch(c, seq, intParam(p, "timeoutMs", 60_000) / 50, reason -> {
                Protection.resume();
                BlockState now = Minecraft.getInstance().level.getBlockState(target);
                ItemStack held = Minecraft.getInstance().player.getMainHandItem();
                return obj("dug", replaceable(now), "block", Names.block(before), "tool", held.isEmpty() ? null : Names.item(held));
            });
            return BridgeServer.LATER;
        });

        s.register("use", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            int foodBefore = pl.getFoodData().getFoodLevel();
            float healthBefore = pl.getHealth();
            using = true;
            mc.gameMode.useItem(pl, InteractionHand.MAIN_HAND);
            mc.options.keyUse.setDown(true); // the client stops using an item as soon as the use key is up
            Ticker.add(new Ticker.Task() {
                int age = 0;
                boolean started = false;
                @Override public boolean tick(Minecraft m) {
                    age++;
                    if (m.player.isUsingItem()) started = true;
                    if (!(started && !m.player.isUsingItem()) && age < 80) return false;
                    m.options.keyUse.setDown(false);
                    if (m.player.isUsingItem()) m.gameMode.releaseUsingItem(m.player);
                    using = false;
                    c.ok(obj("finished", started, "food", m.player.getFoodData().getFoodLevel(), "foodBefore", foodBefore,
                        "health", round(m.player.getHealth()), "healthBefore", round(healthBefore)));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        s.register("craft", true, (p, c) -> {
            craft(c, required(p, "item").replace("minecraft:", ""), intParam(p, "count", 1), p.has("x") ? blockPos(p) : null);
            return BridgeServer.LATER;
        });

        // ---- furnace (the menu stays open between calls; Node polls status and takes output)
        s.register("furnace.open", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            Vec3 hit = faceCenter(at, Direction.UP);
            if (pl.getEyePosition().distanceTo(hit) > 4.5) throw new IllegalStateException("furnace too far to open");
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, at, false));
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (m.player.containerMenu instanceof AbstractFurnaceMenu) { c.ok(furnaceStatus()); return true; }
                    if (++age > 40) { c.fail("the furnace did not open"); return true; }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });
        s.register("furnace.status", true, (p, c) -> furnaceStatus());
        s.register("furnace.put", true, (p, c) -> {
            LocalPlayer pl = player();
            if (!(pl.containerMenu instanceof AbstractFurnaceMenu menu)) throw new IllegalStateException("no furnace open");
            int target = required(p, "slot").equals("fuel") ? 1 : 0;
            int i = find(pl.getInventory(), required(p, "name"));
            if (i < 0 || i > 35) throw new IllegalArgumentException("no " + required(p, "name") + " in inventory");
            int source = containerMenuSlot(3, i);
            int want = intParam(p, "count", 64);
            click(menu, source, 0, ContainerInput.PICKUP); // carry the stack
            int carried = menu.getCarried().getCount();
            if (want >= carried) click(menu, target, 0, ContainerInput.PICKUP); // place all
            else for (int n = 0; n < want; n++) click(menu, target, 1, ContainerInput.PICKUP); // one at a time
            if (!menu.getCarried().isEmpty()) click(menu, source, 0, ContainerInput.PICKUP); // put the rest back
            return furnaceStatus();
        });
        s.register("furnace.take", true, (p, c) -> {
            LocalPlayer pl = player();
            if (!(pl.containerMenu instanceof AbstractFurnaceMenu menu)) throw new IllegalStateException("no furnace open");
            ItemStack out = menu.getSlot(2).getItem().copy();
            click(menu, 2, 0, ContainerInput.QUICK_MOVE);
            return obj("took", out.isEmpty() ? null : obj("name", Names.item(out), "count", out.getCount()));
        });
        s.register("container.close", true, (p, c) -> { player().closeContainer(); return obj("ok", true); });
    }

    static JsonObject furnaceStatus() {
        LocalPlayer pl = player();
        if (!(pl.containerMenu instanceof AbstractFurnaceMenu menu)) return obj("open", false);
        return obj("open", true, "input", stack(menu.getSlot(0).getItem()), "fuel", stack(menu.getSlot(1).getItem()),
            "output", stack(menu.getSlot(2).getItem()), "lit", menu.isLit(), "progress", round(menu.getBurnProgress()));
    }

    static JsonObject stack(ItemStack s) {
        return s.isEmpty() ? null : obj("name", Names.item(s), "count", s.getCount());
    }

    // ---------------------------------------------------------------- crafting

    static boolean fitsInventoryGrid(RecipeDisplayEntry e) {
        if (e.display() instanceof ShapedCraftingRecipeDisplay shaped) return shaped.width() <= 2 && shaped.height() <= 2;
        if (e.display() instanceof ShapelessCraftingRecipeDisplay shapeless) return shapeless.ingredients().size() <= 4;
        return false; // furnace, stonecutter, smithing ... recipes are not crafting-grid recipes
    }

    static boolean isCraftingRecipe(RecipeDisplayEntry e) {
        return e.display() instanceof ShapedCraftingRecipeDisplay || e.display() instanceof ShapelessCraftingRecipeDisplay;
    }

    /**
     * Craft through the recipe book: ask the server to fill the grid with the recipe (it picks matching ingredients,
     * any wood type for "planks" and so on), shift-click the result, repeat. Uses the 2x2 inventory grid unless a
     * table position is given (the table must be in reach). Replies {gained} or fails with a reason
     * ("needs_table: ...", "no recipe ...", "missing ingredients ...").
     */
    static void craft(BridgeServer.Call c, String item, int count, BlockPos table) {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer pl = player();
        var ctx = SlotDisplayContext.fromLevel(mc.level);
        List<RecipeDisplayEntry> recipes = new ArrayList<>();
        for (var collection : pl.getRecipeBook().getCollections()) {
            for (var e : collection.getRecipes()) {
                if (!isCraftingRecipe(e)) continue;
                if (e.resultItems(ctx).stream().anyMatch(st -> !st.isEmpty() && Names.item(st).equals(item))) recipes.add(e);
            }
        }
        if (recipes.isEmpty()) { c.fail("no recipe for " + item + " in the recipe book (unlocked by holding one of its ingredients)"); return; }
        StackedItemContents have = new StackedItemContents();
        pl.getInventory().fillStackedContents(have);
        RecipeDisplayEntry chosen = recipes.stream().filter(e -> e.canCraft(have) && (table != null || fitsInventoryGrid(e))).findFirst().orElse(null);
        if (chosen == null) {
            boolean anyCraftable = recipes.stream().anyMatch(e -> e.canCraft(have));
            if (anyCraftable && table == null) c.fail("needs_table: " + item + " needs a crafting table");
            else c.fail("missing ingredients for " + item);
            return;
        }
        Map<String, Integer> before = Processes.inventoryCounts(mc);
        if (table != null) {
            Vec3 hit = faceCenter(table, Direction.UP);
            if (pl.getEyePosition().distanceTo(hit) > 4.5) { c.fail("crafting table too far"); return; }
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, table, false));
        }
        Ticker.add(new Ticker.Task() {
            int age = 0, wait = 0, done = 0;
            boolean placed = false;
            @Override public boolean tick(Minecraft m) {
                age++;
                AbstractContainerMenu menu = table != null ? m.player.containerMenu : m.player.inventoryMenu;
                if (table != null && !(menu instanceof CraftingMenu)) {
                    if (age > 40) { c.fail("the crafting table did not open"); return true; }
                    return false;
                }
                if (wait > 0) { wait--; return false; }
                if (done >= count || age > 40 + count * 20) return finish(m);
                if (!placed) {
                    m.gameMode.handlePlaceRecipe(menu.containerId, chosen.id(), false);
                    placed = true;
                    wait = 3;
                    return false;
                }
                if (menu.getSlot(0).getItem().isEmpty()) return finish(m); // out of ingredients
                click(menu, 0, 0, ContainerInput.QUICK_MOVE);
                done++;
                placed = false;
                wait = 3;
                return false;
            }

            boolean finish(Minecraft m) {
                m.player.closeContainer(); // also returns anything left in the grid
                Ticker.add(new Ticker.Task() {
                    int w = 3;
                    @Override public boolean tick(Minecraft mm) {
                        if (--w > 0) return false;
                        c.ok(obj("crafted", done, "gained", Processes.gained(before, Processes.inventoryCounts(mm))));
                        return true;
                    }
                });
                return true;
            }
        });
    }
}
