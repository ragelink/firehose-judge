import questions from "../questions.json";

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: string };

export const QUESTIONS = questions as Record<string, Question>;

export type Answer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: string[]; probabilities: number[]; confidence: number }
  | { type: "noul"; noul: number };

export interface JevResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevConfig {
  url: string;
  model: string;
  apiKey: string;
}

export async function judge(cfg: JevConfig, state: string): Promise<JevResponse> {
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, state, questions: QUESTIONS }),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Nouls have no confidence field; distance from 0.5 is the natural equivalent.
export function confidenceOf(a: Answer): number {
  return a.type === "noul" ? Math.abs(a.noul - 0.5) * 2 : a.confidence;
}

// Any question the model would not commit to sends the post to the human-review lane.
// Scores legitimately land between two adjacent levels, so they get a much lower bar.
export const REVIEW_THRESHOLD: Record<Answer["type"], number> = { choice: 0.4, noul: 0.16, score: 0.1 };

// `nsfw` is a server-side filter, not a displayed judgment, so it never sends a post to review.
export function needsReview(answers: Record<string, Answer>): string[] {
  return Object.entries(answers)
    .filter(([k, a]) => k !== "nsfw" && confidenceOf(a) < REVIEW_THRESHOLD[a.type])
    .map(([k]) => k);
}
