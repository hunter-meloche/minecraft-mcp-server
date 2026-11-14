package claudebridge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.BlockHitResult;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * No stray use of a full bucket or a fire starter. Live (Nov 14) a water bucket carried home from the lake poured itself
 * 3 blocks in front of the workshop's door, twice, and in front of the storage house's: a click that was meant for the
 * door (Baritone's door opening: its right click tries the block, and when the block does not take it, uses the item
 * in hand along the look) or the use key the shield holds down (Minecraft.startUseItem tries the main hand first) used
 * the bucket instead. The flowing water then walled both doors off for Baritone. The same path with a lava bucket (the
 * obsidian casting carries them home) or flint and steel would set the yard on fire.
 *
 * So the lowest client layer every path goes through (MultiPlayerGameMode.useItem and useItemOn: Baritone's right
 * click, the use key, Gates, the bridge's own tools; HazardUseMixin) answers PASS without using when the hand holds a
 * hazard, unless the bridge itself armed that use (its useOn and use tools: the casting's pours, the plot's and the
 * workshop's water; later the portal's flint and steel through the same tool). The window is the item's name for a
 * couple of ticks, set right before the bridge's own call and cleared right after it.
 *
 * A click on a block that takes the click itself (a door, a gate, a chest, a bed, a table...) still goes through with
 * a hazard in hand: the block's own use comes first on the server (ServerPlayerGameMode.useItemOn: the block, then
 * for the main hand its use without the item) and nothing reaches the item, so Baritone still opens doors and the
 * stash still opens chests with a bucket in hand. Not while sneaking (a sneaking click with an item skips the block's
 * use and goes to the item), nor from the off hand (only the main hand gets the block's use without the item).
 *
 * Checked against the 26.3 jar: buckets act only through use() (BucketItem and MobBucketItem have no useOn), the
 * powder snow bucket is a BlockItem (it places through useOn), flint and steel and the fire charge only through useOn.
 */
public final class Hazards {
    private Hazards() { }

    /** A full bucket (water, lava, powder snow, a mob in water) or a fire starter: never the empty bucket, nor milk. */
    static boolean isHazard(String item) {
        if (item == null) return false;
        if (item.equals("flint_and_steel") || item.equals("fire_charge")) return true;
        return item.endsWith("_bucket") && !item.equals("milk_bucket");
    }

    /** A bucket the bridge aims and checks as a bucket: the empty one and every full one but milk (which is drunk). */
    static boolean isBucket(String item) {
        return item != null && (item.equals("bucket") || (item.endsWith("_bucket") && !item.equals("milk_bucket")));
    }

    /**
     * A bucket or a fire starter is put in hand only by its own name, never by a name in part (Interact.select's
     * fallback, find: a name containing the one asked for). Asked for the empty "bucket" with none carried, it took the
     * lava_bucket, and useOn arms whatever it then holds: the scoop asked for would have been a pour.
     */
    static boolean byNameOnly(String asked, String found) {
        return found != null && !found.equals(asked) && (isHazard(found) || found.endsWith("bucket"));
    }

    /**
     * Blocks whose own use takes a right click whatever the hand holds (checked against the 26.3 jar: their
     * useWithoutItem answers SUCCESS or CONSUME on every path). Iron doors and trapdoors are not among them (they open
     * only by redstone: their use answers PASS and the click goes on to the item), nor a cauldron (it takes a bucket's
     * contents), TNT, a campfire or a candle (flint and steel lights them), a lectern, a jukebox, a bell or a sign
     * (their use can pass the click on).
     */
    static final Pattern TAKES_CLICK = Pattern.compile(
        "^(crafting_table|crafter|(blast_)?furnace|smoker|.*chest|barrel|.*shulker_box|hopper|dispenser|dropper|brewing_stand|"
            + "enchanting_table|(chipped_|damaged_)?anvil|grindstone|stonecutter|loom|cartography_table|smithing_table|beacon|lever|"
            + ".*_bed|.*_button|.*_fence_gate|.*_door|.*_trapdoor)$");

    static boolean takesClick(String block) {
        return block != null && !block.startsWith("iron_") && TAKES_CLICK.matcher(block).matches();
    }

    /**
     * The rule, pure: why this use is refused, or null when it may go on. {@code block} is the clicked block for a
     * useItemOn, null for a useItem (a use along the look, a bucket's pour or fill).
     */
    static String refusal(String item, String block, boolean onBlock, boolean mainHand, boolean sneaking, String armedItem, long armedUntil, long now) {
        if (!isHazard(item)) return null;
        if (armed(item, armedItem, armedUntil, now)) return null;
        if (!onBlock) return "a use nobody asked for";
        if (!mainHand) return "a click from the off hand (only the main hand gets the block's own use)";
        if (sneaking) return "a sneaking click (it skips the block's own use and goes to the item)";
        if (!takesClick(block)) return "a click on a block that does not take it itself (" + block + ")";
        return null;
    }

    /** The armed window covers only its own item, and only its own ticks. */
    static boolean armed(String item, String armedItem, long armedUntil, long now) {
        return armedItem != null && armedItem.equals(item) && now <= armedUntil;
    }

    // ---------------------------------------------------------------- the window, set by the bridge's own uses

    private static volatile String armedItem;
    private static volatile long armedUntil = -1;
    /** the last tick the bot sneaked (or the shift key was down): the server may still have it for a few ticks */
    private static long lastSneak = -1000;
    private static final int SNEAK_TAIL = 10;

    /** The bridge is about to use {@code item} itself: for this tick and the next {@code ticks}. */
    static void arm(String item, int ticks) {
        armedItem = item;
        armedUntil = Ticker.ticks() + Math.max(0, ticks);
    }

    static void disarm() {
        armedItem = null;
        armedUntil = -1;
    }

    // ---------------------------------------------------------------- the mixin's entry

    private static final Set<String> NOTED = new HashSet<>();

    /** HazardUseMixin: true when this use is to be answered PASS, without using. {@code hit} is null for useItem. */
    public static boolean refuse(Player player, InteractionHand hand, BlockHitResult hit) {
        if (player == null || ClaudeBridge.server == null) return false; // no bridge (no token): a plain client
        ItemStack st = player.getItemInHand(hand);
        if (st.isEmpty()) return false;
        String item = Names.item(st);
        if (!isHazard(item)) return false;
        Minecraft mc = Minecraft.getInstance();
        String block = hit == null || mc.level == null ? null : Names.block(mc.level.getBlockState(hit.getBlockPos()));
        String why = refusal(item, block, hit != null, hand == InteractionHand.MAIN_HAND, sneaking(mc, player), armedItem, armedUntil, Ticker.ticks());
        if (why == null) return false;
        String who = who();
        // once per kind: a held use key or Baritone's click comes back every few ticks
        if (NOTED.add(noteKind(item, who, why))) {
            System.out.println("[claudebridge] guard: refused a stray use of the " + item + " (" + who + "): " + why);
        }
        return true;
    }

    /** A refusal's kind for the log: the item, who, and why, whatever block it was (the reason's last parenthesis). */
    static String noteKind(String item, String who, String why) {
        return item + "|" + who + "|" + why.replaceFirst(" \\([^()]*\\)$", "");
    }

    private static boolean sneaking(Minecraft mc, Player p) {
        return mc.options.keyShift.isDown() || p.isShiftKeyDown() || Ticker.ticks() - lastSneak < SNEAK_TAIL;
    }

    /** Who called: Baritone (its right click), the use key (Minecraft.startUseItem), or a bridge class by name. */
    static String who() {
        String caller = StackWalker.getInstance().walk(frames -> frames.map(StackWalker.StackFrame::getClassName)
            .filter(n -> !n.equals(Hazards.class.getName()) && !n.equals("net.minecraft.client.multiplayer.MultiPlayerGameMode")
                && !n.startsWith("claudebridge.mixin."))
            .findFirst().orElse(""));
        return whoOf(caller);
    }

    static String whoOf(String cls) {
        if (cls.startsWith("baritone.")) return "baritone";
        if (cls.equals("net.minecraft.client.Minecraft")) return "key";
        String simple = cls.substring(cls.lastIndexOf('.') + 1);
        int inner = simple.indexOf('$');
        return "other" + (simple.isEmpty() ? "" : ": " + (inner > 0 ? simple.substring(0, inner) : simple));
    }

    // ---------------------------------------------------------------- the shield: the use key raises it, nothing else

    public enum KeyUse { VANILLA, OFF_HAND_SHIELD, NOTHING }

    /**
     * What the use key may do (ShieldUseMixin, at Minecraft.startUseItem). While Combat holds the shield up (its use key
     * down), the key only raises the off hand's shield: vanilla tries the main hand first, every 4 ticks the key is down
     * and nothing is being used (a shield on cooldown after an axe hit, or a moment between two raises), and the main
     * hand's water bucket poured, its block was placed, its food eaten. Otherwise the key is vanilla's.
     */
    public static KeyUse keyUse(boolean shieldKey, boolean offHandBlocks, boolean using) {
        if (!shieldKey) return KeyUse.VANILLA;
        return offHandBlocks && !using ? KeyUse.OFF_HAND_SHIELD : KeyUse.NOTHING;
    }

    public static void register() {
        Ticker.every(mc -> {
            LocalPlayer p = mc.player;
            if (p != null && (mc.options.keyShift.isDown() || p.isShiftKeyDown())) lastSneak = Ticker.ticks();
            return false;
        });
    }
}
