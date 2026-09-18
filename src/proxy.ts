#!/usr/bin/env bun
/**
 * OpenAI-compatible proxy. Point any client's baseURL here; requests are
 * forwarded to UPSTREAM_BASE_URL, the reply is judged, and a `tripwire` field
 * is added to the JSON. On block, policy.onBlock applies (replace | throw -> 451 | annotate).
 *
 * Streaming requests are served in buffer mode: we ask upstream for a
 * non-streamed reply, judge it, and emit it as SSE in one chunk. Clients that
 * stream keep working; they just don't see tokens early. v0.1 trade-off.
 *
 * Auth: with UPSTREAM_API_KEY set the proxy spends its own key, so it requires
 * TRIPWIRE_PROXY_KEY and every client must send it as its bearer token.
 * Without UPSTREAM_API_KEY the client's own Authorization header is forwarded.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { JsonlLog } from "./log.ts";
import { loadPolicy, DEFAULT_POLICY } from "./policy.ts";
import { Tripwire } from "./tripwire.ts";
import type { Exchange } from "./state.ts";
import type { Verdict } from "./verdict.ts";

export interface ProxyOptions {
  tripwire: Tripwire;
  /** e.g. https://api.openai.com/v1 */
  upstream: string;
  /** Key the proxy uses upstream. If set, `proxyKey` is required. */
  upstreamKey?: string;
  /** Bearer token clients must present. Only meaningful with `upstreamKey`. */
  proxyKey?: string;
}

type Msg = { role: string; content: string | { type: string; text?: string }[] | null };
const text = (c: Msg["content"]) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));

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

const RANK = { pass: 0, flag: 1, block: 2 } as const;
/** Most severe verdict across choices; null when nothing was judged. */
function worst(vs: (Verdict | null)[]): Verdict | null {
  return vs.reduce<Verdict | null>((w, v) => (v && (!w || RANK[v.verdict] > RANK[w.verdict]) ? v : w), null);
}

const digest = (s: string) => createHash("sha256").update(s).digest();
function bearerMatches(header: string | null, key: string): boolean {
  const got = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  return timingSafeEqual(digest(got), digest(key));
}

export function createProxy(o: ProxyOptions): (req: Request) => Promise<Response> {
  if (o.upstreamKey && !o.proxyKey) throw new Error("proxy: UPSTREAM_API_KEY is set, so TRIPWIRE_PROXY_KEY is required (otherwise anyone who can reach the proxy spends your key)");
  if (o.proxyKey && !o.upstreamKey) throw new Error("proxy: TRIPWIRE_PROXY_KEY requires UPSTREAM_API_KEY (the client's Authorization header carries the proxy key, not an upstream key)");
  const upstream = o.upstream.replace(/\/$/, "");
  const tw = o.tripwire;
  const policy = tw.policy;

  /** Client headers minus hop-specific ones, with our upstream key swapped in if we have one. */
  function upstreamHeaders(req: Request): Headers {
    const h = new Headers(req.headers);
    h.delete("host");
    h.delete("connection");
    if (o.upstreamKey) h.set("authorization", `Bearer ${o.upstreamKey}`);
    return h;
  }

  return async function fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, judge: tw.judge.name, policy: policy.name });
    if (o.proxyKey && !bearerMatches(req.headers.get("authorization"), o.proxyKey)) {
      return Response.json({ error: { type: "unauthorized", message: "missing or invalid proxy key" } }, { status: 401 });
    }

    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      const body = await req.json();
      const wantsStream = body.stream === true;
      const headers = upstreamHeaders(req);
      headers.set("content-type", "application/json");
      headers.delete("content-length");

      const up = await globalThis.fetch(`${upstream}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!up.ok) return new Response(await up.text(), { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "text/plain" } });

      const data = await up.json();
      const choices: any[] = data.choices ?? [];
      // One exchange per choice; choices with no text (tool calls only) are not judged.
      const exchanges = choices.map((c) => {
        const t = c.message?.content;
        return typeof t === "string" && t.trim() ? exchangeFromMessages(body.messages ?? [], t) : null;
      });

      let verdicts: (Verdict | null)[] = exchanges.map(() => null);
      if (policy.mode === "async") for (const x of exchanges) { if (x) tw.checkInBackground(x); }
      else verdicts = await Promise.all(exchanges.map((x) => (x ? tw.check(x) : null)));

      const overall = worst(verdicts);
      if (overall?.verdict === "block") {
        if (policy.onBlock === "throw") return Response.json({ error: { type: "tripwire_blocked", reasons: overall.reasons }, tripwire: overall }, { status: 451 });
        if (policy.onBlock === "replace") verdicts.forEach((v, i) => { if (v?.verdict === "block") choices[i].message.content = policy.blockMessage; });
      }
      if (choices.length > 1) choices.forEach((c, i) => { c.tripwire = verdicts[i]; });
      const out = { ...data, tripwire: overall };

      if (!wantsStream) return Response.json(out);
      // Single-chunk SSE so streaming clients keep working.
      const chunk = {
        id: data.id, object: "chat.completion.chunk", created: data.created, model: data.model,
        choices: choices.map((c: any) => ({
          index: c.index,
          delta: {
            role: "assistant",
            content: c.message.content,
            ...(c.message.tool_calls ? { tool_calls: c.message.tool_calls.map((t: any, i: number) => ({ index: i, ...t })) } : {}),
          },
          finish_reason: c.finish_reason,
        })),
        tripwire: overall,
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }

    // Anything else: passthrough, with the same auth handling as chat completions.
    const target = `${upstream}${url.pathname.replace(/^\/v1/, "")}${url.search}`;
    return globalThis.fetch(target, { method: req.method, headers: upstreamHeaders(req), body: req.body });
  };
}

if (import.meta.main) {
  const PORT = Number(process.env.PORT ?? 8787);
  const policy = process.env.TRIPWIRE_POLICY ? await loadPolicy(process.env.TRIPWIRE_POLICY) : DEFAULT_POLICY;
  const tw = new Tripwire({ policy, log: new JsonlLog(process.env.TRIPWIRE_LOG ?? "data/decisions.jsonl") });
  const upstream = process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com/v1";
  const fetch = createProxy({
    tripwire: tw,
    upstream,
    upstreamKey: process.env.UPSTREAM_API_KEY || undefined,
    proxyKey: process.env.TRIPWIRE_PROXY_KEY || undefined,
  });
  console.log(`[tripwire] proxy :${PORT} -> ${upstream} | judge=${tw.judge.name} policy=${policy.name} mode=${policy.mode} onBlock=${policy.onBlock}`);
  Bun.serve({ port: PORT, fetch });
}
