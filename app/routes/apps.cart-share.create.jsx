import { randomBytes } from "node:crypto";
import { authenticate } from "../shopify.server";

/**
 * App Proxy endpoint: POST /apps/cart-share/create
 *
 * Called by theme JS after the customer fills the delivery-address modal.
 * Accepts EITHER payload shape:
 *   A) { items: [...], note, attributes, shippingAddress }      (current theme)
 *   B) { cart_data: { items: [...] }, address_data: {...} }     (spec example)
 *
 * Responds with: { ok, token, shareUrl: "/apps/cart-share/<token>", expiresAt }
 */

const METAOBJECT_TYPE = "share_cart";
const EXPIRY_DAYS = 7;

const CREATE_SHARE_CART = `#graphql
  mutation CreateShareCart($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle type }
      userErrors { field message code }
    }
  }
`;

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function generateToken() {
  return randomBytes(12).toString("hex"); // 24 lowercase hex chars = valid handle
}

export const action = async ({ request }) => {
  console.log("SHARE CART CREATE ROUTE HIT");

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  // Verifies the App Proxy HMAC signature (throws 401 if invalid).
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) {
    return json({ ok: false, error: "App is not installed on this shop." }, { status: 403 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // --- Normalise BOTH payload shapes -----------------------------------------
  const cd = payload?.cart_data;
  const items = Array.isArray(cd?.items)
    ? cd.items
    : Array.isArray(payload?.items)
    ? payload.items
    : null;

  if (!items || items.length === 0) {
    return json({ ok: false, error: "Cart is empty (no items)." }, { status: 422 });
  }

  // Preserve cart-level note + attributes from either shape.
  const cartData = {
    items,
    note: cd?.note ?? payload?.note ?? "",
    attributes: cd?.attributes ?? payload?.attributes ?? {},
  };
  if (cd?.replace !== undefined) cartData.replace = cd.replace;

  const addressData =
    payload?.address_data || payload?.shippingAddress || {};

  // --- Create the metaobject (handle == token for O(1) lookup) ---------------
  const token = generateToken();
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const response = await admin.graphql(CREATE_SHARE_CART, {
    variables: {
      metaobject: {
        type: METAOBJECT_TYPE,
        handle: token,
        fields: [
          { key: "token", value: token },
          { key: "cart_data", value: JSON.stringify(cartData) },
          { key: "address_data", value: JSON.stringify(addressData) },
          { key: "expiry_date", value: expiresAt },
        ],
      },
    },
  });

  const body = await response.json();
  const userErrors = body?.data?.metaobjectCreate?.userErrors ?? [];

  // Surface GraphQL-level errors too (e.g. missing scope, bad field key).
  if (body?.errors?.length) {
    return json({ ok: false, error: "GraphQL error.", details: body.errors }, { status: 502 });
  }
  if (userErrors.length > 0) {
    return json({ ok: false, error: "Could not create share link.", details: userErrors }, { status: 422 });
  }

  return json({ ok: true, token, shareUrl: `/apps/cart-share/${token}`, expiresAt });
};

export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);
  return json({ ok: false, error: "Use POST to create a share link." }, { status: 405 });
};
