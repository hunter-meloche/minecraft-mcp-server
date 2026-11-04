package claudebridge.mixin;

import net.minecraft.client.multiplayer.ClientHandshakePacketListenerImpl;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Offline bot client: skip the client-side session join (there is no account to join with) and carry on with the
 * handshake, as mineflayer's offline mode does. Servers that verify logins still reject the player; only servers
 * that accept offline players let it through. Active only when the launcher sets -Dclaudebridge.offline=true.
 */
@Mixin(ClientHandshakePacketListenerImpl.class)
public class OfflineLoginMixin {
    @Inject(method = "authenticateServer", at = @At("HEAD"), cancellable = true)
    private void claudebridge$skipJoinWhenOffline(String serverId, CallbackInfoReturnable<Component> cir) {
        if (Boolean.getBoolean("claudebridge.offline")) cir.setReturnValue(null);
    }
}
