import { getKV, getUsernameByToken } from "../../utils.js";

export async function onRequestPost(context) {
  try {
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

    const botToken = context.env.TELEGRAM_BOT_TOKEN;
    const chatId = context.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) {
      return Response.json(
        { ok: false, error: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Pages environment variables." },
        { status: 500 }
      );
    }

    let body;
    try {
      body = await context.request.json();
    } catch (_) {
      return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
    }
    const text = String(body?.text || "").trim();
    if (!text) {
      return Response.json({ ok: false, error: "Message text is required" }, { status: 400 });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const tgJson = await tgRes.json().catch(() => null);
    if (!tgRes.ok || !tgJson?.ok) {
      return Response.json(
        { ok: false, error: `Telegram send failed (${tgRes.status})`, details: tgJson || null },
        { status: 502 }
      );
    }
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: `Notify failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
