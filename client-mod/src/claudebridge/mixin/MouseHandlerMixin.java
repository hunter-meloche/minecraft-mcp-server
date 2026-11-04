package claudebridge.mixin;

import claudebridge.Passive;
import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Passive window: never grab the user's mouse, and ignore its movement, buttons and wheel. */
@Mixin(MouseHandler.class)
public class MouseHandlerMixin {
    @Inject(method = "grabMouse", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noGrab(CallbackInfo ci) {
        if (Passive.ENABLED) ci.cancel();
    }

    @Inject(method = "onMove", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noMove(CallbackInfo ci) {
        if (Passive.ENABLED) ci.cancel();
    }

    @Inject(method = "onButton", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noButton(CallbackInfo ci) {
        if (Passive.ENABLED) ci.cancel();
    }

    @Inject(method = "onScroll", at = @At("HEAD"), cancellable = true)
    private void claudebridge$noScroll(CallbackInfo ci) {
        if (Passive.ENABLED) ci.cancel();
    }
}
