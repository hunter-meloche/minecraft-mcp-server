package claudebridge.mixin;

import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Enemy;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Pseudo;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Baritone's mob avoidance (the `avoidance` setting, on since the first walks) for hostile mobs only. Its filter takes
 * every Mob, the cows and sheep too, and each one multiplies the cost of every node within 8 of it by 1.5. Animals
 * that pile up in one spot stack that to a wall: on Nov 18 a cow and sheep (or several) fell into a 2-deep hole at
 * (-557, 61, 2199), and every cell within 8 of it priced out of reach. That took in the whole of storehouse2, whose
 * door is 7.5 away, so from 15:39Z three of its chests were "no path found" from the doorstep, again and again (the
 * stash and pack chores, a dozen times an hour). The cow pen did the same to its own gate ("could not get into the pen
 * by its gate"). Monsters still raise the cost round them, as Baritone's filters already have them (a spider in the
 * light, a calm zombified piglin and a calm enderman are left out there).
 *
 * `c(Entity)Z` is the filter's `entity instanceof Mob` lambda in Avoidance.create (`baritone.fz`), as the api-fabric
 * 1.20.0 jar has it (fetch.mjs pins it by checksum; checked with javap: its bootstrap method #1, the first filter on
 * entitiesStream). Not required: another Baritone build that moved it leaves the avoidance as it was.
 */
@Pseudo
@Mixin(targets = "baritone.fz", remap = false)
public class AvoidanceMixin {
    @Inject(method = "c(Lnet/minecraft/world/entity/Entity;)Z", at = @At("HEAD"), cancellable = true, require = 0, remap = false)
    private static void claudebridge$hostileOnly(Entity entity, CallbackInfoReturnable<Boolean> cir) {
        cir.setReturnValue(claudebridge$avoided(entity));
    }

    /** A mob a path gives room: a hostile one (Enemy: zombies, skeletons, creepers, the Nether's), never an animal. */
    private static boolean claudebridge$avoided(Entity entity) {
        return entity instanceof Mob && entity instanceof Enemy;
    }
}
