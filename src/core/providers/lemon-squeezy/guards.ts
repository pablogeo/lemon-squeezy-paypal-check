// Hand-written type guards for Lemon Squeezy's JSON:API payloads.
// Defensive by design: unknown fields are ignored, optional fields may be missing,
// and a malformed row is skipped (and counted) instead of failing the whole scan.

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** LS uses integers for IDs inside attributes and strings at the resource level. */
export function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/** LS timestamps carry microseconds ("2022-11-12T00:00:00.000000Z"); normalise to milliseconds. */
export function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = ISO_RE.exec(value);
  if (!m) return null;
  const ms = (m[2] ?? '').padEnd(3, '0').slice(0, 3);
  const d = new Date(`${m[1]}.${ms}${m[3]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type LsResource = { id: string; type: string; attributes: JsonRecord };

export function asResource(value: unknown, expectedType: string): LsResource | null {
  if (!isRecord(value)) return null;
  const id = asId(value.id);
  const type = asString(value.type);
  if (!id || type !== expectedType || !isRecord(value.attributes)) return null;
  return { id, type, attributes: value.attributes };
}

export type LsListBody = {
  data: unknown[];
  next: string | null;
  currentPage: number | null;
  lastPage: number | null;
};

export function asListBody(value: unknown): LsListBody | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const links = isRecord(value.links) ? value.links : {};
  const meta = isRecord(value.meta) && isRecord(value.meta.page) ? value.meta.page : {};
  return {
    data: value.data,
    next: asNonEmptyString(links.next),
    currentPage: asNumber(meta.currentPage),
    lastPage: asNumber(meta.lastPage),
  };
}

export function asSingleData(value: unknown): unknown {
  return isRecord(value) ? value.data : undefined;
}

// --- Typed views of the attributes we use ---------------------------------------------

export type LsSubscription = {
  id: string;
  storeId: string;
  customerId: string | null;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  userName: string | null;
  userEmail: string;
  status: string;
  cardBrand: string | null;
  paymentProcessor: string | null;
  cancelled: boolean;
  renewsAt: Date | null;
  endsAt: Date | null;
  firstItem: { priceId: string | null; quantity: number } | null;
  testMode: boolean;
};

export function parseSubscription(value: unknown): LsSubscription | null {
  const res = asResource(value, 'subscriptions');
  if (!res) return null;
  const a = res.attributes;
  const storeId = asId(a.store_id);
  const userEmail = asNonEmptyString(a.user_email);
  const status = asNonEmptyString(a.status);
  if (!storeId || !userEmail || !status) return null;

  let firstItem: LsSubscription['firstItem'] = null;
  if (isRecord(a.first_subscription_item)) {
    const q = asNumber(a.first_subscription_item.quantity);
    firstItem = {
      priceId: asId(a.first_subscription_item.price_id),
      quantity: q !== null && Number.isInteger(q) && q > 0 ? q : 1,
    };
  }

  return {
    id: res.id,
    storeId,
    customerId: asId(a.customer_id),
    variantId: asId(a.variant_id),
    productName: asNonEmptyString(a.product_name) ?? 'Unknown product',
    variantName: asNonEmptyString(a.variant_name),
    userName: asNonEmptyString(a.user_name),
    userEmail,
    status,
    cardBrand: asNonEmptyString(a.card_brand),
    paymentProcessor: asNonEmptyString(a.payment_processor),
    cancelled: asBoolean(a.cancelled) ?? status === 'cancelled',
    renewsAt: asDate(a.renews_at),
    endsAt: asDate(a.ends_at),
    firstItem,
    testMode: asBoolean(a.test_mode) ?? false,
  };
}

export type LsPrice = {
  id: string;
  variantId: string | null;
  category: string | null;
  scheme: string | null;
  usageAggregation: string | null;
  unitPrice: number | null;
  renewalIntervalUnit: string | null;
  renewalIntervalQuantity: number | null;
  createdAt: Date | null;
};

export function parsePrice(value: unknown): LsPrice | null {
  const res = asResource(value, 'prices');
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
    createdAt: asDate(a.created_at),
  };
}

export type LsStore = { id: string; name: string; currency: string | null };

export function parseStore(value: unknown): LsStore | null {
  const res = asResource(value, 'stores');
  if (!res) return null;
  const currency = asNonEmptyString(res.attributes.currency);
  return {
    id: res.id,
    name: asNonEmptyString(res.attributes.name) ?? `Store ${res.id}`,
    currency: currency ? currency.toUpperCase() : null,
  };
}
