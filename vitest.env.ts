import { loadEnvLocal } from "./src/lib/env";
import { assertTestDatabaseMarker } from "./src/lib/db";

// db.ts and crypto.ts each call loadEnvLocal() themselves, so .env.local
// already gets loaded as a side effect of whichever of them a test file
// happens to import first. This call makes that explicit and removes the
// dependency on which one happens to import first.
loadEnvLocal();

// Before any test file is allowed to touch anything: a connection-string
// comparison alone cannot prove TEST_DATABASE_URL names a different
// database than DATABASE_URL (see db.ts). This sentinel does not depend on
// parsing anything, so it catches what that comparison cannot.
await assertTestDatabaseMarker();
