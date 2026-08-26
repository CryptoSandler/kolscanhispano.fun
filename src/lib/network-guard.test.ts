import { afterEach, describe, expect, it, vi } from "vitest";
import { realFetch } from "./network-guard";

afterEach(() => {
  // Some cases below replace globalThis.fetch with a mock via vi.stubGlobal.
  // Undoing it restores whatever fetch was active before that stub — the
  // guarded one installed by this file's own setupFiles run — so a later
  // test in this file never runs against a live, unguarded fetch.
  vi.unstubAllGlobals();
});

describe("the network guard installed by vitest.env.ts", () => {
  it("throws when fetch is called, and the message names the host", async () => {
    const error = await fetch("https://api.dexscreener.com/latest/dex/tokens/abc").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("api.dexscreener.com");
  });

  it("never leaks a query string — the guard names the host only, not the full URL", async () => {
    const urlWithSecret = "https://mainnet.helius-rpc.com/?api-key=super-secret-value";
    const error = await fetch(urlWithSecret).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("mainnet.helius-rpc.com");
    expect(message).not.toContain("super-secret-value");
    expect(message).not.toContain("api-key");
  });

  it("names the host for a Request object and for a URL instance, not just a string", async () => {
    const fromRequest = await fetch(new Request("https://requests.test/x")).catch((e) => e);
    const fromUrl = await fetch(new URL("https://urls.test/y")).catch((e) => e);
    expect((fromRequest as Error).message).toContain("requests.test");
    expect((fromUrl as Error).message).toContain("urls.test");
  });

  it("leaves a test that mocks fetch explicitly completely unaffected", async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", mock);

    const response = await fetch("https://example.test/anything");

    expect(await response.json()).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledOnce();
  });

  it("exposes realFetch as a distinct, named escape hatch rather than the guarded global", () => {
    expect(realFetch).not.toBe(fetch);
    expect(typeof realFetch).toBe("function");
  });
});
