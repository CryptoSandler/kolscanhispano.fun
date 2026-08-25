import { loadEnvLocal } from "./src/lib/env";

// db.ts and crypto.ts each call loadEnvLocal() themselves, so .env.local
// already gets loaded as a side effect of whichever of them a test file
// happens to import first. This setup file makes that explicit and removes
// the dependency on import order, rather than relying on that incidental
// side effect.
loadEnvLocal();
