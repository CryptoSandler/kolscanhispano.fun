import { describe, expect, it } from "vitest";
import { normalizeXHandle } from "./x-handle";

describe("normalizeXHandle: the three forms a person types", () => {
  it("takes a bare handle", () => {
    expect(normalizeXHandle("ejemplo")).toBe("ejemplo");
  });

  it("takes a handle with its @", () => {
    expect(normalizeXHandle("@ejemplo")).toBe("ejemplo");
  });

  it("takes a profile URL, on either domain and with or without a scheme", () => {
    for (const input of [
      "https://x.com/ejemplo",
      "http://x.com/ejemplo",
      "x.com/ejemplo",
      "www.x.com/ejemplo",
      "https://twitter.com/ejemplo",
      "twitter.com/ejemplo",
      "https://www.twitter.com/ejemplo",
      "https://X.com/ejemplo",
    ]) {
      expect(normalizeXHandle(input), input).toBe("ejemplo");
    }
  });

  /**
   * The three forms must land on **one** value, or `kol.x_handle`'s UNIQUE
   * constraint never fires and the same person registers three times. That is
   * the property, so it is asserted as one rather than inferred from the three
   * cases above passing separately.
   */
  it("collapses all three onto a single stored value", () => {
    const forms = ["ejemplo", "@ejemplo", "https://x.com/ejemplo"];
    expect(new Set(forms.map(normalizeXHandle)).size).toBe(1);
  });

  it("strips the tracking parameters a share sheet appends", () => {
    expect(normalizeXHandle("https://x.com/ejemplo?s=21&t=AbCdEf")).toBe("ejemplo");
    expect(normalizeXHandle("https://x.com/ejemplo#top")).toBe("ejemplo");
  });

  it("trims whitespace, which a paste carries", () => {
    expect(normalizeXHandle("  @ejemplo \n")).toBe("ejemplo");
  });

  it("preserves the capitalisation its owner chose", () => {
    // `kol.x_handle` is CITEXT, so uniqueness already ignores case. Folding it
    // here would only disfigure the name on every public row.
    expect(normalizeXHandle("@MiNombre")).toBe("MiNombre");
  });
});

describe("normalizeXHandle: what is not a handle", () => {
  it("refuses an empty or half-typed field without throwing", () => {
    // `null`, not an exception: this runs on every keystroke, where "not yet a
    // handle" is the ordinary state.
    expect(normalizeXHandle("")).toBeNull();
    expect(normalizeXHandle("   ")).toBeNull();
    expect(normalizeXHandle("@")).toBeNull();
  });

  it("refuses a link to a post, which is not a profile", () => {
    // Reading the account out of this would accept a URL that says something
    // else -- and the person pasting it may well have meant the post.
    expect(normalizeXHandle("https://x.com/ejemplo/status/1234567890")).toBeNull();
    expect(normalizeXHandle("https://x.com/")).toBeNull();
  });

  it("refuses another site's URL that happens to have one path segment", () => {
    expect(normalizeXHandle("https://instagram.com/ejemplo")).toBeNull();
    expect(normalizeXHandle("https://x.com.evil.test/ejemplo")).toBeNull();
  });

  it("refuses an email address rather than reading the part before the @", () => {
    expect(normalizeXHandle("ejemplo@correo.com")).toBeNull();
  });

  it("enforces X's own shape: 1-15 of letters, digits and underscore", () => {
    expect(normalizeXHandle("a".repeat(15))).toBe("a".repeat(15));
    expect(normalizeXHandle("a".repeat(16))).toBeNull();
    expect(normalizeXHandle("con-guion")).toBeNull();
    expect(normalizeXHandle("con espacio")).toBeNull();
    expect(normalizeXHandle("con/barra")).toBeNull();
    expect(normalizeXHandle("acentuadó")).toBeNull();
  });

  /**
   * The one that matters beyond tidiness: this value is interpolated into
   * `https://x.com/<handle>` on every public row. A handle carrying a slash,
   * a `..`, or a scheme would make that link point somewhere else.
   */
  it("cannot produce a value that would redirect the public profile link", () => {
    for (const input of [
      "ejemplo/otro",
      "../otro",
      "javascript:alert(1)",
      "//evil.test",
      "ejemplo?next=evil.test",
    ]) {
      expect(normalizeXHandle(input), input).toBeNull();
    }
  });
});
