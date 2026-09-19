// What this deploy costs Cloudflare, so the page can show hosting next to the Jev bill.
// Usage comes from the GraphQL Analytics API; the rates are the published list prices.

export interface CostEnv {
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_SCRIPT_NAME?: string;
}

export interface CostWindow {
  requests: number;
  cpuMs: number;
  doRequests: number;
  doDurationGbS: number;
  doStorageGb: number | null;
  r2ClassA: number | null;
  r2ClassB: number | null;
  r2StorageGb: number | null;
  estimatedUsd: number;
  breakdown: Record<string, number>;
}

export interface Costs {
  today: CostWindow;
  week: CostWindow;
  month: CostWindow;
  fetchedAt: number;
}

// List prices read on 2026-09-19 from:
//   https://developers.cloudflare.com/workers/platform/pricing/
//   https://developers.cloudflare.com/durable-objects/platform/pricing/
//   https://developers.cloudflare.com/r2/pricing/
// Cloudflare rounds billable units up to the next million before applying a rate; these are linear, so a
// small overage estimates lower than the invoice. Storage allowances below are the SQLite backend's.
export const PRICING = {
  daysPerMonth: 30,
  planUsdPerMonth: 5,
  includedRequests: 10_000_000,
  usdPerMRequests: 0.3,
  includedCpuMs: 30_000_000,
  usdPerMCpuMs: 0.02,
  doIncludedRequests: 1_000_000,
  doUsdPerMRequests: 0.15,
  doIncludedGbS: 400_000,
  doUsdPerMGbS: 12.5,
  doIncludedStorageGb: 5,
  doUsdPerGbMonth: 0.2,
  r2IncludedClassA: 1_000_000,
  r2UsdPerMClassA: 4.5,
  r2IncludedClassB: 10_000_000,
  r2UsdPerMClassB: 0.36,
  r2IncludedStorageGb: 10,
  r2UsdPerGbMonth: 0.015,
} as const;

// https://developers.cloudflare.com/r2/pricing/#class-a-operations
const R2_CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const R2_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const BUCKET = "cloutmetrics-archive";
const DEFAULT_SCRIPT = "firehose-judge";
const CACHE_TTL_MS = 5 * 60 * 1000;
// Cloudflare counts a GB as 10^9 bytes: its own GB-s figures are wallTime * 0.128, not * 128/1024.
const BYTES_PER_GB = 1e9;

const WINDOWS = ["today", "week", "month"] as const;
type WindowName = (typeof WINDOWS)[number];
const WINDOW_DAYS: Record<WindowName, number> = { today: 1, week: 7, month: 30 };

let cached: Costs | null = null;

// One worker, one script, so the cache needs no key.
export function clearCostCache(): void {
  cached = null;
}

export async function cloudflareCosts(env: CostEnv, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<Costs | { error: string }> {
  if (!env.CF_ANALYTICS_TOKEN) return { error: "CF_ANALYTICS_TOKEN is not set" };
  if (!env.CF_ACCOUNT_ID) return { error: "CF_ACCOUNT_ID is not set" };
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const variables = {
    account: env.CF_ACCOUNT_ID,
    script: env.CF_SCRIPT_NAME || DEFAULT_SCRIPT,
    bucket: BUCKET,
    todayStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString(),
    weekStart: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
    monthStart: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
    end: now.toISOString(),
  };

  let hasR2 = true;
  let body = await post(env.CF_ANALYTICS_TOKEN, buildQuery(true), variables, fetchImpl);
  if (typeof body !== "string" && body.errors?.length) {
    // R2 is the only optional half of the document, and one bad dataset fails all of it. A token without
    // R2 analytics, or an account with no buckets, should still get Worker and Durable Object numbers.
    hasR2 = false;
    body = await post(env.CF_ANALYTICS_TOKEN, buildQuery(false), variables, fetchImpl);
  }
  if (typeof body === "string") return { error: body };
  if (body.errors?.length) return { error: `cloudflare graphql: ${body.errors.map((e) => e?.message || "unknown error").join("; ")}` };

  const account = body.data?.viewer?.accounts?.[0];
  if (!account) return { error: `no analytics returned for account ${env.CF_ACCOUNT_ID}` };

  cached = {
    today: readWindow(account, "today", hasR2),
    week: readWindow(account, "week", hasR2),
    month: readWindow(account, "month", hasR2),
    fetchedAt: Date.now(),
  };
  return cached;
}

export function estimateUsd(
  w: Omit<CostWindow, "estimatedUsd" | "breakdown">,
  planIncluded: boolean,
  days: number = PRICING.daysPerMonth,
): { estimatedUsd: number; breakdown: Record<string, number> } {
  const share = days / PRICING.daysPerMonth;
  // planIncluded false answers "what does this traffic add", which is the honest question on an account
  // whose monthly allowances are already being spent by other Workers.
  const allow = (monthly: number) => (planIncluded ? monthly * share : 0);
  const metered = (used: number, included: number, usdPerM: number) => round((Math.max(0, used - included) / 1e6) * usdPerM);
  const stored = (gb: number, includedGb: number, usdPerGbMonth: number) => round(Math.max(0, gb - (planIncluded ? includedGb : 0)) * usdPerGbMonth * share);

  const breakdown: Record<string, number> = {
    plan: round(PRICING.planUsdPerMonth * share),
    workerRequests: metered(w.requests, allow(PRICING.includedRequests), PRICING.usdPerMRequests),
    workerCpu: metered(w.cpuMs, allow(PRICING.includedCpuMs), PRICING.usdPerMCpuMs),
    doRequests: metered(w.doRequests, allow(PRICING.doIncludedRequests), PRICING.doUsdPerMRequests),
    doDuration: metered(w.doDurationGbS, allow(PRICING.doIncludedGbS), PRICING.doUsdPerMGbS),
  };
  if (w.doStorageGb !== null) breakdown.doStorage = stored(w.doStorageGb, PRICING.doIncludedStorageGb, PRICING.doUsdPerGbMonth);
  if (w.r2ClassA !== null) breakdown.r2ClassA = metered(w.r2ClassA, allow(PRICING.r2IncludedClassA), PRICING.r2UsdPerMClassA);
  if (w.r2ClassB !== null) breakdown.r2ClassB = metered(w.r2ClassB, allow(PRICING.r2IncludedClassB), PRICING.r2UsdPerMClassB);
  if (w.r2StorageGb !== null) breakdown.r2Storage = stored(w.r2StorageGb, PRICING.r2IncludedStorageGb, PRICING.r2UsdPerGbMonth);

  return { estimatedUsd: round(Object.values(breakdown).reduce((a, b) => a + b, 0)), breakdown };
}

interface Group {
  sum?: Record<string, number>;
  max?: Record<string, number>;
  dimensions?: Record<string, string>;
}
type Account = Record<string, Group[]>;
interface GqlResponse {
  data?: { viewer?: { accounts?: Account[] } | null } | null;
  errors?: ({ message?: string } | null)[] | null;
}

// The query names every window in one document. Aliases are `<window><Dataset>`.
// workersInvocationsAdaptive and durableObjectsInvocationsAdaptiveGroups filter on scriptName;
// durableObjectsPeriodicGroups and durableObjectsSqlStorageGroups cannot, so they are grouped by
// namespaceId and matched afterwards against the namespaces this script's invocations reported.
export function buildQuery(withR2: boolean): string {
  const vars = ["$account: string!", "$script: string!", "$todayStart: string!", "$weekStart: string!", "$monthStart: string!", "$end: string!"];
  if (withR2) vars.splice(2, 0, "$bucket: string!");
  const fields = WINDOWS.flatMap((w) => {
    const when = `datetime_geq: $${w}Start, datetime_leq: $end`;
    const rows = [
      `${w}Workers: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, ${when} }) { sum { requests cpuTimeUs } }`,
      `${w}Do: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: { scriptName: $script, ${when} }) { sum { requests } dimensions { namespaceId } }`,
      `${w}DoDuration: durableObjectsPeriodicGroups(limit: 100, filter: { ${when} }) { sum { duration } dimensions { namespaceId } }`,
      `${w}DoStorage: durableObjectsSqlStorageGroups(limit: 100, filter: { ${when} }) { max { storedBytes } dimensions { namespaceId } }`,
    ];
    if (withR2) {
      rows.push(
        `${w}R2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: { bucketName: $bucket, ${when} }) { sum { requests } dimensions { actionType } }`,
        `${w}R2Storage: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, ${when} }) { max { payloadSize metadataSize } }`,
      );
    }
    return rows;
  });
  return `query FirehoseCosts(${vars.join(", ")}) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      ${fields.join("\n      ")}
    }
  }
}`;
}

async function post(token: string, query: string, variables: Record<string, string>, fetchImpl: typeof fetch): Promise<GqlResponse | string> {
  let res: Response;
  try {
    res = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    return `cloudflare graphql unreachable: ${(e as Error).message}`;
  }
  if (!res.ok) return `cloudflare graphql ${res.status}: ${(await res.text()).slice(0, 200)}`;
  try {
    return (await res.json()) as GqlResponse;
  } catch {
    return "cloudflare graphql returned a body that is not JSON";
  }
}

function readWindow(account: Account, w: WindowName, hasR2: boolean): CostWindow {
  const workers = account[`${w}Workers`]?.[0]?.sum;
  const invocations = account[`${w}Do`] ?? [];
  const namespaces = new Set<string>();
  let doRequests = 0;
  for (const row of invocations) {
    doRequests += row.sum?.requests ?? 0;
    if (row.dimensions?.namespaceId) namespaces.add(row.dimensions.namespaceId);
  }
  // With no invocations in the window there is no namespace to match on, and the account total is the
  // closest available answer rather than a silent zero.
  const mine = (rows: Group[]) => (namespaces.size ? rows.filter((r) => !r.dimensions?.namespaceId || namespaces.has(r.dimensions.namespaceId)) : rows);

  const durations = mine(account[`${w}DoDuration`] ?? []);
  const stores = mine(account[`${w}DoStorage`] ?? []);
  const usage = {
    requests: workers?.requests ?? 0,
    cpuMs: (workers?.cpuTimeUs ?? 0) / 1000,
    doRequests,
    doDurationGbS: durations.reduce((a, r) => a + (r.sum?.duration ?? 0), 0),
    doStorageGb: stores.length ? stores.reduce((a, r) => a + (r.max?.storedBytes ?? 0), 0) / BYTES_PER_GB : null,
    ...r2Usage(hasR2 ? account[`${w}R2Ops`] : undefined, hasR2 ? account[`${w}R2Storage`] : undefined),
  };
  return { ...usage, ...estimateUsd(usage, true, WINDOW_DAYS[w]) };
}

function r2Usage(ops: Group[] | undefined, storage: Group[] | undefined) {
  let r2ClassA: number | null = null;
  let r2ClassB: number | null = null;
  if (ops?.length) {
    r2ClassA = 0;
    r2ClassB = 0;
    for (const row of ops) {
      const n = row.sum?.requests ?? 0;
      const action = row.dimensions?.actionType ?? "";
      if (R2_FREE.has(action)) continue;
      // Anything not on the published class B list bills as class A, the dearer of the two, so a new
      // operation type Cloudflare adds later cannot quietly make the estimate read low.
      if (R2_CLASS_B.has(action)) r2ClassB += n;
      else r2ClassA += n;
    }
  }
  const bytes = storage?.[0]?.max;
  const r2StorageGb = bytes ? ((bytes.payloadSize ?? 0) + (bytes.metadataSize ?? 0)) / BYTES_PER_GB : null;
  return { r2ClassA, r2ClassB, r2StorageGb };
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
