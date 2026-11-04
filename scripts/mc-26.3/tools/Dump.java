import com.google.gson.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.jar.*;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializer;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/** Dumps block/item/entity facts from the running game code. Args: <game jar> <out.json> */
public class Dump {
  public static void main(String[] args) throws Exception {
    SharedConstants.tryDetectVersion();
    Bootstrap.bootStrap();
    JsonObject out = new JsonObject();

    JsonArray blocks = new JsonArray();
    for (Block b : BuiltInRegistries.BLOCK) {
      JsonObject o = new JsonObject();
      o.addProperty("id", BuiltInRegistries.BLOCK.getId(b));
      o.addProperty("name", BuiltInRegistries.BLOCK.getKey(b).getPath());
      o.addProperty("hardness", b.defaultDestroyTime());
      o.addProperty("resistance", b.getExplosionResistance());
      o.addProperty("item", BuiltInRegistries.ITEM.getKey(b.asItem()).getPath());
      o.addProperty("translationKey", b.getDescriptionId());
      BlockState d = b.defaultBlockState();
      o.addProperty("defaultState", Block.getId(d));
      o.addProperty("emitLight", d.getLightEmission());
      o.addProperty("filterLight", d.getLightDampening());
      o.addProperty("canOcclude", d.canOcclude());
      o.addProperty("requiresTool", d.requiresCorrectToolForDrops());
      JsonArray states = new JsonArray();
      for (BlockState s : b.getStateDefinition().getPossibleStates()) {
        JsonObject so = new JsonObject();
        so.addProperty("id", Block.getId(s));
        JsonArray boxes = new JsonArray();
        try {
          for (AABB a : s.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).toAabbs()) {
            JsonArray box = new JsonArray();
            box.add(a.minX); box.add(a.minY); box.add(a.minZ); box.add(a.maxX); box.add(a.maxY); box.add(a.maxZ);
            boxes.add(box);
          }
        } catch (Throwable t) { so.addProperty("shapeError", t.toString()); }
        so.add("shape", boxes);
        states.add(so);
      }
      o.add("states", states);
      blocks.add(o);
    }
    out.add("blocks", blocks);

    JsonArray items = new JsonArray();
    for (Item i : BuiltInRegistries.ITEM) {
      JsonObject o = new JsonObject();
      o.addProperty("id", BuiltInRegistries.ITEM.getId(i));
      o.addProperty("name", BuiltInRegistries.ITEM.getKey(i).getPath());
      items.add(o);
    }
    out.add("items", items);

    JsonArray entities = new JsonArray();
    for (EntityType<?> e : BuiltInRegistries.ENTITY_TYPE) {
      JsonObject o = new JsonObject();
      o.addProperty("id", BuiltInRegistries.ENTITY_TYPE.getId(e));
      o.addProperty("name", BuiltInRegistries.ENTITY_TYPE.getKey(e).getPath());
      o.addProperty("width", e.getWidth());
      o.addProperty("height", e.getHeight());
      o.addProperty("category", e.getCategory().getName());
      o.addProperty("translationKey", e.getDescriptionId());
      entities.add(o);
    }
    out.add("entities", entities);

    JsonArray attrs = new JsonArray();
    for (net.minecraft.world.entity.ai.attributes.Attribute a : BuiltInRegistries.ATTRIBUTE) {
      JsonObject o = new JsonObject();
      o.addProperty("id", BuiltInRegistries.ATTRIBUTE.getId(a));
      o.addProperty("resource", BuiltInRegistries.ATTRIBUTE.getKey(a).toString());
      o.addProperty("default", a.getDefaultValue());
      if (a instanceof net.minecraft.world.entity.ai.attributes.RangedAttribute r) {
        o.addProperty("min", r.getMinValue()); o.addProperty("max", r.getMaxValue());
      }
      attrs.add(o);
    }
    out.add("attributes", attrs);

    // Entity metadata serializers, by network id
    JsonArray sers = new JsonArray();
    for (Field f : EntityDataSerializers.class.getDeclaredFields()) {
      if (!Modifier.isStatic(f.getModifiers()) || !EntityDataSerializer.class.isAssignableFrom(f.getType())) continue;
      f.setAccessible(true);
      int id = EntityDataSerializers.getSerializedId((EntityDataSerializer<?>) f.get(null));
      JsonObject o = new JsonObject();
      o.addProperty("id", id); o.addProperty("field", f.getName());
      sers.add(o);
    }
    out.add("dataSerializers", sers);

    // Synched entity data accessors for every entity class in the jar
    JsonObject accessors = new JsonObject();
    try (JarFile jar = new JarFile(args[0])) {
      for (Enumeration<JarEntry> en = jar.entries(); en.hasMoreElements();) {
        String n = en.nextElement().getName();
        if (!n.startsWith("net/minecraft/world/entity/") || !n.endsWith(".class")) continue;
        String cn = n.substring(0, n.length() - 6).replace('/', '.');
        Class<?> c;
        try { c = Class.forName(cn, true, Dump.class.getClassLoader()); } catch (Throwable t) { continue; }
        JsonArray fl = new JsonArray();
        for (Field f : c.getDeclaredFields()) {
          if (!Modifier.isStatic(f.getModifiers()) || f.getType() != EntityDataAccessor.class) continue;
          try {
            f.setAccessible(true);
            EntityDataAccessor<?> a = (EntityDataAccessor<?>) f.get(null);
            JsonObject o = new JsonObject();
            o.addProperty("field", f.getName()); o.addProperty("id", a.id());
            o.addProperty("serializer", EntityDataSerializers.getSerializedId(a.serializer()));
            fl.add(o);
          } catch (Throwable t) { /* skip */ }
        }
        if (fl.size() > 0) {
          JsonObject co = new JsonObject();
          co.addProperty("super", c.getSuperclass() == null ? null : c.getSuperclass().getName());
          co.add("fields", fl);
          accessors.add(cn, co);
        }
      }
    }
    out.add("accessors", accessors);

    try (Writer w = new OutputStreamWriter(new FileOutputStream(args[1]), StandardCharsets.UTF_8)) {
      new GsonBuilder().create().toJson(out, w);
    }
    System.out.println("blocks " + blocks.size() + " items " + items.size() + " entities " + entities.size() + " accessorClasses " + accessors.size());
    System.exit(0);
  }
}
