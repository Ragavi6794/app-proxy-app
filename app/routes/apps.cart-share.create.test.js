import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Shopify server module BEFORE importing the route (vi.mock is hoisted).
vi.mock("../shopify.server", () => ({
  authenticate: { public: { appProxy: vi.fn() } },
}));

import { authenticate } from "../shopify.server";
import { action, loader } from "./apps.cart-share.create.jsx";
import {
  mockAdmin,
  postRequest,
  methodRequest,
  createOk,
} from "./__test-helpers__/proxy.js";

const appProxy = authenticate.public.appProxy;

/** Run the action and return { status, body } with parsed JSON. */
async function run(request, admin) {
  appProxy.mockResolvedValue({ admin });
  const res = await action({ request });
  return { status: res.status ?? 200, body: await res.json(), res };
}

describe("POST /apps/cart-share/create", () => {
  beforeEach(() => vi.clearAllMocks());

  // ---- Guards -------------------------------------------------------------
  it("rejects non-POST methods with 405", async () => {
    appProxy.mockResolvedValue({ admin: {} });
    const res = await action({ request: methodRequest("GET") });
    expect(res.status).toBe(405);
  });

  it("returns 503 NO_OFFLINE_SESSION when there is no offline session (admin undefined)", async () => {
    const { status, body } = await run(postRequest({ items: [{ variantId: 1, quantity: 1 }] }), undefined);
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NO_OFFLINE_SESSION");
  });

  it("returns 400 on invalid JSON body", async () => {
    const { admin } = mockAdmin(createOk());
    appProxy.mockResolvedValue({ admin });
    const res = await action({ request: postRequest(null, { raw: "{not json" }) });
    expect(res.status).toBe(400);
  });

  it("returns 422 when the cart has no items", async () => {
    const { admin } = mockAdmin(createOk());
    const { status, body } = await run(postRequest({ items: [] }), admin);
    expect(status).toBe(422);
    expect(body.error).toMatch(/empty/i);
  });

  // ---- Payload shape A: { items, shippingAddress } (current theme) --------
  it("accepts shape A {items, shippingAddress} and returns a token URL", async () => {
    const { admin, graphql } = mockAdmin(createOk());
    const { status, body } = await run(
      postRequest({
        items: [{ variantId: 123456789, quantity: 2 }],
        shippingAddress: { firstName: "John", city: "Bangalore" },
      }),
      admin,
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{24}$/); // 12 random bytes -> 24 hex chars
    expect(body.shareUrl).toBe(`/apps/cart-share/${body.token}`);
    expect(body.expiresAt).toEqual(expect.any(String));

    // Metaobject created with handle == token and the four expected fields.
    const vars = graphql.mock.calls[0][1].variables.metaobject;
    expect(vars.type).toBe("share_cart");
    expect(vars.handle).toBe(body.token);
    const fields = Object.fromEntries(vars.fields.map((f) => [f.key, f.value]));
    expect(JSON.parse(fields.cart_data).items).toEqual([{ variantId: 123456789, quantity: 2 }]);
    expect(JSON.parse(fields.address_data)).toEqual({ firstName: "John", city: "Bangalore" });
    expect(fields.token).toBe(body.token);
  });

  // ---- Payload shape B: { cart_data, address_data } (spec example) --------
  it("accepts shape B {cart_data, address_data} (spec payload)", async () => {
    const { admin, graphql } = mockAdmin(createOk());
    const { status, body } = await run(
      postRequest({
        cart_data: { items: [{ variantId: 1, quantity: 1 }] },
        address_data: { firstName: "Jane", zip: "560001", country: "India" },
      }),
      admin,
    );

    expect(status).toBe(200);
    const fields = Object.fromEntries(
      graphql.mock.calls[0][1].variables.metaobject.fields.map((f) => [f.key, f.value]),
    );
    expect(JSON.parse(fields.cart_data).items).toHaveLength(1);
    expect(JSON.parse(fields.address_data).zip).toBe("560001");
  });

  // ---- PII safety: address goes to storage, NOT into the returned URL -----
  it("keeps PII out of the share URL (token only)", async () => {
    const { admin } = mockAdmin(createOk());
    const { body } = await run(
      postRequest({
        items: [{ variantId: 1, quantity: 1 }],
        shippingAddress: { firstName: "John", phone: "9876543210", address1: "123 Street" },
      }),
      admin,
    );
    expect(body.shareUrl).not.toMatch(/John|9876543210|123 Street/);
    expect(body.shareUrl).toBe(`/apps/cart-share/${body.token}`);
  });

  // ---- Preserves note / attributes / replace flag -------------------------
  it("preserves cart note, attributes and the replace flag", async () => {
    const { admin, graphql } = mockAdmin(createOk());
    await run(
      postRequest({
        cart_data: {
          items: [{ variantId: 1, quantity: 1 }],
          note: "gift",
          attributes: { source: "share" },
          replace: false,
        },
      }),
      admin,
    );
    const cart = JSON.parse(
      Object.fromEntries(
        graphql.mock.calls[0][1].variables.metaobject.fields.map((f) => [f.key, f.value]),
      ).cart_data,
    );
    expect(cart.note).toBe("gift");
    expect(cart.attributes).toEqual({ source: "share" });
    expect(cart.replace).toBe(false);
  });

  // ---- Line item properties / bundles / selling plans survive ------------
  it("preserves line item properties and selling plans (bundles/subscriptions)", async () => {
    const { admin, graphql } = mockAdmin(createOk());
    await run(
      postRequest({
        items: [
          {
            variantId: 1,
            quantity: 1,
            properties: { engraving: "Hi" },
            selling_plan: 999,
          },
        ],
      }),
      admin,
    );
    const items = JSON.parse(
      Object.fromEntries(
        graphql.mock.calls[0][1].variables.metaobject.fields.map((f) => [f.key, f.value]),
      ).cart_data,
    ).items;
    expect(items[0].properties).toEqual({ engraving: "Hi" });
    expect(items[0].selling_plan).toBe(999);
  });

  // ---- 7-day expiry --------------------------------------------------------
  it("sets a ~7-day expiry", async () => {
    const { admin } = mockAdmin(createOk());
    const before = Date.now();
    const { body } = await run(postRequest({ items: [{ variantId: 1, quantity: 1 }] }), admin);
    const ttl = Date.parse(body.expiresAt) - before;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(ttl).toBeGreaterThan(sevenDays - 5000);
    expect(ttl).toBeLessThanOrEqual(sevenDays + 5000);
  });

  // ---- GraphQL / userErrors surfaced --------------------------------------
  it("returns 502 on transport-level GraphQL errors", async () => {
    const { admin } = mockAdmin({ errors: [{ message: "Throttled" }] });
    const { status, body } = await run(postRequest({ items: [{ variantId: 1, quantity: 1 }] }), admin);
    expect(status).toBe(502);
    expect(body.details).toBeTruthy();
  });

  it("returns 422 on metaobject userErrors", async () => {
    const { admin } = mockAdmin({
      data: { metaobjectCreate: { metaobject: null, userErrors: [{ field: ["handle"], message: "taken" }] } },
    });
    const { status, body } = await run(postRequest({ items: [{ variantId: 1, quantity: 1 }] }), admin);
    expect(status).toBe(422);
    expect(body.details).toHaveLength(1);
  });

  // ---- loader (wrong verb) ------------------------------------------------
  it("loader (GET) returns 405 telling callers to POST", async () => {
    appProxy.mockResolvedValue({ admin: {} });
    const res = await loader({ request: methodRequest("GET") });
    expect(res.status).toBe(405);
  });

  // ---- token uniqueness ----------------------------------------------------
  it("generates a unique token per request", async () => {
    const { admin } = mockAdmin(createOk());
    const a = await run(postRequest({ items: [{ variantId: 1, quantity: 1 }] }), admin);
    const b = await run(postRequest({ items: [{ variantId: 1, quantity: 1 }] }), admin);
    expect(a.body.token).not.toBe(b.body.token);
  });
});
