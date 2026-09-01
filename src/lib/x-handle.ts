/**
 * One X handle, however it was written.
 *
 * Spec §6 records the handle on the claim and `kol.x_handle` is `CITEXT
 * NOT NULL UNIQUE`, so the value stored has to be one canonical spelling of
 * the account — otherwise `@ejemplo`, `ejemplo` and `https://x.com/ejemplo`
 * become three different KOLs claiming the same person, and the uniqueness
 * constraint that is supposed to prevent exactly that never fires.
 *
 * **The three forms are the three a person actually types**, and they were
 * chosen by watching what people paste rather than by taste: the bare handle,
 * the handle with its `@`, and a copied profile URL — which arrives as
 * `x.com`, as `twitter.com`, with or without a scheme, with or without `www.`,
 * and often with tracking query parameters attached by whatever app it was
 * copied out of.
 *
 * Pure, and it touches no database: the modal normalises as the reader types
 * so they can see what will be stored, and the server normalises again before
 * it writes. Two callers, one function, so the field cannot show one thing and
 * the row hold another.
 */

/**
 * X's own rule: 1–15 characters, letters, digits and underscore.
 *
 * Enforced rather than assumed, because everything downstream treats this as
 * an identifier: it is interpolated into `https://x.com/<handle>` on every
 * public row, and a value that is not a handle would make that link point at
 * something else — a path with a slash in it above all.
 */
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** `x.com` and its predecessor, with or without `www.`. Nothing else is a profile URL. */
const PROFILE_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

/**
 * The handle, bare and without its `@`, or `null` when the input is not one.
 *
 * `null` rather than a throw: this runs on every keystroke in the onboarding
 * field, where "not yet a handle" is the ordinary state of a half-typed one
 * and an exception would be a control-flow lie. The server calls the same
 * function and turns `null` into its own refusal.
 *
 * Case is **preserved**, not lowercased. `kol.x_handle` is `CITEXT`, so the
 * database already compares case-insensitively and the uniqueness constraint
 * holds regardless — and X displays a handle the way its owner capitalised it.
 * Folding the case here would store `MiNombre` as `minombre` and print it that
 * way on every row, which is a small disfigurement of somebody's name for no
 * gain the database was not already giving.
 */
export function normalizeXHandle(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // A profile URL, in any of the shapes a paste produces. Tried first, because
  // a URL contains characters the bare-handle branch would reject anyway.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL | null = null;
  try {
    url = new URL(candidate);
  } catch {
    url = null;
  }
  if (url && PROFILE_HOSTS.has(url.hostname.toLowerCase())) {
    // `pathname` drops the query string and the fragment, which is what strips
    // the tracking parameters a share sheet appends. One segment, no more: a
    // `/ejemplo/status/123` is a link to a post, not to a profile, and quietly
    // reading the account out of it would accept a URL that says something else.
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    if (segments.length !== 1) return null;
    const fromUrl = segments[0].replace(/^@/, "");
    return HANDLE.test(fromUrl) ? fromUrl : null;
  }

  // The bare handle, with or without its `@`. Only one `@`, and only leading:
  // an email address must not normalise to the part before its domain.
  const bare = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return HANDLE.test(bare) ? bare : null;
}
