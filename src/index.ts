export { Firehose } from "./firehose";
import { cloudflareCosts } from "./costs";

// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface SecretEnv {
  TYPESAFE_API_KEY: string;
  STRIPE_WEBHOOK_SECRET?: string;
  CF_ANALYTICS_TOKEN?: string;
}

const SIG_TOLERANCE_S = 300;

interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  data?: {
    object?: {
      id?: string;
      payment_intent?: string | null;
      amount_total?: number | null;
      amount_received?: number | null;
      currency?: string | null;
      // Two optional text fields on the Payment Link, keyed `name` and `message`.
      custom_fields?: { key?: string; text?: { value?: string | null } | null }[];
      customer_details?: { name?: string | null } | null;
    };
  };
}

export default {
  async fetch(request: Request, env: Env & SecretEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/stripe/webhook") return stripeWebhook(request, env);
    if (pathname === "/api/costs") {
      const costs = await cloudflareCosts(env);
      return Response.json(costs, { status: "error" in costs ? 502 : 200, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
    }
    if (pathname === "/ws" || pathname === "/badge.svg" || pathname.startsWith("/api/")) {
      return env.FIREHOSE.getByName("bluesky").fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env & SecretEnv>;

async function stripeWebhook(request: Request, env: Env & SecretEnv): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const secret = env.STRIPE_WEBHOOK_SECRET;
  const body = await request.text();
  if (!secret || !(await verified(body, request.headers.get("Stripe-Signature"), secret))) {
    return new Response("bad signature", { status: 400 });
  }
  let ev: StripeEvent;
  try { ev = JSON.parse(body); } catch { return new Response("bad body", { status: 400 }); }
  const o = ev.data?.object;
  if (o && (ev.type === "checkout.session.completed" || ev.type === "payment_intent.succeeded")) {
    const amountCents = o.amount_total ?? o.amount_received ?? 0;
    // Both events describe the same payment, so the payment intent id keeps the pair from counting twice.
    const id = (typeof o.payment_intent === "string" ? o.payment_intent : o.id) ?? ev.id;
    if (amountCents > 0 && id) {
      const fields = new Map((o.custom_fields ?? []).map((f) => [f.key, f.text?.value ?? ""]));
      await env.FIREHOSE.getByName("bluesky").recordContribution({
        id, ts: (ev.created ?? 0) * 1000 || Date.now(), amountCents, currency: o.currency ?? "usd",
        name: fields.get("name") || o.customer_details?.name || undefined,
        message: fields.get("message") || undefined,
      });
    }
  }
  return Response.json({ received: true });
}

// Stripe signs `${t}.${body}` with the endpoint secret and sends `t=<unix seconds>,v1=<hex hmac>`.
async function verified(body: string, header: string | null, secret: string): Promise<boolean> {
  const parts = (header ?? "").split(",").map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > SIG_TOLERANCE_S) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`));
  const expected = enc.encode([...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  // A rotating signing secret puts more than one v1 signature in the header.
  for (const p of parts) {
    if (!p.startsWith("v1=")) continue;
    const got = enc.encode(p.slice(3));
    if (got.length === expected.length && crypto.subtle.timingSafeEqual(got, expected)) return true;
  }
  return false;
}
