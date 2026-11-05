package claudebridge;

import baritone.api.process.IBaritoneProcess;
import baritone.api.process.PathingCommand;
import baritone.api.process.PathingCommandType;

/**
 * Pauses whatever Baritone job is running while the bot eats (the Guardian's calm-time eating waited for an idle
 * moment, which a 30-minute leveling job never gave it: the bot sat at 11 HP with food 16 and could not heal).
 */
public final class EatPause implements IBaritoneProcess {
    static volatile boolean eating;

    @Override public boolean isActive() { return eating; }
    @Override public PathingCommand onTick(boolean calcFailed, boolean isSafeToCancel) { return new PathingCommand(null, PathingCommandType.REQUEST_PAUSE); }
    @Override public boolean isTemporary() { return true; }
    @Override public void onLostControl() { }
    @Override public double priority() { return 90; }
    @Override public String displayName0() { return "Eating"; }
}
