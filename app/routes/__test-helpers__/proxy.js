import { vi } from "vitest";

/**
 * Build a mock Admin GraphQL client whose `.graphql()` resolves to a response
 * object exposing `.json()` — mirroring the real `@shopify/shopify-app-react-router`
 * admin client used by the proxy routes.
 *
 * @param {object} body  the JSON body the fake `response.json()` should return.
 */
export function mockAdmin(body) {
  const graphql = vi.fn().mockResolvedValue({
    json: async () => body,
  });
  return { admin: { graphql }, graphql };
}

/** A real Request the routes can call `.json()` / read `.method` on. */
export function postRequest(payload, { raw } = {}) {
  return new Request("https://shop.example.com/apps/cart-share/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw !== undefined ? raw : JSON.stringify(payload),
  });
}

export function methodRequest(method) {
  return new Request("https://shop.example.com/apps/cart-share/create", {
    method,
  });
}

export function getRequest() {
  return new Request("https://shop.example.com/apps/cart-share/abc", {
    method: "GET",
  });
}

/** Successful metaobjectCreate response body. */
export function createOk() {
  return {
    data: {
      metaobjectCreate: {
        metaobject: { id: "gid://shopify/Metaobject/1", handle: "h", type: "share_cart" },
        userErrors: [],
      },
    },
  };
}

/** A metaobjectByHandle response body for the open/restore route. */
export function byHandle({ cart, address, expiry } = {}) {
  return {
    data: {
      metaobjectByHandle:
        cart === null
          ? null
          : {
              id: "gid://shopify/Metaobject/1",
              handle: "tok",
              type: "share_cart",
              cartData: { value: typeof cart === "string" ? cart : JSON.stringify(cart) },
              addressData: { value: typeof address === "string" ? address : JSON.stringify(address ?? {}) },
              expiryDate: { value: expiry },
            },
    },
  };
}
