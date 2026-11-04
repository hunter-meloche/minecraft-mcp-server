package claudebridge.mixin;

import claudebridge.Passive;
import com.mojang.blaze3d.platform.Window;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Passive window: created without taking focus, then minimized. */
@Mixin(Window.class)
public class WindowMixin {
    @Inject(method = "createWindow", at = @At("HEAD"))
    private void claudebridge$beforeCreate(CallbackInfoReturnable<Long> cir) {
        Passive.beforeWindow();
    }

    @Inject(method = "createWindow", at = @At("RETURN"))
    private void claudebridge$afterCreate(CallbackInfoReturnable<Long> cir) {
        Passive.minimize(cir.getReturnValue());
    }
}
