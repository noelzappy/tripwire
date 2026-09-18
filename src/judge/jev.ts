import { experimental_evaluate } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import type { Judge, Judgment, Questions } from "./types.ts";

export interface JevJudgeOptions {
  apiKey?: string;
  modelId?: string;
  baseURL?: string;
  /** Retries for transient failures. Default 0: a slow guardrail is a broken guardrail. */
  maxRetries?: number;
}

/** TypeSafe Jev through the AI SDK provider. One request, all questions in parallel. */
export class JevJudge implements Judge {
  readonly name: string;
  private model;
  private maxRetries: number;

  constructor(opts: JevJudgeOptions = {}) {
    const provider = createTypeSafeAi({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    const id = opts.modelId ?? "jev-latest";
    this.model = provider.evaluationModel(id);
    this.name = `jev:${id}`;
    this.maxRetries = opts.maxRetries ?? 0;
  }

  async judge<Q extends Questions>(state: string, questions: Q): Promise<Judgment<Q>> {
    const t0 = performance.now();
    const r = await experimental_evaluate({
      model: this.model,
      state,
      questions: questions as any,
      maxRetries: this.maxRetries,
    });
    const conf = ((r.providerMetadata as any)?.typesafe?.confidence ?? {}) as Record<string, number>;
    const confidence = {} as Judgment<Q>["confidence"];
    for (const k of Object.keys(questions) as (keyof Q)[]) {
      // If the provider omits confidence, fall back to the answer's own peak probability.
      confidence[k] = typeof conf[k as string] === "number" ? conf[k as string]! : peak(r.answers[k as string]);
    }
    return {
      answers: r.answers as Judgment<Q>["answers"],
      confidence,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
      judge: this.name,
    };
  }
}

function peak(a: any): number {
  if (!a) return 0;
  if (a.type === "boolean") return Math.max(a.probability, 1 - a.probability);
  const p = a.probabilities ? (Object.values(a.probabilities) as number[]) : [];
  return p.length ? Math.max(...p) : 1;
}
