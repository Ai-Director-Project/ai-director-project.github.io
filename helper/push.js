// Web Push for After Dark photo-check alerts (works on iPhone home-screen apps and Android Chrome).
// The signing keys are made by the helper itself the first time and kept in Cloudflare storage, never in this file.

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// The helper's own signing keys (VAPID). Made once, then reused.
export async function vapidKeys(env) {
  const saved = await env.STORE.get("vapid", "json");
  if (saved) return saved;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
  await env.STORE.put("vapid", JSON.stringify(keys));
  return keys;
}

async function vapidHeader(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://ai-director-project.github.io" })));
  const key = await crypto.subtle.importKey("jwk", keys.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + keys.pub;
}

// Encrypts the message for one device (RFC 8291, aes128gcm).
export async function encrypt(payload, p256dh, auth) {
  const ua = unb64u(p256dh), secret = unb64u(auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(secret, shared);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), ua, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return cat(head, asPub, ct);
}

// Sends one message to every saved device. Devices that have gone away are removed.
export async function pushAll(env, msg) {
  const subs = (await env.STORE.get("subs", "json")) || [];
  if (!subs.length) return 0;
  const keys = await vapidKeys(env);
  const keep = []; let sent = 0;
  for (const s of subs) {
    try {
      const body = await encrypt(JSON.stringify(msg), s.keys.p256dh, s.keys.auth);
      const r = await fetch(s.endpoint, {
        method: "POST",
        headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "900", Urgency: "high", Topic: "photocheck", Authorization: await vapidHeader(s.endpoint, keys) },
        body
      });
      if (r.status === 404 || r.status === 410) continue;
      if (r.ok) sent++;
      keep.push(s);
    } catch (e) { keep.push(s); }
  }
  if (keep.length !== subs.length) await env.STORE.put("subs", JSON.stringify(keep));
  return sent;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Runs once a minute. If a photo check falls due within the next minute, waits for it and sends the alert.
export async function duePush(env) {
  const c = await env.STORE.get("pchk", "json");
  if (!c) return;
  const wait = c.due - Date.now();
  if (wait > 58000) return;
  if (wait < -15 * 60000) { await env.STORE.delete("pchk"); return; }
  if (wait > 0) await sleep(wait);
  const now = await env.STORE.get("pchk", "json");
  if (!now || now.id !== c.id) return; // cancelled or replaced while waiting
  await env.STORE.delete("pchk");
  await pushAll(env, { title: "Reminder", body: "⏰ Your check-in is due", id: c.id });
}
