package claudebridge;

import baritone.api.IBaritone;
import baritone.api.pathing.goals.GoalBlock;
import baritone.api.pathing.goals.GoalNear;
import baritone.api.utils.BlockOptionalMetaLookup;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.network.chat.Component;
import net.minecraft.world.phys.Vec3;

import java.io.File;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import static claudebridge.Json.*;

/** The bridge methods. Each one runs on the game thread unless registered otherwise. */
public final class Handlers {
    private Handlers() { }

    static LocalPlayer player() {
        LocalPlayer p = Minecraft.getInstance().player;
        if (p == null) throw new IllegalStateException("not in a world");
        return p;
    }

    public static void register(BridgeServer s) {
        s.register("ping", false, (p, c) -> obj("pong", true));

        s.register("status", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = mc.player;
            JsonObject r = new JsonObject();
            r.addProperty("username", mc.getUser().getName());
            r.addProperty("inWorld", pl != null && mc.level != null);
            var screen = mc.gui.screen();
            r.addProperty("screen", screen == null ? null : screen.getClass().getSimpleName());
            if (pl == null || mc.level == null) return r;
            r.add("position", pos(pl.position()));
            r.add("block", pos(pl.blockPosition()));
            r.addProperty("yaw", round(pl.getYRot()));
            r.addProperty("pitch", round(pl.getXRot()));
            r.addProperty("health", round(pl.getHealth()));
            r.addProperty("food", pl.getFoodData().getFoodLevel());
            r.addProperty("saturation", round(pl.getFoodData().getSaturationLevel()));
            r.addProperty("air", Math.max(0, pl.getAirSupply()) / 15); // 0..20 like mineflayer's oxygenLevel
            r.addProperty("underWater", pl.isUnderWater());
            r.addProperty("inLava", pl.isInLava());
            r.addProperty("dimension", Names.strip(mc.level.dimension().identifier().toString()));
            r.addProperty("gameMode", mc.gameMode == null ? null : mc.gameMode.getPlayerMode().name().toLowerCase());
            r.addProperty("difficulty", mc.level.getLevelData().getDifficulty().getSerializedName());
            r.addProperty("timeOfDay", Math.floorMod(mc.level.getOverworldClockTime(), 24000L));
            r.addProperty("sleeping", pl.isSleeping());
            r.addProperty("onGround", pl.onGround());
            r.addProperty("destroying", mc.gameMode != null && mc.gameMode.isDestroying());
            r.addProperty("raining", mc.level.isRaining());
            r.addProperty("thundering", mc.level.isThundering());
            r.addProperty("xpLevel", pl.experienceLevel);
            JsonArray boxed = Guardian.boxedIn(mc);
            if (boxed != null) r.add("boxedIn", boxed);
            r.addProperty("hashedSeed", hashedSeed(mc));
            r.addProperty("protectedCount", Protection.count());
            r.addProperty("windowMinimized", mc.getWindow().isIconified());
            r.addProperty("mouseGrabbed", mc.mouseHandler.isMouseGrabbed());
            IBaritone b = Processes.baritone();
            r.addProperty("process", Processes.active());
            Object goal = b.getPathingBehavior().getGoal();
            r.addProperty("goal", goal == null ? null : goal.toString());
            return r;
        });

        s.register("inventory", true, (p, c) -> {
            LocalPlayer pl = player();
            var inv = pl.getInventory();
            JsonArray items = new JsonArray();
            // 26.x: indices 36-42 are the worn equipment (feet, legs, chest, head, off-hand, body, saddle), so they are listed too
            for (int i = 0; i < inv.getContainerSize(); i++) {
                var st = inv.getItem(i);
                if (st.isEmpty()) continue;
                items.add(withDamage(obj("slot", i, "name", Names.item(st), "count", st.getCount()), st));
            }
            // the same worn items by name, so Node needn't know the index mapping
            JsonArray armor = new JsonArray();
            String[] worn = {"feet", "legs", "chest", "head", "offhand"};
            for (int k = 0; k < worn.length; k++) {
                var st = inv.getItem(Inventory.INVENTORY_SIZE + k);
                if (st.isEmpty()) continue;
                armor.add(withDamage(obj("slot", worn[k], "name", Names.item(st), "count", st.getCount()), st));
            }
            var held = pl.getMainHandItem();
            return obj("items", items, "armor", armor, "selectedSlot", inv.getSelectedSlot(),
                "held", held.isEmpty() ? null : obj("name", Names.item(held), "count", held.getCount()));
        });

        s.register("screen", true, (p, c) -> {
            var screen = Minecraft.getInstance().gui.screen();
            if (screen == null) return obj("screen", null);
            StringBuilder texts = new StringBuilder();
            for (Class<?> k = screen.getClass(); k != null && k != Object.class; k = k.getSuperclass()) {
                for (var f : k.getDeclaredFields()) {
                    try {
                        f.setAccessible(true);
                        Object v = f.get(screen);
                        if (v instanceof Component comp) texts.append(f.getName()).append('=').append(comp.getString()).append(" | ");
                        else if (v instanceof Record rec) {
                            for (var rc : rec.getClass().getRecordComponents()) {
                                Object rv = rc.getAccessor().invoke(rec);
                                if (rv instanceof Component comp) texts.append(f.getName()).append('.').append(rc.getName()).append('=').append(comp.getString()).append(" | ");
                            }
                        }
                    } catch (Exception ignored) { }
                }
            }
            return obj("screen", screen.getClass().getName(), "title", screen.getTitle().getString(), "texts", texts.toString());
        });

        s.register("chat.send", true, (p, c) -> {
            String text = required(p, "text");
            if (text.startsWith("/")) player().connection.sendCommand(text.substring(1));
            else player().connection.sendChat(text);
            return obj("ok", true);
        });

        s.register("baritone.command", true, (p, c) -> obj("ok", Processes.baritone().getCommandManager().execute(required(p, "command"))));

        s.register("world.block", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level == null) throw new IllegalStateException("not in a world");
            BlockPos at = blockPos(p);
            if (!mc.level.isLoaded(at)) return obj("loaded", false);
            BlockState st = mc.level.getBlockState(at);
            JsonObject props = new JsonObject();
            for (Property<?> prop : st.getProperties()) props.addProperty(prop.getName(), valueName(st, prop));
            return obj("loaded", true, "name", Names.block(st), "properties", props);
        });

        // every block in a box, as "name[prop=value,...]" in x-fastest, then z, then y order (the schematic's order); null if unloaded
        s.register("world.region", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level == null) throw new IllegalStateException("not in a world");
            BlockPos o = blockPos(p);
            int w = intParam(p, "width", 1), h = intParam(p, "height", 1), l = intParam(p, "length", 1);
            if ((long) w * h * l > 65_536) throw new IllegalArgumentException("region too large (max 65536 blocks)");
            JsonArray out = new JsonArray();
            for (int y = 0; y < h; y++) for (int z = 0; z < l; z++) for (int x = 0; x < w; x++) {
                BlockPos at = o.offset(x, y, z);
                if (!mc.level.isLoaded(at)) { out.add((String) null); continue; }
                BlockState st = mc.level.getBlockState(at);
                StringBuilder sb = new StringBuilder(Names.block(st));
                if (!st.getProperties().isEmpty()) {
                    sb.append('[');
                    boolean first = true;
                    for (Property<?> prop : st.getProperties()) {
                        if (!first) sb.append(',');
                        sb.append(prop.getName()).append('=').append(valueName(st, prop));
                        first = false;
                    }
                    sb.append(']');
                }
                out.add(sb.toString());
            }
            return obj("blocks", out);
        });

        // block and sky light (0-15) over a box, in world.region's order (x fastest, then z, then y); -1 where unloaded
        s.register("world.light", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            if (mc.level == null) throw new IllegalStateException("not in a world");
            BlockPos o = blockPos(p);
            int w = intParam(p, "width", 1), h = intParam(p, "height", 1), l = intParam(p, "length", 1);
            if ((long) w * h * l > 65_536) throw new IllegalArgumentException("region too large (max 65536 blocks)");
            JsonArray block = new JsonArray(), sky = new JsonArray();
            for (int y = 0; y < h; y++) for (int z = 0; z < l; z++) for (int x = 0; x < w; x++) {
                BlockPos at = o.offset(x, y, z);
                boolean loaded = mc.level.isLoaded(at);
                block.add(loaded ? mc.level.getBrightness(LightLayer.BLOCK, at) : -1);
                sky.add(loaded ? mc.level.getBrightness(LightLayer.SKY, at) : -1);
            }
            return obj("block", block, "sky", sky);
        });

        s.register("world.findBlocks", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            String name = required(p, "block").replace("minecraft:", "");
            int maxDistance = Math.min(intParam(p, "maxDistance", 32), 128);
            int count = Math.min(intParam(p, "count", 1), 256);
            // openAbove: only blocks with air right above (surface water, not an aquifer's: underground water filled
            // the nearest 256 and hid the lake), with a bigger scan budget since most hits are thrown away
            boolean openAbove = p.has("openAbove") && p.get("openAbove").getAsBoolean();
            // away: only blocks at least awayMin (horizontally) from (awayX, awayZ): outside the home zone, where the
            // nearest 512 stone were all inside it once the yard grew
            int awayMin = intParam(p, "awayMin", 0);
            int awayX = intParam(p, "awayX", 0), awayZ = intParam(p, "awayZ", 0);
            // or at least awayMin outside a rectangle (the yard): awayX1, awayZ1, awayX2, awayZ2
            boolean awayRect = p.has("awayX1");
            int ax1 = intParam(p, "awayX1", 0), az1 = intParam(p, "awayZ1", 0), ax2 = intParam(p, "awayX2", 0), az2 = intParam(p, "awayZ2", 0);
            List<BlockPos> found = baritone.api.BaritoneAPI.getProvider().getWorldScanner().scanChunkRadius(
                Processes.baritone().getPlayerContext(), new BlockOptionalMetaLookup(name), openAbove || awayMin > 0 ? 65536 : 4096, -1, (maxDistance >> 4) + 1);
            Vec3 eye = pl.position();
            JsonArray out = new JsonArray();
            found.stream()
                .filter(bp -> Vec3.atCenterOf(bp).distanceTo(eye) <= maxDistance)
                .filter(bp -> awayMin <= 0 || (awayRect
                    ? Math.max(Math.max(ax1 - bp.getX(), bp.getX() - ax2), Math.max(az1 - bp.getZ(), bp.getZ() - az2)) >= awayMin
                    : Math.hypot(bp.getX() - awayX, bp.getZ() - awayZ) >= awayMin))
                .filter(bp -> !openAbove || mc.level.getBlockState(bp.above()).isAir())
                .sorted(Comparator.comparingDouble(bp -> Vec3.atCenterOf(bp).distanceTo(eye)))
                .limit(count)
                .forEach(bp -> out.add(pos(bp)));
            return obj("block", name, "positions", out);
        });

        s.register("world.entities", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = player();
            double maxDistance = numParam(p, "maxDistance", 32);
            String type = strParam(p, "type", null);
            JsonArray out = new JsonArray();
            java.util.ArrayList<Entity> list = new java.util.ArrayList<>();
            for (Entity e : mc.level.entitiesForRendering()) {
                if (e == pl || e.distanceTo(pl) > maxDistance) continue;
                if (type != null && !Names.entity(e).equals(type)) continue;
                list.add(e);
            }
            list.sort(Comparator.comparingDouble(e -> e.distanceTo(pl)));
            for (Entity e : list) {
                JsonObject o = obj("id", e.getId(), "name", Names.entity(e), "category", e.getType().getCategory().getName(),
                    "position", pos(e.position()), "distance", round(e.distanceTo(pl)), "height", round(e.getBbHeight()));
                if (e instanceof LivingEntity le) {
                    o.addProperty("health", round(le.getHealth()));
                    o.addProperty("baby", le.isBaby()); // synced (AgeableMob's DATA_BABY_ID, zombies' own flag)
                }
                // sheared and colour are synced entity data. Whether an animal is in love is not: the client only gets a
                // one-off heart burst (entity event 18) and its own inLove counter stays 0, so it is left out.
                if (e instanceof net.minecraft.world.entity.animal.sheep.Sheep sheep) {
                    o.addProperty("sheared", sheep.isSheared());
                    o.addProperty("color", sheep.getColor().getSerializedName());
                }
                if (e instanceof net.minecraft.world.entity.item.ItemEntity ie && !ie.getItem().isEmpty()) {
                    o.addProperty("item", Names.item(ie.getItem()));
                    o.addProperty("count", ie.getItem().getCount());
                }
                out.add(o);
            }
            return obj("entities", out);
        });

        s.register("goto", true, (p, c) -> {
            LocalPlayer pl = player();
            BlockPos target = blockPos(p);
            int range = intParam(p, "range", 1);
            int timeoutTicks = intParam(p, "timeoutMs", 180_000) / 50;
            long seq = Events.baritoneLogSeq();
            // away: at least `away` blocks from the point (step out of a cell to place a block there)
            int awayFrom = intParam(p, "away", 0);
            // xz: any height at that x/z (long trips over land the bot hasn't seen, where the ground height is unknown)
            boolean xz = p.has("xz") && p.get("xz").getAsBoolean();
            Processes.baritone().getCustomGoalProcess().setGoalAndPath(xz ? new baritone.api.pathing.goals.GoalXZ(target.getX(), target.getZ())
                : awayFrom > 0 ? new baritone.api.pathing.goals.GoalRunAway(awayFrom, target)
                : range <= 0 ? new GoalBlock(target) : new GoalNear(target, range));
            Processes.watch(c, seq, timeoutTicks, reason -> {
                LocalPlayer now = Minecraft.getInstance().player;
                BlockPos at = now == null ? pl.blockPosition() : now.blockPosition();
                double away = xz ? Math.hypot(at.getX() - target.getX(), at.getZ() - target.getZ()) : Math.sqrt(at.distSqr(target));
                if (xz) return obj("arrived", away <= Math.max(range, 2) + 0.01, "at", pos(at), "distance", round(away));
                return obj("arrived", awayFrom > 0 ? away >= awayFrom - 0.01 : away <= Math.max(range, 0) + 0.01 || (range <= 0 && at.equals(target)),
                    "at", pos(at), "distance", round(away));
            });
            return BridgeServer.LATER;
        });

        s.register("mine", true, (p, c) -> {
            String block = required(p, "block").replace("minecraft:", "");
            int count = intParam(p, "count", 1);
            int timeoutTicks = intParam(p, "timeoutMs", 300_000) / 50;
            Map<String, Integer> before = Processes.inventoryCounts(Minecraft.getInstance());
            long seq = Events.baritoneLogSeq();
            // several names at once ("iron_ore,deepslate_iron_ore"); counted together, as Baritone does
            String[] names = java.util.Arrays.stream(block.split(",")).map(String::trim).filter(n -> !n.isEmpty()).toArray(String[]::new);
            for (String n : names) {
                String why = Interact.cannotHarvest(new baritone.api.utils.BlockOptionalMeta(n).getBlock().defaultBlockState());
                if (why != null) throw new IllegalStateException(why);
            }
            // what we came to mine can't be on the avoid list (berry bushes are: "Unable to find any path")
            var avoid = baritone.api.BaritoneAPI.getSettings().blocksToAvoid;
            List<net.minecraft.world.level.block.Block> avoidBefore = new java.util.ArrayList<>(avoid.value);
            List<net.minecraft.world.level.block.Block> avoidNow = new java.util.ArrayList<>(avoid.value);
            for (String n : names) avoidNow.remove(new baritone.api.utils.BlockOptionalMeta(n).getBlock());
            avoid.value = avoidNow;
            Processes.baritone().getMineProcess().mineByName(count, names);
            // Baritone counts a block's drops from its loot table and misses some (a berry bush's berries: it harvested
            // 78 when asked for 12). Also stop once the inventory holds `count` of the block's own item (the same "have
            // count" rule Baritone uses).
            List<String> own = java.util.Arrays.stream(names)
                .map(n -> Names.item(new net.minecraft.world.item.ItemStack(new baritone.api.utils.BlockOptionalMeta(n).getBlock().asItem()))).toList();
            Processes.watch(c, seq, timeoutTicks,
                () -> { var inv = Processes.inventoryCounts(Minecraft.getInstance()); return own.stream().mapToInt(n -> inv.getOrDefault(n, 0)).sum() >= count; },
                reason -> {
                    avoid.value = avoidBefore;
                    return obj("gained", Processes.gained(before, Processes.inventoryCounts(Minecraft.getInstance())),
                        "at", pos(Minecraft.getInstance().player.blockPosition()));
                });
            return BridgeServer.LATER;
        });

        // harvest ripe crops and berry bushes around the bot without destroying them, and replant (Baritone's farm process)
        s.register("farm", true, (p, c) -> {
            int range = intParam(p, "range", 32);
            int timeoutTicks = intParam(p, "timeoutMs", 120_000) / 50;
            Map<String, Integer> before = Processes.inventoryCounts(Minecraft.getInstance());
            long seq = Events.baritoneLogSeq();
            var avoid = baritone.api.BaritoneAPI.getSettings().blocksToAvoid;
            List<net.minecraft.world.level.block.Block> avoidBefore = new java.util.ArrayList<>(avoid.value);
            avoid.value = new java.util.ArrayList<>(avoidBefore);
            avoid.value.remove(net.minecraft.world.level.block.Blocks.SWEET_BERRY_BUSH); // farming walks up to them
            Processes.baritone().getFarmProcess().farm(range, player().blockPosition());
            Processes.watch(c, seq, timeoutTicks, reason -> {
                avoid.value = avoidBefore;
                return obj("gained", Processes.gained(before, Processes.inventoryCounts(Minecraft.getInstance())),
                    "at", pos(Minecraft.getInstance().player.blockPosition()));
            });
            return BridgeServer.LATER;
        });

        s.register("build", true, (p, c) -> {
            File file = new File(required(p, "file"));
            if (!file.isFile()) throw new IllegalArgumentException("no schematic file at " + file);
            BlockPos origin = blockPos(p);
            int timeoutTicks = intParam(p, "timeoutMs", 600_000) / 50;
            Map<String, Integer> before = Processes.inventoryCounts(Minecraft.getInstance());
            long seq = Events.baritoneLogSeq();
            boolean loaded = Processes.baritone().getBuilderProcess().build(file.getName(), file, origin);
            if (!loaded) throw new IllegalStateException("Baritone could not load the schematic " + file.getName());
            Protection.suspend(null); // the builder replaces wrong blocks inside its own box (furniture excepted)
            Processes.watch(c, seq, timeoutTicks, reason -> {
                Protection.resume(null);
                Map<String, Integer> after = Processes.inventoryCounts(Minecraft.getInstance());
                Map<String, Integer> used = Processes.gained(after, before); // what went down
                return obj("used", used, "at", pos(Minecraft.getInstance().player.blockPosition()));
            });
            return BridgeServer.LATER;
        });

        s.register("cancel", true, (p, c) -> {
            Processes.cancels++;
            return obj("cancelled", Processes.baritone().getPathingBehavior().cancelEverything());
        });
    }

    /** The world's hashed seed (what the login packet carries; the mineflayer backend keys its build protection by it). */
    private static String hashedSeed(Minecraft mc) {
        try {
            java.lang.reflect.Field f = net.minecraft.world.level.biome.BiomeManager.class.getDeclaredField("biomeZoomSeed");
            f.setAccessible(true);
            return Long.toString(f.getLong(mc.level.getBiomeManager()));
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /** Adds damage/maxDamage for tools and armour, so Node can tell a nearly broken one before it breaks. */
    static JsonObject withDamage(JsonObject o, net.minecraft.world.item.ItemStack st) {
        if (st.isDamageableItem()) {
            o.addProperty("damage", st.getDamageValue());
            o.addProperty("maxDamage", st.getMaxDamage());
        }
        if (st.isEnchanted()) o.addProperty("enchanted", true);
        return o;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    static String valueName(BlockState st, Property prop) {
        return prop.getName(st.getValue(prop));
    }
}
