// functions/api/auth/logout.js
import { getKV, deleteSession } from "../../utils.js";

export async function onRequestPost(context) {
  const kv = getKV(context);
  if (!kv) {
    return Response.json({ ok: false, error: "Cloudflare KV not configured. Please bind a KV namespace named BITGET_DEMO_KV." }, { status: 500 });
  }

  const auth = context.request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.substring(7).trim();
    if (token) {
      await deleteSession(kv, token);
    }
  }

  return Response.json({ ok: true });
}
