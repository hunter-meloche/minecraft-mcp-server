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
import net.minecraft.world.entity.projectile.FishingHook;
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
    static final Pattern ACTIVATABLE = Pattern.compile(
        "^(crafting_table|crafter|(blast_)?furnace|smoker|(trapped_)?chest|ender_chest|barrel|.*shulker_box|hopper|dispenser|dropper|brewing_stand|"
            + "enchanting_table|(chipped_|damaged_)?anvil|grindstone|stonecutter|loom|cartography_table|smithing_table|fletching_table|lectern|beacon|"
            + "bell|note_block|jukebox|lever|respawn_anchor|.*_(door|trapdoor|fence_gate|bed|button|sign|hanging_sign))$");

    static LocalPlayer player() {
        return Handlers.player();
    }

    static boolean flag(com.google.gson.JsonObject p, String name) {
        return p.has(name) && p.get(name).getAsBoolean();
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

    /**
     * The one rule for `slot` (enchant.put, chest.withdraw, chest.deposit, item.select): the slot asked for when it holds
     * that item, else the first that does, else -1. Names are null for an empty slot. `slot` picks one of several by the
     * same name: the first diamond_pickaxe by name may be the one already enchanted, which the table offers nothing for.
     */
    static int pick(java.util.function.IntFunction<String> nameAt, int size, String name, int want) {
        if (want >= 0 && want < size && name.equals(nameAt.apply(want))) return want;
        for (int i = 0; i < size; i++) if (name.equals(nameAt.apply(i))) return i;
        return -1;
    }

    /**
     * The slots a move takes from, in order. With no `slot` (want -1): every slot holding the name. With one: the slot
     * pick() finds, then only stacks the same as it (`same`: the same item with the same components), never another of
     * the name: three potions of fire resistance asked for by a slot must not bring a potion of weakness along.
     */
    static List<Integer> sources(java.util.function.IntFunction<String> nameAt, int size, String name, int want,
                                 java.util.function.BiPredicate<Integer, Integer> same) {
        List<Integer> out = new ArrayList<>();
        if (want < 0) {
            for (int i = 0; i < size; i++) if (name.equals(nameAt.apply(i))) out.add(i);
            return out;
        }
        int first = pick(nameAt, size, name, want);
        if (first < 0) return out;
        out.add(first);
        for (int i = 0; i < size; i++) if (i != first && name.equals(nameAt.apply(i)) && same.test(first, i)) out.add(i);
        return out;
    }

    static String nameOf(ItemStack st) {
        return st.isEmpty() ? null : Names.item(st);
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
        // and each stack by its slot, with what tells one of a name from another (enchanted books, potions, a worn
        // pickaxe and a fresh one), so Node can ask for that one by `slot`
        com.google.gson.JsonArray stacks = new com.google.gson.JsonArray();
        int own = menu.getRowCount() * 9, free = 0;
        for (int k = 0; k < own; k++) {
            ItemStack in = menu.getSlot(k).getItem();
            if (in.isEmpty()) { free++; continue; }
            String n = Names.item(in);
            items.addProperty(n, (items.has(n) ? items.get(n).getAsInt() : 0) + in.getCount());
            stacks.add(Handlers.withDetail(obj("slot", k, "name", n, "count", in.getCount()), in));
        }
        return obj("slots", own, "free", free, "items", items, "stacks", stacks);
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

    /** What Baritone's farm replants farmland with (its FARMLAND_PLANTABLE). */
    static final java.util.Set<String> PLANTABLE = java.util.Set.of("wheat_seeds", "carrot", "potato", "beetroot_seeds", "melon_seeds", "pumpkin_seeds");

    /**
     * Make `seed` the first plantable in the hotbar, so Baritone's farm replants with it: it takes the first hotbar slot
     * (0-8) holding any seed. The carrots the bot eats sat in slot 3 and the wheat seeds in 6, so with wheat seeds
     * carried for the cow pen every harvested cell went back to carrots (Nov 16). Swaps it into that first plantable's
     * slot (or a free one when the hotbar holds none); nothing when it is first already or not carried.
     */
    static void seedFirst(String seed) {
        LocalPlayer p = player();
        Inventory inv = p.getInventory();
        String q = seed.replace("minecraft:", "");
        int first = -1, at = -1;
        for (int k = 0; k < 9 && first < 0; k++) if (!inv.getItem(k).isEmpty() && PLANTABLE.contains(nameOf(inv.getItem(k)))) first = k;
        if (first >= 0 && q.equals(nameOf(inv.getItem(first)))) return;
        for (int k = 0; k < 36 && at < 0; k++) if (q.equals(nameOf(inv.getItem(k)))) at = k;
        if (at < 0) return;
        int to = first >= 0 ? first : freeHotbarSlot(inv);
        if (p.containerMenu != p.inventoryMenu) p.closeContainer();
        click(p.inventoryMenu, inventoryMenuSlot(at), to, ContainerInput.SWAP);
    }

    /** An enchanted fishing rod in the main inventory (0-35), its index; -1 with none. */
    static int enchantedRod(Inventory inv) {
        for (int i = 0; i < 36; i++) {
            ItemStack st = inv.getItem(i);
            if (st.isEnchanted() && Names.item(st).equals("fishing_rod")) return i;
        }
        return -1;
    }

    /** Ticks a catch takes to fly from the hook to the bot (about a second): the fish reply waits that long after the last bite. */
    static final int CATCH_LANDS = 25;

    /**
     * The game's open-water rule of the fishing hook (FishingHook.calculateOpenWater, private: the treasure loot's
     * `in_open_water`), or null where this jar's game has none by that name.
     */
    static java.lang.reflect.Method openWaterRule() {
        try {
            java.lang.reflect.Method m = FishingHook.class.getDeclaredMethod("calculateOpenWater", BlockPos.class);
            m.setAccessible(true);
            return m;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /**
     * The fishing rod out of the main hand, so the server drops the hook (it does once its owner holds no rod) and
     * nothing is reeled in: an empty hotbar slot first, else one with neither a rod nor a bucket or fire starter in it
     * (an empty bucket's use takes up the first water it meets). Nothing is clicked with what comes into the hand.
     */
    static void rodOutOfHand(LocalPlayer pl) {
        Inventory inv = pl.getInventory();
        int pick = -1;
        for (int k = 1; k <= 7 && pick < 0; k++) if (inv.getItem(k).isEmpty()) pick = k;
        for (int k = 0; k <= 8 && pick < 0; k++) {
            String n = Names.item(inv.getItem(k));
            if (!n.equals("fishing_rod") && !n.equals("bucket") && !Hazards.isHazard(n)) pick = k;
        }
        if (pick >= 0) inv.setSelectedSlot(pick);
    }

    /**
     * No player, nor anything living that is someone's (named, tamed, on a lead: Handlers.marks, as world.entities says
     * them), nearer than this to a cast's line from the eye to the water (fish.ts CAST_CLEAR): a hook pulls what it catches.
     */
    static final double CAST_CLEAR = 8;

    /** Who stands within CAST_CLEAR of the line from the eye to `aim`, in the brain's words (fish.ts nearCast), or null. */
    static String nearCast(LocalPlayer pl, Vec3 aim) {
        Vec3 eye = pl.getEyePosition();
        for (net.minecraft.world.entity.Entity e : pl.level().getEntities(pl, new net.minecraft.world.phys.AABB(eye, aim).inflate(CAST_CLEAR))) {
            if (!(e instanceof net.minecraft.world.entity.LivingEntity) || !e.isAlive()) continue;
            boolean player = e instanceof net.minecraft.world.entity.player.Player;
            if (!player) {
                JsonObject mk = new JsonObject();
                Handlers.marks(mk, e, pl);
                if (!mk.has("named") && !mk.has("tamed") && !mk.has("leashed")) continue;
            }
            Vec3 ab = aim.subtract(eye), ap = e.position().subtract(eye);
            double len = ab.lengthSqr(), f = len > 0 ? Math.max(0, Math.min(1, ap.dot(ab) / len)) : 0;
            double d = e.position().distanceTo(eye.add(ab.scale(f)));
            if (d <= CAST_CLEAR) return (player ? "a player" : "someone's " + Names.entity(e)) + " " + Math.round(d) + " blocks from the cast";
        }
        return null;
    }

    /** The empty slots of the main 36 (the hotbar and the pockets: where a catch goes). */
    static int freeSlots(Inventory inv) {
        int n = 0;
        for (int k = 0; k < 36; k++) if (inv.getItem(k).isEmpty()) n++;
        return n;
    }

    public static int select(String name) {
        return select(name, -1);
    }

    /** select, of several by the name the one at inventory index `want` (0-35) when it holds that item (see pick). */
    public static int select(String name, int want) {
        LocalPlayer p = player();
        Inventory inv = p.getInventory();
        String q = name.replace("minecraft:", "");
        int i = pick(k -> nameOf(inv.getItem(k)), 36, q, want);
        if (i < 0) i = find(inv, name); // a name in part ("log"), or one only worn
        // but a bucket or a fire starter only by its own name: "bucket" with no empty one carried took the lava_bucket
        if (i >= 0 && Hazards.byNameOnly(q, Names.item(inv.getItem(i)))) i = -1;
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

    /** Where and how to click to place a block: the click, or why not (aimed and turned already when there is one). */
    static final class Aim {
        BlockPos target; BlockHitResult click; String face; String reason; double distance = -1;
        static Aim no(String why) { Aim a = new Aim(); a.reason = why; return a; }
        static Aim no(String why, double d) { Aim a = no(why); a.distance = d; return a; }
    }

    /**
     * Aim to place {x, y, z, item?, face?: the side of the target to click against first, axis?: only faces on that axis
     * (logs, pillars), facing?: the yaw to place with (stairs, doors...), top?: click a side face high (a top half)}.
     * Selects the item when one is given, looks at the face, turns: the caller clicks a tick or two later (the server
     * reads the rotation from the next movement packet).
     */
    static Aim aimPlace(LocalPlayer pl, com.google.gson.JsonObject p) {
        Minecraft mc = Minecraft.getInstance();
        BlockPos target = blockPos(p);
        if (!replaceable(mc.level.getBlockState(target))) return Aim.no("occupied by " + Names.block(mc.level.getBlockState(target)));
        if (pl.blockPosition().equals(target) || pl.blockPosition().above().equals(target)) return Aim.no("the bot is standing there");
        List<Direction> order = new ArrayList<>(List.of(Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST, Direction.UP));
        String preferred = strParam(p, "face", null);
        if (preferred != null && Direction.byName(preferred) != null) { order.remove(Direction.byName(preferred)); order.addFirst(Direction.byName(preferred)); }
        // a log, a pillar or a basalt column lies along the axis of the face clicked: only faces on that axis will do
        String axis = strParam(p, "axis", null);
        if (axis != null) {
            Direction.Axis ax = Direction.Axis.byName(axis);
            if (ax == null) throw new IllegalArgumentException("axis must be x, y or z");
            order.removeIf(d -> d.getAxis() != ax);
        }
        boolean top = p.has("top") && p.get("top").getAsBoolean();
        for (Direction toRef : order) {
            BlockPos ref = target.relative(toRef);
            BlockState rs = mc.level.getBlockState(ref);
            if (replaceable(rs) || ACTIVATABLE.matcher(Names.block(rs)).matches()) continue;
            Direction face = toRef.getOpposite(); // the reference block's face that points at the target
            // click a side face low, so stairs and slabs come out as bottom halves (the exact middle is a coin toss),
            // or high for a top half
            Vec3 hit = faceCenter(ref, face).add(0, face.getAxis().isHorizontal() ? (top ? 0.25 : -0.25) : 0, 0);
            double d = pl.getEyePosition().distanceTo(hit);
            if (d > 4.5) return Aim.no("too far", d);
            String item = strParam(p, "item", null);
            if (item != null) select(item);
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            // directional blocks (stairs, doors, furnaces...) take the way the player faces: turn to `facing` if asked
            Direction facing = Direction.byName(strParam(p, "facing", ""));
            if (facing != null && facing.getAxis().isHorizontal()) pl.setYRot(facing.toYRot());
            Aim a = new Aim();
            a.target = target; a.face = toRef.getSerializedName(); a.click = new BlockHitResult(hit, face, ref, false);
            return a;
        }
        return Aim.no(axis != null ? "nothing solid on its " + axis + " sides to place against" : "nothing solid next to it to place against");
    }

    static boolean replaceable(BlockState s) {
        return s.isAir() || s.canBeReplaced();
    }

    static Vec3 faceCenter(BlockPos ref, Direction face) {
        return Vec3.atCenterOf(ref).add(face.getUnitVec3().scale(0.5));
    }

    public static void register(BridgeServer s) {
        // `slot` (inventory index 0-35): of several by the name, that one (the plain pickaxe, the fire resistance potion)
        s.register("item.select", true, (p, c) -> obj("held", select(required(p, "name"), intParam(p, "slot", -1))));

        // take a worn piece off into the pockets (the enchanting table and the anvil take only carried items), and keep
        // the Guardian's gear check (every 2 s) from wearing it, or a spare of the kind, again for holdMs (default 60 s,
        // at most 10 min): it would be back on before the table opened. enchant.close (or anvil.close) ends the hold and
        // wears it again
        // (the enchanted piece beats a plain one of its tier: Combat.armorRank), and the hold gives way while the bot is
        // being hurt (Guardian.gearHeld). Refused with a hostile near or just hurt. Replies with the inventory index it
        // went to (`slot`, for enchant.put): the first free of 9-35, then the hotbar (InventoryMenu.quickMoveStack)
        s.register("armor.unequip", true, (p, c) -> {
            LocalPlayer pl = player();
            String which = required(p, "slot");
            int index = switch (which) {
                case "feet" -> 36;
                case "legs" -> 37;
                case "chest" -> 38;
                case "head" -> 39;
                default -> throw new IllegalArgumentException("slot must be head, chest, legs or feet");
            };
            long holdMs = Math.max(0, Math.min(600_000L, (long) numParam(p, "holdMs", 60_000)));
            Inventory inv = pl.getInventory();
            ItemStack worn = inv.getItem(index).copy();
            if (worn.isEmpty()) throw new IllegalStateException("nothing worn on the " + which);
            if (inv.getFreeSlot() < 0) throw new IllegalStateException("no free slot to take the " + Names.item(worn) + " off into");
            if (Combat.bound(worn)) throw new IllegalStateException("the " + Names.item(worn) + " has curse of binding: it can't come off");
            // not with a hostile about, nor while being hurt: once the table has the piece nothing can wear it again
            // until the close, and the Guardian's give-way (gearHeld) only works on a piece in the pockets
            for (var e : Combat.hostilesNear(12)) {
                String mob = Names.entity(e);
                if (!Combat.keepsArmourOn(mob, e.distanceTo(pl), pl.hasLineOfSight(e))) continue;
                throw new IllegalStateException("a " + mob + " " + Math.round(e.distanceTo(pl)) + " blocks away: keeping the " + Names.item(worn) + " on");
            }
            if (Guardian.hurtRecently(100)) throw new IllegalStateException("hurt in the last 5 s: keeping the " + Names.item(worn) + " on");
            java.util.Set<Integer> already = new java.util.HashSet<>();
            for (int i = 0; i < 36; i++) if (ItemStack.isSameItemSameComponents(inv.getItem(i), worn)) already.add(i);
            Guardian.holdGear(index, holdMs);
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            click(pl.inventoryMenu, inventoryMenuSlot(index), 0, ContainerInput.QUICK_MOVE); // armour shift-clicks into the pockets
            if (!inv.getItem(index).isEmpty()) {
                Guardian.releaseGear(index);
                throw new IllegalStateException("could not take the " + Names.item(worn) + " off (a curse of binding?)");
            }
            int at = -1;
            for (int i = 0; i < 36 && at < 0; i++) if (!already.contains(i) && ItemStack.isSameItemSameComponents(inv.getItem(i), worn)) at = i;
            JsonObject r = Handlers.withDetail(obj("ok", true, "slot", at, "name", Names.item(worn), "count", worn.getCount()), worn);
            r.addProperty("holdMs", holdMs);
            return r;
        });

        // which armour set the gear check dresses in (Combat.wearSet), and dressed so at once: "nether" (the fire
        // protection pieces and the golden helmet first: the brain's swap at home before the portal) or "main" (the
        // rest first, the default after every start: the swap back at home). A swap of piece for piece, never a piece
        // taken off, so nothing is refused with a hostile near: what was worn goes into the pocket slot the new piece
        // came from. Holds (armor.unequip's) are not heeded: the swap is no table's or anvil's. Without `set` it only
        // says. Replies with the set, what went on (`wore`) and every armour slot worn (its index 36-39, the piece)
        s.register("armor.wearset", true, (p, c) -> {
            LocalPlayer pl = player();
            String set = strParam(p, "set", null);
            com.google.gson.JsonArray wore = new com.google.gson.JsonArray();
            if (set != null) {
                if (!set.equals("main") && !set.equals("nether")) throw new IllegalArgumentException("set must be main or nether");
                Combat.wearSet = set;
                for (String n : Combat.equipBestArmor(false)) wore.add(n);
            }
            com.google.gson.JsonArray worn = new com.google.gson.JsonArray();
            Inventory inv = pl.getInventory();
            for (int i = 39; i >= 36; i--) {
                ItemStack st = inv.getItem(i);
                if (!st.isEmpty()) worn.add(Handlers.withDetail(obj("slot", i, "name", Names.item(st), "count", st.getCount()), st));
            }
            JsonObject r = obj("set", Combat.wearSet);
            r.add("wore", wore);
            r.add("worn", worn);
            return r;
        });

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
            // within: how close (horizontally) is there (Terraslicer centres the bot in its cell to place next to it);
            // sneak: slow and never off an edge (on scaffold)
            double within = p.has("within") ? p.get("within").getAsDouble() : 0.5;
            boolean sneak = p.has("sneak") && p.get("sneak").getAsBoolean();
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pl = m.player;
                    double dx = tx - pl.getX(), dz = tz - pl.getZ();
                    double dist = Math.sqrt(dx * dx + dz * dz);
                    boolean done = dist < within || ++age >= timeout;
                    if (!done) {
                        pl.setYRot((float) (Math.toDegrees(Math.atan2(-dx, dz))));
                        m.options.keyUp.setDown(true);
                        m.options.keyShift.setDown(sneak);
                        // keep the head up in water, and hop small steps on land
                        m.options.keyJump.setDown(!sneak && (pl.isInWater() ? pl.getY() < ty + 0.2 : pl.horizontalCollision));
                        return false;
                    }
                    m.options.keyUp.setDown(false);
                    m.options.keyJump.setDown(false);
                    if (sneak) m.options.keyShift.setDown(false);
                    c.ok(obj("reached", dist < within, "distance", Json.round(dist), "at", pos(pl.blockPosition())));
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
            // with the hand in it: the tool walks closer, and a full bucket in hand is put away for that walk (tools.ts)
            if (pl.getEyePosition().distanceTo(hit) > 4.5) return obj("used", false, "reason", "too far", "distance", round(pl.getEyePosition().distanceTo(hit)), "held", Names.item(pl.getMainHandItem()));
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            String before = Names.block(mc.level.getBlockState(at));
            final net.minecraft.world.level.block.state.BlockState beforeState = mc.level.getBlockState(at);
            BlockHitResult click = new BlockHitResult(hit, face, at, false);
            // a shield in the off-hand stops a hoe, axe or shovel from working the block unless the player sneaks
            // (26.x: "blocking item use intent"): with the kit's shield, tilling the plot did nothing
            String inHand = Names.item(pl.getMainHandItem());
            // not for a bucket. It once sneaked for one too ("use: Fail" at every lake and lava pool with the shield on),
            // but that Fail was the aim hitting the shore (an empty bucket's use fails on a block it can't fill from), not
            // the shield: a bucket acts through use(), and nothing on that path looks at the off hand (26.3 jar:
            // BucketItem.use, ItemStack.use, ServerPlayerGameMode.useItem). And the crouch moved the server's eye: the
            // server traces a bucket's use from the eye of the pose its own last tick gave the bot (Player.tick:
            // updatePlayerPose), which for a crouch pressed two ticks before the use was still the standing eye, 0.35
            // above the crouched one the client aimed from. A pour aimed at a hole's opening from 2 off stood the water
            // on the floor over the hole, and three pickups the client saw filled were never filled on the server
            // a door, trapdoor, gate, lever or button is only ever toggled: no sneak (it skips the block's own use) and
            // no "use" with what is held. Shutting the storage-house door with a water bucket in hand and the shield on
            // poured the water outside it at head height, and the flowing sheet kept Baritone from the bed for hours
            var kind = beforeState.getBlock();
            boolean toggle = flag(p, "toggle") || kind instanceof net.minecraft.world.level.block.DoorBlock
                || kind instanceof net.minecraft.world.level.block.TrapDoorBlock || kind instanceof net.minecraft.world.level.block.FenceGateBlock
                || kind instanceof net.minecraft.world.level.block.LeverBlock || kind instanceof net.minecraft.world.level.block.ButtonBlock;
            boolean sneak = !toggle && pl.getOffhandItem().has(net.minecraft.core.component.DataComponents.BLOCKS_ATTACKS)
                && (inHand.endsWith("_hoe") || inHand.endsWith("_axe") || inHand.endsWith("_shovel"));
            if (sneak) mc.options.keyShift.setDown(true);
            Ticker.add(new Ticker.Task() {
                int age = 0, steady = 0, usedAt = -1, sequence, answeredAt = -1, askedAt = -1, slot, fullBefore;
                String result = "", held = "", aimed = "", guessed;
                ItemStack heldStack = ItemStack.EMPTY;
                boolean bucket;
                long syncs;
                net.minecraft.client.multiplayer.ClientLevel level;
                BlockPos lo, hi;
                Map<Long, String> fluidsBefore = Map.of();
                Vec3 aimAt = hit;

                @Override public boolean tick(Minecraft m) {
                    age++;
                    if (m.player == null || m.level == null) { if (sneak) m.options.keyShift.setDown(false); c.fail("not in a world"); return true; }
                    if (usedAt < 0) {
                        // after the rotation is sent; and a bucket only once the bot has stood unchanged for 3 ticks (a
                        // crouch someone else held, let go, reaches the server's pose a tick or two after the client's),
                        // so the eye the server traces from is the eye aimed from
                        boolean isBucket = !toggle && Hazards.isBucket(Names.item(m.player.getMainHandItem()));
                        boolean crouched = m.options.keyShift.isDown() || m.player.isShiftKeyDown() || m.player.isCrouching();
                        steady = isBucket && crouched ? 0 : steady + 1;
                        if (age < 2 || (isBucket && steady < 3 && age < 20)) return false;
                        use(m, isBucket);
                        return false;
                    }
                    if (sneak && age == usedAt + 3) m.options.keyShift.setDown(false);
                    // the server's word: its ack of the use (the block changes it made come just before it), within 2 s
                    if (answeredAt < 0 && ServerWord.acked(level, sequence)) answeredAt = age;
                    if (answeredAt < 0 && age - usedAt < 40) return false;
                    if (age - usedAt < 3) return false; // never sooner than it always replied
                    if (bucket && !handKnown(m)) return false;
                    if (sneak) m.options.keyShift.setDown(false);
                    reply(m);
                    return true;
                }

                void use(Minecraft m, boolean isBucket) {
                    LocalPlayer me = m.player;
                    slot = me.getInventory().getSelectedSlot();
                    heldStack = me.getMainHandItem().copy();
                    held = heldStack.isEmpty() ? "nothing" : Names.item(heldStack);
                    bucket = isBucket;
                    // buckets (and other aimed items) act through "use", along the look direction at the same point,
                    // when the block click does nothing
                    if (bucket) {
                        // a bucket aims along the look, which something (Baritone's look, the guardian) may have turned
                        // since: look again now, at the fluid itself. Every fill at the lake was "use: Fail": the aim hit
                        // the grass
                        // an empty bucket: at the fluid just under its surface (a source fills to 8/9 of the cell):
                        // aimed at the middle, the line from the shore clipped the shore block's corner ("aim: BLOCK
                        // ... grass_block"); the point the brain's sight-line check (fluidpick.ts) looks at too. A full
                        // one pours next to the face clicked: aimed at that face (aimed into the block, the line hit
                        // the pit's upper wall and the lava went in a cell too high)
                        aimAt = held.equals("bucket") ? new Vec3(at.getX() + 0.5, at.getY() + 0.85, at.getZ() + 0.5) : hit;
                        me.lookAt(EntityAnchorArgument.Anchor.EYES, aimAt);
                        // what the bucket's aim hits, the way BucketItem traces it (sources only), for the reply
                        Vec3 eye = me.getEyePosition(), end = eye.add(me.getViewVector(1f).scale(me.blockInteractionRange()));
                        var pov = m.level.clip(new net.minecraft.world.level.ClipContext(eye, end, net.minecraft.world.level.ClipContext.Block.OUTLINE,
                            net.minecraft.world.level.ClipContext.Fluid.SOURCE_ONLY, me));
                        aimed = pov.getType() + " " + pov.getBlockPos().toShortString() + " " + Names.block(m.level.getBlockState(pov.getBlockPos()))
                            + " offhand=" + Names.item(me.getOffhandItem()) + " sneaking=" + me.isShiftKeyDown() + " using=" + me.isUsingItem();
                        // the sources the trace could reach and the cells beside them (a pour lands beside the face it
                        // hits), to tell where the server put the fluid or took it from
                        lo = BlockPos.containing(Math.min(eye.x, end.x) - 1, Math.min(eye.y, end.y) - 1, Math.min(eye.z, end.z) - 1);
                        hi = BlockPos.containing(Math.max(eye.x, end.x) + 1, Math.max(eye.y, end.y) + 1, Math.max(eye.z, end.z) + 1);
                        fluidsBefore = ServerWord.fluids(m.level, lo, hi);
                    }
                    // (a fill from a stack of empties puts the full bucket in another slot: counted over the whole inventory)
                    if (bucket) fullBefore = ServerWord.fullBuckets(me.getInventory());
                    level = m.level;
                    syncs = ServerWord.handSyncs();
                    int sent = ServerWord.sequence(level);
                    // the bridge's own use, so the guard lets a full bucket or a fire starter through (Hazards); only for
                    // these calls. A toggle never arms: it must never pour, whatever the click lands on
                    if (!toggle) Hazards.arm(held, 2);
                    try {
                        var r = m.gameMode.useItemOn(me, InteractionHand.MAIN_HAND, click);
                        result = r.toString();
                        if (!r.consumesAction() && !toggle) result += " / use: " + m.gameMode.useItem(me, InteractionHand.MAIN_HAND);
                    } finally {
                        Hazards.disarm();
                    }
                    sequence = ServerWord.sequence(level);
                    if (sequence == sent) answeredAt = age; // nothing went out (refused, or outside the world): nothing to wait for
                    ItemStack guess = me.getInventory().getItem(slot);
                    guessed = guess.isEmpty() ? "nothing" : Names.item(guess);
                    usedAt = age;
                }

                /** The hand as the server has it: it said so, or nothing changed (nothing to say), or it was asked. */
                boolean handKnown(Minecraft m) {
                    if (answeredAt < 0) return true; // no word at all: the reply says so
                    // a change while the server has the bot using an item (the shield up) comes in its tick just after the ack
                    if (age - answeredAt < 2) return false;
                    if (ServerWord.handSyncs() > syncs || ItemStack.matches(m.player.getInventory().getItem(slot), heldStack)) return true;
                    // the hand changed with no word from the server: the client's guess. Ask the server for its inventory
                    if (askedAt < 0) { askedAt = age; return !ServerWord.resync(m.player); }
                    return age - askedAt >= 40;
                }

                void reply(Minecraft m) {
                    var now = m.level.getBlockState(at);
                    JsonObject props = new JsonObject();
                    for (var prop : now.getProperties()) props.addProperty(prop.getName(), Handlers.valueName(now, prop));
                    JsonObject r = obj("used", true, "before", before, "after", Names.block(now), "changed", !now.equals(beforeState), "properties", props, "held", held, "result", result + (aimed.isEmpty() ? "" : " [aim: " + aimed + "]"),
                        "sneaking", m.player.isShiftKeyDown(), "answered", answeredAt >= 0);
                    if (bucket) {
                        // what the server did with the bucket: filled, poured at, or nothing (never the client's guess)
                        ItemStack hand = m.player.getInventory().getItem(slot);
                        String after = hand.isEmpty() ? "nothing" : Names.item(hand);
                        boolean known = ServerWord.handSyncs() > syncs || ItemStack.matches(hand, heldStack);
                        var ch = m.level == level ? ServerWord.diff(fluidsBefore, ServerWord.fluids(m.level, lo, hi), aimAt.x, aimAt.y, aimAt.z)
                            : new ServerWord.Changes(List.of(), List.of());
                        r.addProperty("bucket", ServerWord.verdict(held, after, guessed, ch, answeredAt >= 0, known,
                            heldStack.getCount(), hand.getCount(), ServerWord.fullBuckets(m.player.getInventory()) - fullBefore));
                        r.addProperty("heldAfter", after);
                    }
                    c.ok(r);
                }
            });
            return BridgeServer.LATER;
        });

        s.register("place", true, (p, c) -> {
            Aim aim = aimPlace(player(), p);
            if (aim.reason != null) return obj("placed", false, "reason", aim.reason, "distance", aim.distance >= 0 ? round(aim.distance) : null);
            // the server reads the rotation from the last movement packet, which the client sends on its next tick: place after it
            Ticker.add(new Ticker.Task() {
                int wait = 5;
                @Override public boolean tick(Minecraft m) {
                    wait--;
                    if (wait == 3) m.gameMode.useItemOn(m.player, InteractionHand.MAIN_HAND, aim.click);
                    if (wait > 0) return false;
                    BlockState now = m.level.getBlockState(aim.target);
                    c.ok(obj("placed", !replaceable(now), "block", Names.block(now), "face", aim.face));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        s.register("dig", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            BlockPos target = blockPos(p);
            BlockState before = mc.level.getBlockState(target);
            if (before.isAir()) return obj("dug", false, "reason", "air");
            if (Foreign.guarded(target, before) && !flag(p, "force")) return obj("dug", false, "reason", "someone else's build (force: true to dig it anyway)", "block", Names.block(before));
            // a lit nether portal's frame: never, not even when asked (it would put the portal out for everyone)
            if (Protection.portalFrame(target, before)) return obj("dug", false, "reason", "part of a lit nether portal's frame", "block", Names.block(before));
            long seq = Events.baritoneLogSeq();
            // breaking this one is the point (it may be a protected block the user asked to dig); narrow (the default):
            // only its kind may be broken on the way, the rest of what the bot built (and the yard's ground) stays
            // protected. narrow: false lifts all but the furniture, as it once always did: walking into reach of a stray
            // by the watchtower, Baritone cut logs and cobblestone out of the tower
            boolean narrow = !p.has("narrow") || p.get("narrow").getAsBoolean();
            if (narrow) { Protection.allowOnly(before.getBlock()); Protection.refresh(); } else Protection.suspend(before.getBlock());
            Processes.baritone().getBuilderProcess().clearArea(target, target); // walks into reach, picks the tool, digs
            Processes.watch(c, seq, intParam(p, "timeoutMs", 60_000) / 50, reason -> {
                if (narrow) { Protection.endAllowOnly(before.getBlock()); Protection.refresh(); } else Protection.resume(before.getBlock());
                BlockState now = Minecraft.getInstance().level.getBlockState(target);
                ItemStack held = Minecraft.getInstance().player.getMainHandItem();
                return obj("dug", replaceable(now), "block", Names.block(before), "tool", held.isEmpty() ? null : Names.item(held));
            });
            return BridgeServer.LATER;
        });

        // break a block from where the bot stands: no walking and no Baritone, so nothing else is broken or placed (the
        // tidy rounds dig scaffold this way; Baritone's builder reached it by breaking fences and walls and pillaring up)
        s.register("dig.here", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos target = blockPos(p);
            BlockState before = mc.level.getBlockState(target);
            if (before.isAir()) return obj("dug", false, "reason", "air");
            // someone else's build: not the bot's to dig, unless a person asked for this very block
            if (Foreign.guarded(target, before) && !flag(p, "force")) return obj("dug", false, "reason", "someone else's build (force: true to dig it anyway)", "block", Names.block(before));
            // a lit nether portal's frame: never, not even when asked (it would put the portal out for everyone)
            if (Protection.portalFrame(target, before)) return obj("dug", false, "reason", "part of a lit nether portal's frame", "block", Names.block(before));
            Vec3 eye = pl.getEyePosition();
            double reach = pl.blockInteractionRange();
            // the face seen from the eye: the nearest open face whose centre a ray from the eye hits on this block
            Direction face = null;
            Vec3 aim = null;
            for (Direction d : Direction.values()) {
                if (!replaceable(mc.level.getBlockState(target.relative(d)))) continue; // covered: not seen
                Vec3 fc = Vec3.atCenterOf(target).add(d.getUnitVec3().scale(0.49));
                if (fc.distanceTo(eye) > reach - 0.1) continue;
                var hit = mc.level.clip(new net.minecraft.world.level.ClipContext(eye, fc, net.minecraft.world.level.ClipContext.Block.OUTLINE,
                    net.minecraft.world.level.ClipContext.Fluid.NONE, pl));
                if (hit.getType() != net.minecraft.world.phys.HitResult.Type.BLOCK || !hit.getBlockPos().equals(target)) continue;
                if (aim == null || fc.distanceTo(eye) < aim.distanceTo(eye)) { face = d; aim = fc; }
            }
            // a small block (a torch, a flower, grass): its outline is nowhere near a face's middle, so no ray to one
            // hits it (a torch on a build's floor cell was "out of reach or out of sight" from a block away, and the
            // floor and everything on it after it failed). Aim at the middle of its outline instead
            if (face == null && !before.isCollisionShapeFullBlock(mc.level, target)) {
                var shape = before.getShape(mc.level, target);
                if (!shape.isEmpty()) {
                    Vec3 mid = shape.bounds().getCenter().add(target.getX(), target.getY(), target.getZ());
                    var hit = mc.level.clip(new net.minecraft.world.level.ClipContext(eye, mid, net.minecraft.world.level.ClipContext.Block.OUTLINE,
                        net.minecraft.world.level.ClipContext.Fluid.NONE, pl));
                    if (mid.distanceTo(eye) <= reach - 0.1 && hit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK && hit.getBlockPos().equals(target)) {
                        face = hit.getDirection();
                        aim = mid;
                    }
                }
            }
            if (face == null) return obj("dug", false, "reason", "out of reach or out of sight", "block", Names.block(before));
            final Direction f = face;
            final Vec3 a = aim;
            final int max = intParam(p, "timeoutMs", 15_000) / 50;
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (c.isDone()) { if (m.gameMode != null) m.gameMode.stopDestroyBlock(); return true; }
                    age++;
                    if (m.player == null || m.level == null) { c.fail("not in a world"); return true; }
                    if (replaceable(m.level.getBlockState(target))) {
                        ItemStack held = m.player.getMainHandItem();
                        c.ok(obj("dug", true, "block", Names.block(before), "tool", held.isEmpty() ? null : Names.item(held)));
                        return true;
                    }
                    if (age > max) { m.gameMode.stopDestroyBlock(); c.ok(obj("dug", false, "reason", "timeout", "block", Names.block(before))); return true; }
                    m.player.lookAt(EntityAnchorArgument.Anchor.EYES, a);
                    Tools.holdFor(target);
                    if (age < 3) return false; // the rotation and the tool go out first
                    if (age == 3) m.gameMode.startDestroyBlock(target, f);
                    else m.gameMode.continueDestroyBlock(target, f); // the arm swing is only for show: left out
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        s.register("use", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            int foodBefore = pl.getFoodData().getFoodLevel();
            float healthBefore = pl.getHealth();
            using = true;
            ItemStack inHand = pl.getMainHandItem();
            // the key is held only for an item used over time (food, a potion, a bow): held down after an item used at
            // once (a bucket, flint and steel, a snowball), the key uses it again every 4 ticks (Minecraft.startUseItem):
            // a water bucket poured, then filled again from its own water, and so on
            boolean overTime = inHand.getUseDuration(pl) > 0;
            // the bridge's own use, so the guard lets a full bucket or a fire starter through (Hazards): this call only
            Hazards.arm(Names.item(inHand), 2);
            try {
                mc.gameMode.useItem(pl, InteractionHand.MAIN_HAND);
            } finally {
                Hazards.disarm();
            }
            if (overTime) mc.options.keyUse.setDown(true); // the client stops using an item as soon as the use key is up
            Ticker.add(new Ticker.Task() {
                int age = 0;
                boolean started = false;
                @Override public boolean tick(Minecraft m) {
                    age++;
                    if (m.player.isUsingItem()) started = true;
                    if (!(started && !m.player.isUsingItem()) && age < (overTime ? 80 : 5)) return false;
                    if (overTime) m.options.keyUse.setDown(false);
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
            // `slot` (inventory index 0-35): that stack first, then only ones the same as it (sources): of two pickaxes
            // the plain one goes, not the enchanted one first by name
            var inv = pl.getInventory();
            int from = intParam(p, "slot", -1);
            List<Integer> order = sources(k -> nameOf(inv.getItem(k)), 36, name, from,
                (a, b) -> ItemStack.isSameItemSameComponents(inv.getItem(a), inv.getItem(b)));
            for (int i : order) {
                if (moved >= want) break;
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
            if (from >= 0) r.addProperty("from", order.isEmpty() ? -1 : order.getFirst()); // the slot it took from first
            return r;
        });

        s.register("chest.withdraw", true, (p, c) -> {
            LocalPlayer pl = player();
            if (!(pl.containerMenu instanceof net.minecraft.world.inventory.ChestMenu menu)) throw new IllegalStateException("no chest open");
            String name = required(p, "name").replace("minecraft:", "");
            int want = intParam(p, "count", Integer.MAX_VALUE);
            int own = menu.getRowCount() * 9;
            int taken = 0;
            // `slot` (the chest's, 0 the top left, as `stacks` numbers them): that stack first, then only ones the same
            // as it (sources): the book with mending, not the first enchanted_book by name
            int from = intParam(p, "slot", -1);
            List<Integer> order = sources(k -> nameOf(menu.getSlot(k).getItem()), own, name, from,
                (a, b) -> ItemStack.isSameItemSameComponents(menu.getSlot(a).getItem(), menu.getSlot(b).getItem()));
            for (int k : order) {
                if (taken >= want) break;
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
            if (from >= 0) r.addProperty("from", order.isEmpty() ? -1 : order.getFirst()); // the slot it took from first
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

        // throw items toward a point, a gold ingot to a piglin's feet (its position): turned to the point at the pitch whose
        // throw comes to rest nearest it (Toss), the look sent first, as for the fireball's hit (the server throws along the
        // look it has for the bot), then the inventory's one-item throw, the same throw as Q's. The shield stays up: a
        // throw from the inventory ends no use. Then it watches the thrown item until it comes to rest, at most the 2 s
        // nothing may pick it up in, and says where it lies (`landed`, each with `fromTarget` along the ground; `gone`: in
        // lava, or taken). Refused when the point has no floor under it, no throw rests within Toss.MAX_MISS of it (a
        // throw goes about 3.75 at most), or one might rest by lava or fire. One a piglin cannot see, or one that lands
        // nearer another piglin (or a baby, which keeps it), is the caller's to avoid.
        s.register("item.toss", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            String name = required(p, "name").replace("minecraft:", "");
            int want = Math.max(1, Math.min(intParam(p, "count", 1), 16));
            if (!p.has("toward") || !p.get("toward").isJsonObject()) throw new IllegalArgumentException("missing parameter: toward {x, y, z}");
            JsonObject t = p.getAsJsonObject("toward");
            Vec3 to = new Vec3(numParam(t, "x", Double.NaN), numParam(t, "y", Double.NaN), numParam(t, "z", Double.NaN));
            if (!Double.isFinite(to.x) || !Double.isFinite(to.y) || !Double.isFinite(to.z)) throw new IllegalArgumentException("toward needs x, y and z");
            boolean carried = false;
            for (int i = 0; i < 36 && !carried; i++) carried = name.equals(nameOf(pl.getInventory().getItem(i)));
            if (!carried) throw new IllegalArgumentException("no " + name + " in inventory");
            Vec3 start = new Vec3(pl.getX(), pl.getEyeY() - Toss.BELOW_EYE, pl.getZ());
            double dx = to.x - start.x, dz = to.z - start.z, distance = Math.hypot(dx, dz);
            // the floor it is to rest on: the block under the point (soul sand's top is 2/16 down: the point in its cell)
            BlockPos floor = BlockPos.containing(to.x, to.y - 0.2, to.z);
            if (!mc.level.isLoaded(floor)) throw new IllegalStateException("the point is not loaded");
            BlockState floorState = mc.level.getBlockState(floor);
            var shape = floorState.getCollisionShape(mc.level, floor);
            // the point is where it is to rest: a mob's feet, not its eyes, and not a mob in mid-jump
            if (shape.isEmpty()) throw new IllegalStateException("nothing to land on under the point (" + Names.block(floorState) + " at " + floor.toShortString() + "): give a mob's feet");
            double sink = Math.max(0, Math.min(1, 1 - shape.max(Direction.Axis.Y)));
            Toss.Floor ground = new Toss.Floor(floorState.getBlock().getFriction(), floorState.getBlock().getSpeedFactor(), sink);
            boolean step = Math.abs(to.y - pl.getY()) > 0.5;
            Toss.Aim aim = Toss.aim(distance, start.y - to.y, ground, step);
            if (aim == null || aim.miss(distance) > Toss.MAX_MISS) {
                throw new IllegalStateException("no throw rests by the point, " + round(distance) + " blocks off along the ground"
                    + (aim == null ? ": no throw comes down on its floor" : ": the nearest rests " + round(aim.rest()) + " out (stand 1 to 4 from it)"));
            }
            float yaw = distance < 1e-3 ? pl.getYRot() : Toss.yaw(dx, dz);
            Vec3 along = distance < 1e-3 ? Vec3.ZERO : new Vec3(dx / distance, 0, dz / distance);
            // no lava or fire where it may come to rest (a lost ingot)
            for (BlockPos b : Toss.restCells(start, along, aim, to.y, step ? pl.getY() : to.y)) {
                BlockState st = mc.level.getBlockState(b);
                if (st.getFluidState().is(net.minecraft.tags.FluidTags.LAVA) || st.is(net.minecraft.tags.BlockTags.FIRE)) {
                    throw new IllegalStateException("the throw might come to rest by " + Names.block(st) + " at (" + b.getX() + ", " + b.getY() + ", " + b.getZ() + ")");
                }
            }
            java.util.Set<Integer> before = new java.util.HashSet<>();
            for (net.minecraft.world.entity.Entity e : mc.level.entitiesForRendering()) if (e instanceof net.minecraft.world.entity.item.ItemEntity) before.add(e.getId());
            float pitch = (float) aim.pitch();
            pl.setYRot(yaw);
            pl.setXRot(pitch);
            pl.setYHeadRot(yaw);
            pl.connection.send(new net.minecraft.network.protocol.game.ServerboundMovePlayerPacket.Rot(yaw, pitch, pl.onGround(), pl.horizontalCollision));
            int tossed = 0;
            for (int i = 0; i < 36 && tossed < want; i++) {
                while (tossed < want && name.equals(nameOf(pl.getInventory().getItem(i)))) {
                    int had = pl.getInventory().getItem(i).getCount();
                    click(pl.inventoryMenu, inventoryMenuSlot(i), 0, ContainerInput.THROW);
                    ItemStack now = pl.getInventory().getItem(i);
                    if ((now.isEmpty() ? 0 : now.getCount()) >= had) break; // not taken: no endless clicking
                    tossed++;
                }
            }
            if (tossed == 0) throw new IllegalStateException("could not throw the " + name);
            final int thrown = tossed;
            final Vec3 rest = start.add(along.scale(aim.rest()));
            Ticker.add(new Ticker.Task() {
                int age = 0;
                final Map<Integer, net.minecraft.world.entity.item.ItemEntity> mine = new java.util.LinkedHashMap<>();
                @Override public boolean tick(Minecraft m) {
                    if (m.player == null || m.level == null) { c.fail("not in a world"); return true; }
                    age++;
                    // ours: an item of the name that turns up by the throw's start within a second (its data comes with it)
                    if (mine.size() < thrown && age <= 20) for (net.minecraft.world.entity.Entity e : m.level.entitiesForRendering()) {
                        if (e instanceof net.minecraft.world.entity.item.ItemEntity ie && !before.contains(ie.getId()) && !mine.containsKey(ie.getId())
                            && name.equals(nameOf(ie.getItem())) && ie.position().distanceTo(start) < 3 && mine.size() < thrown) mine.put(ie.getId(), ie);
                    }
                    boolean still = mine.size() >= thrown && mine.values().stream()
                        .allMatch(ie -> ie.isRemoved() || (ie.onGround() && ie.getDeltaMovement().horizontalDistanceSqr() < 1e-4));
                    if (age < Toss.PICKUP_DELAY && !(still && age >= 10)) return false;
                    com.google.gson.JsonArray landed = new com.google.gson.JsonArray();
                    for (var ie : mine.values()) {
                        JsonObject o = pos(ie.position());
                        o.addProperty("fromTarget", round(Math.hypot(ie.getX() - to.x, ie.getZ() - to.z)));
                        if (ie.isRemoved()) o.addProperty("gone", true);
                        landed.add(o);
                    }
                    c.ok(obj("tossed", thrown, "item", name, "yaw", round(yaw), "pitch", round(pitch), "distance", round(distance),
                        "predicted", pos(new Vec3(rest.x, to.y, rest.z)), "shortest", round(aim.shortest()), "longest", round(aim.longest()),
                        "landed", landed));
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // fish at a water block: cast, reel in when a fish bites, repeat `times` (recast after 45 s without a bite). The
        // brain's `cancel` ends it as well: a run it gave up on went on casting to its timeout before, the rod taken back
        // into the hand over whatever ran next. A hook that caught something in its flight (an animal, someone's dog, a
        // player) is let go, never reeled in, since the reel pulls what the hook holds: the rod goes out of the hand (the
        // server drops a hook whose owner holds no rod) until the hook is gone, and the call ends there, so that no other
        // cast goes out along a line someone stands in before the brain has looked (a dropped item caught is no one: the
        // casts go on). Nor does a cast go out with no free slot for its catch (a book, a saddle, a name tag stacks with
        // nothing: one fished up into full pockets lay on the shore till it despawned): `full`; nor while a player or
        // someone's animal stands within 8 of its line (one walked onto the shore mid-call was hooked by the next
        // recast before): `blocked`, their words. `open`: the bites whose cast bobbed in
        // open water by the game's own rule (FishingHook.calculateOpenWater, run here on the client's copy of the same
        // blocks): treasure is fished up only there; -1 where it cannot be read. After the last bite the reply waits for
        // the catch to fly in (about a second), so `gained` holds it.
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
                bitingField = FishingHook.class.getDeclaredField("biting");
                bitingField.setAccessible(true);
            } catch (ReflectiveOperationException e) { throw new IllegalStateException("cannot read the fishing hook: " + e); }
            final java.lang.reflect.Field biting = bitingField;
            final java.lang.reflect.Method openWater = openWaterRule();
            final long cancels = Processes.cancels;
            // an enchanted rod carried is the one fished with (lure, luck of the sea: quicker bites, more treasure)
            int enchanted = enchantedRod(player().getInventory());
            if (enchanted >= 0 && !player().getMainHandItem().isEnchanted()) select("fishing_rod", enchanted);
            handsBusy = true;
            Ticker.add(new Ticker.Task() {
                int age = 0, castAt = -1, wait = 0, caught = 0, casts = 0, open = 0, lastBite = -1, letGoAt = -1;
                /** this cast's hook in open water at every look since it settled (the server ANDs it the same way) */
                boolean castOpen = true, looked = false, openKnown = openWater != null;
                /** the hook let go of something other than a dropped item (letGoAt) */
                boolean letGoLiving = false;
                /** the call ended before a cast: no free slot for its catch (`full`), or who stood by its line (`blocked`) */
                boolean full = false;
                String blocked = null;
                final java.util.ArrayDeque<String> stale = new java.util.ArrayDeque<>(); // where recalled hooks were
                final java.util.LinkedHashSet<String> letGo = new java.util.LinkedHashSet<>();
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pl = m.player;
                    if (pl == null) { handsBusy = false; c.fail("not in a world"); return true; }
                    if (Processes.cancels != cancels) return finish(m);
                    if (++age > timeout || caught >= times) {
                        // (the catch flies to the bot from the hook: no new cast meanwhile)
                        if (lastBite >= 0 && age - lastBite < CATCH_LANDS && age <= timeout + CATCH_LANDS) return false;
                        return finish(m);
                    }
                    if (wait > 0) { wait--; return false; }
                    // a mob at arm's length is the Guardian's to fight, its weapon in hand: no rod taken back into the
                    // hand meanwhile (each swap back reset its swing, and the hits never came), no cast. The hook out
                    // when the weapon came into the hand is dropped by the server, and nothing is pulled
                    if (Guardian.meleeTarget(pl) != null) return false;
                    // a hook let go: no rod back in the hand until the server has dropped it. Then, where it held
                    // anyone (an animal, someone's dog, a player), the call ends: they may still stand in the cast's
                    // line, and the cast that came next hooked them again, about once a second to the call's end. The
                    // brain looks round before it casts again (fish.ts nearCast). A dropped item the hook caught (the
                    // last catch flying in) is no one: cast again
                    if (letGoAt >= 0) {
                        if (pl.fishing != null && age - letGoAt < 60) return false;
                        letGoAt = -1;
                        if (letGoLiving) return finish(m);
                    }
                    if (!Names.item(pl.getMainHandItem()).equals("fishing_rod")) {
                        if (find(pl.getInventory(), "fishing_rod") < 0) return finish(m); // it broke
                        select("fishing_rod", enchantedRod(pl.getInventory()));
                        wait = 2;
                        return false;
                    }
                    var hook = pl.fishing;
                    if (hook == null) {
                        // a free slot for this cast's catch: the last one let land first where it may take the last
                        // slot (and `gained` hold it)
                        int free = freeSlots(pl.getInventory());
                        if (free < 2 && lastBite >= 0 && age - lastBite < CATCH_LANDS) return false;
                        if (free < 1) { full = true; return finish(m); }
                        blocked = nearCast(pl, aim);
                        if (blocked != null) return finish(m);
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
                        castOpen = true;
                        looked = false;
                        return false;
                    }
                    if (hook.getHookedIn() != null) {
                        letGo.add(Names.entity(hook.getHookedIn()));
                        letGoLiving |= !(hook.getHookedIn() instanceof net.minecraft.world.entity.item.ItemEntity);
                        letGoAt = age;
                        rodOutOfHand(pl);
                        wait = 2;
                        return false;
                    }
                    boolean bite;
                    try { bite = biting.getBoolean(hook); } catch (IllegalAccessException e) { bite = false; }
                    // a bobbing hook floats on top (y 62.9 on a y 62 water block), where its own isInWater() says no, so
                    // look for water just under it; every good cast was reeled back after 3 s before
                    boolean onWater = hook.isInWater() || m.level.getFluidState(BlockPos.containing(hook.getX(), hook.getY() - 0.3, hook.getZ()))
                        .is(net.minecraft.tags.FluidTags.WATER);
                    // its open water looked at once a second while it bobs and waits (not at the bite itself: the bite
                    // pulls the hook under, a block lower than where it waited)
                    if (onWater && !bite && openKnown && (age - castAt) % 20 == 0) {
                        try {
                            castOpen &= (Boolean) openWater.invoke(hook, hook.blockPosition());
                            looked = true;
                        } catch (ReflectiveOperationException | RuntimeException e) { openKnown = false; }
                    }
                    boolean expired = age - castAt > 900 || (age - castAt > 60 && !onWater);
                    if (bite || expired) {
                        if (!bite) {
                            if (stale.size() >= 3) stale.removeFirst();
                            stale.addLast(String.format("hook at (%.1f, %.1f, %.1f)%s%s, %d ticks", hook.getX(), hook.getY(), hook.getZ(),
                                onWater ? " on water" : "", hook.onGround() ? " on ground" : "", age - castAt));
                        }
                        m.gameMode.useItem(pl, InteractionHand.MAIN_HAND); // reel in
                        if (bite) {
                            caught++;
                            lastBite = age;
                            if (looked && castOpen) open++;
                        }
                        wait = 15;
                    }
                    return false;
                }

                boolean finish(Minecraft m) {
                    handsBusy = false;
                    LocalPlayer pl = m.player;
                    // reeled in, unless the hook holds something: then let go (the reel would pull it). Only with the
                    // rod in the hand: out of it (a let-go's wait run out, the Guardian's weapon in hand at a cancel)
                    // the use would be of whatever is there, food, a bow, a pearl; the server drops a hook whose owner
                    // holds no rod anyway
                    if (pl != null && pl.fishing != null) {
                        if (pl.fishing.getHookedIn() != null) { letGo.add(Names.entity(pl.fishing.getHookedIn())); rodOutOfHand(pl); }
                        else if (Names.item(pl.getMainHandItem()).equals("fishing_rod")) m.gameMode.useItem(pl, InteractionHand.MAIN_HAND);
                    }
                    Map<String, Integer> gained = Processes.gained(before, Processes.inventoryCounts(m));
                    com.google.gson.JsonArray let = new com.google.gson.JsonArray();
                    for (String n : letGo) let.add(n);
                    JsonObject reply = obj("bites", caught, "casts", casts, "gained", gained, "seconds", Json.round(age / 20.0), "recalled", String.join("; ", stale),
                        "open", openKnown ? open : -1, "letGo", let);
                    if (full) reply.addProperty("full", true);
                    if (blocked != null) reply.addProperty("blocked", blocked);
                    c.ok(reply);
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
            // slot: "output" (default) or "input" (take back what's waiting to cook, to free the furnace)
            int from = "input".equals(strParam(p, "slot", "output")) ? 0 : 2;
            ItemStack out = menu.getSlot(from).getItem().copy();
            click(menu, from, 0, ContainerInput.QUICK_MOVE);
            return obj("took", out.isEmpty() ? null : obj("name", Names.item(out), "count", out.getCount()));
        });
        s.register("container.close", true, (p, c) -> { player().closeContainer(); return obj("ok", true); });

        // right-click a bed and wait for the server to put us in it; a refusal comes back as an action-bar message
        s.register("bed.sleep", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            if (pl.isSleeping()) return obj("sleeping", true);
            // outside the overworld a bed explodes when used (the Nether's bed_rule: destroy_on_use): never there
            String never = Nether.bedRefusal(Names.dimension(mc.level), true);
            if (never != null) return obj("sleeping", false, "reason", never);
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
