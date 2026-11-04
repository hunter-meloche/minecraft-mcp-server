package claudebridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.Minecraft;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Newline-delimited JSON-RPC 2.0 on 127.0.0.1. The first request on a connection must be
 * {"method":"hello","params":{"token":...}} with the token the launcher generated; anything else is refused.
 * Events are pushed to every authenticated connection as {"jsonrpc":"2.0","method":"event","params":{...}}.
 */
public final class BridgeServer {
    /** A method. Return a result for an immediate reply, or {@link #LATER} and finish through the {@link Call}. */
    public interface Method {
        Object call(JsonObject params, Call call) throws Exception;
    }

    public static final Object LATER = new Object();

    private record Entry(Method method, boolean onClientThread) { }

    private final Map<String, Entry> methods = new ConcurrentHashMap<>();
    private final Set<Connection> connections = ConcurrentHashMap.newKeySet();
    private final String token;
    private final int port;

    public BridgeServer(int port, String token) {
        this.port = port;
        this.token = token;
    }

    /** Register a method. {@code onClientThread}: run it on the game thread (anything touching the game state). */
    public void register(String name, boolean onClientThread, Method method) {
        methods.put(name, new Entry(method, onClientThread));
    }

    public void start() {
        Thread t = new Thread(this::serve, "claudebridge-server");
        t.setDaemon(true);
        t.start();
    }

    /** Push an event to every authenticated connection. Safe from any thread. */
    public void emit(String type, JsonObject data) {
        JsonObject params = data == null ? new JsonObject() : data.deepCopy();
        params.addProperty("type", type);
        JsonObject msg = new JsonObject();
        msg.addProperty("jsonrpc", "2.0");
        msg.addProperty("method", "event");
        msg.add("params", params);
        for (Connection c : connections) if (c.authed) c.send(msg);
    }

    private void serve() {
        try (ServerSocket server = new ServerSocket(port, 8, InetAddress.getLoopbackAddress())) {
            System.out.println("[claudebridge] listening on 127.0.0.1:" + port);
            while (true) {
                Socket s = server.accept();
                Connection c = new Connection(s);
                connections.add(c);
                Thread h = new Thread(c::run, "claudebridge-conn");
                h.setDaemon(true);
                h.start();
            }
        } catch (Exception e) {
            System.out.println("[claudebridge] server stopped: " + e);
        }
    }

    /** One request awaiting its reply; finish it exactly once with {@link #ok} or {@link #fail}. */
    public final class Call {
        private final Connection connection;
        private final JsonElement id;
        private volatile boolean done;

        private Call(Connection connection, JsonElement id) {
            this.connection = connection;
            this.id = id;
        }

        public boolean isDone() { return done; }

        public void ok(Object result) {
            if (done) return;
            done = true;
            JsonObject msg = new JsonObject();
            msg.addProperty("jsonrpc", "2.0");
            msg.add("id", id);
            msg.add("result", Json.toTree(result));
            connection.send(msg);
        }

        public void fail(String message) {
            if (done) return;
            done = true;
            JsonObject err = new JsonObject();
            err.addProperty("code", -32000);
            err.addProperty("message", message);
            JsonObject msg = new JsonObject();
            msg.addProperty("jsonrpc", "2.0");
            msg.add("id", id);
            msg.add("error", err);
            connection.send(msg);
        }
    }

    private final class Connection {
        private final Socket socket;
        private volatile boolean authed;
        private OutputStream out;

        Connection(Socket socket) {
            this.socket = socket;
        }

        synchronized void send(JsonObject msg) {
            try {
                out.write((msg.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            } catch (Exception e) {
                close();
            }
        }

        void close() {
            connections.remove(this);
            try { socket.close(); } catch (Exception ignored) { }
        }

        void run() {
            try (socket; BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))) {
                out = socket.getOutputStream();
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.isBlank()) continue;
                    handle(line);
                }
            } catch (Exception ignored) {
                // connection dropped
            } finally {
                close();
            }
        }

        private void handle(String line) {
            JsonObject req;
            try {
                req = JsonParser.parseString(line).getAsJsonObject();
            } catch (Exception e) {
                return; // not JSON: ignore
            }
            JsonElement id = req.has("id") ? req.get("id") : JsonNull.INSTANCE;
            String name = req.has("method") ? req.get("method").getAsString() : "";
            JsonObject params = req.has("params") && req.get("params").isJsonObject() ? req.getAsJsonObject("params") : new JsonObject();
            Call call = new Call(this, id);

            if (!authed) {
                if (name.equals("hello") && params.has("token") && token.equals(params.get("token").getAsString())) {
                    authed = true;
                    JsonObject hello = new JsonObject();
                    hello.addProperty("bridge", "claudebridge");
                    hello.addProperty("protocol", 1);
                    hello.addProperty("username", Minecraft.getInstance().getUser().getName());
                    call.ok(hello);
                } else {
                    call.fail("hello with the launch token first");
                    close();
                }
                return;
            }

            Entry entry = methods.get(name);
            if (entry == null) { call.fail("unknown method: " + name); return; }
            try {
                if (entry.onClientThread()) {
                    Object result = Minecraft.getInstance().submit(() -> {
                        try { return entry.method().call(params, call); } catch (Exception e) { return new Failure(e); }
                    }).get(30, TimeUnit.SECONDS);
                    finish(call, result);
                } else {
                    finish(call, entry.method().call(params, call));
                }
            } catch (Exception e) {
                call.fail(describe(e));
            }
        }

        private void finish(Call call, Object result) {
            if (result == LATER) return;
            if (result instanceof Failure f) call.fail(describe(f.error()));
            else call.ok(result);
        }
    }

    private record Failure(Exception error) { }

    static String describe(Throwable e) {
        String m = e.getMessage();
        return m == null || m.isBlank() ? e.getClass().getSimpleName() : m;
    }
}
