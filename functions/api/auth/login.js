// functions/api/auth/login.js
import { getKV, getUser, hashPassword, createSession, defaultState } from "../../utils.js";

export async function onRequestPost(context) {
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

  const user = await getUser(kv, username);
  if (!user) {
    return Response.json({ ok: false, error: "Invalid username or password" }, { status: 401 });
  }

  const { salt, passwordHash } = user;
  const gotHash = await hashPassword(password, salt);

  if (gotHash !== passwordHash) {
    return Response.json({ ok: false, error: "Invalid username or password" }, { status: 401 });
  }

  const token = await createSession(kv, username);
  const userState = user.state || defaultState;

  return Response.json({
    ok: true,
    username,
    token,
    state: userState,
  });
}
