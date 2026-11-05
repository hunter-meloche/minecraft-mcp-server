package claudebridge.mixin;

import claudebridge.BrainHud;
import net.minecraft.client.Minecraft;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** The window title carries the brain's status (visible on the taskbar while minimized). */
@Mixin(Minecraft.class)
public class TitleMixin {
    @Inject(method = "createTitle", at = @At("RETURN"), cancellable = true)
    private void claudebridge$title(CallbackInfoReturnable<String> cir) {
        cir.setReturnValue(BrainHud.title(cir.getReturnValue()));
    }
}
