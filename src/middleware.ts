import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import type { Exchange } from "./state.ts";
import { Tripwire, TripwireBlockedError, type TripwireOptions } from "./tripwire.ts";
import type { Verdict } from "./verdict.ts";

/**
 * AI SDK middleware. Use with `wrapLanguageModel({ model, middleware: tripwire({...}) })`.
 *
 *   generate: judge the finished text; on block apply policy.onBlock.
 *   stream (passthrough): forward parts as they arrive, judge after the stream ends,
 *     on block append the block message as a final text part. The partial answer
 *     was already visible; this mode is for monitoring plus a visible notice.
 *   stream (buffer): hold every part until the stream ends and the judge returns,
 *     then release them (or the replacement). Loses streaming, keeps enforcement.
 *
 * The verdict is always attached at providerMetadata.tripwire.
 */
export function tripwire(opts: TripwireOptions | Tripwire = {}): LanguageModelV4Middleware {
  const tw = opts instanceof Tripwire ? opts : new Tripwire(opts);
  const policy = tw.policy;

  return {
    specificationVersion: "v4",

    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();
      const text = textOf(result.content);
      const exchange = exchangeFrom(params, text);

      if (policy.mode === "async") {
        void tw.check(exchange);
        return result;
      }
      const v = await tw.check(exchange);
      return applyVerdict(result, v, policy.onBlock, policy.blockMessage);
    },

    async wrapStream({ doStream, params }) {
      const { stream, ...rest } = await doStream();
      let text = "";
      const held: LanguageModelV4StreamPart[] = [];
      const buffer = policy.stream === "buffer" && policy.mode === "sync";

      const transform = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === "text-delta") text += part.delta;
          if (buffer) held.push(part);
          else controller.enqueue(part);
        },
        async flush(controller) {
          const exchange = exchangeFrom(params, text);
          if (policy.mode === "async") {
            void tw.check(exchange);
            return;
          }
          const v = await tw.check(exchange);
          const blocked = v.verdict === "block";

          if (buffer) {
            if (blocked && policy.onBlock === "throw") { controller.error(new TripwireBlockedError(v)); return; }
            if (blocked && policy.onBlock === "replace") {
              // Drop the model's text parts, emit the replacement, then everything else with finish last.
              const id = "tripwire-block";
              const finish = held.filter((p) => p.type === "finish");
              for (const p of held) if (!isTextPart(p) && p.type !== "finish") controller.enqueue(p);
              controller.enqueue({ type: "text-start", id });
              controller.enqueue({ type: "text-delta", id, delta: policy.blockMessage });
              controller.enqueue({ type: "text-end", id });
              for (const p of finish) { annotateFinish(p as any, v); controller.enqueue(p); }
              return;
            }
            for (const p of held) { if (p.type === "finish") annotateFinish(p, v); controller.enqueue(p); }
            return;
          }

          // passthrough: parts already went out. Append a notice on block; throw if asked.
          if (blocked && policy.onBlock === "throw") { controller.error(new TripwireBlockedError(v)); return; }
          if (blocked && policy.onBlock === "replace") {
            const id = "tripwire-block";
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: `\n\n${policy.blockMessage}` });
            controller.enqueue({ type: "text-end", id });
          }
        },
      });

      return { stream: stream.pipeThrough(transform), ...rest } satisfies LanguageModelV4StreamResult;
    },
  };
}

/* ------------------------------------------------------------------ helpers */

function textOf(content: LanguageModelV4Content[]): string {
  return content.filter((c): c is Extract<LanguageModelV4Content, { type: "text" }> => c.type === "text").map((c) => c.text).join("");
}

function isTextPart(p: LanguageModelV4StreamPart) {
  return p.type === "text-start" || p.type === "text-delta" || p.type === "text-end";
}

function annotateFinish(p: Extract<LanguageModelV4StreamPart, { type: "finish" }>, v: Verdict) {
  (p as any).providerMetadata = { ...(p as any).providerMetadata, tripwire: v as any };
}

/** Pull system prompt, history and the last user message out of the AI SDK prompt. */
export function exchangeFrom(params: LanguageModelV4CallOptions, response: string): Exchange {
  const systemPrompt = params.prompt.filter((m) => m.role === "system").map((m) => m.content as string).join("\n");
  const turns = params.prompt.filter((m) => m.role === "user" || m.role === "assistant");
  const lastUserIdx = turns.map((m) => m.role).lastIndexOf("user");
  const history = turns.slice(0, Math.max(0, lastUserIdx)).map((m) => ({ role: m.role as "user" | "assistant", text: partsText(m.content as any[]) }));
  const userMessage = lastUserIdx >= 0 ? partsText(turns[lastUserIdx]!.content as any[]) : "";
  return { systemPrompt, history, userMessage, response };
}

function partsText(parts: any[]): string {
  return parts.filter((p) => p?.type === "text").map((p) => p.text).join("");
}

function applyVerdict(result: LanguageModelV4GenerateResult, v: Verdict, onBlock: "replace" | "throw" | "annotate", blockMessage: string): LanguageModelV4GenerateResult {
  const annotated: LanguageModelV4GenerateResult = { ...result, providerMetadata: { ...result.providerMetadata, tripwire: v as any } };
  if (v.verdict !== "block" || onBlock === "annotate") return annotated;
  if (onBlock === "throw") throw new TripwireBlockedError(v);
  return { ...annotated, content: [...result.content.filter((c) => c.type !== "text"), { type: "text", text: blockMessage }] };
}
