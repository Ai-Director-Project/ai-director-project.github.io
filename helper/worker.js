// After Dark helper: keeps the chat in sync between devices and can hold the Grok key.
// No secrets live in this file. The first device to set a sync code claims it; it is kept in Cloudflare storage.
import { vapidKeys, pushAll, duePush } from "./push.js";
const ORIGIN = "https://ai-director-project.github.io";

export default {
  async scheduled(event, env, ctx) {
    if (env.STORE) ctx.waitUntil(duePush(env));
  },
  async fetch(req, env, ctx) {
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
    if (path === "/push/key") return reply({ key: (await vapidKeys(env)).pub });

    if (path === "/claim" && req.method === "POST") {
      if (sent.length < 8) return reply({ error: "code too short" }, 400);
      if (saved && saved !== sent) return reply({ error: "already claimed" }, 403);
      if (!saved) await env.STORE.put("code", sent);
      return reply({ ok: true });
    }

    if (path === "/join" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const pair = await env.STORE.get("pair", "json");
      if (!pair || Date.now() > pair.exp) return reply({ error: "expired" }, 410);
      if (String(body.pin || "") !== pair.pin) {
        pair.tries = (pair.tries || 0) + 1;
        if (pair.tries >= 5) await env.STORE.delete("pair"); else await env.STORE.put("pair", JSON.stringify(pair));
        return reply({ error: "wrong numbers" }, 403);
      }
      await env.STORE.delete("pair");
      return reply({ code: saved });
    }

    if (!saved || sent !== saved) return reply({ error: "wrong code" }, 401);

    if (path === "/pair" && req.method === "POST") {
      const pin = String(100000 + Math.floor(Math.random() * 900000));
      await env.STORE.put("pair", JSON.stringify({ pin, exp: Date.now() + 10 * 60000, tries: 0 }));
      return reply({ pin });
    }

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
        gone: Array.isArray(body.gone) ? body.gone.slice(-3000) : [],
        p: typeof body.p === "string" ? body.p.slice(0, 200000) : "",
        pu: +body.pu || 0,
        notes: Array.isArray(body.notes) ? body.notes.slice(-200) : [],
        nu: +body.nu || 0
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
    // phone notifications for photo checks
    if (path === "/push/sub" && req.method === "PUT") {
      const b = await req.json().catch(() => ({}));
      const s = b.sub;
      if (!s || typeof s.endpoint !== "string" || !s.endpoint.startsWith("https://") || !s.keys || !s.keys.p256dh || !s.keys.auth) return reply({ error: "bad subscription" }, 400);
      const subs = ((await env.STORE.get("subs", "json")) || []).filter(x => x.endpoint !== s.endpoint && (!b.dev || x.dev !== b.dev || x.id !== b.id));
      subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, dev: String(b.dev || "").slice(0, 40), id: String(b.id || "").slice(0, 40), at: Date.now() });
      await env.STORE.put("subs", JSON.stringify(subs.slice(-10)));
      return reply({ ok: true, subs: subs.length });
    }
    if (path === "/push/unsub" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const subs = ((await env.STORE.get("subs", "json")) || []).filter(x => x.endpoint !== b.endpoint && (!b.id || x.id !== b.id));
      await env.STORE.put("subs", JSON.stringify(subs));
      return reply({ ok: true, subs: subs.length });
    }
    if (path === "/push/test" && req.method === "POST") {
      const sent = await pushAll(env, { title: "Reminder", body: "\u2705 Notifications are working", id: "test" });
      return reply({ ok: true, sent });
    }
    if (path === "/push/check" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const due = +b.due || 0;
      if (!b.id || !due || due < Date.now() - 60000 || due > Date.now() + 48 * 3600000 + 120000) return reply({ error: "bad check" }, 400);
      const c = { id: String(b.id).slice(0, 40), due, cam: b.cam === "back" ? "back" : "front", win: +b.win || 0 };
      await env.STORE.put("pchk", JSON.stringify(c));
      await env.STORE.put("lastchk", JSON.stringify(c), { expirationTtl: 49 * 3600 });
      const subs = (await env.STORE.get("subs", "json")) || [];
      return reply({ ok: true, subs: subs.length, devs: subs.map(x => x.dev) });
    }
    if (path === "/push/check" && req.method === "GET") {
      return reply((await env.STORE.get("lastchk", "json")) || {});
    }
    if (path === "/push/cancel" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const c = await env.STORE.get("pchk", "json");
      if (c && (!b.id || c.id === b.id)) await env.STORE.delete("pchk");
      const l = await env.STORE.get("lastchk", "json");
      if (l && (!b.id || l.id === b.id)) await env.STORE.delete("lastchk");
      return reply({ ok: true });
    }

    // Vesper's photo collection (check-in photos she chose to keep)
    if (path === "/photos" && req.method === "GET") {
      return reply((await env.STORE.get("phidx", "json")) || []);
    }
    if (path === "/photos" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (typeof b.data !== "string" || !b.data.startsWith("data:image/") || b.data.length > 8000000) return reply({ error: "bad photo" }, 400);
      const idx = (await env.STORE.get("phidx", "json")) || [];
      if (idx.length >= 300) return reply({ error: "collection full" }, 400);
      const n = idx.reduce((m, x) => Math.max(m, x.n), 0) + 1;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await env.STORE.put("ph:" + id, b.data);
      const e = { n, id, cap: String(b.cap || "").slice(0, 120), at: +b.at || Date.now(), cam: b.cam === "back" ? "back" : "front" };
      idx.push(e);
      await env.STORE.put("phidx", JSON.stringify(idx));
      return reply(e);
    }
    if (path === "/photos/bg" && req.method === "GET") {
      return reply((await env.STORE.get("herbg", "json")) || {});
    }
    if (path === "/photos/bg" && req.method === "PUT") {
      const b = await req.json().catch(() => ({}));
      await env.STORE.put("herbg", JSON.stringify({ n: +b.n || 0, until: +b.until || 0, at: Date.now() }));
      return reply({ ok: true });
    }
    const pm = path.match(/^\/photos\/(\d{1,4})$/);
    if (pm && req.method === "GET") {
      const e = ((await env.STORE.get("phidx", "json")) || []).find(x => x.n === +pm[1]);
      const data = e && (await env.STORE.get("ph:" + e.id));
      if (!data) return reply({ error: "no such photo" }, 404);
      return reply({ ...e, data });
    }
    if (path === "/photos/drop" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const idx = (await env.STORE.get("phidx", "json")) || [];
      const e = idx.find(x => x.n === +b.n);
      if (!e) return reply({ error: "no such photo" }, 404);
      await env.STORE.delete("ph:" + e.id);
      await env.STORE.put("phidx", JSON.stringify(idx.filter(x => x !== e)));
      return reply({ ok: true });
    }

    // copy everything to a newly connected device (kept 30 minutes)
    const bm = path.match(/^\/bundle\/(meta|p\/(\d{1,3}))$/);
    if (bm && req.method === "PUT") {
      await env.STORE.put("bundle:" + (bm[2] || "meta"), await req.text(), { expirationTtl: 1800 });
      return reply({ ok: true });
    }
    if (bm && req.method === "GET") {
      const v = await env.STORE.get("bundle:" + (bm[2] || "meta"));
      if (v === null) return reply({ error: "none" }, 404);
      return new Response(v, { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return reply({ error: "not found" }, 404);
  }
};
