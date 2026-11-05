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
    /** a job holds an item in hand for a while (fishing): calm-time eating must not swap it out */
    static volatile boolean handsBusy;

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
    /**
     * Null if something in the inventory (or the bare hand) can harvest the block so that it drops; otherwise why not.
     * Stone mined by hand drops nothing, and Baritone mines on anyway (240 s, nothing gained).
     */
    static String cannotHarvest(net.minecraft.world.level.block.state.BlockState st) {
        if (!st.requiresCorrectToolForDrops()) return null;
        var inv = player().getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            if (!inv.getItem(i).isEmpty() && inv.getItem(i).isCorrectToolForDrops(st)) return null;
        }
        String name = Names.block(st);
        String tool = name.contains("diamond") || name.contains("gold") || name.contains("redstone") || name.contains("emerald") ? "an iron pickaxe or better"
            : name.contains("iron") || name.contains("lapis") || name.contains("copper") ? "a stone pickaxe or better"
            : name.contains("obsidian") || name.contains("ancient_debris") ? "a diamond pickaxe or better" : "the right tool (usually a pickaxe)";
        return "needs_tool: " + name + " drops nothing without " + tool + ", and there is none in the inventory";
    }

    static JsonObject chestContents(net.minecraft.world.inventory.ChestMenu menu) {
        JsonObject items = new JsonObject();
        int own = menu.getRowCount() * 9, free = 0;
        for (int k = 0; k < own; k++) {
            ItemStack in = menu.getSlot(k).getItem();
            if (in.isEmpty()) { free++; continue; }
            String n = Names.item(in);
            items.addProperty(n, (items.has(n) ? items.get(n).getAsInt() : 0) + in.getCount());
        }
        return obj("slots", own, "free", free, "items", items);
    }

    static int containerMenuSlot(int containerSlots, int i) {
        return i < 9 ? containerSlots + 27 + i : containerSlots + (i - 9);
    }

    static void click(AbstractContainerMenu menu, int slot, int button, ContainerInput input) {
        Minecraft mc = Minecraft.getInstance();
        mc.gameMode.handleContainerInput(menu.containerId, slot, button, input, mc.player);
    }

    /** Put the item in the main hand (moving it to the hotbar if needed); returns the inventory index now held. */
    /**
     * A hotbar slot for an item we want in hand, never 0 or 8: with allowInventory Baritone keeps its best pickaxe in
     * slot 0 and building blocks in slot 8, swapping them back every tick (a hoe put in slot 0 was a pickaxe again two
     * ticks later, so tilling did nothing). Prefers an empty slot, then the one in hand.
     */
    static int freeHotbarSlot(Inventory inv) {
        for (int k = 1; k <= 7; k++) if (inv.getItem(k).isEmpty()) return k;
        int sel = inv.getSelectedSlot();
        return sel >= 1 && sel <= 7 ? sel : 7;
    }

    public static int select(String name) {
        LocalPlayer p = player();
        Inventory inv = p.getInventory();
        int i = find(inv, name);
        if (i < 0) throw new IllegalArgumentException("no " + name + " in inventory");
        if (i < 9) { inv.setSelectedSlot(i); return i; } // in slot 0 or 8 it is Baritone's own pick: it stays there
        if (i > 35) throw new IllegalArgumentException(name + " is worn; take it off first");
        if (p.containerMenu != p.inventoryMenu) p.closeContainer();
        int h = freeHotbarSlot(inv);
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

        // right-click a block with whatever is held: till with a hoe, open/close a door, flip a lever, bone meal, buckets
        s.register("useOn", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            Direction face = Direction.byName(strParam(p, "face", "up"));
            if (face == null) face = Direction.UP;
            Vec3 hit = faceCenter(at, face);
            if (pl.getEyePosition().distanceTo(hit) > 4.5) return obj("used", false, "reason", "too far", "distance", round(pl.getEyePosition().distanceTo(hit)));
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            String before = Names.block(mc.level.getBlockState(at));
            final net.minecraft.world.level.block.state.BlockState beforeState = mc.level.getBlockState(at);
            BlockHitResult click = new BlockHitResult(hit, face, at, false);
            Ticker.add(new Ticker.Task() {
                int wait = 5;
                String result = "", held = "";
                @Override public boolean tick(Minecraft m) {
                    wait--;
                    if (wait == 3) {
                        // after the rotation is sent; buckets (and other aimed items) act through "use", along the look
                        // direction at the same point, when the block click does nothing
                        held = m.player.getMainHandItem().isEmpty() ? "nothing" : Names.item(m.player.getMainHandItem());
                        var r = m.gameMode.useItemOn(m.player, InteractionHand.MAIN_HAND, click);
                        result = r.toString();
                        if (!r.consumesAction()) result += " / use: " + m.gameMode.useItem(m.player, InteractionHand.MAIN_HAND);
                    }
                    if (wait > 0) return false;
                    var now = m.level.getBlockState(at);
                    JsonObject props = new JsonObject();
                    for (var prop : now.getProperties()) props.addProperty(prop.getName(), Handlers.valueName(now, prop));
                    c.ok(obj("used", true, "before", before, "after", Names.block(now), "changed", !now.equals(beforeState), "properties", props, "held", held, "result", result,
                        "sneaking", m.player.isShiftKeyDown()));
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
            Protection.suspend(before.getBlock()); // breaking this one is the point (it may be a protected block the user asked to dig)
            Processes.baritone().getBuilderProcess().clearArea(target, target); // walks into reach, picks the tool, digs
            Processes.watch(c, seq, intParam(p, "timeoutMs", 60_000) / 50, reason -> {
                Protection.resume(before.getBlock());
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
        // chests (single or double) and barrels: open, put items in, report what they hold
        s.register("chest.open", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            Vec3 hit = faceCenter(at, Direction.UP);
            if (pl.getEyePosition().distanceTo(hit) > 4.5) throw new IllegalStateException("chest too far to open");
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, at, false));
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (m.player.containerMenu instanceof net.minecraft.world.inventory.ChestMenu menu) { c.ok(chestContents(menu)); return true; }
                    if (++age > 40) { c.fail("the chest did not open (blocked lid, or not a chest)"); return true; }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });
        s.register("chest.deposit", true, (p, c) -> {
            LocalPlayer pl = player();
            if (!(pl.containerMenu instanceof net.minecraft.world.inventory.ChestMenu menu)) throw new IllegalStateException("no chest open");
            String name = required(p, "name").replace("minecraft:", "");
            int want = intParam(p, "count", Integer.MAX_VALUE);
            int own = menu.getRowCount() * 9;
            int moved = 0;
            for (int i = 0; i < 36 && moved < want; i++) {
                ItemStack st = pl.getInventory().getItem(i);
                if (st.isEmpty() || !Names.item(st).equals(name)) continue;
                int slot = containerMenuSlot(own, i);
                int before = st.getCount();
                if (want - moved >= before) {
                    click(menu, slot, 0, ContainerInput.QUICK_MOVE);
                } else {
                    // part of a stack: carry it, drop one at a time into the first chest slot that takes it, put the rest back
                    click(menu, slot, 0, ContainerInput.PICKUP);
                    for (int n = moved; n < want; n++) {
                        int dest = -1;
                        for (int k = 0; k < own && dest < 0; k++) {
                            ItemStack in = menu.getSlot(k).getItem();
                            if (in.isEmpty() || (ItemStack.isSameItemSameComponents(in, menu.getCarried()) && in.getCount() < in.getMaxStackSize())) dest = k;
                        }
                        if (dest < 0) break;
                        click(menu, dest, 1, ContainerInput.PICKUP);
                    }
                    if (!menu.getCarried().isEmpty()) click(menu, slot, 0, ContainerInput.PICKUP);
                }
                moved += before - pl.getInventory().getItem(i).getCount();
                if (pl.getInventory().getItem(i).getCount() == before) break; // the chest is full
            }
            JsonObject r = chestContents(menu);
            r.addProperty("moved", moved);
            return r;
        });

        s.register("chest.withdraw", true, (p, c) -> {
            LocalPlayer pl = player();
            if (!(pl.containerMenu instanceof net.minecraft.world.inventory.ChestMenu menu)) throw new IllegalStateException("no chest open");
            String name = required(p, "name").replace("minecraft:", "");
            int want = intParam(p, "count", Integer.MAX_VALUE);
            int own = menu.getRowCount() * 9;
            int taken = 0;
            for (int k = 0; k < own && taken < want; k++) {
                ItemStack in = menu.getSlot(k).getItem();
                if (in.isEmpty() || !Names.item(in).equals(name)) continue;
                int before = in.getCount();
                if (want - taken >= before) {
                    click(menu, k, 0, ContainerInput.QUICK_MOVE);
                } else {
                    // part of a stack: carry it, drop the wanted number into the player's inventory, put the rest back
                    click(menu, k, 0, ContainerInput.PICKUP);
                    for (int n = taken; n < want; n++) {
                        int dest = -1;
                        for (int s2 = own; s2 < own + 36 && dest < 0; s2++) {
                            ItemStack st = menu.getSlot(s2).getItem();
                            if (st.isEmpty() || (ItemStack.isSameItemSameComponents(st, menu.getCarried()) && st.getCount() < st.getMaxStackSize())) dest = s2;
                        }
                        if (dest < 0) break;
                        click(menu, dest, 1, ContainerInput.PICKUP);
                    }
                    if (!menu.getCarried().isEmpty()) click(menu, k, 0, ContainerInput.PICKUP);
                }
                int after = menu.getSlot(k).getItem().isEmpty() ? 0 : menu.getSlot(k).getItem().getCount();
                if (after == before) break; // the inventory is full
                taken += before - after;
            }
            JsonObject r = chestContents(menu);
            r.addProperty("moved", taken);
            return r;
        });

        // throw items out of the inventory (whole stacks, or one at a time for an exact count)
        s.register("item.drop", true, (p, c) -> {
            LocalPlayer pl = player();
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            String name = required(p, "name").replace("minecraft:", "");
            int want = intParam(p, "count", Integer.MAX_VALUE);
            int dropped = 0;
            for (int i = 0; i < 36 && dropped < want; i++) {
                ItemStack st = pl.getInventory().getItem(i);
                if (st.isEmpty() || !Names.item(st).equals(name)) continue;
                int slot = inventoryMenuSlot(i);
                if (want - dropped >= st.getCount()) { dropped += st.getCount(); click(pl.inventoryMenu, slot, 1, ContainerInput.THROW); }
                else while (dropped < want && !pl.getInventory().getItem(i).isEmpty()) { click(pl.inventoryMenu, slot, 0, ContainerInput.THROW); dropped++; }
            }
            return obj("dropped", dropped);
        });

        // fish at a water block: cast, reel in when a fish bites, repeat `times` (recast after 45 s without a bite)
        s.register("fish", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            if (find(player().getInventory(), "fishing_rod") < 0) throw new IllegalArgumentException("no fishing_rod in inventory");
            BlockPos water = blockPos(p);
            Vec3 aim = Vec3.atCenterOf(water).add(0, 0.5, 0);
            int times = intParam(p, "times", 5);
            int timeout = intParam(p, "timeoutMs", 300_000) / 50;
            Map<String, Integer> before = Processes.inventoryCounts(mc);
            java.lang.reflect.Field bitingField;
            try {
                bitingField = net.minecraft.world.entity.projectile.FishingHook.class.getDeclaredField("biting");
                bitingField.setAccessible(true);
            } catch (ReflectiveOperationException e) { throw new IllegalStateException("cannot read the fishing hook: " + e); }
            final java.lang.reflect.Field biting = bitingField;
            handsBusy = true;
            Ticker.add(new Ticker.Task() {
                int age = 0, castAt = -1, wait = 0, caught = 0, casts = 0;
                final java.util.ArrayDeque<String> stale = new java.util.ArrayDeque<>(); // where recalled hooks were
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pl = m.player;
                    if (pl == null) { c.fail("not in a world"); return true; }
                    if (++age > timeout || caught >= times) return finish(m);
                    if (wait > 0) { wait--; return false; }
                    if (!Names.item(pl.getMainHandItem()).equals("fishing_rod")) {
                        if (find(pl.getInventory(), "fishing_rod") < 0) return finish(m); // it broke
                        select("fishing_rod");
                        wait = 2;
                        return false;
                    }
                    var hook = pl.fishing;
                    if (hook == null) {
                        pl.lookAt(EntityAnchorArgument.Anchor.EYES, aim);
                        // cast two ticks later, once the rotation has gone out
                        Ticker.add(new Ticker.Task() {
                            int w = 2;
                            @Override public boolean tick(Minecraft m2) {
                                if (--w > 0) return false;
                                m2.gameMode.useItem(m2.player, InteractionHand.MAIN_HAND);
                                return true;
                            }
                        });
                        wait = 4;
                        castAt = age + 2;
                        casts++;
                        return false;
                    }
                    boolean bite;
                    try { bite = biting.getBoolean(hook); } catch (IllegalAccessException e) { bite = false; }
                    // a bobbing hook floats on top (y 62.9 on a y 62 water block), where its own isInWater() says no, so
                    // look for water just under it; every good cast was reeled back after 3 s before
                    boolean onWater = hook.isInWater() || m.level.getFluidState(BlockPos.containing(hook.getX(), hook.getY() - 0.3, hook.getZ()))
                        .is(net.minecraft.tags.FluidTags.WATER);
                    boolean expired = age - castAt > 900 || (age - castAt > 60 && !onWater);
                    if (bite || expired) {
                        if (!bite) {
                            if (stale.size() >= 3) stale.removeFirst();
                            stale.addLast(String.format("hook at (%.1f, %.1f, %.1f)%s%s, %d ticks", hook.getX(), hook.getY(), hook.getZ(),
                                onWater ? " on water" : "", hook.onGround() ? " on ground" : "", age - castAt));
                        }
                        m.gameMode.useItem(pl, InteractionHand.MAIN_HAND); // reel in
                        if (bite) caught++;
                        wait = 15;
                    }
                    return false;
                }

                boolean finish(Minecraft m) {
                    handsBusy = false;
                    if (m.player != null && m.player.fishing != null) m.gameMode.useItem(m.player, InteractionHand.MAIN_HAND);
                    Map<String, Integer> gained = Processes.gained(before, Processes.inventoryCounts(m));
                    c.ok(obj("bites", caught, "casts", casts, "gained", gained, "seconds", Json.round(age / 20.0), "recalled", String.join("; ", stale)));
                    return true;
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

        // right-click a bed and wait for the server to put us in it; a refusal comes back as an action-bar message
        s.register("bed.sleep", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            if (pl.isSleeping()) return obj("sleeping", true);
            Vec3 hit = Vec3.atBottomCenterOf(at).add(0, 0.5625, 0); // the top of the mattress (beds are 9/16 tall)
            if (pl.getEyePosition().distanceTo(hit) > 4.5) throw new IllegalStateException("bed too far");
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            long seq = Events.systemSeq();
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, at, false));
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (m.player == null) { c.fail("not in a world"); return true; }
                    if (m.player.isSleeping()) { c.ok(obj("sleeping", true)); return true; }
                    String reason = null, overlay = null;
                    for (Events.SystemMessage msg : Events.systemMessagesSince(seq)) {
                        String r = bedReason(msg.key());
                        if (r != null) reason = r;
                        else if (msg.overlay()) overlay = msg.text();
                    }
                    if (reason == null && ++age < 40) return false;
                    c.ok(obj("sleeping", false, "reason", reason != null ? reason : overlay != null && !overlay.isBlank() ? overlay : "unknown"));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // the in-bed screen's "Leave Bed" button: the same packet, so the server wakes us as it would a player
        s.register("bed.wake", true, (p, c) -> {
            LocalPlayer pl = player();
            boolean was = pl.isSleeping();
            if (was) pl.connection.send(new net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket(pl,
                net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket.Action.STOP_SLEEPING));
            return obj("wasSleeping", was);
        });

        // right-click an entity the way the use key does: feed/breed an animal, shear a sheep, milk a cow, put on a lead,
        // trade (opens the menu). No walking: the entity must already be in reach.
        s.register("entity.use", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            int id = Integer.parseInt(required(p, "id"));
            net.minecraft.world.entity.Entity e = mc.level.getEntity(id);
            if (e == null || e.isRemoved()) throw new IllegalArgumentException("no entity with id " + id + " nearby");
            String item = strParam(p, "item", null);
            if (item != null) select(item);
            Vec3 eye = pl.getEyePosition();
            var box = e.getBoundingBox();
            double dist = Math.sqrt(box.distanceToSqr(eye));
            if (dist > 4.5) throw new IllegalStateException("too far: " + round(dist) + " blocks to the " + Names.entity(e) + " (max 4.5)");
            Vec3 center = box.getCenter();
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, center);
            Ticker.add(new Ticker.Task() {
                int wait = 3;
                @Override public boolean tick(Minecraft m) {
                    if (--wait > 0) return false; // after the rotation and the selected slot have gone out
                    if (m.player == null) { c.fail("not in a world"); return true; }
                    if (e.isRemoved()) { c.fail("the " + Names.entity(e) + " is gone"); return true; }
                    Vec3 from = m.player.getEyePosition();
                    var bb = e.getBoundingBox();
                    Vec3 hitAt = bb.contains(from) ? from : bb.clip(from, bb.getCenter()).orElse(bb.getCenter());
                    var hit = new net.minecraft.world.phys.EntityHitResult(e, hitAt);
                    // as Minecraft.startUseItem: main hand first, then the off hand, stopping at the first Success (and
                    // swinging when the result says the client predicts the swing). Unlike the use key it never falls
                    // through to using the held item on its own (that would throw an egg or a snowball).
                    String heldBefore = m.player.getMainHandItem().isEmpty() ? null : Names.item(m.player.getMainHandItem());
                    net.minecraft.world.InteractionResult mainResult = null, r = null;
                    InteractionHand used = null;
                    for (InteractionHand hand : InteractionHand.values()) {
                        ItemStack inHand = m.player.getItemInHand(hand);
                        r = m.gameMode.interact(m.player, e, hit, hand);
                        if (mainResult == null) mainResult = r;
                        if (r instanceof net.minecraft.world.InteractionResult.Success ok) {
                            if (ok.swingSource() == net.minecraft.world.InteractionResult.SwingSource.PREDICTED) {
                                m.player.swing(hand, inHand.getInteractAnimation(), false);
                            }
                            used = hand;
                            break;
                        }
                    }
                    if (used == null) r = mainResult; // neither hand did anything: report the main hand's answer
                    c.ok(obj("result", r.getClass().getSimpleName(), "success", used != null, "hand", used == null ? null : used == InteractionHand.MAIN_HAND ? "main" : "off",
                        "held", heldBefore, "entity", Names.entity(e), "id", e.getId()));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // Baritone's sprinting on paths: off to lure animals holding food (they can't keep up with a sprinting player)
        s.register("sprint.set", true, (p, c) -> {
            if (!p.has("allowed") || p.get("allowed").isJsonNull()) throw new IllegalArgumentException("missing parameter: allowed");
            var setting = baritone.api.BaritoneAPI.getSettings().allowSprint;
            boolean previous = setting.value;
            setting.value = p.get("allowed").getAsBoolean();
            if (!setting.value) player().setSprinting(false);
            return obj("allowed", setting.value, "previous", previous);
        });
    }

    /** Short reason for a vanilla bed refusal, from its translation key (language-independent); null if not one. */
    static String bedReason(String key) {
        if (key == null) return null;
        return switch (key) {
            case "block.minecraft.bed.no_sleep" -> "not night";
            case "block.minecraft.bed.not_safe" -> "monsters nearby";
            case "block.minecraft.bed.obstructed" -> "obstructed";
            case "block.minecraft.bed.too_far_away" -> "too far";
            case "block.minecraft.bed.occupied" -> "occupied";
            default -> null;
        };
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
