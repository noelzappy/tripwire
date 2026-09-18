import { describe, expect, test } from "bun:test";
import { decide } from "../src/verdict.ts";
import { DEFAULT_POLICY, definePolicy } from "../src/policy.ts";
import type { Judgment } from "../src/judge/types.ts";

const clean: Judgment = {
  judge: "test", latencyMs: 1, inputTokens: 10,
  answers: {
    on_topic: { type: "boolean", probability: 0.95 },
    follows_system: { type: "score", score: 2.9 },
    pii_leak: { type: "boolean", probability: 0.02 },
    injection_complied: { type: "boolean", probability: 0.03 },
    tone: { type: "choice", choice: "professional" },
    hallucination_risk: { type: "score", score: 0.1 },
  },
  confidence: { on_topic: 0.9, follows_system: 0.9, pii_leak: 0.95, injection_complied: 0.9, tone: 0.9, hallucination_risk: 0.9 },
};

const withAnswer = (patch: Judgment["answers"], conf: Judgment["confidence"] = {}): Judgment => ({
  ...clean, answers: { ...clean.answers, ...patch }, confidence: { ...clean.confidence, ...conf },
});

describe("decide", () => {
  test("clean response passes", () => {
    expect(decide(clean, DEFAULT_POLICY).verdict).toBe("pass");
  });

  test("confident PII leak blocks", () => {
    const v = decide(withAnswer({ pii_leak: { type: "boolean", probability: 0.9 } }, { pii_leak: 0.95 }), DEFAULT_POLICY);
    expect(v.verdict).toBe("block");
    expect(v.reasons).toEqual(["pii_leak"]);
  });

  test("low-confidence hard check downgrades to flag, never suppresses", () => {
    const v = decide(withAnswer({ pii_leak: { type: "boolean", probability: 0.9 } }, { pii_leak: 0.4 }), DEFAULT_POLICY);
    expect(v.verdict).toBe("flag");
    expect(v.checks.pii_leak?.fired).toBe(true);
  });

  test("soft checks only flag", () => {
    const v = decide(withAnswer({ on_topic: { type: "boolean", probability: 0.1 }, hallucination_risk: { type: "score", score: 1.8 } }), DEFAULT_POLICY);
    expect(v.verdict).toBe("flag");
    expect(v.reasons.sort()).toEqual(["hallucination_risk", "on_topic"]);
  });

  test("rude tone flags, unsafe tone blocks", () => {
    expect(decide(withAnswer({ tone: { type: "choice", choice: "rude" } }), DEFAULT_POLICY).verdict).toBe("flag");
    expect(decide(withAnswer({ tone: { type: "choice", choice: "unsafe" } }), DEFAULT_POLICY).verdict).toBe("block");
  });

  test("forbidden category blocks; none passes", () => {
    const p = definePolicy({ forbiddenTopics: ["investment advice"] });
    expect(decide(withAnswer({ category: { type: "choice", choice: "investment advice" } }, { category: 0.9 }), p).verdict).toBe("block");
    expect(decide(withAnswer({ category: { type: "choice", choice: "none" } }, { category: 0.9 }), p).verdict).toBe("pass");
  });

  test("policy can demote a check to soft", () => {
    const p = definePolicy({ checks: { pii_leak: { severity: "soft" } } });
    const v = decide(withAnswer({ pii_leak: { type: "boolean", probability: 0.9 } }, { pii_leak: 0.99 }), p);
    expect(v.verdict).toBe("flag");
  });

  test("definePolicy rejects typos", () => {
    expect(() => definePolicy({ checks: { pii_leek: {} } as any })).toThrow(/unknown check/);
    expect(() => definePolicy({ onBlok: "replace" } as any)).toThrow(/unknown key/);
  });
});
