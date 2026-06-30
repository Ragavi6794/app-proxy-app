# Unit Testing Report — Share Cart (App Proxy + Metaobjects)

| | |
|---|---|
| **Feature** | Configurable Share Cart (Scenario 1 permalink + Scenario 2 token/address) |
| **App** | `share-cart-app` (Shopify React Router app) |
| **Build / Version** | `share-cart-app-8` (released) · host `https://app-proxy-app.onrender.com` |
| **Dev store** | rnd-store-9869.myshopify.com |
| **Test framework** | **Vitest** `^2.1.9` |
| **Run command** | `npm run test` (`vitest run`) |
| **Tested by** | Ragavi E |
| **Date** | 2026-06-26 |
| **Result** | ✅ **27 / 27 passed**, 0 failed (2 test files) · ~349ms |

## 1. Scope

Automated **unit tests** for the two App Proxy route handlers, driven through their real
`action`/`loader` exports with `authenticate.public.appProxy` and the Admin GraphQL client mocked
(`app/routes/__test-helpers__/proxy.js`). Covers both merchant configurations (Scenario 1 / 2),
payload handling, restore-page rendering, security (PII/XSS), and all error paths.

> Storefront-side behaviour (theme `share-cart.js`, modal, copy button) is covered by the **theme
> repo's** jsdom suite and by the manual E2E verification in §5 below.

## 2. How to run

```bash
npm run test            # all suites (vitest run)
npm run test -- --reporter=verbose
npx vitest -t "Scenario"   # filter by name
```
Tests mock auth + Admin API, so no live store/DB is required.

## 3. Suite A — `apps.cart-share.create.jsx` (POST) — 14 tests

| # | Test | Verifies | Status |
|---|------|----------|--------|
| 1 | rejects non-POST methods with 405 | method guard | ✅ |
| 2 | returns **503 `NO_OFFLINE_SESSION`** when no offline session (admin undefined) | clearer error (was 403) | ✅ |
| 3 | returns 400 on invalid JSON body | body parsing | ✅ |
| 4 | returns 422 when the cart has no items | payload validation | ✅ |
| 5 | accepts shape A `{items, shippingAddress}` → token URL | theme payload | ✅ |
| 6 | accepts shape B `{cart_data, address_data}` (spec payload) | spec payload | ✅ |
| 7 | keeps PII out of the share URL (token only) | security | ✅ |
| 8 | preserves cart note, attributes and the `replace` flag | data fidelity | ✅ |
| 9 | preserves line item properties and selling plans (bundles/subscriptions) | advanced cart | ✅ |
| 10 | sets a ~7-day expiry | TTL | ✅ |
| 11 | returns 502 on transport-level GraphQL errors | error handling | ✅ |
| 12 | returns 422 on metaobject `userErrors` | error handling | ✅ |
| 13 | loader (GET) returns 405 telling callers to POST | method guard | ✅ |
| 14 | generates a unique token per request | token uniqueness | ✅ |

## 4. Suite B — `apps.cart-share.$token.jsx` (GET) — 13 tests

| # | Test | Verifies | Status |
|---|------|----------|--------|
| 1 | returns 403 when the app is not installed | auth guard | ✅ |
| 2 | returns 404 when no token is supplied | input guard | ✅ |
| 3 | returns 404 for an invalid/unknown token | "not valid" page | ✅ |
| 4 | returns 410 for an expired link | "expired" page | ✅ |
| 5 | treats a missing/garbage expiry as expired (410) | expiry hardening | ✅ |
| 6 | returns 422 when stored cart JSON is corrupted | data integrity | ✅ |
| 7 | returns 422 when the shared cart has no items | empty guard | ✅ |
| 8 | renders the restore page with item count, address and embedded items | happy path | ✅ |
| 9 | singular item count copy ('1 item') | copy/pluralization | ✅ |
| 10 | honours `replace:false` (merge mode) | replace vs merge | ✅ |
| 11 | renders correctly when no address was shared | optional address | ✅ |
| 12 | escapes HTML in address fields (no XSS injection) | security/XSS | ✅ |
| 13 | escapes `</script>` in embedded item JSON | security/XSS | ✅ |

## 5. Requirement → test coverage

| Requirement | Covered by |
|---|---|
| Enable/disable + address toggle | theme settings (jsdom suite) + A5/A6 payload shapes |
| Scenario 1 — permalink | theme jsdom suite (storefront-only, no app call) |
| Scenario 2 — token + metaobject | A5–A10, B8, B11 |
| Restore via Ajax Cart API | B8 (embedded items) + manual E2E §6 |
| Replace vs merge | A8, B10 |
| Line item properties / bundles / selling plans | A9 |
| Note & attributes | A8 |
| Invalid / expired links | B3, B4, B5 |
| PII not in URL | A7 + B12/B13 (XSS) |
| 7-day TTL | A10 |
| Error handling (400/422/502/503) | A2, A3, A4, A11, A12 |
| Plus & Non-Plus | standard APIs only (no plan-gated calls) |

## 6. Manual / E2E verification (live, on Render)

| Check | Result |
|---|---|
| Scenario 2 — Generate Link → metaobject created (`share_cart`, token/cart_data/address_data/expiry) | ✅ verified (entries `e2c3c6f4…`, `212b6d2e…`) |
| Open token URL → "Shared cart ready" page with address + Continue to cart | ✅ verified |
| Invalid token → "This share link is not valid" | ✅ verified |
| App Proxy routing (storefront → Render route) | ✅ verified (build live, routes 400 to unsigned probes) |
| Scenario 1 — permalink | ⏳ verify on storefront with address toggle OFF |

> The dev store storefront is **password protected** — run manual checks in a browser session past
> the password.

## 7. Defects

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| DF-01 | High | `Generate Link` 403 "App is not installed" after Render restart (SQLite ephemeral session loss). | **✅ Resolved** — session store migrated to PostgreSQL; offline session persists. Error now surfaces as 503 `NO_OFFLINE_SESSION` (test A2) and is cleared by opening the app once. |
| DF-02 | Low | Admin API version mismatch (`October25` vs webhooks `2026-07`). | Open (cosmetic). |

## 8. Summary

- **Automated unit tests: 27 / 27 passed, 0 failed** (Vitest, 2 files).
- All spec behaviours (both scenarios, payload shapes, restore, replace/merge, properties/bundles/
  selling plans, note/attributes, expiry, PII/XSS, full error matrix) are covered.
- Previously-failing test updated to assert the new **503 `NO_OFFLINE_SESSION`** behaviour.
- DF-01 (the production 403) is **resolved** via the PostgreSQL session store.

**Verdict:** ✅ **PASS.** Feature is functionally complete and unit-test green. Remaining: one
storefront E2E pass for Scenario 1 (permalink) and the low-priority DF-02 API-version alignment.
