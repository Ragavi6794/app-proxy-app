# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An embedded Shopify app (`share-cart-app`) built on the **Shopify React Router app template** (React Router v7 + Vite, the successor to the Remix template). The intended feature is cart sharing, exposed to storefronts through an **app proxy** (`shopify.app.toml` → `[app_proxy]`, served at `/apps/cart-share`). At present the code is largely the unmodified template (product-creation demo on the home page); the share-cart logic still needs to be built.

The source is JavaScript (`.jsx`), but the toolchain is TypeScript-aware (`tsconfig.json`, `typecheck`, GraphQL codegen all run against the JS files).

## Commands

```shell
npm run dev          # shopify app dev — the primary dev loop (tunnel, env injection, hot reload)
npm run build        # react-router build
npm run start        # serve the production build
npm run lint         # eslint (cached)
npm run typecheck    # react-router typegen && tsc --noEmit
npm run setup        # prisma generate && prisma migrate deploy
npm run deploy       # shopify app deploy (pushes config + extensions)
npm run generate     # shopify app generate (scaffold an extension)
npm run config:link  # link local config to an app in your Partner org
npm run graphql-codegen   # regenerate Admin API types into app/types
```

There is no test runner configured. Always run via the **Shopify CLI** (`npm run dev`), never bare `react-router dev` — auth, env vars, the tunnel, and webhook registration all depend on the CLI.

## Architecture

**Routing** is file-based flat routes (`@react-router/fs-routes`, see `app/routes.js`). Filename dots map to URL segments and `$` to params:
- `app/routes/app.jsx` — authenticated embedded-admin layout. Its loader calls `authenticate.admin(request)`; every `app.*` child route is gated by it and rendered inside `AppProvider`. Nav links are declared here.
- `app/routes/app._index.jsx`, `app.additional.jsx` — admin pages.
- `app/routes/_index/route.jsx` — public landing/login page (redirects to `/app` when a `shop` param is present).
- `app/routes/auth.$.jsx`, `auth.login/` — OAuth flow.
- `app/routes/webhooks.app.*.jsx` — webhook handlers (`app/uninstalled`, `app/scopes_update`), subscribed in `shopify.app.toml`.

**Shopify integration** is centralized in `app/shopify.server.js`. It calls `shopifyApp(...)` once and re-exports `authenticate`, `unauthenticated`, `login`, `registerWebhooks`, `sessionStorage`, etc. Import from here — do not call `shopifyApp` elsewhere. Notable config: `AppDistribution.AppStore`, `expiringOfflineAccessTokens: true` (offline tokens rotate via refresh token).

**Data access pattern**: in a loader/action, `const { admin } = await authenticate.admin(request)`, then `admin.graphql(\`#graphql ...\`, { variables })`. The `#graphql` tag enables codegen and editor support. `app._index.jsx`'s action is the worked example (product create + metafield + metaobject upsert).

**Persistence**: Prisma with **SQLite** (`prisma/dev.sqlite`), schema in `prisma/schema.prisma`. The only model is `Session` — Prisma here is the Shopify **session store** (`PrismaSessionStorage`), not app data. `app/db.server.js` exports a singleton `PrismaClient` (cached on `global` outside production to survive HMR). For production you'll likely swap SQLite for Postgres/MySQL in `schema.prisma`.

**App proxy**: `[app_proxy]` in `shopify.app.toml` routes storefront requests at `/apps/cart-share` to this app. Authenticate those requests with `authenticate.public.appProxy(request)` (not `authenticate.admin`).

## Conventions & gotchas

- **API version is set in two places** and they currently differ: `shopify.server.js` uses `ApiVersion.October25` (also used by `.graphqlrc.js` codegen) while `shopify.app.toml` `[webhooks]` declares `api_version = "2026-07"`. Keep the GraphQL/Admin version (`shopify.server.js` + `.graphqlrc.js`) in sync when bumping.
- **Scopes** live in `shopify.app.toml` `[access_scopes]` (`write_products,write_metaobjects,write_metaobject_definitions,read_metaobjects`) and are loaded via `process.env.SCOPES`. Changing them requires a redeploy/reinstall.
- **Declarative config**: product metafield + metaobject *definitions* are declared in `shopify.app.toml` and applied on deploy — don't create those definitions imperatively.
- After editing `prisma/schema.prisma`, run `npm run setup`. After changing GraphQL queries, run `npm run graphql-codegen`.
- Webhook layout responses must propagate Shopify headers — admin routes export `headers = boundary.headers` and `ErrorBoundary = boundary.error(...)` (see `app/routes/app.jsx`). Keep this when adding admin routes.
- Extensions live under `extensions/*` (npm workspace, currently empty). Scaffold with `npm run generate`.

## Shopify Dev MCP

The repo is configured with the Shopify Dev MCP server (`.mcp.json`, `.cursor/mcp.json`). Use its tools to look up Admin/Storefront API schemas, validate GraphQL, and search Shopify docs rather than guessing API shapes.
