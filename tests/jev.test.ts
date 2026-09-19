import { describe, it, expect } from "vitest";
import { confidenceOf, needsReview, REVIEW_THRESHOLD, QUESTIONS, type Answer } from "../src/jev";

// judge() is left alone on purpose: it needs the network, and the retry path around it
// is the one part of this module that is not pure.

const choice = (confidence: number): Answer => ({ type: "choice", choice: "opine", probabilities: { opine: confidence }, confidence });
const score = (confidence: number): Answer => ({ type: "score", score: 2, legend: ["a", "b"], probabilities: [0.5, 0.5], confidence });
const noul = (n: number): Answer => ({ type: "noul", noul: n });

describe("confidenceOf", () => {
  it("passes through the reported confidence of a choice or a score", () => {
    expect(confidenceOf(choice(0.87))).toBe(0.87);
    expect(confidenceOf(score(0.12))).toBe(0.12);
  });

  it("reads a noul as its distance from the coin flip", () => {
    expect(confidenceOf(noul(0.5))).toBe(0);
    expect(confidenceOf(noul(1))).toBe(1);
    expect(confidenceOf(noul(0))).toBe(1);
    expect(confidenceOf(noul(0.75))).toBeCloseTo(0.5, 10);
    expect(confidenceOf(noul(0.25))).toBeCloseTo(0.5, 10);
  });
});

describe("REVIEW_THRESHOLD", () => {
  it("gives scores a lower bar than choices", () => {
    expect(REVIEW_THRESHOLD).toEqual({ choice: 0.4, noul: 0.16, score: 0.1 });
    expect(REVIEW_THRESHOLD.score).toBeLessThan(REVIEW_THRESHOLD.choice);
  });
});

describe("needsReview", () => {
  it("passes a post where every answer clears its bar", () => {
    expect(needsReview({ intent: choice(0.9), sentiment: score(0.4), bot: noul(0.95) })).toEqual([]);
  });

  it("names every question the model would not commit to", () => {
    const flagged = needsReview({ intent: choice(0.2), topic: choice(0.85), sentiment: score(0.05), sarcasm: noul(0.52) });
    expect(flagged).toEqual(["intent", "sentiment", "sarcasm"]);
  });

  it("holds each answer type to its own threshold", () => {
    expect(needsReview({ a: choice(0.39), b: score(0.39), c: noul(0.8) })).toEqual(["a"]);
    expect(needsReview({ a: choice(0.41) })).toEqual([]);
    expect(needsReview({ a: score(0.09) })).toEqual(["a"]);
    expect(needsReview({ a: noul(0.55) })).toEqual(["a"]);   // 0.1 of confidence, under 0.16
    expect(needsReview({ a: noul(0.6) })).toEqual([]);       // 0.2 of confidence, over it
  });

  it("never sends a post to review over nsfw, however unsure the model is", () => {
    expect(needsReview({ nsfw: noul(0.5) })).toEqual([]);
    expect(needsReview({ nsfw: noul(0.5), hostile: noul(0.5) })).toEqual(["hostile"]);
  });

  it("handles a post with no answers at all", () => {
    expect(needsReview({})).toEqual([]);
  });
});

describe("QUESTIONS", () => {
  it("loads the question sheet from JSON", () => {
    expect(Object.keys(QUESTIONS).length).toBeGreaterThan(0);
    for (const [name, q] of Object.entries(QUESTIONS)) {
      expect(["choice", "score", "noul"], name).toContain(q.type);
      expect(q.instructions.length, name).toBeGreaterThan(0);
    }
  });

  it("keeps the one name the server-side drop depends on", () => {
    expect(QUESTIONS.nsfw).toBeDefined();
    expect(QUESTIONS.nsfw.type).toBe("noul");
  });

  it("gives every threshold a question type that exists in the sheet", () => {
    const used = new Set(Object.values(QUESTIONS).map((q) => q.type));
    for (const type of used) expect(REVIEW_THRESHOLD[type]).toBeGreaterThan(0);
  });
});
