// functions/api/auth/register.js
import { getKV, getUser, saveUser, hashPassword, createSession, defaultState, randomHex, PASSWORD_ITERATIONS } from "../../utils.js";

export async function onRequestPost(context) {
  try {
    const kv = getKV(context);
    if (!kv) {
      return Response.json({ ok: false, error: "Cloudflare KV not configured. Please bind a KV namespace named BITGET_DEMO_KV." }, { status: 500 });
    }

    let body;
    try {
      body = await context.request.json();
    } catch (e) {
      return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }

    const { username, password } = body;
    if (!username || !password) {
      return Response.json({ ok: false, error: "Username and password required" }, { status: 400 });
    }

    if (username.length < 3 || username.length > 32 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
      return Response.json({ ok: false, error: "Invalid username format" }, { status: 400 });
    }

    if (password.length < 6) {
      return Response.json({ ok: false, error: "Password too short" }, { status: 400 });
    }

    const existing = await getUser(kv, username);
    if (existing) {
      return Response.json({ ok: false, error: "Username already exists" }, { status: 409 });
    }

    const salt = randomHex(16);
    const passwordHash = await hashPassword(password, salt, PASSWORD_ITERATIONS);

    const state = structuredClone(defaultState);
    const userData = {
      salt,
      passwordHash,
      iterations: PASSWORD_ITERATIONS,
      state,
    };

    await saveUser(kv, username, userData);
    const token = await createSession(kv, username);

    return Response.json({
      ok: true,
      username,
      token,
      state,
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: `Register failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
