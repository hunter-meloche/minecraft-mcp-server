package claudebridge;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/** Registry names without the "minecraft:" prefix, matching the names the MCP tools use. */
public final class Names {
    private Names() { }

    static String strip(String id) {
        return id.startsWith("minecraft:") ? id.substring(10) : id;
    }

    public static String block(BlockState state) {
        return strip(state.getBlock().builtInRegistryHolder().getRegisteredName());
    }

    public static String item(ItemStack stack) {
        return strip(stack.typeHolder().getRegisteredName());
    }

    public static String entity(Entity e) {
        return strip(e.getType().builtInRegistryHolder().getRegisteredName());
    }
}
