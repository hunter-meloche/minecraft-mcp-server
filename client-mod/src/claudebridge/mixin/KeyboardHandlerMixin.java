package claudebridge.mixin;

import claudebridge.Passive;
import net.minecraft.client.KeyboardHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Passive window: ignore the user's keyboard (the bridge presses the bot's keys itself, not through here). */
@Mixin(KeyboardHandler.class)
public class KeyboardHandlerMixin {
    @Inject(method = "keyPress", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noKeys(CallbackInfo ci) {
        if (Passive.ENABLED) ci.cancel();
    }

    @Inject(method = "charTyped", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noChars(CallbackInfo ci) {
        if (Passive.ENABLED) ci.cancel();
    }
}
