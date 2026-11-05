package claudebridge.mixin;

import claudebridge.BrainHud;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.Hud;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** The brain's status line, drawn over the HUD. */
@Mixin(Hud.class)
public class HudMixin {
    @Inject(method = "extractRenderState", at = @At("TAIL"))
    private void claudebridge$brainLine(GuiGraphicsExtractor g, DeltaTracker delta, CallbackInfo ci) {
        BrainHud.draw(g);
    }
}
