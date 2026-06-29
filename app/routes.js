import { flatRoutes } from "@react-router/fs-routes";

// Exclude test files and test helpers from the route tree. They live next to the
// routes in app/routes/ but must NOT be treated as routes or bundled into the
// production build (they import `vitest`, a devDependency that isn't installed on
// the server) — otherwise the build fails with an unresolved-import PLUGIN_ERROR.
export default flatRoutes({
  ignoredRouteFiles: [
    "**/*.test.{js,jsx,ts,tsx}",
    "**/*.spec.{js,jsx,ts,tsx}",
    "**/__tests__/**",
    "**/__test-helpers__/**",
  ],
});
