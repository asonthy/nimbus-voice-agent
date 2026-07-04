/**
 * Client-side tool implementations.
 * All tools read/write localStorage["nimbus_cart"] directly.
 * Returns { result, latency_ms }.
 */

const CART_KEY = "nimbus_cart";

function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || "[]");
  } catch { return []; }
}

function saveCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  // Trigger cart UI repaint if cart.js is loaded
  try { window._nimbusCartPaint?.(); } catch {}
}

function timed(fn) {
  return async (...args) => {
    const t0 = performance.now();
    const result = await fn(...args);
    return { result, latency_ms: Math.round(performance.now() - t0) };
  };
}

export const tools = {
  get_cart_items: timed(async () => loadCart()),

  get_cart_total: timed(async () => {
    const items = loadCart();
    const total = items.reduce((s, i) => s + (i.price || 0) * (i.seats || 1), 0);
    return { total: parseFloat(total.toFixed(2)), items: items.length };
  }),

  add_to_cart: timed(async ({ product_name, tier_name, seats = 1 }) => {
    // Try to call cart.js addToCart if exposed on window
    if (window.addToCart) {
      await window.addToCart(product_name, tier_name, seats);
      return { success: true, cart_length: loadCart().length };
    }
    // Fallback: look up from catalog
    const catalog = await _getCatalog();
    const product = catalog.products.find(
      (p) => p.name.toLowerCase() === product_name.toLowerCase()
    );
    if (!product) return { success: false, error: `Product not found: ${product_name}` };
    const tier = product.tiers?.find(
      (t) => t.name.toLowerCase() === tier_name.toLowerCase()
    );
    if (!tier) return { success: false, error: `Tier not found: ${tier_name}` };
    const price = tier.priceAnnualMonthly ?? tier.priceMonthly ?? 0;
    const items = loadCart();
    const existing = items.find(
      (i) => i.product_id === product.id && i.tier === tier.name
    );
    if (existing) {
      existing.seats += seats;
    } else {
      items.push({
        product_id: product.id,
        product_name: product.name,
        tier: tier.name,
        seats,
        price,
      });
    }
    saveCart(items);
    return { success: true, cart_length: items.length };
  }),

  remove_from_cart: timed(async ({ index }) => {
    const items = loadCart();
    if (index < 0 || index >= items.length) return { success: false, error: "Index out of range" };
    items.splice(index, 1);
    saveCart(items);
    return { success: true, cart_length: items.length };
  }),

  clear_cart: timed(async () => {
    saveCart([]);
    return { success: true };
  }),

  checkout_all: timed(async () => {
    const items = loadCart();
    const orderId = "NB-" + Math.abs(
      items.reduce((h, i) => Math.imul(31, h) + i.product_id?.charCodeAt?.(0) || 0, 0)
    ).toString(36).slice(0, 6);
    saveCart([]);
    return { success: true, order_id: orderId, items_count: items.length };
  }),

  checkout_item: timed(async ({ index }) => {
    const items = loadCart();
    if (index < 0 || index >= items.length) return { success: false, error: "Index out of range" };
    const item = items.splice(index, 1)[0];
    saveCart(items);
    const orderId = "NB-" + Math.abs(
      (item.product_id || "x").charCodeAt(0) * 31 + Date.now()
    ).toString(36).slice(0, 6);
    return { success: true, order_id: orderId, item };
  }),

  get_pricing_annual: timed(async ({ product_name, tier_name }) => {
    const catalog = await _getCatalog();
    const product = _findProduct(catalog, product_name);
    if (!product) return { error: `Not found: ${product_name}` };
    const tier = _findTier(product, tier_name);
    if (!tier) return { error: `Tier not found: ${tier_name}` };
    const monthly = tier.priceAnnualMonthly ?? tier.priceMonthly ?? 0;
    return {
      product: product.name,
      tier: tier.name,
      monthly_billed_annually: monthly,
      annual_total: parseFloat((monthly * 12).toFixed(2)),
    };
  }),

  calculate_savings: timed(async ({ product_name, tier_name }) => {
    const catalog = await _getCatalog();
    const product = _findProduct(catalog, product_name);
    if (!product) return { error: `Not found: ${product_name}` };
    const tier = _findTier(product, tier_name);
    if (!tier) return { error: `Tier not found: ${tier_name}` };
    const monthly = tier.priceMonthly ?? 0;
    const annual = tier.priceAnnualMonthly ?? monthly;
    if (!monthly) return { savings_pct: 0 };
    const pct = ((monthly - annual) / monthly) * 100;
    return {
      product: product.name,
      tier: tier.name,
      monthly_price: monthly,
      annual_monthly_price: annual,
      savings_pct: parseFloat(pct.toFixed(1)),
      savings_per_user_per_year: parseFloat(((monthly - annual) * 12).toFixed(2)),
    };
  }),

  sort_products: timed(async ({ order = "asc" }) => {
    const catalog = await _getCatalog();
    const withPrice = catalog.products.map((p) => {
      const paid = (p.tiers || []).filter(
        (t) => !t.custom && (t.priceMonthly || 0) > 0
      );
      const min = paid.length ? Math.min(...paid.map((t) => t.priceMonthly)) : Infinity;
      return { name: p.name, category: p.category, starting_price: min === Infinity ? null : min };
    });
    withPrice.sort((a, b) => {
      const pa = a.starting_price ?? (order === "asc" ? Infinity : -Infinity);
      const pb = b.starting_price ?? (order === "asc" ? Infinity : -Infinity);
      return order === "asc" ? pa - pb : pb - pa;
    });
    return withPrice;
  }),

  get_top_k_expensive: timed(async ({ k = 5 }) => {
    const catalog = await _getCatalog();
    const withPrice = catalog.products.map((p) => {
      const paid = (p.tiers || []).filter((t) => !t.custom && t.priceMonthly != null);
      const max = paid.length ? Math.max(...paid.map((t) => t.priceMonthly)) : 0;
      return { name: p.name, category: p.category, max_monthly_price: max };
    });
    withPrice.sort((a, b) => b.max_monthly_price - a.max_monthly_price);
    return withPrice.slice(0, k);
  }),
};

let _catalogCache = null;

async function _getCatalog() {
  if (_catalogCache) return _catalogCache;
  const res = await fetch("/data/catalog.json");
  _catalogCache = await res.json();
  return _catalogCache;
}

function _findProduct(catalog, name) {
  const lname = name.toLowerCase();
  return catalog.products.find(
    (p) => p.name.toLowerCase() === lname || p.id.toLowerCase() === lname
  );
}

function _findTier(product, name) {
  const lname = name.toLowerCase();
  return (product.tiers || []).find((t) => t.name.toLowerCase() === lname);
}

export async function dispatch(toolName, args) {
  const fn = tools[toolName];
  if (!fn) return { result: null, latency_ms: 0, error: `Unknown tool: ${toolName}` };
  try {
    return await fn(args || {});
  } catch (err) {
    return { result: null, latency_ms: 0, error: err.message };
  }
}
