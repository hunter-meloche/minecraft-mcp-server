package claudebridge.mixin;

import claudebridge.Protection;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Pseudo;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * No scaffold over the yard fence: Baritone climbed over it on throwaway cobblestone rather than walk round to a gate
 * (a stair over the north gate, pillars along the fence east of it up to 4 over it): placing a few blocks was cheaper.
 * Every block a path places (a pillar, a bridge, a step up) is first costed by the path's context, its
 * costOfPlacingAt; here that cost becomes "never" for a block in the fence's band (Protection.fenceScaffold), so the
 * path goes by a gate or not at all. The pens' fences have the same band: its way out of the cow pen was over the
 * pen's fence too. Baritone's settings can only turn placing off everywhere (allowPlace).
 *
 * Two contexts cost it: the plain one (`baritone.ca`: walks, the miner, the farm, fights, retreats) and the builder's
 * (`baritone.dt$a`: build jobs, level-area, the dig call), which overrides it without calling it. The builder's own
 * blocks, what its schematic wants where the bot carries it, cost 0 there and stay allowed; its throwaway blocks on
 * the way are refused like any other. The builder's own placing (BuilderProcess's tick) never asks this, nor do the
 * bridge's place, place.batch and pillar, so every build still places what it is building.
 *
 * The place is taken at the start and the rule applied at each return, with what Baritone made of it, by a handler
 * that takes no arguments: the builder's method reuses the slot of its x for the schematic's block partway through,
 * and a return handler given the arguments would read that block as x (the class fails to verify).
 *
 * Those names are the api-fabric 1.20.0 jar's obfuscation (fetch.mjs pins it by checksum): another Baritone build
 * moves them, so nothing here is required, and a build that moved them leaves pathing as it was instead of a client
 * that won't start (the client log's "[claudebridge] path:" line shows the rule is on).
 */
@Pseudo
@Mixin(targets = { "baritone.ca", "baritone.dt$a" }, remap = false)
public class FenceScaffoldMixin {
    @Inject(method = "a(IIILnet/minecraft/world/level/block/state/BlockState;)D", at = @At("HEAD"), require = 0, remap = false)
    private void claudebridge$placingAt(int x, int y, int z, BlockState current, CallbackInfoReturnable<Double> cir) {
        Protection.placingAt(x, y, z);
    }

    @Inject(method = "a(IIILnet/minecraft/world/level/block/state/BlockState;)D", at = @At("RETURN"), cancellable = true,
        require = 0, remap = false)
    private void claudebridge$notByTheFence(CallbackInfoReturnable<Double> cir) {
        if (Protection.fenceScaffold(cir.getReturnValueD())) cir.setReturnValue(Protection.COST_INF);
    }
}
