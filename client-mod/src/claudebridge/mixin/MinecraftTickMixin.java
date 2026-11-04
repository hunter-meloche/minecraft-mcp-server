package claudebridge.mixin;

import claudebridge.Ticker;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Drives Ticker once per client tick (20 per second), on the game thread. */
@Mixin(Minecraft.class)
public class MinecraftTickMixin {
    @Inject(method = "tick", at = @At("TAIL"))
    private void claudebridge$tick(CallbackInfo ci) {
        Ticker.tick((Minecraft) (Object) this);
    }
}
