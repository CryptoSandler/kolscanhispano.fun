import { describe, expect, it } from "vitest";

// Deliberately does not import anything from network-guard.ts. The point of
// this file is to prove the guard reaches every test file through
// vitest.env.ts's setupFiles, not only files that opt in by referencing it.
describe("the network guard, from a file that never mentions it", () => {
  it("still blocks a bare fetch call", async () => {
    const error = await fetch("https://never-actually-called.test/path").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("never-actually-called.test");
  });
});
