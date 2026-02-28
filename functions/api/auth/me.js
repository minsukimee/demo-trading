// functions/api/auth/me.js
import { getKV, getUsernameByToken, getUser, defaultState } from "../../utils.js";

export async function onRequestGet(context) {
  const kv = getKV(context);
  if (!kv) {
    return Response.json({ ok: false, error: "Cloudflare KV not configured. Please bind a KV namespace named BITGET_DEMO_KV." }, { status: 500 });
  }

  const auth = context.request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const token = auth.substring(7).trim();
  const username = await getUsernameByToken(kv, token);
  if (!username) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const user = await getUser(kv, username);
  if (!user) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  return Response.json({
    ok: true,
    username,
    state: user.state || defaultState,
  });
}
