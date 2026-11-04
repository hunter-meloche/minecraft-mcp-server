package claudebridge;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

/** Small JSON helpers over the Gson that ships with the game. */
public final class Json {
    private static final Gson GSON = new Gson();

    private Json() { }

    public static JsonElement toTree(Object value) {
        if (value instanceof JsonElement e) return e;
        return GSON.toJsonTree(value);
    }

    public static JsonObject obj(Object... keyValues) {
        JsonObject o = new JsonObject();
        for (int i = 0; i + 1 < keyValues.length; i += 2) o.add((String) keyValues[i], toTree(keyValues[i + 1]));
        return o;
    }

    public static JsonObject pos(BlockPos p) {
        return obj("x", p.getX(), "y", p.getY(), "z", p.getZ());
    }

    public static JsonObject pos(Vec3 v) {
        return obj("x", round(v.x), "y", round(v.y), "z", round(v.z));
    }

    public static double round(double d) {
        return Math.round(d * 100) / 100.0;
    }

    public static int intParam(JsonObject p, String key, int fallback) {
        return p.has(key) && !p.get(key).isJsonNull() ? p.get(key).getAsInt() : fallback;
    }

    public static double numParam(JsonObject p, String key, double fallback) {
        return p.has(key) && !p.get(key).isJsonNull() ? p.get(key).getAsDouble() : fallback;
    }

    public static String strParam(JsonObject p, String key, String fallback) {
        return p.has(key) && !p.get(key).isJsonNull() ? p.get(key).getAsString() : fallback;
    }

    public static String required(JsonObject p, String key) {
        if (!p.has(key) || p.get(key).isJsonNull()) throw new IllegalArgumentException("missing parameter: " + key);
        return p.get(key).getAsString();
    }

    public static BlockPos blockPos(JsonObject p) {
        return new BlockPos((int) Math.floor(numParam(p, "x", Double.NaN)), (int) Math.floor(numParam(p, "y", Double.NaN)),
            (int) Math.floor(numParam(p, "z", Double.NaN)));
    }
}
