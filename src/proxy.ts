/**
 * OpenAI-compatible proxy. Point any client's baseURL here; requests are
 * forwarded to UPSTREAM_BASE_URL, the reply is judged, and a `tripwire` field
 * is added to the JSON. On block, policy.onBlock applies (replace | throw -> 451 | annotate).
 *
 * Streaming requests are served in buffer mode: we ask upstream for a
 * non-streamed reply, judge it, and emit it as SSE in one chunk. Clients that
 * stream keep working; they just don't see tokens early. v0.1 trade-off.
 */
import { JsonlLog } from "./log.ts";
import { loadPolicy, DEFAULT_POLICY } from "./policy.ts";
import { Tripwire } from "./tripwire.ts";
import type { Exchange } from "./state.ts";

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = (process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY;

const policy = process.env.TRIPWIRE_POLICY ? await loadPolicy(process.env.TRIPWIRE_POLICY) : DEFAULT_POLICY;
const tw = new Tripwire({ policy, log: new JsonlLog(process.env.TRIPWIRE_LOG ?? "data/decisions.jsonl") });
console.log(`[tripwire] proxy :${PORT} -> ${UPSTREAM} | judge=${tw.judge.name} policy=${policy.name} mode=${policy.mode} onBlock=${policy.onBlock}`);

type Msg = { role: string; content: string | { type: string; text?: string }[] };
const text = (c: Msg["content"]) => (typeof c === "string" ? c : c.map((p) => p.text ?? "").join(""));

function exchangeFromMessages(messages: Msg[], response: string): Exchange {
  const systemPrompt = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n");
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const last = turns.map((m) => m.role).lastIndexOf("user");
  return {
    systemPrompt,
    history: turns.slice(0, Math.max(0, last)).map((m) => ({ role: m.role as "user" | "assistant", text: text(m.content) })),
    userMessage: last >= 0 ? text(turns[last]!.content) : "",
    response,
  };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, judge: tw.judge.name, policy: policy.name });

    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      const body = await req.json();
      const wantsStream = body.stream === true;
      const auth = UPSTREAM_KEY ? `Bearer ${UPSTREAM_KEY}` : req.headers.get("authorization") ?? "";

      const up = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!up.ok) return new Response(await up.text(), { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "text/plain" } });

      const data = await up.json();
      const content: string = data.choices?.[0]?.message?.content ?? "";
      const exchange = exchangeFromMessages(body.messages ?? [], content);

      let verdict = null;
      if (policy.mode === "async") void tw.check(exchange);
      else {
        verdict = await tw.check(exchange);
        if (verdict.verdict === "block") {
          if (policy.onBlock === "throw") return Response.json({ error: { type: "tripwire_blocked", reasons: verdict.reasons }, tripwire: verdict }, { status: 451 });
          if (policy.onBlock === "replace") for (const c of data.choices ?? []) c.message.content = policy.blockMessage;
        }
      }
      const out = { ...data, tripwire: verdict };

      if (!wantsStream) return Response.json(out);
      // Single-chunk SSE so streaming clients keep working.
      const chunk = {
        id: data.id, object: "chat.completion.chunk", created: data.created, model: data.model,
        choices: (out.choices ?? []).map((c: any) => ({ index: c.index, delta: { role: "assistant", content: c.message.content }, finish_reason: c.finish_reason })),
        tripwire: verdict,
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }

    // Anything else: transparent passthrough.
    const target = `${UPSTREAM}${url.pathname.replace(/^\/v1/, "")}${url.search}`;
    return fetch(target, { method: req.method, headers: req.headers, body: req.body });
  },
});
