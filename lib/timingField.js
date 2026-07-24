/**
 * Per-language timing overrides, stored as a Crowdin custom Field.
 *
 * WHY A CUSTOM FIELD: verified live against a real Crowdin Enterprise
 * project - subtitle timing lives in each source string's `context` field
 * ("Start time: ... / End time: ..."), which is a single shared value for
 * every target language. There is no per-language timing slot anywhere in
 * Crowdin's data model (Translation objects are text-only; custom Fields
 * only support project/file/string/user/task scope, not per-translation).
 *
 * So instead of a private database, this app stores per-language timing
 * corrections as ONE custom Field on the string entity (created once, org-
 * wide), holding a JSON blob keyed by language: e.g.
 *   { "fr": { "startMs": 9600, "endMs": 13100 }, "es": { ... } }
 * This keeps the corrected data visible/auditable inside Crowdin itself
 * (in the string's side panel) rather than hidden in this app's own store,
 * even though Crowdin's native "Download translations" still can't use it
 * (see README - that's a hard platform limitation, not something this file
 * works around).
 *
 * IMPORTANT - NOT YET SMOKE-TESTED AGAINST A LIVE PROJECT:
 * Reading `context`/translations was verified against a real org during
 * design. Writing a custom field's VALUE on a string was not, to avoid
 * mutating live production data without sign-off. Before relying on this in
 * production, run `scripts/smoke-test-field.js` (or equivalent) against a
 * disposable test project and confirm the patch path below actually
 * persists a value Crowdin's UI shows back to you.
 */

const FIELD_NAME = "Subtitle Timing Overrides";
const FIELD_SLUG = "subtitle-timing-overrides";

// See lib/crowdinApi.js's `client()` for why this is domain-scoped for
// Crowdin Enterprise orgs (`{domain}.api.crowdin.com`) instead of the
// shared `api.crowdin.com` host.
function client(axios, accessToken, domain) {
  const baseURL = domain ? `https://${domain}.api.crowdin.com/api/v2` : "https://api.crowdin.com/api/v2";
  return axios.create({
    baseURL,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Ensure the "Subtitle Timing Overrides" custom field exists (org-wide,
 * scoped to the `string` entity). Crowdin Fields are defined once at the
 * organization level, independent of any single project. Safe to call on
 * every app install / server boot - it no-ops if the field already exists.
 */
async function ensureTimingField(axios, accessToken, domain) {
  const api = client(axios, accessToken, domain);
  const { data } = await api.get("/fields", { params: { entity: "string" } });
  const existing = (data.data || []).find((f) => f.data.slug === FIELD_SLUG || f.data.name === FIELD_NAME);
  if (existing) return existing.data;

  try {
    const { data: created } = await api.post("/fields", {
      name: FIELD_NAME,
      slug: FIELD_SLUG,
      type: "textarea",
      entities: ["string"],
      // `config.locations` is required by Crowdin's Add Field endpoint even
      // for plain text-like field types with no UI locations of their own
      // (confirmed via the actual validation error: "[locations - Required
      // field]") - an empty array is enough since this field is managed
      // entirely by this app, not edited through Crowdin's UI.
      config: { locations: [] },
      description: "JSON blob of per-language subtitle timing/text corrections, keyed by language id. Managed by the Subtitle Video & Timing app - not meant to be hand-edited.",
    });
    return created.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Creating "${FIELD_NAME}" field failed: ${detail}`);
  }
}

/**
 * Read the raw per-language overrides blob off a string record (as
 * returned by GET /projects/{id}/strings or /strings/{id}).
 *
 * NOTE: the exact shape of `string.fields` for a POPULATED custom field
 * hasn't been observed yet (only ever seen as an empty array on strings
 * with no fields set). This function defensively handles both an array of
 * {fieldId|slug, value} entries and a plain {slug: value} object - confirm
 * which one your org actually returns during the smoke test above, and trim
 * the branch you don't need.
 */
function readOverrides(stringRecord) {
  const fields = stringRecord.fields;
  if (!fields) return {};

  let raw;
  if (Array.isArray(fields)) {
    const entry = fields.find((f) => f.slug === FIELD_SLUG || f.fieldSlug === FIELD_SLUG);
    raw = entry && entry.value;
  } else if (typeof fields === "object") {
    raw = fields[FIELD_SLUG];
  }

  if (!raw) return {};
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

/**
 * Merge a single language's { startMs, endMs, text } into the string's
 * overrides blob and PATCH it back. Other languages' entries are preserved
 * untouched.
 *
 * Ensures the field exists before writing, rather than relying solely on
 * ensureTimingField having succeeded at install time - this field's
 * original creation call was missing Crowdin's required `config` property
 * and silently failed with a 400 (only logged, not surfaced), so this
 * org's install never actually had the field until this fix.
 */
async function writeOverride(axios, accessToken, domain, projectId, stringRecord, languageId, timing) {
  await ensureTimingField(axios, accessToken, domain);
  const api = client(axios, accessToken, domain);
  const overrides = readOverrides(stringRecord);
  overrides[languageId] = timing;

  // Crowdin's Strings API is JSON-Patch based. "add" (not "replace") - per
  // JSON Patch semantics, "replace" requires the key to already exist at
  // that path, which it won't the first time this specific string gets a
  // value for this field (confirmed via Crowdin's actual error:
  // "invalidOperation - Key not found"). "add" creates it if missing and
  // overwrites it if present, either way.
  try {
    const { data } = await api.patch(`/projects/${projectId}/strings/${stringRecord.id}`, [
      { op: "add", path: `/fields/${FIELD_SLUG}`, value: JSON.stringify(overrides) },
    ]);
    return data.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Writing "${FIELD_NAME}" value failed: ${detail}`);
  }
}

module.exports = { FIELD_NAME, FIELD_SLUG, ensureTimingField, readOverrides, writeOverride };
