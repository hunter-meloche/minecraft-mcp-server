package claudebridge.mixin;

import claudebridge.Tools;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * The tool for every block the bot breaks, whoever breaks it (Baritone's miner and builder, our dig): the right tool,
 * or a hand that doesn't wear one out for nothing (Tools.slotFor). Before the game compares the held item with the
 * one the dig started with, so a dig keeps its progress.
 */
@Mixin(MultiPlayerGameMode.class)
public class DestroyToolMixin {
    @Inject(method = "startDestroyBlock", at = @At("HEAD"))
    private void claudebridge$start(BlockPos pos, Direction face, CallbackInfoReturnable<Boolean> cir) {
        Tools.holdFor(pos);
    }

    @Inject(method = "continueDestroyBlock", at = @At("HEAD"))
    private void claudebridge$continue(BlockPos pos, Direction face, CallbackInfoReturnable<Boolean> cir) {
        Tools.holdFor(pos);
    }
}
