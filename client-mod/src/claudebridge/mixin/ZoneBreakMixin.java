package claudebridge.mixin;

import claudebridge.Protection;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Pseudo;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * No path through the ground under the yard: every block a path would break is first costed by the path's context,
 * its breakCostMultiplierAt (1, or never when breaking is off); here it is never for ground or ore in the home zone's
 * column (Protection.zoneBreak). Baritone's own rule there goes by kind (blocksToDisallowBreaking) and only while the
 * bot stands in the column, so a path searched from the mine start east of the yard tunnelled into it, and the bot
 * stood under the yard able to break nothing (the deep trips' "out from under", a dozen a day).
 *
 * The same two contexts as FenceScaffoldMixin's: the plain one (`baritone.ca`) and the builder's (`baritone.dt$a`),
 * whose override is `b` too. The arguments are read at the head, before either body touches them.
 *
 * Those names are the api-fabric 1.20.0 jar's obfuscation (fetch.mjs pins it by checksum): another Baritone build
 * moves them, so nothing here is required, and a build that moved them leaves pathing as it was instead of a client
 * that won't start (the client log's "[claudebridge] path: no path breaks ground" line shows the rule is on).
 */
@Pseudo
@Mixin(targets = { "baritone.ca", "baritone.dt$a" }, remap = false)
public class ZoneBreakMixin {
    @Inject(method = "b(IIILnet/minecraft/world/level/block/state/BlockState;)D", at = @At("HEAD"), cancellable = true,
        require = 0, remap = false)
    private void claudebridge$notUnderTheYard(int x, int y, int z, BlockState current, CallbackInfoReturnable<Double> cir) {
        if (Protection.zoneBreak(x, y, z, current)) cir.setReturnValue(Protection.COST_INF);
    }
}
