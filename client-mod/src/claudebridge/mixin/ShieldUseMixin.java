package claudebridge.mixin;

import claudebridge.Combat;
import claudebridge.Hazards;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.InteractionHand;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * The shield is held up with the use key down (Combat.shieldUp), and vanilla's use key (startUseItem, every 4 ticks the
 * key is down and nothing is being used) tries the main hand first: its click on the block in sight, then its item.
 * Whenever the shield was not up for a moment (on cooldown after an axe hit, or between two raises) the main hand's
 * water bucket poured, its block was placed, its food eaten. While Combat holds the key for the shield, the key raises
 * the off hand's shield and does nothing else (Hazards.keyUse); otherwise it is vanilla's.
 */
@Mixin(Minecraft.class)
public abstract class ShieldUseMixin {
    @Shadow private int rightClickDelay;
    @Shadow public LocalPlayer player;
    @Shadow public MultiPlayerGameMode gameMode;

    @Inject(method = "startUseItem", at = @At("HEAD"), cancellable = true)
    private void claudebridge$shieldOnly(CallbackInfo ci) {
        LocalPlayer p = this.player;
        if (p == null || this.gameMode == null) return;
        var rule = Hazards.keyUse(Combat.shieldKey(), p.getOffhandItem().has(DataComponents.BLOCKS_ATTACKS), p.isUsingItem());
        if (rule == Hazards.KeyUse.VANILLA) return;
        ci.cancel();
        // as vanilla: nothing while breaking a block, then the 4-tick delay, and nothing with the hands busy (riding)
        if (this.gameMode.isDestroying()) return;
        this.rightClickDelay = 4;
        if (p.isHandsBusy() || rule != Hazards.KeyUse.OFF_HAND_SHIELD) return;
        this.gameMode.useItem(p, InteractionHand.OFF_HAND);
    }
}
