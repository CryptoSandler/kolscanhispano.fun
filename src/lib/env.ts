import { existsSync, readFileSync } from "node:fs";

/**
 * Loaded from a file rather than the shell so a connection string (or a key)
 * never has to be typed on a command line, where it would land in shell history.
 */
export function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
