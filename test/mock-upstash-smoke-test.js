/**
 * Structural smoke test for lib/store.js against a fake Upstash REST server
 * (no real Upstash account needed). Verifies the @upstash/redis client is
 * being used correctly by store.js - real command shape, real auth header,
 * round-trips an installation record through get/save/get/remove/get.
 * Run: node test/mock-upstash-smoke-test.js
 */
const http = require("http");

const db = new Map();
const TOKEN = "test-token-123";

// Minimal stand-in for Upstash's REST API. The @upstash/redis client
// defaults to "auto-pipelining" - it batches commands into a single
// `POST /pipeline` call with a body like `[["get","installations"]]` and
// expects back `[{"result": ...}, ...]` in the same order. (Discovered by
// running this test against the real client and reading the mismatch -
// the simple per-command REST endpoints assumed on the first pass aren't
// what the SDK actually calls by default.)
const mockServer = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  if (req.method === "POST" && req.url.startsWith("/pipeline")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const commands = JSON.parse(body);
      console.log("PIPELINE COMMANDS:", JSON.stringify(commands));
      // Real Redis/Upstash values are always strings - GET must hand back
      // the same raw string SET was given, and the @upstash/redis client
      // does its own JSON.parse on the way out. Storing/returning an
      // already-parsed object (as an earlier version of this mock did)
      // silently breaks the client's deserialization - caught by this test.
      const results = commands.map(([op, key, value]) => {
        if (op === "get") return { result: db.has(key) ? db.get(key) : null };
        if (op === "set") {
          db.set(key, value);
          return { result: "OK" };
        }
        return { error: `unsupported op: ${op}` };
      });
      console.log("DB AFTER:", JSON.stringify([...db.entries()]), "RESPONDING:", JSON.stringify(results));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: `unhandled: ${req.method} ${req.url}` }));
});

mockServer.listen(0, async () => {
  const port = mockServer.address().port;
  process.env.UPSTASH_REDIS_REST_URL = `http://localhost:${port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;

  // Require store.js only after env vars are set, since Redis.fromEnv()
  // reads them at module-load time.
  delete require.cache[require.resolve("../lib/store")];
  const store = require("../lib/store");

  try {
    console.log("getInstallation (none yet):", await store.getInstallation("sinch.crowdin.com"));

    await store.saveInstallation("sinch.crowdin.com", { clientId: "abc", appSecret: "shh" });
    const saved = await store.getInstallation("sinch.crowdin.com");
    console.log("after save:", saved);
    if (saved.clientId !== "abc" || saved.appSecret !== "shh") throw new Error("save/get round-trip mismatch");

    await store.saveInstallation("sinch.crowdin.com", { accessToken: "tok1" });
    const merged = await store.getInstallation("sinch.crowdin.com");
    console.log("after merge-update:", merged);
    if (merged.clientId !== "abc" || merged.accessToken !== "tok1") throw new Error("merge update did not preserve prior fields");

    await store.removeInstallation("sinch.crowdin.com");
    const afterRemove = await store.getInstallation("sinch.crowdin.com");
    console.log("after remove:", afterRemove);
    if (afterRemove !== undefined) throw new Error("removeInstallation did not clear the record");

    console.log("ALL STORE.JS CHECKS PASSED");
    process.exit(0);
  } catch (err) {
    console.error("STORE.JS SMOKE TEST FAILED:", err);
    process.exit(1);
  } finally {
    mockServer.close();
  }
});
