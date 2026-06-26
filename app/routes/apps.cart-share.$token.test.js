import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../shopify.server", () => ({
  authenticate: { public: { appProxy: vi.fn() } },
}));

import { authenticate } from "../shopify.server";
import { loader } from "./apps.cart-share.$token.jsx";
import { mockAdmin, getRequest, byHandle } from "./__test-helpers__/proxy.js";

const appProxy = authenticate.public.appProxy;

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + DAY).toISOString();
const past = () => new Date(Date.now() - DAY).toISOString();

/** Run the loader and return { status, html }. */
async function open(token, admin) {
  appProxy.mockResolvedValue({ admin });
  const res = await loader({ request: getRequest(), params: { token } });
  return { status: res.status ?? 200, html: await res.text() };
}

describe("GET /apps/cart-share/:token", () => {
  beforeEach(() => vi.clearAllMocks());

  // ---- Guards -------------------------------------------------------------
  it("returns 403 when the app is not installed", async () => {
    const { status, html } = await open("tok", undefined);
    expect(status).toBe(403);
    expect(html).toMatch(/not enabled cart sharing/i);
  });

  it("returns 404 when no token is supplied", async () => {
    appProxy.mockResolvedValue({ admin: {} });
    const res = await loader({ request: getRequest(), params: {} });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an invalid/unknown token", async () => {
    const { admin } = mockAdmin(byHandle({ cart: null }));
    const { status, html } = await open("missing", admin);
    expect(status).toBe(404);
    expect(html).toMatch(/not valid/i);
  });

  // ---- Expiry --------------------------------------------------------------
  it("returns 410 for an expired link", async () => {
    const { admin } = mockAdmin(
      byHandle({ cart: { items: [{ variantId: 1, quantity: 1 }] }, expiry: past() }),
    );
    const { status, html } = await open("tok", admin);
    expect(status).toBe(410);
    expect(html).toMatch(/expired/i);
  });

  it("treats a missing/garbage expiry as expired (410)", async () => {
    const { admin } = mockAdmin(
      byHandle({ cart: { items: [{ variantId: 1, quantity: 1 }] }, expiry: "not-a-date" }),
    );
    const { status } = await open("tok", admin);
    expect(status).toBe(410);
  });

  // ---- Corrupt / empty data ------------------------------------------------
  it("returns 422 when stored cart JSON is corrupted", async () => {
    const { admin } = mockAdmin(byHandle({ cart: "{broken", expiry: future() }));
    const { status, html } = await open("tok", admin);
    expect(status).toBe(422);
    expect(html).toMatch(/corrupted/i);
  });

  it("returns 422 when the shared cart has no items", async () => {
    const { admin } = mockAdmin(byHandle({ cart: { items: [] }, expiry: future() }));
    const { status } = await open("tok", admin);
    expect(status).toBe(422);
  });

  // ---- Success page --------------------------------------------------------
  it("renders the restore page with item count, address and embedded items", async () => {
    const { admin } = mockAdmin(
      byHandle({
        cart: { items: [{ variantId: 123, quantity: 2 }, { variantId: 456, quantity: 1 }] },
        address: { firstName: "John", lastName: "Doe", city: "Bangalore", zip: "560001", country: "India" },
        expiry: future(),
      }),
    );
    const { status, html } = await open("tok", admin);
    expect(status).toBe(200);
    expect(html).toMatch(/add 2 items/i);
    expect(html).toContain("John Doe");
    expect(html).toContain("Bangalore");
    expect(html).toContain("560001");
    expect(html).toContain('id="continue"');
    // Items embedded for the client-side /cart/add.js restore.
    expect(html).toContain('"variantId":123');
    // Defaults to replacing the cart.
    expect(html).toContain("REPLACE_CART = true");
    // Should not be indexed.
    expect(html).toContain('name="robots"');
  });

  it("singular item count copy ('1 item')", async () => {
    const { admin } = mockAdmin(
      byHandle({ cart: { items: [{ variantId: 1, quantity: 1 }] }, expiry: future() }),
    );
    const { html } = await open("tok", admin);
    expect(html).toMatch(/add 1 item\b/i);
  });

  it("honours replace:false (merge mode)", async () => {
    const { admin } = mockAdmin(
      byHandle({ cart: { items: [{ variantId: 1, quantity: 1 }], replace: false }, expiry: future() }),
    );
    const { html } = await open("tok", admin);
    expect(html).toContain("REPLACE_CART = false");
  });

  it("renders correctly when no address was shared (Scenario address-off via token)", async () => {
    const { admin } = mockAdmin(
      byHandle({ cart: { items: [{ variantId: 1, quantity: 1 }] }, address: {}, expiry: future() }),
    );
    const { status, html } = await open("tok", admin);
    expect(status).toBe(200);
    expect(html).toContain('id="continue"');
  });

  // ---- Security: XSS-safe rendering ---------------------------------------
  it("escapes HTML in address fields (no XSS injection)", async () => {
    const { admin } = mockAdmin(
      byHandle({
        cart: { items: [{ variantId: 1, quantity: 1 }] },
        address: { address1: "<img src=x onerror=alert(1)>" },
        expiry: future(),
      }),
    );
    const { html } = await open("tok", admin);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes </script> in embedded item JSON", async () => {
    const { admin } = mockAdmin(
      byHandle({
        cart: { items: [{ variantId: 1, quantity: 1, properties: { note: "</script>" } }] },
        expiry: future(),
      }),
    );
    const { html } = await open("tok", admin);
    // safeJson() turns "<" into the < escape so the script tag can't break out.
    expect(html).not.toContain("</script>\"");
    expect(html).toContain("\\u003c/script>");
  });
});
