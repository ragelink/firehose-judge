import { beforeEach, describe, expect, it } from "vitest";
import { buildQuery, clearCostCache, cloudflareCosts, estimateUsd, PRICING } from "../src/costs";

const ZERO = { requests: 0, cpuMs: 0, doRequests: 0, doDurationGbS: 0, doStorageGb: null, r2ClassA: null, r2ClassB: null, r2StorageGb: null };

describe("estimateUsd", () => {
  it("charges only the plan fee for an idle month", () => {
    const { estimatedUsd, breakdown } = estimateUsd(ZERO, true);
    expect(estimatedUsd).toBe(5);
    expect(breakdown).toEqual({ plan: 5, workerRequests: 0, workerCpu: 0, doRequests: 0, doDuration: 0 });
  });

  it("prorates the plan fee by window length", () => {
    expect(estimateUsd(ZERO, true, 1).breakdown.plan).toBe(0.166667);
    expect(estimateUsd(ZERO, true, 7).breakdown.plan).toBe(1.166667);
    expect(estimateUsd(ZERO, true, 30).breakdown.plan).toBe(5);
  });

  // Worked example 1 from https://developers.cloudflare.com/workers/platform/pricing/ : 15M requests at
  // 7ms of CPU each is $5 + $1.50 + $1.50 = $8.00 per month.
  it("reproduces Cloudflare's own worked example", () => {
    const { estimatedUsd, breakdown } = estimateUsd({ ...ZERO, requests: 15_000_000, cpuMs: 7 * 15_000_000 }, true, 30);
    expect(breakdown.workerRequests).toBe(1.5);
    expect(breakdown.workerCpu).toBe(1.5);
    expect(estimatedUsd).toBe(8);
  });

  it("prorates the included quota to one day", () => {
    // A day's share of 10M requests is 333,333.33, so 500,000 requests leaves 166,666.67 billable.
    const { estimatedUsd, breakdown } = estimateUsd({ ...ZERO, requests: 500_000 }, true, 1);
    expect(breakdown.workerRequests).toBe(0.05);
    expect(estimatedUsd).toBeCloseTo(0.216667, 6);
  });

  it("drops the included quota but keeps the plan fee when planIncluded is false", () => {
    const { estimatedUsd, breakdown } = estimateUsd({ ...ZERO, requests: 500_000 }, false, 1);
    expect(breakdown.workerRequests).toBe(0.15);
    expect(breakdown.plan).toBe(0.166667);
    expect(estimatedUsd).toBeCloseTo(0.316667, 6);
  });

  it("bills Durable Object requests and duration past their monthly allowance", () => {
    // Cloudflare's invoice rounds 500,000 billable requests up to a million and charges $0.15; this
    // estimate stays linear, so it reads $0.075.
    const { breakdown } = estimateUsd({ ...ZERO, doRequests: 1_500_000, doDurationGbS: 128_000 }, true, 30);
    expect(breakdown.doRequests).toBe(0.075);
    expect(breakdown.doDuration).toBe(0);
    expect(estimateUsd({ ...ZERO, doDurationGbS: 500_000 }, true, 30).breakdown.doDuration).toBe(1.25);
  });

  it("bills stored data above the allowance for the fraction of a month it is held", () => {
    expect(estimateUsd({ ...ZERO, doStorageGb: 6 }, true, 30).breakdown.doStorage).toBe(0.2);
    expect(estimateUsd({ ...ZERO, doStorageGb: 6 }, true, 1).breakdown.doStorage).toBe(0.006667);
    expect(estimateUsd({ ...ZERO, doStorageGb: 4 }, true, 30).breakdown.doStorage).toBe(0);
  });

  it("bills R2 operations and storage past the free tier", () => {
    const usage = { ...ZERO, r2ClassA: 2_000_000, r2ClassB: 12_000_000, r2StorageGb: 20 };
    const { estimatedUsd, breakdown } = estimateUsd(usage, true, 30);
    expect(breakdown.r2ClassA).toBe(4.5);
    expect(breakdown.r2ClassB).toBe(0.72);
    expect(breakdown.r2Storage).toBe(0.15);
    expect(estimatedUsd).toBe(10.37);
  });

  it("leaves unmeasured products out of the breakdown entirely", () => {
    expect(Object.keys(estimateUsd(ZERO, true, 30).breakdown)).not.toContain("r2ClassA");
    expect(Object.keys(estimateUsd({ ...ZERO, r2ClassA: 0 }, true, 30).breakdown)).toContain("r2ClassA");
  });

  it("keeps the published rates", () => {
    expect(PRICING.planUsdPerMonth).toBe(5);
    expect(PRICING.usdPerMRequests).toBe(0.3);
    expect(PRICING.doUsdPerMGbS).toBe(12.5);
    expect(PRICING.r2UsdPerMClassA).toBe(4.5);
  });
});

const NS = "59397fbddf6a4ac09fb2535a7feb8a69";
const OTHER_NS = "423af90819db41a4abf4577840d9b302";

interface Rows { requests: number; cpuTimeUs: number; doRequests: number; duration: number; storedBytes: number }

// Shaped like a real response: sums under `sum`, levels under `max`, one row per group, and account-wide
// datasets carrying a second Durable Object namespace that belongs to another Worker.
function windowRows(w: string, n: Rows): Record<string, unknown[]> {
  return {
    [`${w}Workers`]: [{ sum: { requests: n.requests, cpuTimeUs: n.cpuTimeUs } }],
    [`${w}Do`]: [{ sum: { requests: n.doRequests }, dimensions: { namespaceId: NS } }],
    [`${w}DoDuration`]: [
      { sum: { duration: n.duration }, dimensions: { namespaceId: NS } },
      { sum: { duration: 99 }, dimensions: { namespaceId: OTHER_NS } },
    ],
    [`${w}DoStorage`]: [
      { max: { storedBytes: n.storedBytes }, dimensions: { namespaceId: NS } },
      { max: { storedBytes: 131_072 }, dimensions: { namespaceId: OTHER_NS } },
    ],
    [`${w}R2Ops`]: [
      { sum: { requests: 1200 }, dimensions: { actionType: "PutObject" } },
      { sum: { requests: 300 }, dimensions: { actionType: "CompleteMultipartUpload" } },
      { sum: { requests: 5000 }, dimensions: { actionType: "GetObject" } },
      { sum: { requests: 40 }, dimensions: { actionType: "HeadObject" } },
      { sum: { requests: 700 }, dimensions: { actionType: "DeleteObject" } },
      { sum: { requests: 9 }, dimensions: { actionType: "SomeFutureOperation" } },
    ],
    [`${w}R2Storage`]: [{ max: { payloadSize: 2_500_000_000, metadataSize: 1_500_000 } }],
  };
}

const LIVE = {
  data: {
    viewer: {
      accounts: [{
        ...windowRows("today", { requests: 1778, cpuTimeUs: 574_158, doRequests: 1943, duration: 3551.56, storedBytes: 126_001_150 }),
        ...windowRows("week", { requests: 400_000, cpuTimeUs: 2_000_000_000, doRequests: 300_000, duration: 100_000, storedBytes: 7_000_000_000 }),
        ...windowRows("month", { requests: 12_000_000, cpuTimeUs: 35_000_000_000, doRequests: 2_000_000, duration: 900_000, storedBytes: 8_000_000_000 }),
      }],
    },
  },
  errors: null,
};

const ENV = { CF_ANALYTICS_TOKEN: "test-token", CF_ACCOUNT_ID: "e87eea63be7f065f610560a9d49c82ff", CF_SCRIPT_NAME: "firehose-judge" };
const NOW = new Date("2026-09-19T12:30:00.000Z");

function recorder(...bodies: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    if (body instanceof Error) throw body;
    if (body instanceof Response) return body.clone();
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const sent = (i: number) => JSON.parse(String(calls[i].init.body));
  return { calls, fetchImpl, sent };
}

describe("cloudflareCosts", () => {
  beforeEach(clearCostCache);

  it("reports missing configuration instead of throwing", async () => {
    const { calls, fetchImpl } = recorder(LIVE);
    expect(await cloudflareCosts({}, NOW, fetchImpl)).toEqual({ error: "CF_ANALYTICS_TOKEN is not set" });
    expect(await cloudflareCosts({ CF_ANALYTICS_TOKEN: "t" }, NOW, fetchImpl)).toEqual({ error: "CF_ACCOUNT_ID is not set" });
    expect(calls).toHaveLength(0);
  });

  it("asks for all three windows in one authenticated request", async () => {
    const { calls, fetchImpl, sent } = recorder(LIVE);
    await cloudflareCosts(ENV, NOW, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(sent(0).variables).toEqual({
      account: ENV.CF_ACCOUNT_ID,
      script: "firehose-judge",
      bucket: "cloutmetrics-archive",
      todayStart: "2026-09-19T00:00:00.000Z",
      weekStart: "2026-09-12T12:30:00.000Z",
      monthStart: "2026-08-20T12:30:00.000Z",
      end: "2026-09-19T12:30:00.000Z",
    });
  });

  it("queries the documented datasets", () => {
    const q = buildQuery(true);
    for (const dataset of ["workersInvocationsAdaptive", "durableObjectsInvocationsAdaptiveGroups", "durableObjectsPeriodicGroups", "durableObjectsSqlStorageGroups", "r2OperationsAdaptiveGroups", "r2StorageAdaptiveGroups"]) {
      expect(q).toContain(dataset);
    }
    expect(q).toContain("sum { requests cpuTimeUs }");
    expect(buildQuery(false)).not.toContain("r2OperationsAdaptiveGroups");
    expect(buildQuery(false)).not.toContain("$bucket");
  });

  it("reads usage out of a response", async () => {
    const { fetchImpl } = recorder(LIVE);
    const costs = await cloudflareCosts(ENV, NOW, fetchImpl);
    if ("error" in costs) throw new Error(costs.error);
    expect(costs.today.requests).toBe(1778);
    expect(costs.today.cpuMs).toBe(574.158);
    expect(costs.today.doRequests).toBe(1943);
    expect(costs.today.doDurationGbS).toBe(3551.56);
    expect(costs.today.doStorageGb).toBe(0.12600115);
    expect(costs.today.r2ClassA).toBe(1509);
    expect(costs.today.r2ClassB).toBe(5040);
    expect(costs.today.r2StorageGb).toBe(2.5015);
    expect(costs.fetchedAt).toBeGreaterThan(0);
  });

  it("ignores Durable Object namespaces belonging to other Workers", async () => {
    const { fetchImpl } = recorder(LIVE);
    const costs = await cloudflareCosts(ENV, NOW, fetchImpl);
    if ("error" in costs) throw new Error(costs.error);
    // The foreign namespace adds 99 GB-s and 131,072 bytes to the account-wide rows.
    expect(costs.today.doDurationGbS).toBe(3551.56);
    expect(costs.today.doStorageGb).toBe(0.12600115);
  });

  it("prices each window against its own prorated allowance", async () => {
    const { fetchImpl } = recorder(LIVE);
    const costs = await cloudflareCosts(ENV, NOW, fetchImpl);
    if ("error" in costs) throw new Error(costs.error);
    expect(costs.today.estimatedUsd).toBeCloseTo(0.166667, 6);
    expect(costs.week.breakdown).toEqual({ plan: 1.166667, workerRequests: 0, workerCpu: 0, doRequests: 0.01, doDuration: 0.083333, doStorage: 0.093333, r2ClassA: 0, r2ClassB: 0, r2Storage: 0 });
    expect(costs.week.estimatedUsd).toBeCloseTo(1.353333, 6);
    expect(costs.month.breakdown).toEqual({ plan: 5, workerRequests: 0.6, workerCpu: 0.1, doRequests: 0.15, doDuration: 6.25, doStorage: 0.6, r2ClassA: 0, r2ClassB: 0, r2Storage: 0 });
    expect(costs.month.estimatedUsd).toBeCloseTo(12.7, 6);
  });

  it("degrades to null R2 when the bucket dataset is not readable", async () => {
    const without = structuredClone(LIVE) as typeof LIVE;
    const account = without.data.viewer.accounts[0] as Record<string, unknown>;
    for (const key of Object.keys(account)) if (key.includes("R2")) delete account[key];
    const { calls, fetchImpl, sent } = recorder({ data: null, errors: [{ message: "unauthorized to access r2OperationsAdaptiveGroups" }] }, without);
    const costs = await cloudflareCosts(ENV, NOW, fetchImpl);
    if ("error" in costs) throw new Error(costs.error);
    expect(calls).toHaveLength(2);
    expect(sent(1).query).not.toContain("r2OperationsAdaptiveGroups");
    expect(costs.today.r2ClassA).toBeNull();
    expect(costs.today.r2StorageGb).toBeNull();
    expect(costs.today.requests).toBe(1778);
    expect(Object.keys(costs.today.breakdown)).not.toContain("r2Storage");
  });

  it("reports an empty bucket as null rather than zero", async () => {
    const empty = structuredClone(LIVE) as typeof LIVE;
    const account = empty.data.viewer.accounts[0] as Record<string, unknown>;
    for (const key of Object.keys(account)) if (key.includes("R2")) account[key] = [];
    const { fetchImpl } = recorder(empty);
    const costs = await cloudflareCosts(ENV, NOW, fetchImpl);
    if ("error" in costs) throw new Error(costs.error);
    expect(costs.today.r2ClassA).toBeNull();
    expect(costs.today.r2ClassB).toBeNull();
    expect(costs.today.r2StorageGb).toBeNull();
  });

  it("returns the GraphQL message when the whole query fails", async () => {
    const failure = { data: null, errors: [{ message: "authentication error" }] };
    const { calls, fetchImpl } = recorder(failure, failure);
    expect(await cloudflareCosts(ENV, NOW, fetchImpl)).toEqual({ error: "cloudflare graphql: authentication error" });
    expect(calls).toHaveLength(2);
  });

  it("returns an error for a non-200 and for an unreachable API", async () => {
    const http = recorder(new Response("bad token", { status: 403 }));
    expect(await cloudflareCosts(ENV, NOW, http.fetchImpl)).toEqual({ error: "cloudflare graphql 403: bad token" });
    clearCostCache();
    const down = recorder(new Error("connection reset"));
    expect(await cloudflareCosts(ENV, NOW, down.fetchImpl)).toEqual({ error: "cloudflare graphql unreachable: connection reset" });
  });

  it("returns an error when the account has no analytics", async () => {
    const { fetchImpl } = recorder({ data: { viewer: { accounts: [] } }, errors: null });
    expect(await cloudflareCosts(ENV, NOW, fetchImpl)).toEqual({ error: `no analytics returned for account ${ENV.CF_ACCOUNT_ID}` });
  });

  it("serves the cached answer until it is cleared", async () => {
    const { calls, fetchImpl } = recorder(LIVE);
    const first = await cloudflareCosts(ENV, NOW, fetchImpl);
    const second = await cloudflareCosts(ENV, NOW, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(second).toBe(first);
    clearCostCache();
    await cloudflareCosts(ENV, NOW, fetchImpl);
    expect(calls).toHaveLength(2);
  });

  it("does not cache failures", async () => {
    const { calls, fetchImpl } = recorder(new Response("nope", { status: 500 }), LIVE);
    expect(await cloudflareCosts(ENV, NOW, fetchImpl)).toHaveProperty("error");
    expect(await cloudflareCosts(ENV, NOW, fetchImpl)).not.toHaveProperty("error");
    expect(calls).toHaveLength(2);
  });
});
