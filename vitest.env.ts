import { loadEnvLocal } from "./src/lib/env";
import { assertTestDatabaseMarker } from "./src/lib/db";
import { installNetworkGuard } from "./src/lib/network-guard";

// db.ts and crypto.ts each call loadEnvLocal() themselves, so .env.local
// already gets loaded as a side effect of whichever of them a test file
// happens to import first. This call makes that explicit and removes the
// dependency on which one happens to import first.
loadEnvLocal();

// Installed first, and per test file (see network-guard.ts for why this
// cannot live in vitest.globalSetup.ts instead): every test file's default
// `fetch` now throws naming the host, so no test reaches the network by
// accident, whether or not it has ever heard of this module.
installNetworkGuard();

// Before any test file is allowed to touch anything: a connection-string
// comparison alone cannot prove TEST_DATABASE_URL names a different
// database than DATABASE_URL (see db.ts). This sentinel does not depend on
// parsing anything, so it catches what that comparison cannot.
await assertTestDatabaseMarker();
