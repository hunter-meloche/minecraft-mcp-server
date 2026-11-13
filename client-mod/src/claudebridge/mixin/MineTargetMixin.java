package claudebridge.mixin;

import claudebridge.Protection;
import net.minecraft.core.BlockPos;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Pseudo;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

import java.util.List;

/**
 * Baritone's miner prunes the ore it knows of before each use (what it may not break, then the nearest 64): the ground
 * and ore in the home zone's column come off that list first (Protection.mineTargets), so it never sets out for ore
 * under the yard. Baritone has no setting for it: its settings keep blocks off by kind, never by place.
 *
 * The mine process is `baritone.em` in the api-fabric 1.20.0 jar (fetch.mjs pins it by checksum), its prune the private
 * static `a(CalculationContext, List, BlockOptionalMetaLookup, int, List, List)`: names that jar's obfuscation made up,
 * and another Baritone build makes up others. So nothing here is required: a build that moved them leaves the miner as
 * it was, not a client that won't start (the client log's "[claudebridge] mine:" line shows the filter is on).
 */
@Pseudo
@Mixin(targets = "baritone.em", remap = false)
public class MineTargetMixin {
    // (the ore list: the first List among its arguments, changed before anything reads it)
    @ModifyVariable(method = "a(Lbaritone/ca;Ljava/util/List;Lbaritone/api/utils/BlockOptionalMetaLookup;ILjava/util/List;Ljava/util/List;)Ljava/util/List;",
        at = @At("HEAD"), argsOnly = true, ordinal = 0, require = 0, remap = false)
    private static List<BlockPos> claudebridge$offTheYard(List<BlockPos> locs) {
        return Protection.mineTargets(locs);
    }
}
