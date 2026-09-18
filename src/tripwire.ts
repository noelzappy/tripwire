import { buildQuestions } from "./checks.ts";
import { JevJudge } from "./judge/jev.ts";
import { MockJudge } from "./judge/mock.ts";
import type { Judge } from "./judge/types.ts";
import { hashState, noopLog, type DecisionLog, type DecisionRecord } from "./log.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import { buildState, DEFAULT_BUDGET, type Exchange, type StateBudget } from "./state.ts";
import { decide, type Verdict } from "./verdict.ts";

export interface TripwireOptions {
  policy?: Policy;
  judge?: Judge;
  log?: DecisionLog;
  budget?: StateBudget;
  /** Store user message and response bodies in the log. Off by default: the log should be PII-free. */
  storeBodies?: boolean;
  onVerdict?: (v: Verdict, x: Exchange) => void;
  /** Called when the judge itself fails. Default: log to stderr and return a `flag` verdict (fail-open). */
  onJudgeError?: (err: unknown, x: Exchange) => Verdict | void;
}

export class TripwireBlockedError extends Error {
  constructor(public verdict: Verdict) {
    super(`tripwire blocked response: ${verdict.reasons.join(", ")}`);
    this.name = "TripwireBlockedError";
  }
}

/** The core: judge one exchange, log it, return a verdict. Middleware and proxy are thin wrappers. */
export class Tripwire {
  readonly policy: Policy;
  readonly judge: Judge;
  private log: DecisionLog;
  private budget: StateBudget;
  private questions;
  private opts: TripwireOptions;

  constructor(opts: TripwireOptions = {}) {
    this.opts = opts;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.judge = opts.judge ?? defaultJudge();
    this.log = opts.log ?? noopLog;
    this.budget = opts.budget ?? DEFAULT_BUDGET;
    this.questions = buildQuestions(this.policy);
  }

  async check(x: Exchange): Promise<Verdict> {
    const exchange = { ...x, forbiddenTopics: x.forbiddenTopics ?? this.policy.forbiddenTopics };
    const state = buildState(exchange, this.budget);
    let verdict: Verdict;
    try {
      const j = await this.judge.judge(state, this.questions);
      verdict = decide(j, this.policy);
    } catch (err) {
      const v = this.opts.onJudgeError?.(err, exchange);
      if (v) verdict = v;
      else {
        console.error("[tripwire] judge failed, failing open with flag:", err instanceof Error ? err.message : err);
        verdict = { verdict: "flag", checks: {}, reasons: [], judge: this.judge.name, latencyMs: 0, inputTokens: 0 };
      }
    }
    const rec: DecisionRecord = {
      ts: new Date().toISOString(),
      id: crypto.randomUUID(),
      judge: verdict.judge,
      policy: this.policy.name,
      verdict: verdict.verdict,
      checks: verdict.checks,
      latencyMs: Math.round(verdict.latencyMs),
      inputTokens: verdict.inputTokens,
      stateHash: hashState(state),
      ...(this.opts.storeBodies ? { bodies: { userMessage: exchange.userMessage, response: exchange.response } } : {}),
    };
    // The log and onVerdict are telemetry: their failures are reported, never allowed to break the response.
    try { this.log.write(rec); } catch (err) { report("decision log write failed", err); }
    try { this.opts.onVerdict?.(verdict, exchange); } catch (err) { report("onVerdict threw", err); }
    return verdict;
  }

  /** Fire-and-forget check for async mode. Anything that escapes check() (e.g. a throwing onJudgeError) is reported, not left unhandled. */
  checkInBackground(x: Exchange): void {
    this.check(x).catch((err) => report("background check failed", err));
  }
}

function report(what: string, err: unknown) {
  console.error(`[tripwire] ${what}:`, err instanceof Error ? err.message : err);
}

/** Jev when a key is present or TRIPWIRE_JUDGE=jev, otherwise the mock, loudly. */
export function defaultJudge(): Judge {
  const want = process.env.TRIPWIRE_JUDGE ?? (process.env.TYPESAFE_AI_API_KEY ? "jev" : "mock");
  if (want === "jev") {
    if (!process.env.TYPESAFE_AI_API_KEY) throw new Error("TRIPWIRE_JUDGE=jev but TYPESAFE_AI_API_KEY is not set");
    return new JevJudge();
  }
  console.warn("[tripwire] using MOCK judge (regex heuristics). Set TYPESAFE_AI_API_KEY for Jev.");
  return new MockJudge();
}
