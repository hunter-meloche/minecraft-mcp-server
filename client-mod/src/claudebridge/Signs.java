package claudebridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractSignEditScreen;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.SignBlockEntity;
import net.minecraft.world.level.block.entity.SignTextSlot;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;

import java.lang.reflect.Field;

import static claudebridge.Json.*;

/**
 * Signs, the way a player makes them: hold a sign, click the face of the block it hangs on (sneaking, so a chest
 * doesn't open), and fill in the edit screen the server opens; closing the screen sends the text. And reading the
 * text of a sign the client has loaded. The chests' labels ("food1", "tools1", ...) are written with these.
 */
public final class Signs {
    private Signs() { }

    /** The edit screen's lines: the String[] field of AbstractSignEditScreen (found by type, not by name). */
    private static boolean setLines(AbstractSignEditScreen screen, String[] lines) {
        for (Class<?> k = screen.getClass(); k != null && k != Screen.class; k = k.getSuperclass()) {
            for (Field f : k.getDeclaredFields()) {
                if (f.getType() != String[].class) continue;
                try {
                    f.setAccessible(true);
                    String[] msgs = (String[]) f.get(screen);
                    for (int i = 0; i < msgs.length; i++) msgs[i] = i < lines.length ? lines[i] : "";
                    return true;
                } catch (ReflectiveOperationException e) {
                    return false;
                }
            }
        }
        return false;
    }

    private static String[] read(Minecraft mc, BlockPos at) {
        if (!(mc.level.getBlockEntity(at) instanceof SignBlockEntity sign)) return null;
        var msgs = sign.getText(SignTextSlot.FRONT).getMessages(false);
        String[] out = new String[4];
        for (int i = 0; i < 4; i++) out[i] = i < msgs.size() ? msgs.get(i).getString() : "";
        return out;
    }

    public static void register(BridgeServer s) {
        // {x, y, z}: the text on the sign there, or sign:false
        s.register("sign.read", true, (p, c) -> {
            String[] lines = read(Minecraft.getInstance(), blockPos(p));
            if (lines == null) return obj("sign", false);
            JsonArray a = new JsonArray();
            for (String l : lines) a.add(l);
            return obj("sign", true, "lines", a);
        });

        // {x, y, z: the cell for the sign; face: the side of the cell its support is on (north/south/east/west, or
        // down for a standing sign); lines: [up to 4]} -> {placed, lines}
        s.register("sign.place", true, (p, c) -> {
            Minecraft mc = Minecraft.getInstance();
            LocalPlayer pl = Handlers.player();
            BlockPos cell = blockPos(p);
            if (!Interact.replaceable(mc.level.getBlockState(cell))) return obj("placed", false, "reason", "occupied by " + Names.block(mc.level.getBlockState(cell)));
            Direction toSupport = Direction.byName(required(p, "face"));
            if (toSupport == null || toSupport == Direction.UP) throw new IllegalArgumentException("face must be north, south, east, west or down");
            BlockPos support = cell.relative(toSupport);
            Direction face = toSupport.getOpposite();
            Vec3 hit = Interact.faceCenter(support, face);
            if (pl.getEyePosition().distanceTo(hit) > 4.5) return obj("placed", false, "reason", "too far", "distance", round(pl.getEyePosition().distanceTo(hit)));
            int slot = -1;
            for (int i = 0; i < 36; i++) {
                ItemStack st = pl.getInventory().getItem(i);
                if (!st.isEmpty() && Names.item(st).endsWith("_sign") && !Names.item(st).endsWith("_hanging_sign")) { slot = i; break; }
            }
            if (slot < 0) return obj("placed", false, "reason", "no sign carried");
            Interact.select(Names.item(pl.getInventory().getItem(slot)));
            String[] lines = new String[4];
            JsonArray given = p.has("lines") ? p.getAsJsonArray("lines") : new JsonArray();
            for (int i = 0; i < 4; i++) lines[i] = i < given.size() ? given.get(i).getAsString() : "";
            pl.lookAt(EntityAnchorArgument.Anchor.EYES, hit);
            BlockHitResult click = new BlockHitResult(hit, face, support, false);
            Ticker.add(new Ticker.Task() {
                int age = 0;
                boolean clicked = false;
                @Override public boolean tick(Minecraft m) {
                    age++;
                    // sneak a couple of ticks first: the server reads it from the player's input, and a sneaking
                    // click on a chest places the sign instead of opening the chest
                    if (age == 1) m.options.keyShift.setDown(true);
                    if (age == 4 && !clicked) { clicked = true; m.gameMode.useItemOn(m.player, InteractionHand.MAIN_HAND, click); }
                    if (age == 6) m.options.keyShift.setDown(false);
                    if (m.gui.screen() instanceof AbstractSignEditScreen edit) {
                        boolean ok = setLines(edit, lines);
                        edit.onClose(); // sends the lines
                        m.options.keyShift.setDown(false);
                        JsonArray out = new JsonArray();
                        for (String l : lines) out.add(l);
                        c.ok(obj("placed", true, "written", ok, "lines", out, "block", Names.block(m.level.getBlockState(cell))));
                        return true;
                    }
                    if (age > 40) {
                        m.options.keyShift.setDown(false);
                        boolean there = !Interact.replaceable(m.level.getBlockState(cell));
                        c.ok(obj("placed", there, "written", false, "reason", there ? "no sign editor opened" : "the server did not accept it"));
                        return true;
                    }
                    return false;
                }
            });
            return BridgeServer.LATER;
        });
    }
}
