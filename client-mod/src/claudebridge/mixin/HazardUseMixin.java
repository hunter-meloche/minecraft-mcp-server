package claudebridge.mixin;

import claudebridge.Hazards;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * The guard against stray uses of a full bucket or a fire starter (Hazards): every right click the client makes, by
 * whoever (Baritone's door opening and block placing, the use key, Gates, the bridge's tools), comes through these two.
 * A refused use answers PASS before anything is predicted or sent, as a click that did nothing would.
 */
@Mixin(MultiPlayerGameMode.class)
public class HazardUseMixin {
    @Inject(method = "useItem", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noStrayUse(Player player, InteractionHand hand, CallbackInfoReturnable<InteractionResult> cir) {
        if (Hazards.refuse(player, hand, null)) cir.setReturnValue(InteractionResult.PASS);
    }

    @Inject(method = "useItemOn", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noStrayUseOn(LocalPlayer player, InteractionHand hand, BlockHitResult hit, CallbackInfoReturnable<InteractionResult> cir) {
        if (Hazards.refuse(player, hand, hit)) cir.setReturnValue(InteractionResult.PASS);
    }
}
