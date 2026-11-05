package claudebridge.mixin;

import claudebridge.Events;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundDamageEventPacket;
import net.minecraft.network.protocol.game.ClientboundPlayerCombatKillPacket;
import net.minecraft.network.protocol.game.ClientboundRespawnPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Damage, death, respawn and system messages as the server reports them. Each handler first hands itself over to the game thread
 * (throwing on the network thread), so injecting at TAIL runs once, on the game thread.
 */
@Mixin(ClientPacketListener.class)
public class ClientPacketListenerMixin {
    @Inject(method = "handleDamageEvent", at = @At("TAIL"))
    private void claudebridge$damage(ClientboundDamageEventPacket packet, CallbackInfo ci) {
        Events.onDamage(packet);
    }

    @Inject(method = "handlePlayerCombatKill", at = @At("TAIL"))
    private void claudebridge$death(ClientboundPlayerCombatKillPacket packet, CallbackInfo ci) {
        Events.onCombatKill(packet);
    }

    @Inject(method = "handleRespawn", at = @At("TAIL"))
    private void claudebridge$respawn(ClientboundRespawnPacket packet, CallbackInfo ci) {
        Events.onRespawn();
    }

    @Inject(method = "handleSystemChat", at = @At("TAIL"))
    private void claudebridge$systemChat(ClientboundSystemChatPacket packet, CallbackInfo ci) {
        Events.onSystemMessage(packet.content(), packet.overlay());
    }
}
