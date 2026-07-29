/**
 * Per-language "customized" cue lists - what makes clone/split/merge/delete
 * possible, on top of lib/timingField.js's simpler per-string overrides.
 *
 * WHY THIS EXISTS: Crowdin has no notion of "extra language-only cues".
 * Cue count and order are fixed by the source file and shared by every
 * language - a per-string custom Field (like lib/timingField.js's timing
 * overrides) can only ever represent ONE value per EXISTING source string,
 * for EVERY language. That's fine for correcting a cue's timing or text,
 * but it can't represent a clone (a cue with no source string of its own)
 * or a delete (removing a cue from one language's view without touching
 * the shared source string, which would affect every other language too).
 *
 * So the moment a linguist clones or deletes a cue for a given (file,
 * language), this app snapshots that language's *entire* current cue list
 * (text + timing + order + count) into ONE custom Field on the FILE entity
 * (org-wide, scoped to `file`), keyed by language id:
 *   {
 *     "fr": { "customized": true, "cues": [ {id, sourceStringId, startMs, endMs, text}, ... ] },
 *     "es": { "customized": false }  // or simply absent - still derived live, as before
 *   }
 * From that point on, this (file, language) is fully owned by the app:
 * server.js's buildCues() reads straight from this blob instead of
 * deriving cues from Crowdin's source strings/translations/timingField.
 *
 * CONFIRMED TRADE-OFF (signed off on before building this): once a (file,
 * language) is customized, Crowdin's own translation grid / QA checks /
 * reports for that language may no longer reflect what's actually shipped
 * for this file - e.g. a deleted cue's backing string can still show up as
 * untranslated in Crowdin's main Editor, since we deliberately do NOT touch
 * that string's actual translation on delete (per instruction: cue edits
 * here must never affect Crowdin's own translations). Export .srt (not
 * Crowdin's native download) is the correct output once this kicks in for
 * a file+language.
 */

const FIELD_NAME = "Subtitle Language Cues";
const FIELD_SLUG = "subtitle-language-cues";

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
 * Ensure the "Subtitle Language Cues" custom field exists (org-wide, scoped
 * to the `file` entity). Safe to call on every app install - no-ops if the
 * field already exists.
 */
async function ensureLanguageCuesField(axios, accessToken, domain) {
  const api = client(axios, accessToken, domain);
  const { data } = await api.get("/fields", { params: { entity: "file" } });
  const existing = (data.data || []).find((f) => f.data.slug === FIELD_SLUG || f.data.name === FIELD_NAME);
  if (existing) return existing.data;

  try {
    const { data: created } = await api.post("/fields", {
      name: FIELD_NAME,
      slug: FIELD_SLUG,
      type: "textarea",
      entities: ["file"],
      // `config.locations` is required by Crowdin's Add Field endpoint even
      // for plain text-like field types with no UI locations of their own
      // (confirmed via the actual validation error: "[locations - Required
      // field]") - an empty array is enough since this field is managed
      // entirely by this app, not edited through Crowdin's UI.
      config: { locations: [] },
      description:
        "Per-language customized cue lists (text+timing+order) for files where a linguist has cloned, split, merged, or deleted a cue. Managed by the Subtitle Video & Timing app - not meant to be hand-edited.",
    });
    return created.data;
  } catch (err) {
    // Surface Crowdin's actual validation message instead of a bare 400/500 -
    // err.response.data usually holds the real reason (invalid config, a
    // slug collision, a plan/permission restriction, etc).
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Creating "${FIELD_NAME}" field failed: ${detail}`);
  }
}

/**
 * Read the raw { languageId: { customized, cues } } blob off a file record
 * (as returned by GET /projects/{id}/files/{id}). Same defensive
 * array-vs-object handling as lib/timingField.js's readOverrides, since the
 * exact shape of a populated custom field hasn't been observed for every
 * Crowdin version.
 */
function readAll(fileRecord) {
  const fields = fileRecord.fields;
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

/** Returns the customized cue array for a language, or null if that (file,
 * language) hasn't been customized yet - caller should derive cues live
 * from Crowdin (source strings + translations + timingField) instead. */
function readForLanguage(fileRecord, languageId) {
  const entry = readAll(fileRecord)[languageId];
  if (entry && entry.customized && Array.isArray(entry.cues)) return entry.cues;
  return null;
}

/**
 * Persist the full cue list for one language, marking it customized. Other
 * languages' entries in the same field are preserved untouched. Callers
 * must pass a FRESH fileRecord (re-fetched right before calling) to avoid
 * clobbering a concurrent edit to another language - same pattern as
 * lib/timingField.js's writeOverride.
 *
 * Ensures the field exists before writing, rather than relying solely on
 * ensureLanguageCuesField having run at install time - orgs that installed
 * this app before this field existed would otherwise get a PATCH error on
 * their very first clone/delete, since Crowdin can't JSON-Patch a field
 * path that was never created.
 */
async function writeForLanguage(axios, accessToken, domain, projectId, fileRecord, languageId, cues) {
  await ensureLanguageCuesField(axios, accessToken, domain);
  const api = client(axios, accessToken, domain);
  const all = readAll(fileRecord);
  all[languageId] = { customized: true, cues };

  try {
    // "add" (not "replace") - per JSON Patch semantics, "replace" requires
    // the key to already exist at that path, which it won't the first time
    // this specific file gets a value for this field (confirmed via
    // Crowdin's actual error: "invalidOperation - Key not found"). "add"
    // creates it if missing and overwrites it if present, either way.
    const { data } = await api.patch(`/projects/${projectId}/files/${fileRecord.id}`, [
      { op: "add", path: `/fields/${FIELD_SLUG}`, value: JSON.stringify(all) },
    ]);
    return data.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Writing "${FIELD_NAME}" value failed: ${detail}`);
  }
}

module.exports = { FIELD_NAME, FIELD_SLUG, ensureLanguageCuesField, readForLanguage, writeForLanguage };
