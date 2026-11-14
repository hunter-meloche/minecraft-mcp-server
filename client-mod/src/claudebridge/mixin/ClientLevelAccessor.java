package claudebridge.mixin;

import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.prediction.BlockStatePredictionHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** The level's prediction handler (package-private in 26.3): the sequence number a use went out with (ServerWord). */
@Mixin(ClientLevel.class)
public interface ClientLevelAccessor {
    @Invoker("getBlockStatePredictionHandler")
    BlockStatePredictionHandler claudebridge$predictions();
}
