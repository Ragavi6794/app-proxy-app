# Share Cart — Full Implementation Documentation

A configurable "Share Cart" feature for Shopify, built with a **Shopify React Router app**
(`@shopify/shopify-app-react-router`, the successor to the Remix template) + **App Proxy** +
**Metaobjects**. Works on both **Shopify Plus and Non‑Plus** stores.

- **App (this repo):** `share-cart-app` — proxy routes, Admin GraphQL, metaobject storage.
- **Theme (separate):** `R&D store` theme — the storefront button, modal, and merchant settings.
- **Live host:** `https://app-proxy-app.onrender.com` (Render) — stable URL, no tunnel.
- **Dev store:** `rnd-store-9869.myshopify.com`.

---

## 1. Requirement

Implement a configurable Share Cart that lets a merchant:

1. **Enable / disable** the feature (hide the CTA when off).
2. **Optionally include the delivery address** in the shared link.

### Scenario 1 — Share enabled, address sharing OFF
Use a native **Shopify cart permalink** (variant IDs + quantities):

```
https://store.com/cart/123456789:2,987654321:1
```

### Scenario 2 — Share enabled, address sharing ON
Cart permalinks can't carry an address, so use a **token‑based URL**. The cart + address are
stored server‑side in a **metaobject** keyed by a token; only the token appears in the URL:

```
https://store.com/apps/cart-share/{token}
```

Opening the link restores the cart (Ajax Cart API), shows the address for confirmation, and
continues to the cart page. Invalid/expired links are handled gracefully and **no PII is exposed in the URL**.

---

## 2. Architecture & data flow

```
                    ┌─────────────────────────────────────────────────────────┐
   CREATE (Scenario 2)                                                          │
                    │                                                           │
  Theme JS  ──POST /apps/cart-share/create──▶  App Proxy  ──▶  Remix App        │
 (share-cart.js)        (storefront domain)     (Shopify)      (Render)         │
                                                                  │             │
                                                    authenticate.public.appProxy│  HMAC verify
                                                                  │             │
                                                          Admin GraphQL         │
                                                        metaobjectCreate        │
                                                                  │             │
                                                       Metaobject "share_cart"  │
                                                       (token, cart_data,       │
                                                        address_data, expiry)   │
                                                                  │             │
                    ◀────────  { shareUrl: /apps/cart-share/<token> }  ─────────┘

                    ┌─────────────────────────────────────────────────────────┐
   OPEN / RESTORE                                                               │
                    │                                                           │
  Customer opens  ──GET /apps/cart-share/<token>──▶ App Proxy ──▶ Remix App     │
                                                                  │             │
                                                    authenticate.public.appProxy│
                                                                  │             │
                                                          Admin GraphQL         │
                                                       metaobjectByHandle       │
                                                                  │             │
                                              expiry check ─▶ self-contained HTML│
                                                                  │             │
                       /cart/clear.js + /cart/add.js  ◀──── browser runs page   │
                       (restore) → address confirm → "Continue to cart" → /cart │
                    └─────────────────────────────────────────────────────────┘
```

---

## 3. Why these building blocks (design rationale)

| Choice | Why |
|---|---|
| **App Proxy** | Lets storefront JS call our app on the shop's **own domain** (`/apps/cart-share/...`). Same‑origin, so `/cart.js`, `/cart/add.js`, `/cart` all work without CORS. Shopify signs every request (HMAC) so the app can trust it. |
| **Metaobject (not a custom DB table)** | Native Shopify storage, visible/manageable in admin (Content → Metaobjects), no extra DB to host. The token is the metaobject **handle**, giving O(1) lookup via `metaobjectByHandle`. |
| **Token in URL, data in metaobject** | Keeps **PII (address) out of the URL**. The opaque token is the only thing shared; the address never appears in the link, logs, or referrers. |
| **Cart permalink for Scenario 1** | When there's no address, Shopify's built‑in permalink (`/cart/{variant}:{qty}`) is the simplest, zero‑storage way to share — works on any store. |
| **Self‑contained HTML for the restore page** | The proxy returns plain `text/html` (not `application/liquid`), so the restore page is a standalone page that runs the Ajax Cart calls itself — no theme dependency. |
| **React Router app template** | First‑class `authenticate.public.appProxy` (automatic HMAC verification), Admin GraphQL client, session storage, and CLI tooling. |

---

## 4. Implementation — App (this repo)

### 4.1 App proxy configuration — `shopify.app.toml`

```toml
[access_scopes]
scopes = "write_app_proxy,write_products,write_metaobjects,write_metaobject_definitions,read_metaobjects"

[app_proxy]
url    = "https://app-proxy-app.onrender.com/apps/cart-share"
subpath = "cart-share"
prefix  = "apps"
```

**Key rules learned (and why):**
- `write_app_proxy` scope is **required** to configure/update the proxy.
- Shopify **strips** `prefix`+`subpath` (`/apps/cart-share`) from the storefront path and **appends the
  remainder** to the proxy `url`. So `url` must **end in `/apps/cart-share`** for the forwarded path to
  match the `apps.cart-share.*` route files:
  - `/apps/cart-share/create`  → `{url}/create`  → `…/apps/cart-share/create` → route `apps.cart-share.create`
  - `/apps/cart-share/<token>` → `{url}/<token>` → `…/apps/cart-share/<token>` → route `apps.cart-share.$token`
- Use an **absolute** `url`. A relative `url` (`/apps/cart-share`) gets resolved to just the host (path
  dropped) → Shopify forwarded to `{app}/create` → **404 "No route matches /create"**.

### 4.2 Metaobject definition — type `share_cart`

| Field | Type |
|---|---|
| `token` | `single_line_text_field` |
| `cart_data` | `json` |
| `address_data` | `json` |
| `expiry_date` | `date_time` |

The **handle == token**, so lookups use `metaobjectByHandle`. (Created in admin as a merchant‑owned
definition. Note: declaring it under `[metaobjects.app.*]` in the toml would create a *separate*
app‑owned type `app--<id>--share_cart` that the code does **not** use — so it is intentionally left
out of the toml.)

### 4.3 Create route — `app/routes/apps.cart-share.create.jsx`

Handles **POST `/apps/cart-share/create`**.

```js
import { randomBytes } from "node:crypto";
import { authenticate } from "../shopify.server";

const CREATE_SHARE_CART = `#graphql
  mutation CreateShareCart($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle type }
      userErrors { field message code }
    }
  }`;

export const action = async ({ request }) => {
  // 1) Verify the App Proxy HMAC signature (throws 401 if invalid/missing).
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) return json({ ok: false, error: "App is not installed." }, { status: 403 });

  // 2) Accept BOTH payload shapes: {cart_data, address_data} or {items, shippingAddress}.
  const payload = await request.json();
  const items = payload?.cart_data?.items ?? payload?.items;
  const addressData = payload?.address_data ?? payload?.shippingAddress ?? {};
  const cartData = { items, note: payload?.note ?? "", attributes: payload?.attributes ?? {} };

  // 3) Token = metaobject handle; 7‑day expiry.
  const token = randomBytes(12).toString("hex");              // 24 hex chars
  const expiresAt = new Date(Date.now() + 7 * 864e5).toISOString();

  // 4) Create the metaobject via Admin GraphQL.
  const res = await admin.graphql(CREATE_SHARE_CART, { variables: { metaobject: {
    type: "share_cart",
    handle: token,
    fields: [
      { key: "token",        value: token },
      { key: "cart_data",    value: JSON.stringify(cartData) },
      { key: "address_data", value: JSON.stringify(addressData) },
      { key: "expiry_date",  value: expiresAt },
    ],
  }}});

  // 5) Return the share URL.
  return json({ ok: true, token, shareUrl: `/apps/cart-share/${token}`, expiresAt });
};
```

### 4.4 Open/restore route — `app/routes/apps.cart-share.$token.jsx`

Handles **GET `/apps/cart-share/:token`** and returns a self‑contained HTML page.

```js
const GET_SHARE_CART = `#graphql
  query GetShareCart($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      cartData:    field(key: "cart_data")    { value }
      addressData: field(key: "address_data") { value }
      expiryDate:  field(key: "expiry_date")  { value }
    }
  }`;

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.public.appProxy(request);          // HMAC verify

  const mo = (await (await admin.graphql(GET_SHARE_CART, {
    variables: { handle: { type: "share_cart", handle: params.token } },
  })).json()).data?.metaobjectByHandle;

  if (!mo)                          return messagePage("This share link is not valid", 404);
  if (Date.parse(mo.expiryDate.value) <= Date.now())
                                    return messagePage("This share link has expired", 410);

  // → returns text/html page that restores the cart and confirms the address
};
```

**The returned page (browser‑side) logic:**
- Normalizes items to `/cart/add.js` shape, **preserving `properties` (line item properties) and
  `selling_plan` (bundles/subscriptions)**.
- **Replace vs merge:** if `cart_data.replace !== false`, calls `/cart/clear.js` first (replace);
  otherwise merges.
- **Per‑item fallback:** `/cart/add.js` is *atomic* — if any line is unavailable Shopify adds none
  (422). So it tries all items at once, and on failure retries **one item at a time** so available
  items still land. Shows "Some items were unavailable; added the rest" or "None available".
- Renders the **delivery address** for confirmation + a **"Continue to cart"** button → `/cart`.

### 4.5 Authentication — `authenticate.public.appProxy`

We do **not** hand‑roll HMAC verification. `authenticate.public.appProxy(request)`:
- Validates the **HMAC‑SHA256 `signature`** Shopify adds to every proxied request (throws 401 if bad).
- Returns `{ admin, session, storefront, liquid }`. `admin` is the Admin GraphQL client; it is
  `undefined` if the shop hasn't installed the app (we guard with a 403).

### 4.6 Response Content‑Type (per the docs)
- `create` returns **`application/json`** → returned to the AJAX caller as‑is.
- `$token` returns **`text/html`** → returned as‑is (standalone page). We intentionally do **not** use
  `application/liquid` (which would make Shopify render it through the theme).

---

## 5. Implementation — Theme (the `R&D store` theme)

### 5.1 Merchant settings — `config/settings_schema.json`
```json
{ "type": "checkbox", "id": "enable_share_cart", "label": "Enable Share Cart", "default": true },
{ "type": "checkbox", "id": "share_cart_include_address", "label": "Include Address in Shared Cart",
  "default": false, "visible_if": "{{ settings.enable_share_cart }}" }
```
- `enable_share_cart` — hides the whole CTA when off.
- `share_cart_include_address` — only visible when sharing is enabled; switches Scenario 1 ↔ 2.

### 5.2 CTA snippet — `snippets/share-cart.liquid`
Renders only when enabled and passes settings to JS via data attributes:
```liquid
{%- if settings.enable_share_cart -%}
  <div data-share-cart
       data-include-address="{{ settings.share_cart_include_address }}"
       data-proxy-path="/apps/cart-share"> … </div>
{%- endif -%}
```

### 5.3 Storefront logic — `assets/share-cart.js`
```js
var cart = await fetch("/cart.js").then(r => r.json());      // read cart

if (!includeAddress) {                                       // Scenario 1: permalink
  var pairs = cart.items.map(i => i.variant_id + ":" + i.quantity).join(",");
  showResultModal(origin + "/cart/" + pairs);
} else {                                                     // Scenario 2: token link
  var payload = { items: toItems(cart), note, attributes, shippingAddress: address };
  var data = await fetch(proxyPath + "/create", { method:"POST", body: JSON.stringify(payload) })
               .then(r => r.json());
  showResultModal(origin + "/apps/cart-share/" + data.token);
}
```
`toItems()` also captures custom **line item properties** and **selling plan** IDs so they survive the round trip.

---

## 6. Edge cases & how they're handled

| Case | Handling |
|---|---|
| **Invalid token** | `metaobjectByHandle` returns null → "This share link is not valid" (404). |
| **Expired link** | `expiry_date` ≤ now → "This share link has expired" (410). Default TTL **7 days**. |
| **App not installed** | `admin` undefined → 403 (create) / message page (open). |
| **Out‑of‑stock / unavailable item** | Atomic add fails → per‑item fallback adds the rest; partial/none messaging. |
| **Line item properties / bundles / subscriptions** | `properties` + `selling_plan` preserved through create and restore. |
| **Replace vs merge** | `cart_data.replace` flag (default = replace via `/cart/clear.js`). |
| **PII safety** | Address stored in metaobject; only the opaque token is in the URL. |
| **Plus vs Non‑Plus** | Uses only standard APIs (cart permalink, Ajax Cart, metaobjects, app proxy) — no Plus‑only features. |

---

## 7. Deployment

- **Host:** Render Web Service `app-proxy-app.onrender.com` (Docker, `docker-start` → `prisma migrate deploy` + `react-router-serve`).
- **Released version:** `share-cart-app-5` (proxy URL points to the Render host).
- **Config push:** `npm run deploy` (`shopify app deploy --allow-updates`) pushes `shopify.app.toml`
  (scopes + `[app_proxy]`) and releases a new app version.

### ⚠️ Known production note — session store
`prisma/schema.prisma` uses **SQLite** (`file:dev.sqlite`). Render's filesystem is **ephemeral**, so the
session DB (and the shop's offline token) is lost on each restart/deploy → `appProxy` then returns
`admin: undefined` → `Generate link` fails with 403 until the app is re‑opened in admin. **Fix for a
stable deployment: switch the Prisma provider to PostgreSQL** with a persistent `DATABASE_URL`.

---

## 8. How to test

1. **Scenario 2:** Cart page → **Share Cart** → fill address → **Generate link** → a new entry appears in
   **Content → Metaobjects → Share cart**; open the returned `/apps/cart-share/<token>` URL → cart
   restores + address shown → **Continue to cart**.
2. **Scenario 1:** Theme settings → turn **off** "Include Address" → **Share Cart** returns a
   `/cart/{variant}:{qty},…` permalink.
3. **Expiry/invalid:** open `/apps/cart-share/bad-token` → "This share link is not valid".

> Note: the dev store storefront is **password protected** — test in a browser session that's past the
> password (curl gets redirected to `/password`).

---

## 9. Reference documentation

**App proxies**
- About app proxies — https://shopify.dev/docs/apps/build/online-store/app-proxies
- Authenticate app proxy requests (HMAC) — https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
- App configuration (`[app_proxy]`, scopes) — https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration

**React Router / Remix app library**
- `authenticate.public.appProxy` — https://shopify.dev/docs/api/shopify-app-remix/latest/authenticate/public/app-proxy
- App proxy components (`AppProxyForm`, `AppProxyLink`) — https://shopify.dev/docs/api/shopify-app-remix/latest/app-proxy-components

**Admin GraphQL — metaobjects**
- Metaobjects overview — https://shopify.dev/docs/apps/build/custom-data/metaobjects
- `metaobjectCreate` mutation — https://shopify.dev/docs/api/admin-graphql/latest/mutations/metaobjectCreate
- `metaobjectByHandle` query — https://shopify.dev/docs/api/admin-graphql/latest/queries/metaobjectByHandle

**Storefront cart**
- Ajax Cart API (`/cart.js`, `/cart/add.js`, `/cart/clear.js`) — https://shopify.dev/docs/api/ajax/reference/cart
- Cart permalinks — https://help.shopify.com/en/manual/products/details/checkout-link

---

## 10. File map

| File | Role |
|---|---|
| `shopify.app.toml` | App proxy config, scopes, app URL |
| `app/routes/apps.cart-share.create.jsx` | POST → create metaobject, return share URL |
| `app/routes/apps.cart-share.$token.jsx` | GET → look up by token, validate expiry, restore page |
| `app/shopify.server.js` | `shopifyApp()` setup; exports `authenticate`, etc. |
| `prisma/schema.prisma` | Session store (SQLite → Postgres for prod) |
| *(theme)* `assets/share-cart.js` | Storefront Scenario 1/2 logic |
| *(theme)* `snippets/share-cart*.liquid` | CTA + modal |
| *(theme)* `config/settings_schema.json` | Merchant toggles |
