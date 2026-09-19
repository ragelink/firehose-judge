import { describe, it, expect } from "vitest";
import { detectAlerts, recentAlerts, type Alert, type AlertInput } from "../src/alerts";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = 1_750_000_000_000;

type Row = { id: number; ts: number; kind: string; key: string; text: string };

// Stand-in for the DO's SqlStorage: only the statements alerts.ts issues need to work.
function fakeSql() {
  const rows: Row[] = [];
  const cursor = (out: unknown[]) => ({ toArray: () => out });
  const exec = (query: string, ...p: any[]) => {
    if (query.startsWith("CREATE TABLE")) return cursor([]);
    if (query.startsWith("SELECT MAX(ts)")) return cursor([{ ts: rows.length ? Math.max(...rows.map((r) => r.ts)) : null }]);
    if (query.startsWith("SELECT key, MAX(ts)")) {
      const last = new Map<string, number>();
      for (const r of rows) if (r.ts >= p[0]) last.set(r.key, Math.max(last.get(r.key) ?? 0, r.ts));
      return cursor([...last].map(([key, ts]) => ({ key, ts })));
    }
    if (query.startsWith("INSERT INTO alerts")) {
      const row: Row = { id: rows.length + 1, ts: p[0], kind: p[1], key: p[2], text: p[3] };
      rows.push(row);
      return cursor([{ id: row.id }]);
    }
    if (query.startsWith("SELECT id, ts, kind")) return cursor([...rows].sort((a, b) => b.id - a.id).slice(0, p[0]));
    throw new Error(`unexpected query: ${query}`);
  };
  return { sql: { exec } as unknown as SqlStorage, rows };
}

type Gauge = { now: number | null; base: number | null; n: number };

function input(at: number, over: Partial<AlertInput> = {}): AlertInput {
  return { at, terms: [], baro: {}, series: [], ...over };
}

function term(t: string, hot = 42, burst = 12.4) {
  return { t, hot, base: hot * 4, burst };
}

const hostile = (over: Partial<Gauge> = {}): Record<string, Gauge> => ({ hostile: { now: 0.41, base: 0.22, n: 40, ...over } });
const mood = (over: Partial<Gauge> = {}): Record<string, Gauge> => ({ sentiment: { now: 0.38, base: 0.53, n: 40, ...over } });

const one = (a: Alert[]): Alert => {
  expect(a).toHaveLength(1);
  return a[0];
};

describe("term burst", () => {
  it("records the surging term with counts and multiple", () => {
    const { sql, rows } = fakeSql();
    const a = one(detectAlerts(sql, input(T0, { terms: [term("climate")] })));
    expect(a).toEqual({ id: 1, ts: T0, kind: "burst", key: "climate", text: `"climate" is surging: 42 mentions in 15 min, 12× normal.` });
    expect(rows).toHaveLength(1);
  });

  it("fires exactly at both thresholds", () => {
    const { sql } = fakeSql();
    const a = one(detectAlerts(sql, input(T0, { terms: [term("budget", 8, 10)] })));
    expect(a.text).toBe(`"budget" is surging: 8 mentions in 15 min, 10× normal.`);
  });

  it("stays quiet one step under either threshold", () => {
    expect(detectAlerts(fakeSql().sql, input(T0, { terms: [term("budget", 7, 10)] }))).toEqual([]);
    expect(detectAlerts(fakeSql().sql, input(T0, { terms: [term("budget", 8, 9.9)] }))).toEqual([]);
  });

  it("takes the first qualifying term, which is the busiest", () => {
    const { sql } = fakeSql();
    const a = one(detectAlerts(sql, input(T0, { terms: [term("quiet", 4, 40), term("climate", 42, 12), term("budget", 30, 11)] })));
    expect(a.key).toBe("climate");
  });

  it("truncates a long term and keeps the text within 280 characters", () => {
    const { sql } = fakeSql();
    const long = "x".repeat(400);
    const a = one(detectAlerts(sql, input(T0, { terms: [term(long)] })));
    expect(a.text.length).toBeLessThanOrEqual(280);
    expect(a.text).not.toContain(long);
    // the term is what gets clipped, so the rest of the line still reads
    expect(a.text).toMatch(/^"x+…" is surging: 42 mentions in 15 min, 12× normal\.$/);
    expect(a.key).toBe(long); // the full term is the cooldown key, only the prose is clipped
  });
});

describe("hostility spike", () => {
  it("records the jump against the 24h average", () => {
    const { sql } = fakeSql();
    const a = one(detectAlerts(sql, input(T0, { baro: hostile() })));
    expect(a).toEqual({ id: 1, ts: T0, kind: "hostile", key: "hostile", text: "Hostility on the wire jumped to 41% (24h average 22%)." });
  });

  it("fires at the level, ratio and sample edges", () => {
    expect(one(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ now: 0.35, base: 0.2 }) }))).kind).toBe("hostile");
    expect(one(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ now: 0.4, base: 0.25 }) }))).kind).toBe("hostile"); // exactly 1.6x
    expect(one(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ n: 30 }) }))).kind).toBe("hostile");
  });

  it("stays quiet below the level, the ratio or the sample floor", () => {
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ now: 0.34, base: 0.2 }) }))).toEqual([]);
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ now: 0.4, base: 0.26 }) }))).toEqual([]);
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ n: 29 }) }))).toEqual([]);
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ now: null }) }))).toEqual([]);
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: hostile({ base: null }) }))).toEqual([]);
  });
});

describe("mood swing", () => {
  it("reads the direction off the sign of the move", () => {
    expect(one(detectAlerts(fakeSql().sql, input(T0, { baro: mood() }))).text).toBe("Bluesky's mood dropped to 38/100 (24h average 53).");
    expect(one(detectAlerts(fakeSql().sql, input(T0, { baro: mood({ now: 0.71 }) }))).text).toBe("Bluesky's mood rose to 71/100 (24h average 53).");
  });

  it("fires at the swing and sample edges", () => {
    expect(one(detectAlerts(fakeSql().sql, input(T0, { baro: mood({ now: 0.5, base: 0.35 }) }))).kind).toBe("mood");
    expect(one(detectAlerts(fakeSql().sql, input(T0, { baro: mood({ n: 30 }) }))).kind).toBe("mood");
  });

  it("stays quiet under the swing or the sample floor", () => {
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: mood({ now: 0.5, base: 0.36 }) }))).toEqual([]);
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: mood({ n: 29 }) }))).toEqual([]);
    expect(detectAlerts(fakeSql().sql, input(T0, { baro: mood({ now: null }) }))).toEqual([]);
  });

  it("ignores an empty barometer", () => {
    expect(detectAlerts(fakeSql().sql, input(T0))).toEqual([]);
  });
});

describe("one alert per call", () => {
  it("prefers a burst, then hostility, then mood, one at a time", () => {
    const { sql, rows } = fakeSql();
    const baro = { ...hostile(), ...mood() };
    const terms = [term("climate")];
    expect(one(detectAlerts(sql, input(T0, { terms, baro }))).kind).toBe("burst");
    expect(one(detectAlerts(sql, input(T0 + 31 * MIN, { terms, baro }))).kind).toBe("hostile");
    expect(one(detectAlerts(sql, input(T0 + 62 * MIN, { terms, baro }))).kind).toBe("mood");
    expect(detectAlerts(sql, input(T0 + 93 * MIN, { terms, baro }))).toEqual([]);
    expect(rows).toHaveLength(3);
  });
});

describe("cooldowns", () => {
  it("holds everything for 30 minutes after any alert", () => {
    const { sql } = fakeSql();
    one(detectAlerts(sql, input(T0, { terms: [term("climate")] })));
    expect(detectAlerts(sql, input(T0 + 29 * MIN, { terms: [term("budget")] }))).toEqual([]);
    expect(one(detectAlerts(sql, input(T0 + 30 * MIN, { terms: [term("budget")] }))).key).toBe("budget");
  });

  it("holds a term for six hours and lets other terms through", () => {
    const { sql } = fakeSql();
    one(detectAlerts(sql, input(T0, { terms: [term("climate")] })));
    expect(one(detectAlerts(sql, input(T0 + 31 * MIN, { terms: [term("climate"), term("budget")] }))).key).toBe("budget");
    expect(detectAlerts(sql, input(T0 + 6 * HOUR - MIN, { terms: [term("climate")] }))).toEqual([]);
    expect(one(detectAlerts(sql, input(T0 + 6 * HOUR, { terms: [term("climate")] }))).key).toBe("climate");
  });

  it("holds a barometer key for three hours", () => {
    const { sql } = fakeSql();
    one(detectAlerts(sql, input(T0, { baro: hostile() })));
    expect(detectAlerts(sql, input(T0 + 3 * HOUR - MIN, { baro: hostile() }))).toEqual([]);
    expect(one(detectAlerts(sql, input(T0 + 3 * HOUR, { baro: hostile() }))).kind).toBe("hostile");
  });
});

describe("recentAlerts", () => {
  it("returns an empty log before anything has happened", () => {
    expect(recentAlerts(fakeSql().sql)).toEqual([]);
  });

  it("returns newest first and defaults to twenty", () => {
    const { sql } = fakeSql();
    for (let i = 0; i < 25; i++) detectAlerts(sql, input(T0 + i * 31 * MIN, { terms: [term(`t${i}`)] }));
    const log = recentAlerts(sql);
    expect(log).toHaveLength(20);
    expect(log[0].key).toBe("t24");
    expect(log.map((a) => a.ts)).toEqual([...log.map((a) => a.ts)].sort((a, b) => b - a));
    expect(recentAlerts(sql, 3).map((a) => a.key)).toEqual(["t24", "t23", "t22"]);
    expect(recentAlerts(sql, 0)).toHaveLength(1);
  });
});

describe("failure", () => {
  it("swallows a broken database and logs instead of throwing", () => {
    const sql = { exec: () => { throw new Error("no such table"); } } as unknown as SqlStorage;
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      expect(detectAlerts(sql, input(T0, { terms: [term("climate")] }))).toEqual([]);
    } finally {
      console.error = original;
    }
    expect(logged).toHaveLength(1);
  });
});
