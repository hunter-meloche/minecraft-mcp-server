package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.network.protocol.game.ServerboundSelectTradePacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.npc.villager.AbstractVillager;
import net.minecraft.world.entity.npc.villager.VillagerData;
import net.minecraft.world.entity.npc.villager.VillagerDataHolder;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ContainerInput;
import net.minecraft.world.inventory.MerchantMenu;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.trading.ItemCost;
import net.minecraft.world.item.trading.MerchantOffer;
import net.minecraft.world.item.trading.MerchantOffers;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;

import java.util.regex.Pattern;

import static claudebridge.Interact.player;
import static claudebridge.Json.*;

/**
 * Villagers (and wandering traders) through the normal trade screen, the way the anvil is driven (Anvil.java): right-click
 * the villager, read its offers as the server sends them, pick an offer the way the screen's button does (the server
 * moves the payment from the pockets into the two payment slots), take the result one trade at a time, close. The menu
 * stays open between calls; trade.close shift-clicks what is left in the payment slots back into the pockets and closes
 * it (container.close only closes it: the server hands back what is left, a tick or more later).
 *
 * What the client sees of a villager without any screen (checked against the 26.3 jar): its VillagerData (profession,
 * level 1-5, biome type) is synced entity data (Villager's and ZombieVillager's DATA_VILLAGER_DATA), so world.entities
 * reports it for every villager in sight (describe, below). Its xp, its offers and whether someone is trading with it
 * are not: those come only with the trade screen (ClientboundMerchantOffersPacket: the offers, the level, the xp).
 * Villagers cannot be leashed (AbstractVillager.canBeLeashed answers false).
 */
public final class Merchant {
    private Merchant() { }

    /**
     * Menu slots (26.3 MerchantMenu: PAYMENT1_SLOT 0, PAYMENT2_SLOT 1, RESULT_SLOT 2, then addStandardInventorySlots):
     * the two payments, the result, then the player's 27 main slots (3-29) and 9 hotbar slots (30-38).
     */
    static final int PAYMENT_A = 0, PAYMENT_B = 1, RESULT = 2, OWN_SLOTS = 3;
    /** How near the villager must be to open its trades (from the eye to its box, as entity.use). */
    static final double REACH = 4.5;
    /** At most this many trades in one trade.do (a villager's offer runs out at 16 uses at most, a trader's at 12). */
    static final int MAX_TIMES = 64;
    /** Ticks to let the server's word come back after picking an offer (it moves the payment too, and may correct ours). */
    static final int SETTLE = 3;

    /** The merchant trade.open last opened (its entity id) and the menu it opened: status names it while that menu stays. */
    private static int openId = -1, openMenu = -1;

    // ---------------------------------------------------------------- what world.entities says of a villager

    /**
     * A villager's or zombie villager's job, level (1 novice .. 5 master) and biome look, and whether it trades at all (a
     * wandering trader has no VillagerData: only `merchant`). An unemployed villager's profession is "none"; a nitwit's
     * "nitwit" (it never takes a job). 5c takes only unemployed adults, never a nitwit, and 5d reads the librarian.
     */
    static void describe(JsonObject o, Entity e) {
        if (e instanceof AbstractVillager) o.addProperty("merchant", true);
        if (e instanceof VillagerDataHolder holder) {
            VillagerData d = holder.getVillagerData();
            o.addProperty("profession", Names.strip(d.profession().getRegisteredName()));
            o.addProperty("level", d.level());
            o.addProperty("type", Names.strip(d.type().getRegisteredName()));
        }
    }

    // ---------------------------------------------------------------- the hand for the right-click (pure)

    /** A weapon in hand: a right-click never hits, but trade.open never goes to a villager holding one (no swing near it). */
    private static final Pattern WEAPON = Pattern.compile("^([a-z]+_(sword|axe)|trident|mace|bow|crossbow)$");

    /**
     * What the hand may hold for the right-click on a villager: nothing, or something the click does nothing with. Not a
     * hazard (a full bucket, a fire starter: Hazards), not a name tag nor a spawn egg (Mob.checkAndHandleImportantInteractions
     * uses them on the villager before its trades: a name tag names it, and a named villager reads as someone's), not a
     * lead or shears (the leash rules of Entity.interact), not a weapon.
     */
    static boolean harmless(String item) {
        if (item == null) return true;
        if (Hazards.isHazard(item)) return false;
        if (item.equals("name_tag") || item.equals("lead") || item.equals("shears") || item.endsWith("_spawn_egg")) return false;
        return !WEAPON.matcher(item).matches();
    }

    /** The order empty hotbar slots are taken in: Baritone keeps its pickaxe in 0 and its blocks in 8 (Interact.freeHotbarSlot). */
    private static final int[] HOTBAR_ORDER = { 1, 2, 3, 4, 5, 6, 7, 0, 8 };

    /**
     * The hotbar slot (0-8) the right-click goes from, or -1: the one in hand when it is empty, else an empty one, else
     * the one in hand when what it holds is harmless, else the first harmless one. `hotbar` holds the 9 slots' item
     * names, null for an empty slot. Pure.
     */
    static int handSlot(String[] hotbar, int selected) {
        boolean sel = selected >= 0 && selected < 9;
        if (sel && hotbar[selected] == null) return selected;
        for (int k : HOTBAR_ORDER) if (hotbar[k] == null) return k;
        if (sel && harmless(hotbar[selected])) return selected;
        for (int k : HOTBAR_ORDER) if (harmless(hotbar[k])) return k;
        return -1;
    }

    /** Why this one cannot be traded with now, or null. Pure. */
    static String notTrading(boolean merchant, boolean alive, boolean baby, boolean sleeping) {
        if (!merchant) return "not a villager nor a wandering trader";
        if (!alive) return "it is dead";
        if (baby) return "a baby villager does not trade (it shakes its head)";
        if (sleeping) return "it is asleep";
        return null;
    }

    // ---------------------------------------------------------------- offers, payment and room (pure)

    /** How many times the pockets can pay an offer: `have` counts of each cost's item, `need` its price (0: no cost B). */
    static int affordable(int haveA, int needA, int haveB, int needB, boolean sameItem) {
        if (needA <= 0) return 0;
        if (needB <= 0) return haveA / needA;
        if (sameItem) return haveA / (needA + needB); // one heap pays both (haveA counts it once)
        return Math.min(haveA / needA, haveB / needB);
    }

    /** What the pockets are short of for one more trade, or null when they can pay it. Pure. */
    static String shortOf(String nameA, int haveA, int needA, String nameB, int haveB, int needB, boolean sameItem) {
        if (sameItem && needB > 0) {
            return haveA >= needA + needB ? null : "short of " + nameA + ": needs " + (needA + needB) + ", has " + haveA;
        }
        if (haveA < needA) return "short of " + nameA + ": needs " + needA + ", has " + haveA;
        if (needB > 0 && haveB < needB) return "short of " + nameB + ": needs " + needB + ", has " + haveB;
        return null;
    }

    /**
     * The pocket (inventory index 0-35) a taken result goes into whole, or -1: a stack of the same that has room for all
     * of it, else an empty main slot (9-35), else an empty hotbar slot in HOTBAR_ORDER. `same[k]` is the count of a stack
     * of the same item and components in pocket k, 0 for an empty pocket, -1 for anything else. Pure.
     */
    static int fitSlot(int[] same, int add, int max) {
        for (int k = 0; k < 36; k++) if (same[k] > 0 && same[k] + add <= max) return k;
        for (int k = 9; k < 36; k++) if (same[k] == 0) return k;
        for (int k : HOTBAR_ORDER) if (same[k] == 0) return k;
        return -1;
    }

    static int[] sameCounts(Inventory inv, ItemStack want) {
        int[] same = new int[36];
        for (int k = 0; k < 36; k++) {
            ItemStack st = inv.getItem(k);
            same[k] = st.isEmpty() ? 0 : ItemStack.isSameItemSameComponents(st, want) ? st.getCount() : -1;
        }
        return same;
    }

    /**
     * How many of a cost's item the bot has to pay with: its pockets and what already lies in the two payment slots (a
     * null menu: the pockets only, as after a close: the client's closed menu still shows the payment the server has put
     * back in the pockets).
     */
    static int have(Inventory inv, MerchantMenu menu, ItemCost cost) {
        int n = 0;
        for (int k = 0; k < 36; k++) if (cost.test(inv.getItem(k))) n += inv.getItem(k).getCount();
        if (menu != null) for (int k : new int[] { PAYMENT_A, PAYMENT_B }) if (cost.test(menu.getSlot(k).getItem())) n += menu.getSlot(k).getItem().getCount();
        return n;
    }

    /** The count of stacks the same as `want` (item and components) in the pockets. */
    static int count(Inventory inv, ItemStack want) {
        int n = 0;
        for (int k = 0; k < 36; k++) if (ItemStack.isSameItemSameComponents(inv.getItem(k), want)) n += inv.getItem(k).getCount();
        return n;
    }

    /** Whether the result slot shows exactly this offer's result (another offer's would be a trade nobody asked for). */
    static boolean shows(MerchantMenu menu, ItemStack want) {
        ItemStack r = menu.getSlot(RESULT).getItem();
        return !r.isEmpty() && r.getCount() == want.getCount() && ItemStack.isSameItemSameComponents(r, want);
    }

    /** A stack with what tells it from others of its name (a book's stored enchantments, damage, a potion), or null. */
    static JsonObject detail(ItemStack st) {
        return st.isEmpty() ? null : Handlers.withDetail(obj("name", Names.item(st), "count", st.getCount()), st);
    }

    /** One offer as the screen shows it: the prices now (demand, reputation and discounts in them), the result, stock. */
    static JsonObject offer(int index, MerchantOffer o, Inventory inv, MerchantMenu menu) {
        ItemStack a = o.getCostA(), b = o.getCostB();
        JsonObject costA = detail(a);
        if (costA != null && o.getItemCostA().count() != a.getCount()) costA.addProperty("baseCount", o.getItemCostA().count());
        int haveA = have(inv, menu, o.getItemCostA());
        int haveB = o.getItemCostB().map(cb -> have(inv, menu, cb)).orElse(0);
        boolean same = !b.isEmpty() && ItemStack.isSameItemSameComponents(a, b);
        JsonObject j = obj("index", index, "costA", costA, "costB", detail(b), "result", detail(o.getResult()),
            "uses", o.getUses(), "maxUses", o.getMaxUses(), "outOfStock", o.isOutOfStock(), "xp", o.getXp());
        j.addProperty("afford", affordable(haveA, a.getCount(), haveB, b.isEmpty() ? 0 : b.getCount(), same));
        return j;
    }

    static MerchantMenu menu() {
        if (!(player().containerMenu instanceof MerchantMenu menu)) throw new IllegalStateException("no trade screen open (trade.open first)");
        return menu;
    }

    /** The trade screen: who, its level and xp (xp 0 at level 1: nobody has traded with it yet), the offers, the slots. */
    static JsonObject status() {
        LocalPlayer pl = player();
        if (!(pl.containerMenu instanceof MerchantMenu menu)) return obj("open", false);
        var inv = pl.getInventory();
        JsonArray offers = new JsonArray();
        MerchantOffers list = menu.getOffers();
        for (int i = 0; i < list.size(); i++) offers.add(offer(i, list.get(i), inv, menu));
        int free = 0;
        for (int k = 0; k < 36; k++) if (inv.getItem(k).isEmpty()) free++;
        JsonObject r = obj("open", true, "level", menu.getTraderLevel(), "xp", menu.getTraderXp(), "showProgress", menu.showProgressBar(),
            "canRestock", menu.canRestock(), "offers", offers, "paymentA", detail(menu.getSlot(PAYMENT_A).getItem()),
            "paymentB", detail(menu.getSlot(PAYMENT_B).getItem()), "result", detail(menu.getSlot(RESULT).getItem()), "free", free);
        // who: the one trade.open opened, while its menu is the one open (the level above is the menu's, from the offers
        // packet: the same as its VillagerData's once the offers came)
        Entity e = menu.containerId == openMenu && Minecraft.getInstance().level != null ? Minecraft.getInstance().level.getEntity(openId) : null;
        if (e != null) {
            r.addProperty("id", e.getId());
            r.addProperty("entity", Names.entity(e));
            if (e instanceof VillagerDataHolder holder) {
                r.addProperty("profession", Names.strip(holder.getVillagerData().profession().getRegisteredName()));
                r.addProperty("type", Names.strip(holder.getVillagerData().type().getRegisteredName()));
            }
        }
        return r;
    }

    // ---------------------------------------------------------------- one trade.do, step by step

    /** The clicks a run makes: the live client's (packets to the server), or a check's straight on a menu. */
    interface Hands {
        void click(MerchantMenu menu, int slot, int button, ContainerInput input);
        /** Pick an offer as the screen's button does. */
        void select(MerchantMenu menu, int index);
    }

    static final Hands LIVE = new Hands() {
        @Override public void click(MerchantMenu menu, int slot, int button, ContainerInput input) {
            Interact.click(menu, slot, button, input);
        }
        // as MerchantScreen.postButtonClick: the hint and the move on the client's menu (its own guess of what the server
        // does), and the packet; the server (handleSelectTrade) sets the same hint and moves the same payment
        @Override public void select(MerchantMenu menu, int index) {
            menu.setSelectionHint(index);
            menu.tryMoveItems(index);
            Minecraft.getInstance().getConnection().send(new ServerboundSelectTradePacket(index));
        }
    };

    /**
     * One trade.do on the menu as the client has it: pick the offer (the payment comes from the pockets, a stack of each
     * cost at most), take one result onto the cursor and put it in a pocket where it fits whole, again while the result
     * slot shows this offer's result and the run has trades left; pick the offer again when the payment slots run dry.
     * A take is one trade: a shift-click on the result trades again and again while the result keeps the same item
     * (AbstractContainerMenu's QUICK_MOVE loop), and with offer 0 picked the game falls back to ANY offer the payment
     * satisfies (MerchantOffers.getRecipeFor looks only at the hint when it is above 0), so each take first checks the
     * result slot holds exactly the asked offer's result: never a trade whose result the bot did not ask for.
     */
    static final class Run {
        final MerchantMenu menu;
        final Inventory inv;
        final int index, times;
        final ItemStack want;
        final Hands hands;
        int done, wait;
        boolean picked;
        String stopped;

        Run(MerchantMenu menu, Inventory inv, int index, ItemStack want, int times, Hands hands) {
            this.menu = menu;
            this.inv = inv;
            this.index = index;
            this.want = want;
            this.times = times;
            this.hands = hands;
        }

        boolean stop(String why) {
            stopped = why;
            return true;
        }

        /** One step (a tick); true when the run is over, `stopped` says why ("done" when every trade asked for went). */
        boolean step() {
            if (wait > 0) { wait--; return false; }
            if (done >= times) return stop("done");
            MerchantOffers offers = menu.getOffers();
            if (index >= offers.size() || !ItemStack.isSameItemSameComponents(offers.get(index).getResult(), want)
                || offers.get(index).getResult().getCount() != want.getCount()) return stop("the offers changed (offer " + index + " is not the one asked for)");
            MerchantOffer o = offers.get(index);
            if (!shows(menu, want)) {
                if (o.isOutOfStock()) return stop("out of stock (" + o.getUses() + "/" + o.getMaxUses() + " uses)");
                if (picked) {
                    // picked and settled, and still no result: the pockets ran out, or the inputs did not move (no room
                    // for what the payment slots held)
                    ItemStack a = o.getCostA(), b = o.getCostB();
                    String why = shortOf(Names.item(a), have(inv, menu, o.getItemCostA()), a.getCount(),
                        b.isEmpty() ? null : Names.item(b), o.getItemCostB().map(cb -> have(inv, menu, cb)).orElse(0), b.isEmpty() ? 0 : b.getCount(),
                        !b.isEmpty() && ItemStack.isSameItemSameComponents(a, b));
                    return stop(why != null ? why : "the result did not show (the payment did not move)");
                }
                hands.select(menu, index);
                picked = true;
                wait = SETTLE;
                return false;
            }
            picked = false;
            if (!menu.getCarried().isEmpty()) return stop("something is on the cursor");
            int fit = fitSlot(sameCounts(inv, want), want.getCount(), want.getMaxStackSize());
            if (fit < 0) return stop("no room in the pockets for the " + Names.item(want));
            hands.click(menu, RESULT, 0, ContainerInput.PICKUP); // one trade: the result onto the cursor
            ItemStack carried = menu.getCarried().copy();
            if (carried.isEmpty()) return stop("the result would not come off");
            hands.click(menu, Interact.containerMenuSlot(OWN_SLOTS, fit), 0, ContainerInput.PICKUP);
            if (!menu.getCarried().isEmpty()) {
                int again = fitSlot(sameCounts(inv, menu.getCarried()), menu.getCarried().getCount(), menu.getCarried().getMaxStackSize());
                if (again >= 0) hands.click(menu, Interact.containerMenuSlot(OWN_SLOTS, again), 0, ContainerInput.PICKUP);
                if (!menu.getCarried().isEmpty()) return stop("the " + Names.item(carried) + " stayed on the cursor (no pocket took it)");
            }
            // never: the slot showed the asked result in this same step, and a take gives what the slot shows
            if (!ItemStack.isSameItemSameComponents(carried, want)) return stop("took a " + Names.item(carried) + " nobody asked for");
            done++;
            wait = 1; // a tick for the server's word before the next
            return false;
        }
    }

    // ---------------------------------------------------------------- closing

    /** Shift-click the payment slots back into the pockets, then close (the server hands back what found no room). */
    static boolean close(LocalPlayer pl) {
        if (!(pl.containerMenu instanceof MerchantMenu menu)) return false;
        // what an unfinished or untaken trade left in the payment slots: back in the pockets here and on the server alike,
        // so the next job sees them at once (the client's MerchantMenu has a ClientSideMerchant: its close hands nothing
        // back; only the server's does, a tick or more later)
        for (int k : new int[] { PAYMENT_A, PAYMENT_B }) if (!menu.getSlot(k).getItem().isEmpty()) Interact.click(menu, k, 0, ContainerInput.QUICK_MOVE);
        pl.closeContainer();
        openId = -1;
        openMenu = -1;
        return true;
    }

    public static void register(BridgeServer s) {
        s.register("trade.status", true, (p, c) -> status());

        // a villager or wandering trader within 4.5 blocks: right-click it with an empty or harmless hand (never a hazard,
        // a name tag, a lead or a weapon: see harmless), never a hit, and wait for its trade screen and offers. A villager
        // with no trades (unemployed, a nitwit), a baby, one asleep or one trading with someone else opens nothing
        s.register("trade.open", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            int id = Integer.parseInt(required(p, "id"));
            Entity e = mc.level.getEntity(id);
            if (e == null || e.isRemoved()) throw new IllegalArgumentException("no entity with id " + id + " nearby");
            String why = notTrading(e instanceof AbstractVillager, e.isAlive(), e instanceof AbstractVillager v && v.isBaby(),
                e instanceof AbstractVillager v2 && v2.isSleeping());
            if (why != null) throw new IllegalStateException(Names.entity(e) + ": " + why);
            if (Combat.fighting) throw new IllegalStateException("a fight is on: not opening trades now");
            double dist = Math.sqrt(e.getBoundingBox().distanceToSqr(pl.getEyePosition()));
            if (dist > REACH) throw new IllegalStateException("too far: " + round(dist) + " blocks to the " + Names.entity(e) + " (max " + REACH + ")");
            var inv = pl.getInventory();
            String[] hotbar = new String[9];
            for (int k = 0; k < 9; k++) hotbar[k] = Interact.nameOf(inv.getItem(k));
            int hand = handSlot(hotbar, inv.getSelectedSlot());
            if (hand < 0) throw new IllegalStateException("no empty or harmless hotbar slot to click with (" + String.join(", ", java.util.Arrays.stream(hotbar).map(String::valueOf).toList()) + ")");
            if (pl.containerMenu != pl.inventoryMenu && !close(pl)) pl.closeContainer();
            inv.setSelectedSlot(hand);
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, e.getBoundingBox().getCenter());
            int unhappyBefore = ((AbstractVillager) e).getUnhappyCounter();
            Ticker.add(new Ticker.Task() {
                int wait = 3, age = 0;
                boolean clicked;
                @Override public boolean tick(Minecraft m) {
                    try {
                        if (m.player == null) { c.fail("not in a world"); return true; }
                        if (!clicked) {
                            if (--wait > 0) return false; // after the rotation and the selected slot have gone out
                            if (e.isRemoved()) { c.fail("the " + Names.entity(e) + " is gone"); return true; }
                            // the hand again at the click: the Guardian may have taken a weapon up meanwhile
                            String held = Interact.nameOf(m.player.getMainHandItem());
                            if (!harmless(held)) { c.fail("the hand holds " + held + " at the click: not clicking the villager with it"); return true; }
                            Vec3 from = m.player.getEyePosition();
                            var bb = e.getBoundingBox();
                            Vec3 hitAt = bb.contains(from) ? from : bb.clip(from, bb.getCenter()).orElse(bb.getCenter());
                            // a use, never an attack, and from the main hand only (Villager.mobInteract opens trades for it
                            // alone); no arm swing either
                            m.gameMode.interact(m.player, e, new EntityHitResult(e, hitAt), InteractionHand.MAIN_HAND);
                            clicked = true;
                            return false;
                        }
                        age++;
                        // the screen first (ClientboundOpenScreenPacket), the offers right after it (ClientboundMerchantOffersPacket)
                        if (m.player.containerMenu instanceof MerchantMenu menu && (!menu.getOffers().isEmpty() || age > 20)) {
                            openId = e.getId();
                            openMenu = menu.containerId;
                            c.ok(status()); // names it: id, entity, profession, type
                            return true;
                        }
                        if (age > 40) {
                            boolean shook = e instanceof AbstractVillager v && v.getUnhappyCounter() > unhappyBefore;
                            c.fail(shook ? "the " + Names.entity(e) + " shook its head (no trades: unemployed, a nitwit, or none yet)"
                                : "the " + Names.entity(e) + " opened no trades (busy with someone, asleep, or out of reach)");
                            return true;
                        }
                        return false;
                    } catch (RuntimeException ex) {
                        c.fail("trade.open: " + ex);
                        return true;
                    }
                }
            });
            return BridgeServer.LATER;
        });

        // trade offer `index` (as trade.status lists them) up to `times` times (default: while the payment lasts and the
        // offer is in stock, at most 64). `result` (an item name) and `enchantment` (a book's, e.g. mending), when given,
        // must be what the offer gives, else nothing is traded: the brain names what it asks for. Each trade takes one
        // result and puts it in the pockets (see Run). The reply comes once the server's word is in (half a second after
        // the last take): what the pockets gained, what the payment cost, why it stopped
        s.register("trade.do", true, (p, c) -> {
            LocalPlayer pl = player();
            MerchantMenu menu = menu();
            int index = intParam(p, "index", -1);
            MerchantOffers offers = menu.getOffers();
            if (index < 0 || index >= offers.size()) throw new IllegalArgumentException("no offer " + index + " (the screen lists " + offers.size() + ")");
            MerchantOffer o = offers.get(index);
            ItemStack want = o.getResult().copy();
            String asked = strParam(p, "result", null);
            if (asked != null && !Names.item(want).equals(asked.replace("minecraft:", ""))) {
                throw new IllegalStateException("offer " + index + " gives " + Names.item(want) + ", not " + asked + ": nothing traded");
            }
            String ench = strParam(p, "enchantment", null);
            if (ench != null) {
                String en = ench.replace("minecraft:", "");
                boolean has = false;
                for (var x : Enchanting.enchantments(want)) has |= en.equals(x.getAsJsonObject().get("name").getAsString());
                if (!has) throw new IllegalStateException("offer " + index + "'s " + Names.item(want) + " has no " + en + ": nothing traded");
            }
            if (o.isOutOfStock()) throw new IllegalStateException("offer " + index + " is out of stock (" + o.getUses() + "/" + o.getMaxUses() + " uses)");
            if (!menu.getCarried().isEmpty()) throw new IllegalStateException("something is on the cursor; close the trade first");
            int times = Math.max(1, Math.min(MAX_TIMES, intParam(p, "times", MAX_TIMES)));
            var inv = pl.getInventory();
            ItemStack costA = o.getCostA().copy(), costB = o.getCostB().copy();
            ItemCost itemA = o.getItemCostA();
            ItemCost itemB = o.getItemCostB().orElse(null);
            int gotBefore = count(inv, want), aBefore = have(inv, menu, itemA), bBefore = itemB == null ? 0 : have(inv, menu, itemB);
            int levelBefore = menu.getTraderLevel(), xpBefore = menu.getTraderXp();
            Run run = new Run(menu, inv, index, want, times, LIVE);
            Ticker.add(new Ticker.Task() {
                int age = 0, after = -1;
                @Override public boolean tick(Minecraft m) {
                    try {
                        LocalPlayer pp = m.player;
                        if (pp == null) { c.fail("not in a world"); return true; }
                        boolean open = pp.containerMenu == menu;
                        if (after < 0) {
                            boolean over = !open ? run.stop("the trade screen closed (the villager moved off, slept or was hurt)")
                                : ++age > 20 * 30 ? run.stop("timed out") : run.step();
                            if (!over) return false;
                            after = 0;
                        }
                        // the server's word on the last take (a refused one comes back as the pockets without it)
                        if (++after < 10) return false;
                        var in = pp.getInventory();
                        boolean still = pp.containerMenu == menu;
                        MerchantMenu live = still ? menu : null;
                        int gained = count(in, want) - gotBefore;
                        int spentA = aBefore - have(in, live, itemA), spentB = itemB == null ? 0 : bBefore - have(in, live, itemB);
                        int traded = Math.max(0, gained) / Math.max(1, want.getCount());
                        JsonObject spent = new JsonObject();
                        if (spentA != 0) spent.addProperty(Names.item(costA), spentA);
                        // both costs of one item: each count above is the whole heap's, already in spentA
                        if (itemB != null && spentB != 0 && !ItemStack.isSameItemSameComponents(costA, costB)) spent.addProperty(Names.item(costB), spentB);
                        JsonObject r = Handlers.withDetail(obj("ok", traded > 0, "traded", traded, "asked", times, "index", index, "item", Names.item(want),
                            "count", Math.max(0, gained)), want);
                        r.add("spent", spent);
                        r.addProperty("stopped", run.stopped);
                        if (run.done != traded) r.addProperty("clicked", run.done); // a take the server did not let through
                        r.addProperty("open", still);
                        if (still && index < menu.getOffers().size()) r.add("offer", offer(index, menu.getOffers().get(index), in, menu));
                        r.addProperty("levelBefore", levelBefore);
                        r.addProperty("level", still ? menu.getTraderLevel() : levelBefore);
                        r.addProperty("xpBefore", xpBefore);
                        r.addProperty("xp", still ? menu.getTraderXp() : xpBefore);
                        c.ok(r);
                        return true;
                    } catch (RuntimeException ex) {
                        c.fail("trade.do: " + ex);
                        return true;
                    }
                }
            });
            return BridgeServer.LATER;
        });

        s.register("trade.close", true, (p, c) -> {
            // the trade screen only: the close of a run the brain gave up can come late, and must not shut the chest the
            // next job has open
            boolean was = close(player());
            return obj("ok", true, "wasOpen", was);
        });
    }
}
