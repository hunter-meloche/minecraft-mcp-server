package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.inventory.BrewingStandMenu;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.ArrayList;
import java.util.List;

import static claudebridge.Interact.click;
import static claudebridge.Interact.flag;
import static claudebridge.Interact.player;
import static claudebridge.Json.*;

/**
 * Brewing stands through the normal menu packets, the way the anvil and the enchanting table are driven (Anvil.java,
 * Enchanting.java): open the stand, put the bottles, the ingredient and the blaze powder in, read what the server says
 * (the slots, the fuel left, the brew's ticks), take the potions out, close. Unlike the anvil and the table, the stand
 * is a block with its own inventory: closing the menu hands nothing back, and the brew goes on with the menu shut
 * (BrewingStandBlockEntity.serverTick runs whoever looks), so a batch is put in, the menu closed, and the potions taken
 * once it is done, 20 s later.
 *
 * Checked against the 26.3 jar, where brewing is data driven (data/minecraft/recipe/brewing/*.json, type
 * minecraft:brewing: an input potion by its contents, a reagent, an output): the water bottle and nether wart make
 * awkward (potion_water_nether_wart), awkward and magma cream fire resistance, blaze powder strength, sugar swiftness,
 * and each of those and redstone its long version (potion_fire_resistance_redstone and so on). Blaze powder is the only
 * fuel (Items: brewingFuel(BREWING_DEFAULT_USES), 20 brews a powder: context_int_provider/brewing/uses_default.json). A
 * brew takes 400 ticks at speed 1.0 (BREWING_TIME_SECONDS 20), uses one of the ingredient for all three bottles, and
 * starts by itself once the ingredient brews at least one of the bottles there and there is fuel.
 */
public final class Brewing {
    private Brewing() { }

    /**
     * Menu slots (26.3 BrewingStandMenu): 0-2 the bottles (PotionSlot: one each, only what PotionIngredient.isPotionInput
     * takes: the potions the brewing recipes start from), 3 the ingredient (IngredientsSlot: the BREWING_REAGENTS set),
     * 4 the fuel (FuelSlot: an item with the BREWING_FUEL component), then the player's 27 main slots and 9 hotbar
     * slots. The block entity's own slots are the same five (INGREDIENT_SLOT 3, FUEL_SLOT 4).
     */
    static final int BOTTLES = 3, INGREDIENT = 3, FUEL = 4, OWN_SLOTS = 5;
    /** Brews a blaze powder gives (ContextIntProviders.BREWING_DEFAULT_USES, the data's uses_default 20). */
    static final int USES_PER_POWDER = 20;
    /** A brew's ticks at the default speed (BrewingStandBlockEntity: BREWING_TIME_SECONDS 20, speed_default 1.0). */
    static final int BREW_TICKS = 400;

    /**
     * Ticks a put waits for the server's word that a brew started, where the stand could start one (an ingredient, a
     * bottle, fuel): the brew starts only on the server, in the stand's tick after the click, and its data slot comes a
     * round trip and a tick or two later still, after the slot's own word. A put that answered at its 4th tick said
     * "not brewing" on a stand that brewed, and the brain gave the batch up.
     */
    static final int START_TICKS = 20;

    /**
     * Whether a put's reply may go at this tick, pure: the slot and whether it brews unchanged for 2 ticks, from the 4th
     * on (or 10 at most); but where the stand could brew and does not show it yet, not before START_TICKS.
     */
    static boolean answered(int age, int stable, boolean couldBrew, boolean brewing) {
        if (couldBrew && !brewing && age < START_TICKS) return false;
        return (age >= 4 && stable >= 2) || age >= 10;
    }

    /** The stand could start a brew by what it holds: an ingredient, a bottle, and fuel burning or in its slot. */
    static boolean couldBrew(BrewingStandMenu mm) {
        boolean bottle = false;
        for (int k = 0; k < BOTTLES; k++) bottle |= !mm.getSlot(k).getItem().isEmpty();
        return bottle && !mm.getSlot(INGREDIENT).getItem().isEmpty() && (mm.getFuel() > 0 || !mm.getSlot(FUEL).getItem().isEmpty());
    }

    /** The stand brew.open last opened, for the replies. */
    private static BlockPos openAt;

    /**
     * Which of the stand's slots a put goes into, pure: a number 0-4 as given (0-2 a bottle, 3 the ingredient, 4 the
     * fuel), or by name: "ingredient", "fuel", and "bottle" for the first empty of the three ({@code bottleFree}), -1
     * when all three hold one. Anything else is refused.
     */
    static int target(String into, boolean[] bottleFree) {
        if (into == null) throw new IllegalArgumentException("into required: bottle (or 0-2), ingredient (3) or fuel (4)");
        switch (into) {
            case "ingredient": return INGREDIENT;
            case "fuel": return FUEL;
            case "bottle": {
                for (int k = 0; k < BOTTLES; k++) if (bottleFree[k]) return k;
                return -1;
            }
            default: {
                // a number comes as "3" (or "3.0" from a JSON number read as a string)
                if (!into.matches("[0-4](\\.0)?")) throw new IllegalArgumentException("into must be bottle, 0-2, ingredient (3) or fuel (4), not " + into);
                return into.charAt(0) - '0';
            }
        }
    }

    /** A slot's name in the replies: bottle 0-2, ingredient, fuel. */
    static String slotName(int k) {
        return k == INGREDIENT ? "ingredient" : k == FUEL ? "fuel" : "bottle " + k;
    }

    /**
     * Why a put is refused, pure, or null when it may go: the stand's own rule for the slot ({@code mayPlace}: the
     * menu's slot, read from the recipes the server synced), one bottle a bottle slot, and no bottle taken out from under
     * a brew. {@code holds}: what the slot holds now (null: empty), {@code same}: it is the same item and components as
     * the one put, {@code brewing}: the stand is brewing now.
     */
    static String refusal(int target, String item, boolean mayPlace, String holds, boolean same, boolean brewing) {
        if (!mayPlace) {
            return target == FUEL ? "the brewing stand burns only blaze_powder, not " + item
                : target == INGREDIENT ? "no brewing recipe takes " + item + " as its ingredient"
                : "a bottle slot takes only a potion a brew starts from (a water bottle, an awkward potion...), not " + item;
        }
        if (holds == null) return null;
        // a brew under way: what is in the stand is the batch (a bottle taken or the ingredient changed stops it)
        if (brewing && !same) return "brewing: the " + slotName(target) + " slot holds " + holds + " (take it after the brew)";
        if (target < BOTTLES) return "the " + slotName(target) + " slot holds " + holds + " already (one bottle a slot)";
        return null;
    }

    /** The bottle slots a take empties, pure: "bottles" (or none given) every bottle slot that holds one, else the one slot. */
    static List<Integer> takeFrom(String from, boolean[] holds) {
        List<Integer> out = new ArrayList<>();
        if (from == null || from.equals("bottles")) {
            for (int k = 0; k < BOTTLES; k++) if (holds[k]) out.add(k);
            return out;
        }
        int k = target(from, new boolean[BOTTLES]);
        if (k < 0 || k > 4) throw new IllegalArgumentException("from must be bottles, 0-2, ingredient or fuel");
        if (holds[k]) out.add(k);
        return out;
    }

    /** A stack's potion contents ('long_fire_resistance', 'water', 'awkward'), or null for none. */
    static String contents(ItemStack st) {
        var pc = st.isEmpty() ? null : st.get(DataComponents.POTION_CONTENTS);
        return pc == null ? null : pc.potion().map(h -> Names.strip(h.getRegisteredName())).orElse(null);
    }

    static BrewingStandMenu menu() {
        if (!(player().containerMenu instanceof BrewingStandMenu menu)) throw new IllegalStateException("no brewing stand open (brew.open first)");
        return menu;
    }

    /** A slot's stack with its potion contents (Handlers.withDetail), or JSON null for an empty slot. */
    static com.google.gson.JsonElement detail(ItemStack st) {
        return st.isEmpty() ? JsonNull.INSTANCE : Handlers.withDetail(obj("name", Names.item(st), "count", st.getCount()), st);
    }

    static int freePockets(LocalPlayer pl) {
        int n = 0;
        for (int i = 0; i < 36; i++) if (pl.getInventory().getItem(i).isEmpty()) n++;
        return n;
    }

    /**
     * What the stand shows, as the server synced it: the three bottles, the ingredient and the fuel; the brews left in
     * the burning powder ({@code fuelUses}, of 20); the brew's ticks left ({@code brewTicks}, counting down from
     * {@code totalBrewTicks}; 0: not brewing); and the free pocket slots a take needs (a potion does not stack).
     */
    static JsonObject status() {
        LocalPlayer pl = player();
        if (!(pl.containerMenu instanceof BrewingStandMenu menu)) return obj("open", false);
        JsonArray bottles = new JsonArray();
        for (int k = 0; k < BOTTLES; k++) bottles.add(detail(menu.getSlot(k).getItem()));
        int left = menu.getBrewingTicks();
        return obj("open", true, "at", openAt == null ? null : pos(openAt), "bottles", bottles,
            "ingredient", detail(menu.getSlot(INGREDIENT).getItem()), "fuel", detail(menu.getSlot(FUEL).getItem()),
            "fuelUses", menu.getFuel(), "brewing", left > 0, "brewTicks", left, "totalBrewTicks", menu.getTotalBrewingTicks(),
            "freePockets", freePockets(pl));
    }

    public static void register(BridgeServer s) {
        s.register("brew.status", true, (p, c) -> status());

        // a brewing_stand within 4.5 blocks: right-click it and wait for the menu. Any hand will do: the stand's own use
        // takes the click first (Hazards.TAKES_CLICK), so a bottle or a bucket in hand is not used
        s.register("brew.open", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            BlockPos at = blockPos(p);
            String block = Names.block(mc.level.getBlockState(at));
            if (!block.equals("brewing_stand")) throw new IllegalArgumentException("no brewing_stand at " + at.toShortString() + " (" + block + ")");
            // the stand's middle (its rod): the server takes any point in the cell, and the base is only 2/16 high
            Vec3 hit = Vec3.atCenterOf(at);
            double d = pl.getEyePosition().distanceTo(hit);
            if (d > 4.5) throw new IllegalStateException("brewing stand too far to open (" + round(d) + " blocks, max 4.5)");
            // a sneaking click with something in hand skips the stand's own use and goes to the item
            if (pl.isShiftKeyDown() || mc.options.keyShift.isDown()) throw new IllegalStateException("sneaking: the click would go to the item in hand, not the stand");
            if (pl.containerMenu != pl.inventoryMenu) pl.closeContainer();
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            mc.gameMode.useItemOn(pl, InteractionHand.MAIN_HAND, new BlockHitResult(hit, Direction.UP, at, false));
            openAt = at.immutable();
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    if (m.player == null) { c.fail("not in a world"); return true; }
                    // a tick or two more for the data slots (fuel, brew ticks), which come after the menu's contents
                    if (m.player.containerMenu instanceof BrewingStandMenu) { if (++age >= 2) { c.ok(status()); return true; } return false; }
                    if (++age > 40) { c.fail("the brewing stand did not open"); return true; }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // put an item from the pockets into one of the stand's slots: `into` "bottle" (the first empty bottle slot) or
        // 0-2, "ingredient" (3), "fuel" (4). `name` the item ('potion', 'nether_wart', 'blaze_powder'); `potion` the
        // contents a potion must have ('water', 'awkward': picked by its contents, never by the name alone, which four
        // kinds share); `slot` (inventory index 0-35) one of several (its contents still checked); `count` for the
        // ingredient and the fuel (default 1, at most a stack; a bottle slot takes one). An ingredient or fuel slot that
        // holds the same item is topped up; one that holds something else has it shifted back to the pockets first,
        // never while a brew is under way. The reply waits for the server: the slot as it has it, and whether the brew
        // started (it starts by itself: the right ingredient, a bottle it brews, fuel)
        s.register("brew.put", true, (p, c) -> {
            LocalPlayer pl = player();
            BrewingStandMenu menu = menu();
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the brewing stand first");
            boolean[] free = new boolean[BOTTLES];
            for (int k = 0; k < BOTTLES; k++) free[k] = menu.getSlot(k).getItem().isEmpty();
            int target = target(strParam(p, "into", null), free);
            if (target < 0) throw new IllegalStateException("all three bottle slots hold a bottle");
            var inv = pl.getInventory();
            String named = strParam(p, "name", null);
            int asked = intParam(p, "slot", -1);
            String name = named != null ? named.replace("minecraft:", "")
                : asked >= 0 && asked < 36 && !inv.getItem(asked).isEmpty() ? Names.item(inv.getItem(asked)) : null;
            if (name == null) throw new IllegalArgumentException("name, or a pocket slot (0-35) that holds something, required");
            String potion = strParam(p, "potion", null);
            String want = potion == null ? null : potion.replace("minecraft:", "");
            // by the name, and with `potion` by the contents too: a slot asked for that holds another potion is not taken
            java.util.function.IntFunction<String> nameAt = k -> {
                ItemStack st = inv.getItem(k);
                if (st.isEmpty() || !Names.item(st).equals(name)) return null;
                return want == null || want.equals(contents(st)) ? name : null;
            };
            int i = Interact.pick(nameAt, 36, name, asked);
            String what = name + (want == null ? "" : " (" + want + ")");
            if (i < 0) throw new IllegalArgumentException("no " + what + " in the pockets");
            ItemStack source = inv.getItem(i);
            ItemStack holds = menu.getSlot(target).getItem();
            boolean same = !holds.isEmpty() && ItemStack.isSameItemSameComponents(holds, source);
            boolean brewing = menu.getBrewingTicks() > 0;
            String why = refusal(target, what, menu.getSlot(target).mayPlace(source), holds.isEmpty() ? null : Names.item(holds)
                + (contents(holds) == null ? "" : " (" + contents(holds) + ")"), same, brewing);
            if (why != null) throw new IllegalStateException(why);
            if (!holds.isEmpty() && !same) {
                click(menu, target, 0, ContainerInput.QUICK_MOVE);
                if (!menu.getSlot(target).getItem().isEmpty()) throw new IllegalStateException("could not clear the " + slotName(target) + " slot (pockets full?)");
                i = Interact.pick(nameAt, 36, name, asked); // the slot may have moved with what came back
                if (i < 0) throw new IllegalArgumentException("no " + what + " in the pockets");
            }
            int count = target < BOTTLES ? 1 : Math.max(1, Math.min(64, intParam(p, "count", 1)));
            int before = menu.getSlot(target).getItem().getCount();
            int from = Interact.containerMenuSlot(OWN_SLOTS, i);
            click(menu, from, 0, ContainerInput.PICKUP); // carry the stack
            if (count >= menu.getCarried().getCount()) click(menu, target, 0, ContainerInput.PICKUP); // all of it (a bottle slot keeps one)
            else for (int n = 0; n < count; n++) click(menu, target, 1, ContainerInput.PICKUP); // one at a time
            if (!menu.getCarried().isEmpty()) click(menu, from, 0, ContainerInput.PICKUP); // the rest back
            final int into = target;
            // the server's word: a click it handled as the client did comes with no reply, one it did not puts the
            // client right a tick or two later; and a brew that starts shows in the data slots a round trip and a tick
            // or two after that. So: the slot and whether it brews unchanged for 2 ticks, from the 4th on (or 10 at
            // most), and up to START_TICKS where the stand could brew and shows no brew yet (answered)
            Ticker.add(new Ticker.Task() {
                int age = 0, stable = 0;
                String last = "";
                @Override public boolean tick(Minecraft m) {
                    if (!(m.player != null && m.player.containerMenu instanceof BrewingStandMenu mm)) { c.fail("the brewing stand closed"); return true; }
                    age++;
                    ItemStack now = mm.getSlot(into).getItem();
                    // (whether it brews, not its ticks: those count down every tick of a brew)
                    String seen = (now.isEmpty() ? "-" : Names.item(now) + " x" + now.getCount()) + (mm.getBrewingTicks() > 0 ? " brewing" : "");
                    stable = seen.equals(last) ? stable + 1 : 0;
                    last = seen;
                    if (answered(age, stable, couldBrew(mm), mm.getBrewingTicks() > 0)) {
                        JsonObject r = status();
                        r.addProperty("into", slotName(into));
                        r.addProperty("put", Math.max(0, now.getCount() - before));
                        r.add("slot", detail(now));
                        c.ok(r);
                        return true;
                    }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });

        // shift-click out of the stand into the pockets: `from` "bottles" (the default: every bottle slot that holds
        // one), 0-2, "ingredient" or "fuel". Refused while a brew is under way (a bottle taken out is not brewed, and
        // with none left the brew stops) unless `force`, and when the pockets lack a free slot for each bottle (a potion
        // does not stack). The reply waits half a second for the server (it puts a refused click right), then reports
        // what came into the pockets, each with its contents and pocket slot
        s.register("brew.take", true, (p, c) -> {
            LocalPlayer pl = player();
            BrewingStandMenu menu = menu();
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the brewing stand first");
            boolean[] holds = new boolean[5];
            for (int k = 0; k < 5; k++) holds[k] = !menu.getSlot(k).getItem().isEmpty();
            List<Integer> slots = takeFrom(strParam(p, "from", null), holds);
            if (slots.isEmpty()) {
                JsonObject r = status();
                r.addProperty("ok", true);
                r.add("taken", new JsonArray());
                r.addProperty("reason", "nothing there to take");
                return r;
            }
            int left = menu.getBrewingTicks();
            if (left > 0 && !flag(p, "force")) throw new IllegalStateException("brewing (" + (left + 19) / 20 + " s left): take the potions once it is done, or force");
            int bottles = 0;
            for (int k : slots) if (k < BOTTLES) bottles++;
            if (freePockets(pl) < Math.max(1, bottles)) throw new IllegalStateException("too few free pocket slots (" + freePockets(pl) + ") for " + Math.max(1, bottles) + " stack(s)");
            var inv = pl.getInventory();
            ItemStack[] pockets = new ItemStack[36];
            for (int k = 0; k < 36; k++) pockets[k] = inv.getItem(k).copy();
            for (int k : slots) click(menu, k, 0, ContainerInput.QUICK_MOVE);
            Ticker.add(new Ticker.Task() {
                int age = 0;
                @Override public boolean tick(Minecraft m) {
                    LocalPlayer pp = m.player;
                    if (pp == null) { c.fail("not in a world"); return true; }
                    age++;
                    boolean open = pp.containerMenu instanceof BrewingStandMenu;
                    boolean emptied = open && slots.stream().allMatch(k -> ((BrewingStandMenu) pp.containerMenu).getSlot(k).getItem().isEmpty());
                    if (age < 10 || (!emptied && age < 30)) return false;
                    // what is new in the pockets: a slot that was empty or held less of the same
                    JsonArray taken = new JsonArray();
                    var in = pp.getInventory();
                    for (int k = 0; k < 36; k++) {
                        ItemStack now = in.getItem(k), was = pockets[k];
                        if (now.isEmpty()) continue;
                        int gained = was.isEmpty() ? now.getCount() : ItemStack.isSameItemSameComponents(was, now) ? now.getCount() - was.getCount() : now.getCount();
                        if (gained <= 0) continue;
                        JsonObject o = Handlers.withDetail(obj("name", Names.item(now), "count", gained, "slot", k), now);
                        taken.add(o);
                    }
                    JsonObject r = status();
                    r.addProperty("ok", emptied);
                    if (!emptied) r.addProperty("reason", open ? "the server kept something in the stand" : "the brewing stand closed");
                    r.add("taken", taken);
                    c.ok(r);
                    return true;
                }
            });
            return BridgeServer.LATER;
        });

        // close the stand's menu: the stand keeps what is in it and brews on (it is no anvil: nothing comes back)
        s.register("brew.close", true, (p, c) -> {
            LocalPlayer pl = player();
            // the stand only: the close of a run the brain gave up can come late, and must not shut the chest the next
            // job has open
            boolean was = pl.containerMenu instanceof BrewingStandMenu;
            JsonObject last = was ? status() : null;
            if (was) pl.closeContainer();
            return obj("ok", true, "wasOpen", was, "stand", last);
        });
    }
}
