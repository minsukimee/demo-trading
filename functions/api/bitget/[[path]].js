export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const prefix = "/api/bitget";
  const endpoint = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  if (!endpoint) {
    return Response.json({ ok: false, error: "Missing endpoint" }, { status: 400 });
  }

  const upstream = new URL(`https://api.bitget.com${endpoint}`);
  upstream.search = url.search;

  try {
    const resp = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "demo-trading-cloudflare/1.0"
      }
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: "Bitget request failed", details: String(err) },
      { status: 502 }
    );
  }
}
