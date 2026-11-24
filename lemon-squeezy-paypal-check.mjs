#!/usr/bin/env node
// Lemon Squeezy PayPal subscriber check v0.3.1. MIT License.
// Single file, no dependencies. Talks only to https://api.lemonsqueezy.com (and api.stripe.com, read-only, to verify cancels).

// cli/src/main.ts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// src/config/cli.json
var cli_default = { packageName: "lemon-squeezy-paypal-check", fileName: "lemon-squeezy-paypal-check.mjs", version: "0.3.1", npmPublished: false };

// src/config/brand.ts
var BRAND_NAME = "ReLink";
var SITE_URL = "https://relinkpay.com";
var CLI_FILE_NAME = cli_default.fileName;
var CLI_VERSION = cli_default.version;

// src/core/cancel-files.ts
var CANCEL_SCHEMA_VERSION = 1;
var MAX_CANCEL_FILE_BYTES = 10 * 1024 * 1024;
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var str = (v, max = 320) => typeof v === "string" && v.length > 0 && v.length <= max;
var iso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
function parseCancelList(text) {
  if (text.length > MAX_CANCEL_FILE_BYTES) return { ok: false, error: "The file is larger than 10 MB." };
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file is not JSON." };
  }
  if (!isObj(v) || v.schemaVersion !== CANCEL_SCHEMA_VERSION || !str(v.campaignId, 64) || !iso(v.generatedAt) || !Array.isArray(v.items)) {
    return { ok: false, error: "This is not a cancel list from the dashboard." };
  }
  for (const [i, it] of v.items.entries()) {
    if (!isObj(it) || !str(it.sourceSubscriptionId, 128) || !str(it.email) || !str(it.productName, 500) || !str(it.destSubscriptionId, 255) || !iso(it.cancelBy)) {
      return { ok: false, error: `Item ${i + 1} is incomplete.` };
    }
  }
  return { ok: true, file: v };
}

// src/core/mrr.ts
var MONTHLY_FACTOR = {
  month: 1,
  year: 1 / 12,
  week: 4.348214,
  day: 30.4375
};
function monthlyFactor(interval) {
  return MONTHLY_FACTOR[interval.unit] / interval.count;
}
function monthlyValueCents(sub) {
  if (sub.unitPriceCents === null || sub.interval === null) return null;
  return sub.unitPriceCents * sub.quantity * monthlyFactor(sub.interval);
}

// src/core/report.ts
var DAY_MS = 864e5;
function weekStartUtc(d) {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - dow * DAY_MS);
}
var isoDay = (d) => d.toISOString().slice(0, 10);
var LIVE_STATES = /* @__PURE__ */ new Set(["paid", "trial", "unpaid"]);
function buildStoreReport(account, rows, now, cutoffAt) {
  const live = rows.filter((r) => LIVE_STATES.has(r.state));
  const stranded = rows.filter((r) => r.stranded);
  let mrrExact = 0;
  let mrrUnknownCount = 0;
  const plans = /* @__PURE__ */ new Map();
  const needsReview = {};
  for (const r of rows) {
    if (r.needsReview) needsReview[r.needsReview] = (needsReview[r.needsReview] ?? 0) + 1;
  }
  const firstWeek = weekStartUtc(now);
  const lastWeek = cutoffAt ? weekStartUtc(new Date(cutoffAt.getTime() - 1)) : new Date(firstWeek.getTime() + 51 * 7 * DAY_MS);
  const weeks = /* @__PURE__ */ new Map();
  for (let t = firstWeek.getTime(); t <= lastWeek.getTime(); t += 7 * DAY_MS) {
    weeks.set(isoDay(new Date(t)), { count: 0, exact: 0 });
  }
  let inPaymentRetryCount = 0;
  let paidBeyondCutoffCount = 0;
  for (const r of stranded) {
    const value = monthlyValueCents(r);
    if (value === null) mrrUnknownCount += 1;
    else mrrExact += value;
    const key = `${r.productName}\0${r.planName ?? ""}\0${r.sourceVariantId ?? ""}`;
    const plan = plans.get(key) ?? {
      productName: r.productName,
      planName: r.planName,
      sourceVariantId: r.sourceVariantId,
      count: 0,
      monthlyValueCents: 0,
      mrrUnknownCount: 0,
      exact: 0
    };
    plan.count += 1;
    if (value === null) plan.mrrUnknownCount += 1;
    else plan.exact += value;
    plans.set(key, plan);
    if (r.paidThrough === null) {
      inPaymentRetryCount += 1;
    } else if (cutoffAt && r.paidThrough.getTime() >= cutoffAt.getTime()) {
      paidBeyondCutoffCount += 1;
    } else {
      const wk = isoDay(weekStartUtc(r.paidThrough < now ? now : r.paidThrough));
      const bucket = weeks.get(wk);
      if (bucket) {
        bucket.count += 1;
        bucket.exact += value ?? 0;
      }
    }
  }
  const byPlan = [...plans.values()].map(({ exact, ...p }) => ({ ...p, monthlyValueCents: Math.round(exact) })).sort((a, b) => b.count - a.count || b.monthlyValueCents - a.monthlyValueCents);
  return {
    accountId: account.id,
    accountName: account.name,
    currency: account.currency,
    liveCount: live.length,
    strandedCount: stranded.length,
    paypalSharePct: live.length ? Math.round(stranded.length / live.length * 1e3) / 10 : null,
    strandedMrrCents: Math.round(mrrExact),
    mrrUnknownCount,
    byPlan,
    renewalWeeks: [...weeks.entries()].map(([weekStart, b]) => ({
      weekStart,
      count: b.count,
      monthlyValueCents: Math.round(b.exact)
    })),
    inPaymentRetryCount,
    paidBeyondCutoffCount,
    needsReview
  };
}
function buildCheckerReport(input) {
  const { accounts, subscriptions, now, cutoffAt } = input;
  const real = subscriptions.filter((s) => !s.isTest);
  const testRowsIgnored = subscriptions.length - real.length;
  const stores = accounts.map(
    (account) => buildStoreReport(
      account,
      real.filter((s) => s.sourceAccountId === account.id),
      now,
      cutoffAt
    )
  );
  const mrrByCurrency = {};
  for (const s of stores) {
    if (s.strandedCount === 0) continue;
    const cur = s.currency ?? "unknown";
    mrrByCurrency[cur] = (mrrByCurrency[cur] ?? 0) + s.strandedMrrCents;
  }
  return {
    generatedAt: now.toISOString(),
    cutoffAt: cutoffAt ? cutoffAt.toISOString() : null,
    partial: Boolean(input.partialReason),
    partialReason: input.partialReason ?? null,
    testModeOnly: subscriptions.length > 0 && real.length === 0,
    testRowsIgnored,
    skippedRows: input.skippedRows ?? 0,
    stores,
    totals: {
      strandedCount: stores.reduce((n, s) => n + s.strandedCount, 0),
      liveCount: stores.reduce((n, s) => n + s.liveCount, 0),
      mrrByCurrency
    }
  };
}

// src/core/checker.ts
var CheckAbortedError = class extends Error {
  constructor() {
    super("The check was cancelled.");
    this.name = "CheckAbortedError";
  }
};
async function runCheck(options) {
  const { source, creds, now } = options;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (options.signal?.aborted) throw new CheckAbortedError();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const stop = { reason: null };
  const timer = options.maxMs !== void 0 ? setTimeout(() => {
    stop.reason ??= "time_limit";
    ctrl.abort();
  }, options.maxMs) : null;
  const subscriptions = [];
  let accounts = [];
  let totalPages = 0;
  let skippedRows = 0;
  try {
    accounts = await source.listAccounts(creds, ctrl.signal);
    for (const account of accounts) {
      let accountSkipped = 0;
      let pageLimitHit = false;
      const rows = source.scan(
        creds,
        account.id,
        (p) => {
          totalPages += 1;
          accountSkipped = p.skippedRows;
          if (options.maxPages !== void 0 && totalPages > options.maxPages) {
            pageLimitHit = true;
            return;
          }
          options.onProgress?.({
            accountId: account.id,
            accountName: account.name,
            pagesFetched: p.pagesFetched,
            lastPage: p.lastPage,
            totalPages
          });
        },
        ctrl.signal
      );
      for await (const row of rows) {
        if (pageLimitHit) break;
        subscriptions.push(row);
      }
      skippedRows += accountSkipped;
      if (pageLimitHit) {
        stop.reason = "page_limit";
        break;
      }
    }
  } catch (err) {
    if (options.signal?.aborted) throw new CheckAbortedError();
    if (!(ctrl.signal.aborted && stop.reason === "time_limit")) throw err;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
  return buildCheckerReport({
    accounts,
    subscriptions,
    now,
    cutoffAt: source.preset.cutoffAt,
    partialReason: stop.reason,
    skippedRows
  });
}

// src/core/export-file/types.ts
var EXPORT_SCHEMA_VERSION = 1;
var MAX_EXPORT_BYTES = 10 * 1024 * 1024;

// src/core/export-file/write.ts
function exportableRows(rows, accountId) {
  return rows.filter((r) => !r.isTest && r.sourceAccountId === accountId && (r.stranded || r.needsReview !== null));
}
function buildExport(input) {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    sourceProvider: input.sourceProvider,
    exportedAt: input.now.toISOString(),
    account: { id: input.account.id, name: input.account.name, currency: input.account.currency },
    subscriptions: exportableRows(input.subscriptions, input.account.id)
  };
}
function writeExport(input) {
  const file = buildExport(input);
  return { json: `${JSON.stringify(file, null, 2)}
`, file };
}

// src/core/format.ts
function formatMoney(cents, currency) {
  const amount = cents / 100;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
    } catch {
    }
  }
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}
function formatDate(value) {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}
function formatPct(value) {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}
var NEEDS_REVIEW_LABELS = {
  paused: "PayPal subscriptions that are paused",
  unpaid: "PayPal subscriptions marked unpaid (payment retries exhausted)",
  non_card_method: "Stripe-processed subscriptions paid without a card (e.g. Cash App Pay). Only relevant if you are leaving Stripe.",
  unknown_status: "Subscriptions with a status this tool does not recognise",
  unknown_processor: "Live subscriptions with an unrecognised payment processor"
};

// src/core/providers/lemon-squeezy/guards.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asString(value) {
  return typeof value === "string" ? value : null;
}
function asNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function asBoolean(value) {
  return typeof value === "boolean" ? value : null;
}
function asId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return null;
}
var ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;
function asDate(value) {
  if (typeof value !== "string") return null;
  const m = ISO_RE.exec(value);
  if (!m) return null;
  const ms = (m[2] ?? "").padEnd(3, "0").slice(0, 3);
  const d = /* @__PURE__ */ new Date(`${m[1]}.${ms}${m[3]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function asResource(value, expectedType) {
  if (!isRecord(value)) return null;
  const id = asId(value.id);
  const type = asString(value.type);
  if (!id || type !== expectedType || !isRecord(value.attributes)) return null;
  return { id, type, attributes: value.attributes };
}
function asListBody(value) {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const links = isRecord(value.links) ? value.links : {};
  const meta = isRecord(value.meta) && isRecord(value.meta.page) ? value.meta.page : {};
  return {
    data: value.data,
    next: asNonEmptyString(links.next),
    currentPage: asNumber(meta.currentPage),
    lastPage: asNumber(meta.lastPage)
  };
}
function asSingleData(value) {
  return isRecord(value) ? value.data : void 0;
}
function parseSubscription(value) {
  const res = asResource(value, "subscriptions");
  if (!res) return null;
  const a = res.attributes;
  const storeId = asId(a.store_id);
  const userEmail = asNonEmptyString(a.user_email);
  const status = asNonEmptyString(a.status);
  if (!storeId || !userEmail || !status) return null;
  let firstItem = null;
  if (isRecord(a.first_subscription_item)) {
    const q = asNumber(a.first_subscription_item.quantity);
    firstItem = {
      priceId: asId(a.first_subscription_item.price_id),
      quantity: q !== null && Number.isInteger(q) && q > 0 ? q : 1
    };
  }
  return {
    id: res.id,
    storeId,
    customerId: asId(a.customer_id),
    variantId: asId(a.variant_id),
    productName: asNonEmptyString(a.product_name) ?? "Unknown product",
    variantName: asNonEmptyString(a.variant_name),
    userName: asNonEmptyString(a.user_name),
    userEmail,
    status,
    cardBrand: asNonEmptyString(a.card_brand),
    paymentProcessor: asNonEmptyString(a.payment_processor),
    cancelled: asBoolean(a.cancelled) ?? status === "cancelled",
    renewsAt: asDate(a.renews_at),
    endsAt: asDate(a.ends_at),
    firstItem,
    testMode: asBoolean(a.test_mode) ?? false
  };
}
function parsePrice(value) {
  const res = asResource(value, "prices");
  if (!res) return null;
  const a = res.attributes;
  return {
    id: res.id,
    variantId: asId(a.variant_id),
    category: asNonEmptyString(a.category),
    scheme: asNonEmptyString(a.scheme),
    usageAggregation: asNonEmptyString(a.usage_aggregation),
    unitPrice: asNumber(a.unit_price),
    renewalIntervalUnit: asNonEmptyString(a.renewal_interval_unit),
    renewalIntervalQuantity: asNumber(a.renewal_interval_quantity),
    createdAt: asDate(a.created_at)
  };
}
function parseStore(value) {
  const res = asResource(value, "stores");
  if (!res) return null;
  const currency = asNonEmptyString(res.attributes.currency);
  return {
    id: res.id,
    name: asNonEmptyString(res.attributes.name) ?? `Store ${res.id}`,
    currency: currency ? currency.toUpperCase() : null
  };
}

// src/core/providers/lemon-squeezy/client.ts
var LS_API_ORIGIN = "https://api.lemonsqueezy.com";
var LsApiError = class extends Error {
  kind;
  status;
  constructor(kind, message, status = null) {
    super(message);
    this.name = "LsApiError";
    this.kind = kind;
    this.status = status;
  }
};
var defaultSleep = (ms, signal) => new Promise((resolve2, reject) => {
  if (signal?.aborted) return reject(abortedError());
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve2();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortedError());
  };
  signal?.addEventListener("abort", onAbort, { once: true });
});
function abortedError() {
  return new LsApiError("aborted", "The scan was cancelled.");
}
function resolveLsUrl(pathOrUrl) {
  if (pathOrUrl.startsWith("/v1/")) return LS_API_ORIGIN + pathOrUrl;
  let url;
  try {
    url = new URL(pathOrUrl);
  } catch {
    throw new LsApiError("foreign_host", "Refusing to follow an invalid Lemon Squeezy URL.");
  }
  if (url.origin !== LS_API_ORIGIN) {
    throw new LsApiError("foreign_host", "Refusing to send the API key to a host other than api.lemonsqueezy.com.");
  }
  return url.toString();
}
function createLsClient(apiKey, options = {}) {
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 15e3;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 6;
  const maxTransientRetries = options.maxTransientRetries ?? 3;
  const headers = {
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
    Authorization: `Bearer ${apiKey}`
  };
  async function attempt(url, signal, method = "GET") {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, headers, signal: ctrl.signal, redirect: "error" });
      const text = await res.text();
      const remainingHeader = res.headers.get("x-ratelimit-remaining");
      const remaining = remainingHeader !== null && remainingHeader !== "" ? Number(remainingHeader) : null;
      return { status: res.status, text, remaining: Number.isFinite(remaining) ? remaining : null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  async function getJson(pathOrUrl, signal, method = "GET") {
    const url = resolveLsUrl(pathOrUrl);
    let rateLimited = 0;
    let transient = 0;
    for (; ; ) {
      if (signal?.aborted) throw abortedError();
      let result;
      try {
        result = await attempt(url, signal, method);
      } catch {
        if (signal?.aborted) throw abortedError();
        if (transient < maxTransientRetries) {
          transient += 1;
          await sleep(1e3 * 2 ** (transient - 1), signal);
          continue;
        }
        throw new LsApiError("network", "Could not reach Lemon Squeezy (network error or timeout).");
      }
      const { status, text, remaining } = result;
      if (status >= 200 && status < 300) {
        if (remaining !== null && remaining <= 2) await sleep(5e3, signal);
        try {
          return JSON.parse(text);
        } catch {
          throw new LsApiError("bad_response", "Lemon Squeezy returned a response that is not JSON.", status);
        }
      }
      if (status === 429) {
        if (rateLimited < maxRateLimitRetries) {
          rateLimited += 1;
          await sleep(Math.min(6e4, 2e3 * 2 ** (rateLimited - 1)), signal);
          continue;
        }
        throw new LsApiError("rate_limited", "Lemon Squeezy rate limit reached. Try again in a minute.", status);
      }
      if (status === 401 || status === 403) {
        throw new LsApiError(
          "auth",
          `Lemon Squeezy rejected this API key (HTTP ${status}). Check that you copied the whole key and that it has not expired or been deleted.`,
          status
        );
      }
      if (status === 404) throw new LsApiError("not_found", "Lemon Squeezy returned 404 Not Found.", status);
      if (status >= 500) {
        if (transient < maxTransientRetries) {
          transient += 1;
          await sleep(1e3 * 2 ** (transient - 1), signal);
          continue;
        }
        throw new LsApiError("upstream", `Lemon Squeezy is not responding normally (HTTP ${status}).`, status);
      }
      throw new LsApiError("bad_request", `Lemon Squeezy refused the request (HTTP ${status}${errorTitle(text)}).`, status);
    }
  }
  async function* paginate(firstPath, signal) {
    const seen = /* @__PURE__ */ new Set();
    let next = firstPath;
    while (next !== null) {
      const url = resolveLsUrl(next);
      if (seen.has(url)) throw new LsApiError("bad_response", "Lemon Squeezy pagination looped back to a page it already returned.");
      seen.add(url);
      const body = asListBody(await getJson(url, signal));
      if (!body) throw new LsApiError("bad_response", "Lemon Squeezy returned a list response without a data array.");
      yield body;
      next = body.next;
    }
  }
  return { getJson: (p, sig) => getJson(p, sig), deleteJson: (p, sig) => getJson(p, sig, "DELETE"), paginate };
}
function errorTitle(text) {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed) && Array.isArray(parsed.errors) && isRecord(parsed.errors[0])) {
      const title = parsed.errors[0].title;
      if (typeof title === "string" && title.length < 120) return `: ${title}`;
    }
  } catch {
  }
  return "";
}

// src/core/providers/lemon-squeezy/normalize.ts
var LIVE_STATUSES = /* @__PURE__ */ new Set(["active", "on_trial", "past_due"]);
var KNOWN_STATUSES = /* @__PURE__ */ new Set([
  "on_trial",
  "active",
  "paused",
  "past_due",
  "unpaid",
  "cancelled",
  "expired"
]);
function mapState(status, endsAt, now) {
  switch (status) {
    case "active":
      return "paid";
    case "on_trial":
      return "trial";
    case "past_due":
    case "unpaid":
      return "unpaid";
    case "paused":
      return "paused";
    case "cancelled":
      return endsAt !== null && endsAt.getTime() > now.getTime() ? "cancelled_in_grace" : "ended";
    case "expired":
      return "ended";
    default:
      return "ended";
  }
}
function paidThroughFor(state, renewsAt, endsAt) {
  if (state === "paid" || state === "trial") return renewsAt;
  if (state === "cancelled_in_grace") return endsAt;
  return null;
}
function classify(sub) {
  const live = LIVE_STATUSES.has(sub.status) && !sub.cancelled;
  if (!KNOWN_STATUSES.has(sub.status)) return { stranded: false, needsReview: "unknown_status" };
  if (sub.paymentProcessor === "paypal") {
    if (live) return { stranded: true, needsReview: null };
    if (sub.status === "paused") return { stranded: false, needsReview: "paused" };
    if (sub.status === "unpaid") return { stranded: false, needsReview: "unpaid" };
    return { stranded: false, needsReview: null };
  }
  if (sub.paymentProcessor === "stripe") {
    if (live && sub.cardBrand === null) return { stranded: false, needsReview: "non_card_method" };
    return { stranded: false, needsReview: null };
  }
  return { stranded: false, needsReview: live ? "unknown_processor" : null };
}
var INTERVAL_UNITS = /* @__PURE__ */ new Set(["day", "week", "month", "year"]);
function priceTerms(price) {
  if (!price) return { unitPriceCents: null, interval: null };
  const q = price.renewalIntervalQuantity;
  const interval = price.renewalIntervalUnit !== null && INTERVAL_UNITS.has(price.renewalIntervalUnit) && q !== null && Number.isInteger(q) && q > 0 ? { unit: price.renewalIntervalUnit, count: q } : null;
  const flat = price.category === "subscription" && price.scheme === "standard" && price.usageAggregation === null && price.unitPrice !== null && Number.isInteger(price.unitPrice) && price.unitPrice >= 0;
  return { unitPriceCents: flat ? price.unitPrice : null, interval };
}
function normalizeSubscription(input) {
  const { sub, price, priceId, quantity, currency, now } = input;
  const state = mapState(sub.status, sub.endsAt, now);
  const { stranded, needsReview } = classify(sub);
  const { unitPriceCents, interval } = priceTerms(price);
  return {
    sourceSubscriptionId: sub.id,
    sourceCustomerId: sub.customerId,
    sourceAccountId: sub.storeId,
    productName: sub.productName,
    planName: sub.variantName,
    sourceVariantId: sub.variantId,
    sourcePriceId: priceId,
    email: sub.userEmail,
    name: sub.userName,
    state,
    rawStatus: sub.status,
    paidThrough: paidThroughFor(state, sub.renewsAt, sub.endsAt),
    quantity,
    unitPriceCents,
    currency,
    interval,
    stranded,
    needsReview,
    isTest: sub.testMode
  };
}

// src/core/providers/lemon-squeezy/preset-base.ts
var LEMON_SQUEEZY_CUTOFF = /* @__PURE__ */ new Date("2027-03-31T00:00:00Z");
var lemonSqueezyPresetBase = {
  displayName: "Lemon Squeezy",
  cutoffAt: LEMON_SQUEEZY_CUTOFF,
  disclaimers: ["Not affiliated with Lemon Squeezy, Stripe, or PayPal."],
  defaultEmailTemplates: [],
  landingCopy: {}
};

// src/core/providers/lemon-squeezy/source.ts
var LEMON_SQUEEZY_ID = "lemon_squeezy";
async function softFail(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LsApiError && (err.kind === "auth" || err.kind === "aborted")) throw err;
    return null;
  }
}
function newestPrice(prices) {
  const candidates = prices.some((p) => p.category === "subscription") ? prices.filter((p) => p.category === "subscription") : prices;
  let best = null;
  for (const p of candidates) {
    const tp = p.createdAt?.getTime() ?? -Infinity;
    const tb = best?.createdAt?.getTime() ?? -Infinity;
    if (best === null || tp > tb || tp === tb && Number(p.id) > Number(best.id)) best = p;
  }
  return best;
}
async function resolvePrice(client, sub, cache, signal) {
  let priceId = sub.firstItem?.priceId ?? null;
  let price = null;
  if (sub.firstItem && priceId) {
    const id = priceId;
    let p = cache.byId.get(id);
    if (!p) {
      p = softFail(async () => parsePrice(asSingleData(await client.getJson(`/v1/prices/${encodeURIComponent(id)}`, signal))));
      cache.byId.set(id, p);
    }
    price = await p;
  } else if (!sub.firstItem && sub.variantId) {
    const variantId = sub.variantId;
    let p = cache.byVariant.get(variantId);
    if (!p) {
      p = softFail(async () => {
        const found = [];
        for await (const page of client.paginate(`/v1/prices?filter[variant_id]=${encodeURIComponent(variantId)}&page[size]=100`, signal)) {
          for (const item of page.data) {
            const pr = parsePrice(item);
            if (pr) found.push(pr);
          }
        }
        return newestPrice(found);
      });
      cache.byVariant.set(variantId, p);
    }
    price = await p;
    priceId = price?.id ?? null;
  }
  return { price, priceId, quantity: sub.firstItem?.quantity ?? 1 };
}
async function storeCurrency(client, accountId, signal) {
  try {
    const store = parseStore(asSingleData(await client.getJson(`/v1/stores/${encodeURIComponent(accountId)}`, signal)));
    return store?.currency ?? null;
  } catch (err) {
    if (err instanceof LsApiError && err.kind === "not_found") return null;
    throw err;
  }
}
async function readSubscription(client, id, signal) {
  const sub = parseSubscription(asSingleData(await client.getJson(`/v1/subscriptions/${encodeURIComponent(id)}`, signal)));
  if (!sub) throw new LsApiError("bad_response", "Lemon Squeezy returned an unreadable subscription.");
  return sub;
}
function createLemonSqueezySource(options = {}) {
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const clientFor = (creds) => createLsClient(creds.apiKey, { fetch: options.fetch, sleep: options.sleep, timeoutMs: options.timeoutMs });
  return {
    id: LEMON_SQUEEZY_ID,
    capabilities: { supportsLiveRefresh: true, supportsApiCancel: true, requiresApiKey: true },
    preset: options.preset ?? lemonSqueezyPresetBase,
    async listAccounts(creds, signal) {
      const client = clientFor(creds);
      const accounts = [];
      for await (const page of client.paginate("/v1/stores?page[size]=100", signal)) {
        for (const item of page.data) {
          const store = parseStore(item);
          if (store) accounts.push({ id: store.id, name: store.name, currency: store.currency });
        }
      }
      return accounts;
    },
    scan(creds, accountId, onProgress, signal) {
      return scanStore(clientFor(creds), accountId, now(), onProgress, signal);
    },
    /** One subscription, live (connected mode at click time, the CLI before cancelling). */
    async refresh(creds, sourceSubscriptionId) {
      const client = clientFor(creds);
      const signal = AbortSignal.timeout(options.timeoutMs ?? 5e3);
      const sub = await readSubscription(client, sourceSubscriptionId, signal);
      const { price, priceId, quantity } = await resolvePrice(client, sub, { byId: /* @__PURE__ */ new Map(), byVariant: /* @__PURE__ */ new Map() }, signal);
      const currency = await storeCurrency(client, sub.storeId, signal);
      return normalizeSubscription({ sub, price, priceId, quantity, currency, now: now() });
    },
    /**
     * DELETE, then read the subscription back: it counts as cancelled only if Lemon Squeezy now
     * shows it cancelled. (Its docs do not say whether DELETE works for PayPal subscriptions, so
     * the result is never assumed; see docs/API_NOTES.md.)
     */
    async cancel(creds, sourceSubscriptionId) {
      const client = clientFor(creds);
      await client.deleteJson(`/v1/subscriptions/${encodeURIComponent(sourceSubscriptionId)}`);
      const after = await readSubscription(client, sourceSubscriptionId);
      if (!after.cancelled && after.status !== "cancelled" && after.status !== "expired") {
        throw new LsApiError(
          "not_cancelled",
          "Lemon Squeezy did not cancel this subscription. Cancel it by hand in the Lemon Squeezy dashboard."
        );
      }
    }
  };
}
async function* scanStore(client, accountId, scanNow, onProgress, signal) {
  const currency = await storeCurrency(client, accountId, signal);
  const cache = { byId: /* @__PURE__ */ new Map(), byVariant: /* @__PURE__ */ new Map() };
  let pagesFetched = 0;
  let skippedRows = 0;
  const path = `/v1/subscriptions?filter[store_id]=${encodeURIComponent(accountId)}&page[size]=100`;
  for await (const page of client.paginate(path, signal)) {
    pagesFetched += 1;
    const rows = [];
    for (const item of page.data) {
      const sub = parseSubscription(item);
      if (sub) rows.push(sub);
      else skippedRows += 1;
    }
    onProgress?.({ accountId, pagesFetched, lastPage: page.lastPage, skippedRows });
    for (const sub of rows) {
      const { stranded, needsReview } = classify(sub);
      const wantsPrice = !sub.testMode && (stranded || needsReview !== null);
      const resolved = wantsPrice ? await resolvePrice(client, sub, cache, signal) : { price: null, priceId: sub.firstItem?.priceId ?? null, quantity: sub.firstItem?.quantity ?? 1 };
      yield normalizeSubscription({ sub, ...resolved, currency, now: scanNow });
    }
  }
}

// cli/src/main.ts
var MRR_LABEL = "list price, in store currency, before discounts and tax";
var HELP = `Lemon Squeezy PayPal subscriber check (${BRAND_NAME} CLI v${CLI_VERSION})

Usage:
  node ${CLI_FILE_NAME} [check] [--json]
  node ${CLI_FILE_NAME} export [--out stranded.json] [--store <id>]
  node ${CLI_FILE_NAME} cancel cancel-list.json [--yes] [--no-verify] [--out cancel-results.json]

Commands:
  check     (default) print the report: PayPal subscribers, revenue at stake, renewals by week.
            Nothing leaves your machine.
  export    write the stranded subscribers of one store to a file you upload to your campaign.
  cancel    cancel the old subscriptions of customers who already re-subscribed, from the
            cancel-list.json your dashboard gives you. Each one is re-checked with Lemon Squeezy
            (and with Stripe when STRIPE_API_KEY holds your restricted key) before anything is
            deleted, and you confirm the final list. Writes cancel-results.json to upload.

The API key is read from LEMONSQUEEZY_API_KEY, or asked for at a hidden prompt. It is never
written to disk. Lemon Squeezy keys are full-access: create a dedicated key, delete it afterwards.

Options:
  --json        (check) print the report as JSON
  --out <file>  (export) where to write the file, default stranded.json
  --store <id>  (export) which store, when the key can see more than one
  --yes         (cancel) skip the confirmation prompt
  --no-verify   (cancel) proceed without checking Stripe (not recommended)
  --out <file>  (cancel) where to write the results, default cancel-results.json
  --help        show this help
  --version     show the version
`;
var UsageError = class extends Error {
};
function parseArgs(argv) {
  const args = { command: "check", json: false, out: "stranded.json", store: null, file: null, yes: false, noVerify: false };
  const rest = [...argv];
  if (rest[0] === "check" || rest[0] === "export" || rest[0] === "cancel") args.command = rest.shift();
  if (args.command === "cancel") args.out = "cancel-results.json";
  while (rest.length) {
    const a = rest.shift();
    if (a === "--help" || a === "-h" || a === "help") return "help";
    if (a === "--version") return "version";
    if (a === "--json" && args.command === "check") args.json = true;
    else if (args.command === "cancel" && a === "--yes") args.yes = true;
    else if (args.command === "cancel" && a === "--no-verify") args.noVerify = true;
    else if (args.command === "cancel" && !a.startsWith("--") && !args.file) args.file = a;
    else if (args.command === "cancel" && a === "--out") {
      const v = rest.shift();
      if (!v || v.startsWith("--")) throw new UsageError("--out needs a value");
      args.out = v;
    } else if ((a === "--out" || a === "--store") && args.command === "export") {
      const v = rest.shift();
      if (!v || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      if (a === "--out") args.out = v;
      else args.store = v;
    } else throw new UsageError(`Unknown option for ${args.command}: ${a}`);
  }
  return args;
}
function readHiddenLine(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((done) => {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk) => data += chunk);
      stdin.on("end", () => done(data.split(/\r?\n/)[0]?.trim() ?? ""));
    });
  }
  return new Promise((done, fail) => {
    process.stderr.write(prompt);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return done(value.trim());
        }
        if (ch === "") {
          finish();
          return fail(new Error("cancelled"));
        }
        if (ch === "\x7F" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}
function bar(n, max, width = 24) {
  return "#".repeat(max ? Math.max(n ? 1 : 0, Math.round(n / max * width)) : 0);
}
function storeText(s, cutoffAt, lines) {
  lines.push(`Store: ${s.accountName}${s.currency ? ` (${s.currency})` : ""}  [id ${s.accountId}]`);
  lines.push(
    `  PayPal subscribers who must re-subscribe: ${s.strandedCount} of ${s.liveCount} live subscriptions (${formatPct(s.paypalSharePct)})`
  );
  lines.push(`  Monthly revenue at stake: ${formatMoney(s.strandedMrrCents, s.currency)}  (${MRR_LABEL})`);
  if (s.mrrUnknownCount) lines.push(`  Not included above: ${s.mrrUnknownCount} on usage-based, tiered or unreadable prices`);
  if (s.inPaymentRetryCount) lines.push(`  Past due (payment being retried): ${s.inPaymentRetryCount}`);
  if (cutoffAt && s.paidBeyondCutoffCount)
    lines.push(`  Already paid through after ${formatDate(cutoffAt)}: ${s.paidBeyondCutoffCount}`);
  if (s.byPlan.length) {
    lines.push("", "  By plan:");
    const width = Math.min(40, Math.max(...s.byPlan.map((p) => `${p.productName} \xB7 ${p.planName ?? "-"}`.length)));
    for (const p of s.byPlan) {
      const name = `${p.productName} \xB7 ${p.planName ?? "-"}`.padEnd(width);
      const unknown = p.mrrUnknownCount ? ` + ${p.mrrUnknownCount} unknown` : "";
      lines.push(`    ${name}  ${String(p.count).padStart(5)}  ${formatMoney(p.monthlyValueCents, s.currency)}/mo${unknown}`);
    }
  }
  const weeks = s.renewalWeeks.filter((w) => w.count > 0);
  if (weeks.length) {
    const max = Math.max(...weeks.map((w) => w.count));
    lines.push("", "  Paid period ends, by week:");
    for (const w of weeks) {
      lines.push(`    ${formatDate(w.weekStart).padEnd(13)} ${String(w.count).padStart(4)}  ${bar(w.count, max)}`);
    }
  }
  const review = Object.entries(s.needsReview).filter(([, n]) => n > 0);
  if (review.length) {
    lines.push("", "  Needs a look (not counted above):");
    for (const [reason, n] of review) lines.push(`    ${n} \xB7 ${NEEDS_REVIEW_LABELS[reason] ?? reason}`);
  }
  lines.push("");
}
function reportText(report) {
  const lines = [`Lemon Squeezy PayPal subscriber check (${BRAND_NAME} CLI v${CLI_VERSION})`];
  if (report.cutoffAt) lines.push(`Lemon Squeezy stops processing payments on ${formatDate(report.cutoffAt)}.`);
  lines.push("");
  if (report.testModeOnly) {
    lines.push("This key only sees test-mode data. Create a live-mode key in Lemon Squeezy and run again.");
    return lines.join("\n");
  }
  if (report.stores.length === 0) {
    lines.push("This key does not have access to any store.");
    return lines.join("\n");
  }
  for (const s of report.stores) storeText(s, report.cutoffAt, lines);
  const mrr = Object.entries(report.totals.mrrByCurrency).map(([c, v]) => formatMoney(v, c === "unknown" ? null : c)).join(" + ");
  lines.push(`Total: ${report.totals.strandedCount} PayPal subscribers must re-subscribe${mrr ? `; ${mrr}/month at list price` : ""}.`);
  if (report.testRowsIgnored) lines.push(`${report.testRowsIgnored} test-mode subscriptions were ignored.`);
  if (report.skippedRows) lines.push(`${report.skippedRows} subscriptions could not be read and were skipped.`);
  if (report.totals.strandedCount > 0 && report.totals.strandedCount < 5) {
    lines.push("", "With fewer than 5 PayPal subscribers, emailing them yourself is probably simplest.");
  }
  if (report.totals.strandedCount > 0) {
    lines.push("", `To start a campaign: node ${CLI_FILE_NAME} export --out stranded.json`);
  }
  return lines.join("\n");
}
async function runCheckCommand(source, apiKey, json, signal) {
  const tty = process.stderr.isTTY;
  const report = await runCheck({
    source,
    creds: { apiKey },
    now: /* @__PURE__ */ new Date(),
    signal,
    onProgress: (p) => {
      const msg = `${p.accountName}: page ${p.pagesFetched}${p.lastPage ? ` of ${p.lastPage}` : ""}`;
      process.stderr.write(tty ? `\r${msg}   ` : `${msg}
`);
    }
  });
  if (tty) process.stderr.write("\r\x1B[K");
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}
` : `${reportText(report)}
`);
  return 0;
}
async function runExportCommand(source, apiKey, args, signal) {
  const creds = { apiKey };
  const accounts = await source.listAccounts(creds, signal);
  let account;
  if (args.store) {
    account = accounts.find((a) => a.id === args.store);
    if (!account) {
      process.stderr.write(`No store with id ${args.store}. Stores this key can see:
${storeList(accounts)}`);
      return 2;
    }
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    process.stderr.write(
      accounts.length === 0 ? "This key does not have access to any store.\n" : `This key can see ${accounts.length} stores. Pick one with --store <id>:
${storeList(accounts)}`
    );
    return 2;
  }
  if (!account) return 2;
  const rows = [];
  const tty = process.stderr.isTTY;
  for await (const row of source.scan(
    creds,
    account.id,
    (p) => {
      const msg = `${account.name}: page ${p.pagesFetched}${p.lastPage ? ` of ${p.lastPage}` : ""}`;
      process.stderr.write(tty ? `\r${msg}   ` : `${msg}
`);
    },
    signal
  )) {
    rows.push(row);
  }
  if (tty) process.stderr.write("\r\x1B[K");
  if (rows.length > 0 && rows.every((r) => r.isTest)) {
    process.stderr.write("This key only sees test-mode data. Create a live-mode key in Lemon Squeezy and run again.\n");
    return 2;
  }
  const { json, file } = writeExport({ sourceProvider: source.id, account, subscriptions: rows, now: /* @__PURE__ */ new Date() });
  const outPath = resolve(args.out);
  writeFileSync(outPath, json, { encoding: "utf8", mode: 384 });
  const stranded = file.subscriptions.filter((s) => s.stranded).length;
  const review = file.subscriptions.length - stranded;
  process.stdout.write(
    [
      `Wrote ${outPath}`,
      `  Store: ${account.name}`,
      `  ${stranded} stranded PayPal subscribers${review ? `, ${review} more flagged for review` : ""}.`,
      "",
      `This file contains customer names and emails. Upload it only in your campaign at ${SITE_URL}.`,
      ""
    ].join("\n")
  );
  return 0;
}
var PAYPAL_FLAGGED = /* @__PURE__ */ new Set(["paused", "unpaid"]);
async function verifyStripe(stripeKey, item) {
  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(item.destSubscriptionId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
      signal: AbortSignal.timeout(15e3)
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return `Stripe: ${body?.error?.message ?? `HTTP ${res.status}`}`;
    if (body?.status !== "active" && body?.status !== "trialing") return `Stripe subscription is ${body?.status ?? "unknown"}`;
    if (body.metadata?.source_subscription_id !== item.sourceSubscriptionId) {
      return "Stripe subscription belongs to another Lemon Squeezy subscription";
    }
    return null;
  } catch {
    return "Could not reach Stripe";
  }
}
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((done) => rl.question(question, done));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
async function runCancelCommand(source, apiKey, args) {
  if (!args.file) {
    process.stderr.write("Pass the cancel-list.json your dashboard gave you: cancel cancel-list.json\n");
    return 2;
  }
  let text;
  try {
    text = readFileSync(resolve(args.file), "utf8");
  } catch {
    process.stderr.write(`Cannot read ${args.file}
`);
    return 2;
  }
  const parsed = parseCancelList(text);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}
`);
    return 2;
  }
  const list = parsed.file;
  const stripeKey = process.env.STRIPE_API_KEY?.trim() ?? "";
  if (stripeKey && !/^rk_(live|test)_/.test(stripeKey)) {
    process.stderr.write("STRIPE_API_KEY must be a restricted key (rk_\u2026). Secret keys are refused.\n");
    return 2;
  }
  if (!stripeKey && !args.noVerify) {
    process.stderr.write(
      "Without STRIPE_API_KEY the CLI cannot check that each customer's new Stripe subscription is active.\nSet STRIPE_API_KEY to your restricted key, or pass --no-verify to continue without that check.\n"
    );
    return 2;
  }
  if (!stripeKey) process.stderr.write("Warning: not verifying with Stripe (--no-verify).\n");
  const creds = { apiKey };
  const results = [];
  const toCancel = [];
  for (const item of list.items) {
    const skip = (reason) => results.push({ sourceSubscriptionId: item.sourceSubscriptionId, outcome: "skipped", reason, overlap: false });
    let live;
    try {
      live = await source.refresh(creds, item.sourceSubscriptionId);
    } catch (err) {
      const kind = err instanceof Error && "kind" in err ? err.kind : null;
      if (kind === "auth") throw err;
      if (kind === "not_found") skip("missing in Lemon Squeezy");
      else {
        results.push({
          sourceSubscriptionId: item.sourceSubscriptionId,
          outcome: "failed",
          reason: err instanceof Error ? err.message : "read failed",
          overlap: false
        });
      }
      continue;
    }
    if (live.state === "cancelled_in_grace" || live.state === "ended") {
      skip("already cancelled");
      continue;
    }
    if (!live.stranded && !PAYPAL_FLAGGED.has(live.needsReview ?? "")) {
      skip("not a PayPal subscription");
      continue;
    }
    if (live.email.trim().toLowerCase() !== item.email.trim().toLowerCase()) {
      skip("email differs from the list");
      continue;
    }
    if (stripeKey) {
      const problem = await verifyStripe(stripeKey, item);
      if (problem) {
        skip(problem);
        continue;
      }
    }
    const overlap = live.paidThrough !== null && live.paidThrough.getTime() > Date.parse(item.cancelBy);
    toCancel.push({ item, overlap });
  }
  const lines = [`Campaign ${list.campaignId}: ${toCancel.length} to cancel, ${results.length} skipped or failed.`, ""];
  for (const t of toCancel) {
    lines.push(
      `  cancel   ${t.item.email}  ${t.item.productName}  (cancel by ${formatDate(t.item.cancelBy)})${t.overlap ? "  [already renewed: refund the latest payment]" : ""}`
    );
  }
  for (const r of results) lines.push(`  ${r.outcome.padEnd(7)}  ${r.sourceSubscriptionId}  ${r.reason ?? ""}`);
  process.stdout.write(`${lines.join("\n")}

`);
  if (toCancel.length && !args.yes && !await confirm(`Cancel these ${toCancel.length} Lemon Squeezy subscriptions? [y/N] `)) {
    process.stderr.write("Nothing cancelled.\n");
    return 1;
  }
  for (const t of toCancel) {
    try {
      await source.cancel(creds, t.item.sourceSubscriptionId);
      results.push({ sourceSubscriptionId: t.item.sourceSubscriptionId, outcome: "cancelled", overlap: t.overlap });
    } catch (err) {
      results.push({
        sourceSubscriptionId: t.item.sourceSubscriptionId,
        outcome: "failed",
        reason: err instanceof Error ? err.message : "cancel failed",
        overlap: t.overlap
      });
    }
  }
  const out = { schemaVersion: 1, campaignId: list.campaignId, completedAt: (/* @__PURE__ */ new Date()).toISOString(), items: results };
  const outPath = resolve(args.out);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}
`, { encoding: "utf8", mode: 384 });
  const done = results.filter((r) => r.outcome === "cancelled").length;
  const failed = results.filter((r) => r.outcome === "failed").length;
  process.stdout.write(`Cancelled ${done}, failed ${failed}. Wrote ${outPath}
Upload it in your campaign at ${SITE_URL} so the dashboard knows.
`);
  return failed ? 1 : 0;
}
function storeList(accounts) {
  return accounts.map((a) => `  ${a.id}  ${a.name}${a.currency ? ` (${a.currency})` : ""}
`).join("");
}
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : "Bad arguments"}

${HELP}`);
    return 2;
  }
  if (args === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args === "version") {
    process.stdout.write(`${CLI_VERSION}
`);
    return 0;
  }
  let apiKey = process.env.LEMONSQUEEZY_API_KEY?.trim() ?? "";
  if (!apiKey) {
    try {
      apiKey = await readHiddenLine("Lemon Squeezy API key (input hidden): ");
    } catch {
      return 130;
    }
  }
  if (!apiKey) {
    process.stderr.write("No API key given. Set LEMONSQUEEZY_API_KEY or paste it at the prompt.\n");
    return 2;
  }
  const ctrl = new AbortController();
  process.once("SIGINT", () => ctrl.abort());
  const source = createLemonSqueezySource();
  try {
    if (args.command === "cancel") return await runCancelCommand(source, apiKey, args);
    return args.command === "export" ? await runExportCommand(source, apiKey, args, ctrl.signal) : await runCheckCommand(source, apiKey, args.json, ctrl.signal);
  } catch (err) {
    if (process.stderr.isTTY) process.stderr.write("\n");
    if (err instanceof CheckAbortedError || err instanceof Error && "kind" in err && err.kind === "aborted") return 130;
    const kind = err instanceof Error && "kind" in err ? err.kind : null;
    process.stderr.write(`${err instanceof Error && err.name === "LsApiError" ? err.message : "Unexpected error."}
`);
    return kind === "auth" ? 2 : 1;
  }
}
main().then(
  (code) => process.exit(code),
  () => process.exit(1)
);
