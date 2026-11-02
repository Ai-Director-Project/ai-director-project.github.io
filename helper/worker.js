// After Dark helper: keeps the chat in sync between devices and can hold the Grok key.
// No secrets live in this file. The first device to set a sync code claims it; it is kept in Cloudflare storage.
const ORIGIN = "https://ai-director-project.github.io";

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Code",
      "Access-Control-Max-Age": "86400"
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!env.STORE) return reply({ error: "storage not connected" }, 500);
    const path = new URL(req.url).pathname;
    const saved = await env.STORE.get("code");
    const sent = req.headers.get("X-Code") || "";

    if (path === "/" || path === "/ping") return reply({ ok: true, claimed: !!saved });

    if (path === "/claim" && req.method === "POST") {
      if (sent.length < 8) return reply({ error: "code too short" }, 400);
      if (saved && saved !== sent) return reply({ error: "already claimed" }, 403);
      if (!saved) await env.STORE.put("code", sent);
      return reply({ ok: true });
    }

    if (!saved || sent !== saved) return reply({ error: "wrong code" }, 401);

    if (path === "/chat" && req.method === "GET") {
      const data = await env.STORE.get("chat", "json");
      return reply(data || { history: [], updated: 0 });
    }
    if (path === "/chat" && req.method === "PUT") {
      const body = await req.json();
      const old = await env.STORE.get("chat", "json");
      if (old && old.updated > (body.updated || 0)) return reply(old, 409);
      await env.STORE.put("chat", JSON.stringify({
        history: Array.isArray(body.history) ? body.history.slice(-200) : [],
        persona: typeof body.persona === "string" ? body.persona : undefined,
        updated: body.updated || Date.now()
      }));
      return reply({ ok: true });
    }
    if (path === "/mem" && req.method === "GET") {
      const data = await env.STORE.get("mem", "json");
      return reply(data || { n: 0, f: [], gone: [] });
    }
    if (path === "/mem" && req.method === "PUT") {
      const body = await req.json();
      if (!body || !Array.isArray(body.f)) return reply({ error: "bad memory" }, 400);
      await env.STORE.put("mem", JSON.stringify({
        n: +body.n || 0,
        f: body.f.slice(0, 5000),
        gone: Array.isArray(body.gone) ? body.gone.slice(-3000) : []
      }));
      return reply({ ok: true });
    }
    if (path === "/key" && req.method === "PUT") {
      const body = await req.json();
      if (!body.key || !String(body.key).startsWith("xai-")) return reply({ error: "not an xAI key" }, 400);
      await env.STORE.put("xai_key", String(body.key));
      return reply({ ok: true });
    }
    if (path === "/key" && req.method === "GET") {
      return reply({ stored: !!(await env.STORE.get("xai_key")) });
    }
    if (path === "/grok" && req.method === "POST") {
      const key = await env.STORE.get("xai_key");
      if (!key) return reply({ error: "no key stored" }, 400);
      const r = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: await req.text()
      });
      return new Response(r.body, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
    }
    return reply({ error: "not found" }, 404);
  }
};
