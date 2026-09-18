/**
 * The Judge abstraction. Everything above this file talks to a Judge, never to
 * TypeSafe directly, so the provider can be swapped (or mocked) in one place.
 * This module is written to be lifted into a shared `jevkit` package later.
 */

/** A judgment question, mirroring the AI SDK evaluation shape. */
export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: (string | null)[] }
  | { type: "boolean"; instructions: string; criteria?: { true?: string; false?: string } };

export type Questions = Record<string, Question>;

export type Answer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number };

export interface Judgment<Q extends Questions = Questions> {
  answers: { [K in keyof Q]: Answer };
  /** Provider confidence per question in [0, 1]. Distinct from probability. */
  confidence: { [K in keyof Q]: number };
  latencyMs: number;
  inputTokens: number;
  judge: string;
}

export interface Judge {
  readonly name: string;
  judge<Q extends Questions>(state: string, questions: Q): Promise<Judgment<Q>>;
}
