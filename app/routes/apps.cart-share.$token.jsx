import { authenticate } from "../shopify.server";

/**
 * App Proxy page: GET /apps/cart-share/:token
 *
 * Looks up the share_cart metaobject by handle (== token), validates expiry,
 * and returns a self-contained HTML page that restores the cart via the
 * storefront Ajax Cart API and shows the saved delivery address for confirmation.
 *
 * Because the page is served through the App Proxy it lives on the shop's
 * own domain, so calls to /cart/add.js, /cart/clear.js and /cart are same-origin.
 */

const METAOBJECT_TYPE = "share_cart";

const GET_SHARE_CART = `#graphql
  query GetShareCart($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) {
      id
      handle
      type
      cartData: field(key: "cart_data") { value }
      addressData: field(key: "address_data") { value }
      expiryDate: field(key: "expiry_date") { value }
    }
  }
`;

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Escape a JS object for safe embedding inside a <script> tag. */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Minimal page chrome shared by the message and success states. */
function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
           background: #f6f6f7; color: #1a1a1a; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 8px 24px rgba(0,0,0,.06);
            max-width: 460px; width: 100%; padding: 28px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    p { margin: 6px 0; line-height: 1.5; color: #444; }
    .muted { color: #6b7280; font-size: 14px; }
    dl { margin: 16px 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; font-size: 14px; }
    dt { color: #6b7280; }
    dd { margin: 0; }
    .btn { display: inline-block; width: 100%; text-align: center; border: none; border-radius: 8px; padding: 12px 16px;
           font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 16px; }
    .btn-primary { background: #1a1a1a; color: #fff; }
    .btn-primary:disabled { opacity: .55; cursor: default; }
    .status { font-size: 14px; margin-top: 12px; min-height: 18px; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <div class="card">${bodyHtml}</div>
</body>
</html>`;
}

function messagePage(title, message, status = 200) {
  return htmlResponse(
    page(title, `<h1>${title}</h1><p class="muted">${message}</p>`),
    status,
  );
}

export const loader = async ({ request, params }) => {
  // Verifies the App Proxy HMAC signature. Throws a 401 Response if invalid.
  const { admin } = await authenticate.public.appProxy(request);

  if (!admin) {
    return messagePage("Cart sharing unavailable", "This shop has not enabled cart sharing.", 403);
  }

  const token = params.token;
  if (!token) {
    return messagePage("This share link is not valid", "No share token was provided.", 404);
  }

  // --- Fetch the metaobject by handle ----------------------------------------
  const response = await admin.graphql(GET_SHARE_CART, {
    variables: { handle: { type: METAOBJECT_TYPE, handle: token } },
  });
  const body = await response.json();
  const metaobject = body?.data?.metaobjectByHandle;

  if (!metaobject) {
    return messagePage("This share link is not valid", "We couldn't find a shared cart for this link.", 404);
  }

  // --- Validate expiry --------------------------------------------------------
  const expiryRaw = metaobject.expiryDate?.value;
  const expiryMs = expiryRaw ? Date.parse(expiryRaw) : NaN;
  if (Number.isNaN(expiryMs) || expiryMs <= Date.now()) {
    return messagePage("This share link has expired", "Ask the sender to generate a new link.", 410);
  }

  // --- Parse stored payloads --------------------------------------------------
  let cartData;
  let addressData;
  try {
    cartData = JSON.parse(metaobject.cartData?.value || "{}");
    addressData = JSON.parse(metaobject.addressData?.value || "{}");
  } catch {
    return messagePage("This share link is not valid", "The shared cart data is corrupted.", 422);
  }

  const items = Array.isArray(cartData.items) ? cartData.items : [];
  if (items.length === 0) {
    return messagePage("This share link is not valid", "The shared cart is empty.", 422);
  }

  // --- Build the address confirmation summary --------------------------------
  const a = addressData || {};
  const fullName = [a.firstName, a.lastName].filter(Boolean).join(" ");
  const addressRows = [
    ["Name", fullName],
    ["Address", a.address1],
    ["City", a.city],
    ["Province", a.province],
    ["ZIP", a.zip],
    ["Country", a.country],
    ["Phone", a.phone],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/</g, "&lt;")}</dd>`)
    .join("");

  const successBody = `
    <h1>Shared cart ready</h1>
    <p class="muted">We'll add ${items.length} item${items.length === 1 ? "" : "s"} to your cart. Please confirm the delivery address.</p>
    <dl>${addressRows}</dl>
    <button id="continue" class="btn btn-primary">Continue to cart</button>
    <div id="status" class="status" role="status"></div>
    <script>
      (function () {
        var ITEMS = ${safeJson(items)};
        var REPLACE_CART = ${cartData.replace === false ? "false" : "true"};
        var btn = document.getElementById("continue");
        var statusEl = document.getElementById("status");

        // Normalize to the shape /cart/add.js expects, preserving line item
        // properties and selling plans (bundles/subscriptions) when present.
        var addItems = ITEMS.map(function (it) {
          var line = { id: it.variantId || it.id || it.variant_id, quantity: it.quantity || 1 };
          if (it.properties && Object.keys(it.properties).length) line.properties = it.properties;
          var sp = it.sellingPlanId || it.sellingPlan || it.selling_plan;
          if (sp) line.selling_plan = sp;
          return line;
        }).filter(function (it) { return it.id; });

        function setStatus(msg, isError) {
          statusEl.textContent = msg || "";
          statusEl.className = "status" + (isError ? " error" : "");
        }

        async function restoreAndGo() {
          btn.disabled = true;
          setStatus("Restoring cart…", false);
          try {
            // Replace the current cart (so it matches exactly) or merge, per merchant setting.
            if (REPLACE_CART) {
              await fetch("/cart/clear.js", { method: "POST", headers: { "Content-Type": "application/json" } });
            }
            var res = await fetch("/cart/add.js", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items: addItems })
            });
            if (!res.ok) {
              var err = await res.json().catch(function () { return {}; });
              throw new Error(err.description || "Some items could not be added.");
            }
            setStatus("Done! Redirecting to your cart…", false);
            window.location.href = "/cart";
          } catch (e) {
            setStatus(e.message || "Could not restore the cart.", true);
            btn.disabled = false;
          }
        }

        btn.addEventListener("click", restoreAndGo);
      })();
    </script>
  `;

  return htmlResponse(page("Shared cart ready", successBody));
};
