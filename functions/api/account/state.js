// functions/api/account/state.js
import { getKV, getUsernameByToken, getUser, saveUser, defaultState } from "../../utils.js";

function validateState(candidate) {
  if (!candidate || typeof candidate !== "object") return defaultState;
  const safe = { ...defaultState };
  if (typeof candidate.nextId === "number" && candidate.nextId > 0) {
    safe.nextId = Math.floor(candidate.nextId);
  }
  if (typeof candidate.nextAlertId === "number" && candidate.nextAlertId > 0) {
    safe.nextAlertId = Math.floor(candidate.nextAlertId);
  }
  if (typeof candidate.equityStart === "number" && candidate.equityStart > 0) {
    safe.equityStart = candidate.equityStart;
  }
  if (typeof candidate.realizedPnl === "number") {
    safe.realizedPnl = candidate.realizedPnl;
  }
  if (Array.isArray(candidate.positions)) {
    safe.positions = candidate.positions.slice(0, 3000);
  }
  if (Array.isArray(candidate.closed)) {
    safe.closed = candidate.closed.slice(0, 10000);
  }
  if (Array.isArray(candidate.alerts)) {
    safe.alerts = candidate.alerts.slice(0, 2000);
  }
  if (Array.isArray(candidate.alertHistory)) {
    safe.alertHistory = candidate.alertHistory.slice(0, 300);
  }
  return safe;
}

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
    state: user.state || defaultState,
  });
}

export async function onRequestPut(context) {
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

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const user = await getUser(kv, username);
  if (!user) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  user.state = validateState(body.state);
  await saveUser(kv, username, user);

  return Response.json({ ok: true });
}
