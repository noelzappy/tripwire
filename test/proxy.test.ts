import { afterAll, describe, expect, test } from "bun:test";
import { MockJudge } from "../src/judge/mock.ts";
import { MemoryLog } from "../src/log.ts";
import { definePolicy, type PolicyInput } from "../src/policy.ts";
import { createProxy } from "../src/proxy.ts";
import { Tripwire } from "../src/tripwire.ts";

const LEAKY = "The other customer's number is +233 24 555 0199.";
const CLEAN = "You can reset your PIN from Settings > Security.";

/** Fake upstream that records what it received and replies with the queued choices. */
let reply: any[] = [];
const seen: { path: string; auth: string | null }[] = [];
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ path: url.pathname, auth: req.headers.get("authorization") });
    if (url.pathname === "/chat/completions") return Response.json({ id: "c1", created: 1, model: "m", choices: reply });
    return Response.json({ data: [] });
  },
});
afterAll(() => upstream.stop());

const msg = (content: string | null, extra: any = {}) => ({ message: { role: "assistant", content, ...extra }, finish_reason: "stop" });
const choices = (...cs: any[]) => cs.map((c, index) => ({ index, ...c }));

function proxy(policy: PolicyInput = {}, keys: { upstreamKey?: string; proxyKey?: string } = {}) {
  const log = new MemoryLog();
  const tw = new Tripwire({ judge: new MockJudge(undefined, 0), log, policy: definePolicy({ blockMessage: "[blocked]", ...policy }) });
  return { log, handle: createProxy({ tripwire: tw, upstream: upstream.url.href, ...keys }) };
}

const chat = (auth?: string, extra: any = {}) =>
  new Request("http://proxy/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], ...extra }),
  });

describe("proxy auth", () => {
  test("refuses to start with an upstream key but no proxy key", () => {
    expect(() => proxy({}, { upstreamKey: "sk-up" })).toThrow(/TRIPWIRE_PROXY_KEY is required/);
  });

  test("rejects a missing or wrong proxy key", async () => {
    reply = choices(msg(CLEAN));
    const { handle } = proxy({}, { upstreamKey: "sk-up", proxyKey: "pk" });
    expect((await handle(chat())).status).toBe(401);
    expect((await handle(chat("Bearer nope"))).status).toBe(401);
  });

  test("accepts the proxy key and spends the upstream key, on every route", async () => {
    reply = choices(msg(CLEAN));
    const { handle } = proxy({}, { upstreamKey: "sk-up", proxyKey: "pk" });
    seen.length = 0;
    expect((await handle(chat("Bearer pk"))).status).toBe(200);
    expect((await handle(new Request("http://proxy/v1/models", { headers: { authorization: "Bearer pk" } }))).status).toBe(200);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer sk-up", "Bearer sk-up"]);
  });

  test("without keys, forwards the client's own Authorization", async () => {
    reply = choices(msg(CLEAN));
    const { handle } = proxy();
    seen.length = 0;
    await handle(new Request("http://proxy/v1/models", { headers: { authorization: "Bearer client" } }));
    expect(seen[0]!.auth).toBe("Bearer client");
  });
});

describe("proxy judging", () => {
  test("judges every choice and replaces only the blocked one", async () => {
    reply = choices(msg(CLEAN), msg(LEAKY));
    const { handle, log } = proxy();
    const out: any = await (await handle(chat())).json();
    expect(out.choices[0].message.content).toBe(CLEAN);
    expect(out.choices[1].message.content).toBe("[blocked]");
    expect(out.choices.map((c: any) => c.tripwire.verdict)).toEqual(["pass", "block"]);
    expect(out.tripwire.verdict).toBe("block");
    expect(log.records).toHaveLength(2);
  });

  test("tool-call-only replies are not judged and keep their tool calls when streamed", async () => {
    const call = { id: "t1", type: "function", function: { name: "lookup", arguments: "{}" } };
    reply = choices(msg(null, { tool_calls: [call] }));
    const { handle, log } = proxy();
    const sse = await (await handle(chat(undefined, { stream: true }))).text();
    const chunk = JSON.parse(sse.split("\n")[0]!.slice("data: ".length));
    expect(chunk.tripwire).toBeNull();
    expect(chunk.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, id: "t1" });
    expect(log.records).toHaveLength(0);
  });

  test("onBlock: throw returns 451", async () => {
    reply = choices(msg(LEAKY));
    const { handle } = proxy({ onBlock: "throw" });
    expect((await handle(chat())).status).toBe(451);
  });
});
