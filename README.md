# tripwire

[![npm](https://img.shields.io/npm/v/@noelzappy/tripwire)](https://www.npmjs.com/package/@noelzappy/tripwire) [![ci](https://github.com/noelzappy/tripwire/actions/workflows/ci.yml/badge.svg)](https://github.com/noelzappy/tripwire/actions/workflows/ci.yml)

Judge every LLM response before the user sees it. Seven checks in one ~100 ms call to [TypeSafe's Jev](https://typesafe.ai), cheap enough to run on 100% of traffic instead of sampling 1% with a frontier judge.

- **AI SDK middleware**: `wrapLanguageModel({ model, middleware: tripwire(...) })`. Zero infra.
- **OpenAI-compatible proxy**: point any client's `baseURL` at it.
- **Policy as YAML**: which checks run, how confident Jev must be, what a block does.
- **Confidence-gated**: a check that fires with high confidence blocks; low confidence downgrades to flag, never suppresses.
- **Decision log** that is PII-free by default and doubles as your labelling dataset.
- **Eval CLI** that prints per-check precision/recall and coverage at each threshold. Run it before you trust anything.

## Status

v0.1. Middleware and proxy work end to end (29 tests, mock judge). **No accuracy numbers against real Jev yet.** The eval harness and a 27-item seed set exist so the first real run is one command. Do not put this in front of users until that run shows block precision above 95% on your own data.

## Install

```sh
npm install @noelzappy/tripwire ai     
# or: bun add @noelzappy/tripwire ai
```

The library runs on Node 20+ and Bun. The proxy server needs Bun. `ai` (v7) is a peer dependency, so tripwire uses the same copy as your app.

## Develop

```sh
bun install
cp .env.example .env     # add TYPESAFE_AI_API_KEY, or leave empty for the mock judge
bun test
bun run eval             # replay eval/dataset.jsonl through the judge
```

### Middleware

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, wrapLanguageModel } from "ai";
import { tripwire, definePolicy, JsonlLog } from "@noelzappy/tripwire";

const policy = definePolicy({
  name: "support-bot",
  purpose: "Help customers with the Acme banking app",
  forbiddenTopics: ["investment advice", "competitor products"],
  onBlock: "replace",           // replace | throw | annotate
  mode: "sync",                 // sync | async (judge in background, never alter the response)
  stream: "passthrough",        // passthrough | buffer
});

const model = wrapLanguageModel({
  model: anthropic("claude-sonnet-5"),
  middleware: tripwire({ policy, log: new JsonlLog("data/decisions.jsonl") }),
});

const r = await generateText({ model, system: SYSTEM, prompt: userMessage });
r.text;                                  // replaced with policy.blockMessage on block
r.providerMetadata.tripwire;             // { verdict, checks, reasons, latencyMs, ... }
```

### Proxy

```sh
UPSTREAM_BASE_URL=https://api.openai.com/v1 TRIPWIRE_POLICY=policies/default.yaml bun run proxy
# or, without cloning: bunx --package @noelzappy/tripwire tripwire-proxy
# then: OPENAI_BASE_URL=http://localhost:8787/v1
```

The JSON reply gains a `tripwire` field. On block: `replace` swaps the content, `throw` returns HTTP 451 with the verdict, `annotate` leaves it. Streaming requests are served as a single SSE chunk after judging (v0.1 trade-off; token-level streaming through the proxy is on the list).

Every choice is judged. With `n > 1`, each choice carries its own `tripwire` verdict, only blocked choices are replaced, and the top-level `tripwire` is the most severe one. Choices with no text (tool calls only) are not judged; their `tripwire` is `null`.

**Auth.** By default the proxy forwards the client's own `Authorization` header upstream, so it holds no secrets. If you set `UPSTREAM_API_KEY` so the proxy spends its own key, you must also set `TRIPWIRE_PROXY_KEY`; clients then send `Authorization: Bearer $TRIPWIRE_PROXY_KEY` and anything else gets a 401. The proxy refuses to start with an upstream key and no proxy key. `/health` is always open. To embed the handler in your own server, use `createProxy({ tripwire, upstream, upstreamKey, proxyKey })`.

### Example

[`examples/support-bot`](examples/support-bot) is a small AI SDK support bot with tripwire in front of it. It runs offline with a scripted model and the mock judge (`cd examples/support-bot && bun install && bun start`), and switches to Claude and Jev when you set their keys.

## The checks

| Check | Jev primitive | Fires when | Default severity |
| --- | --- | --- | --- |
| `pii_leak` | boolean | response reveals personal data the user did not supply | hard |
| `injection_complied` | boolean | response obeys instructions injected via user content | hard |
| `tone` | choice | `unsafe` (hard) or `rude` (always soft) | hard |
| `category` | choice | response discusses a `forbiddenTopics` entry | hard |
| `on_topic` | boolean | P(on topic) < 0.5 | soft |
| `follows_system` | score 0–3 | score < 2 | soft |
| `hallucination_risk` | score 0–2 | score ≥ 1 (unsupported specifics) | soft |

Verdict: **block** if any hard check fires with confidence ≥ its threshold; **flag** if a hard check fires below threshold or any soft check fires; **pass** otherwise. Question wording lives in `src/checks.ts`; it is the whole "model" as far as Jev is concerned, so changes there need an eval run.

## Policy file

```yaml
name: support-bot
purpose: Answer questions about the Acme banking app
forbiddenTopics: [investment advice, competitor products]
checks:
  pii_leak:           { severity: hard, threshold: 0.85 }
  injection_complied: { severity: hard, threshold: 0.80 }
  hallucination_risk: { severity: soft, threshold: 0.80 }
onBlock: replace
blockMessage: "I can't share that response."
mode: sync
stream: passthrough
```

Unknown keys and check names throw at load time. Thresholds are per check and should be tuned from the decision log, not guessed.

## Streaming semantics

- `passthrough` (default): tokens stream to the user unchanged; the judge runs when the stream ends. On block, the block message is appended as a final text part. The user has already seen the response; this mode is monitoring plus a visible notice.
- `buffer`: every part is held until the stream ends and the judge returns, then released (or replaced). Enforcement at the cost of streaming.
- `mode: async`: return immediately, judge in the background, log and call `onVerdict`. Most teams should start here.

## Failure behaviour

If Jev is unreachable or errors, tripwire **fails open**: the response goes through with `verdict: "flag"` and an empty `checks` map, and the error is logged. Override with `onJudgeError` if you want fail-closed; in sync mode an error thrown from it propagates to the caller.

The decision log and `onVerdict` are telemetry: if either throws, the error goes to stderr and the response is unaffected. In async mode nothing the background check does can surface as an unhandled rejection; failures are reported to stderr.

## Eval

```sh
bun run eval                                    # eval/dataset.jsonl, judge from env
bun run eval path/to/your.jsonl --judge=jev --policy=policies/default.yaml
```

Prints per-check tp/fp/fn, a verdict confusion matrix, block precision/recall, the count of expected blocks that passed (the number that matters), and hard-check coverage at thresholds 0.6–0.95 so you can pick `threshold` per check from data. Dataset rows:

```json
{"system": "...", "user": "...", "response": "...", "labels": {"pii_leak": true, "tone": false}, "expected": "block"}
```

Regenerate the seed set from `eval/build-seed.ts`. Replace it with 300–500 rows from your own logs before drawing conclusions.

## Decision log

One JSONL line per judged response: timestamp, judge, policy, verdict, every check's fired/confidence/value, latency, input tokens, and a hash of the state. Message bodies are **not** stored unless `storeBodies: true`. Add a `label` field to rows as humans review them and the log becomes your eval set.

## Layout

```
src/judge/types.ts   Judge interface (lift into a shared package later)
src/judge/jev.ts     TypeSafe Jev via @ai-sdk/typesafe-ai
src/judge/mock.ts    deterministic regex stand-in for tests and dry runs
src/state.ts         builds the judged text within Jev's ~32k token budget
src/checks.ts        policy -> Jev questions
src/verdict.ts       answers + confidence -> pass | flag | block
src/policy.ts        schema, defaults, YAML loader
src/tripwire.ts      core: check(exchange) -> verdict, logging, fail-open
src/middleware.ts    AI SDK LanguageModelV4Middleware
src/proxy.ts         OpenAI-compatible proxy: createProxy() handler, Bun.serve when run directly
eval/run.ts          eval CLI
examples/            runnable example projects
test/node-smoke.mjs  imports the built dist/ under plain Node
```

`bun run build` compiles `src/` to `dist/` (ESM + `.d.ts`) for npm. The `source` export condition points at `src/index.ts`, which the in-repo example and typecheck use so they don't need a build.

## Known limits

- Jev sees text only; `hallucination_risk` is a heuristic about unsupported specifics, not fact-checking.
- Responses with no text (tool-call-only turns) are not judged, in the middleware or the proxy; tool-call arguments are not inspected.
- Prompt-injection detection is adversarial. This is one layer.
- ~32k token state budget; long system prompts and histories are trimmed (oldest first).
- Jev launched 15 Sep 2026 and is in early access; its API, limits and pricing can change. Everything provider-specific is behind `Judge`.

MIT.
