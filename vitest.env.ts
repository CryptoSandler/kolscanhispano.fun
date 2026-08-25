import { loadEnvLocal } from "./src/lib/env";

// Several test files read process.env at module top level. Vitest's own
// module loading order does not guarantee .env.local is loaded before that
// happens, so this setup file makes it explicit rather than relying on an
// import chain that happens to load it first.
loadEnvLocal();
