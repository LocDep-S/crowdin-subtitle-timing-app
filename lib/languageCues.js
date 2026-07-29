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
 * (text + timing + order + count) into a custom Field on the FILE entity
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
 *
 * OVERFLOW (chunked fields): Crowdin caps a single custom field's value at
 * 65,535 characters. The blob above holds EVERY customized language for a
 * file combined into one value, so a file with several customized
 * languages (or just one language with a lot of cues) can cross that cap -
 * every future clone/split/merge/delete write for the file then fails
 * outright with a "fieldValidationFailed" 400, for every language, not just
 * the one being edited. To keep working past that ceiling without adding
 * an external dependency, once the combined JSON is too big for one field
 * it's split across additional numbered fields ("Subtitle Language Cues 2",
 * "-3", ...), created lazily only once a file actually needs them. Reading
 * is free: Crowdin already returns every custom field value on a file in
 * the same GET /files/{id} call this app already makes (see
 * server.js's buildCues()), so reassembly is just concatenating whichever
 * chunk fields are present, in order, before parsing - no extra API calls.
 */

const BASE_FIELD_NAME = "Subtitle Language Cues";
const BASE_FIELD_SLUG = "subtitle-language-cues";
// Kept for backward compatibility - some callers/older code may still
// reference the single, pre-chunking field name/slug directly.
const FIELD_NAME = BASE_FIELD_NAME;
const FIELD_SLUG = BASE_FIELD_SLUG;

// Comfortably under Crowdin's 65,535-character cap on a field's value, to
// leave headroom for whatever encoding overhead Crowdin's own API/transport
// might add - this app has no way to know that cap's exact enforcement
// point ahead of time, so it errs conservative rather than shaving it thin.
const MAX_CHUNK_CHARS = 60000;

function chunkSlug(index) {
  return index === 1 ? BASE_FIELD_SLUG : `${BASE_FIELD_SLUG}-${index}`;
}
function chunkName(index) {
  return index === 1 ? BASE_FIELD_NAME : `${BASE_FIELD_NAME} ${index}`;
}

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
 * Ensure the base "Subtitle Language Cues" custom field exists (org-wide,
 * scoped to the `file` entity). Safe to call on every app install - no-ops
 * if the field already exists. Overflow chunk fields ("-2", "-3", ...) are
 * NOT created here - most files never need them, so they're created lazily
 * by ensureChunkFields() only the first time a file's data actually grows
 * past one field.
 */
async function ensureLanguageCuesField(axios, accessToken, domain) {
  const api = client(axios, accessToken, domain);
  const { data } = await api.get("/fields", { params: { entity: "file" } });
  const existing = (data.data || []).find((f) => f.data.slug === BASE_FIELD_SLUG || f.data.name === BASE_FIELD_NAME);
  if (existing) return existing.data;

  try {
    const { data: created } = await api.post("/fields", {
      name: BASE_FIELD_NAME,
      slug: BASE_FIELD_SLUG,
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
    throw new Error(`Creating "${BASE_FIELD_NAME}" field failed: ${detail}`);
  }
}

/**
 * Ensure however many chunk fields (1..count) a write actually needs exist,
 * creating any missing ones. Fetches the existing field list once rather
 * than once per chunk.
 */
async function ensureChunkFields(axios, accessToken, domain, count) {
  const api = client(axios, accessToken, domain);
  const { data } = await api.get("/fields", { params: { entity: "file" } });
  const existingFields = data.data || [];

  for (let index = 1; index <= count; index++) {
    const already = existingFields.find((f) => f.data.slug === chunkSlug(index) || f.data.name === chunkName(index));
    if (already) continue;

    try {
      await api.post("/fields", {
        name: chunkName(index),
        slug: chunkSlug(index),
        type: "textarea",
        entities: ["file"],
        config: { locations: [] },
        description:
          index === 1
            ? "Per-language customized cue lists (text+timing+order) for files where a linguist has cloned, split, merged, or deleted a cue. Managed by the Subtitle Video & Timing app - not meant to be hand-edited."
            : `Overflow continuation of "${BASE_FIELD_NAME}" - Crowdin caps a single custom field's value at 65,535 characters, so large files spill into additional numbered fields like this one. Managed by the Subtitle Video & Timing app - not meant to be hand-edited.`,
      });
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Creating "${chunkName(index)}" field failed: ${detail}`);
    }
  }
}

/** Read one chunk field's raw value off a file record (as returned by
 * GET /projects/{id}/files/{id}), or undefined/null if that chunk field
 * doesn't exist or has no value yet. Same defensive array-vs-object
 * handling as lib/timingField.js's readOverrides, since the exact shape of
 * a populated custom field hasn't been observed for every Crowdin version. */
function readRawChunk(fileRecord, index) {
  const fields = fileRecord.fields;
  if (!fields) return undefined;
  const slug = chunkSlug(index);

  if (Array.isArray(fields)) {
    const entry = fields.find((f) => f.slug === slug || f.fieldSlug === slug);
    return entry && entry.value;
  } else if (typeof fields === "object") {
    return fields[slug];
  }
  return undefined;
}

/**
 * Read the raw { languageId: { customized, cues } } blob off a file record.
 * The common case (and every file written before chunking existed) is a
 * single field, handled with the same defensive string-vs-object parsing
 * as before. Only once a second chunk field is actually present does this
 * concatenate chunks - individual chunks are just a substring split of one
 * JSON string, not independently parseable, so they're joined first and
 * parsed once at the end.
 */
function readAll(fileRecord) {
  const chunk1 = readRawChunk(fileRecord, 1);
  if (chunk1 == null) return {};

  const chunk2 = readRawChunk(fileRecord, 2);
  if (chunk2 == null) {
    try {
      return typeof chunk1 === "string" ? JSON.parse(chunk1) : chunk1;
    } catch {
      return {};
    }
  }

  let combined = "";
  for (let index = 1; ; index++) {
    const raw = readRawChunk(fileRecord, index);
    if (raw == null || raw === "") break;
    combined += typeof raw === "string" ? raw : JSON.stringify(raw);
  }
  try {
    return JSON.parse(combined);
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

/** Split a string into MAX_CHUNK_CHARS-sized pieces, in order. Splitting can
 * land in the middle of a UTF-16 surrogate pair, but that's harmless here:
 * chunks are never parsed individually, only concatenated back in the same
 * order before JSON.parse, which reconstructs the original string exactly. */
function splitIntoChunks(str) {
  const chunks = [];
  for (let i = 0; i < str.length; i += MAX_CHUNK_CHARS) {
    chunks.push(str.slice(i, i + MAX_CHUNK_CHARS));
  }
  return chunks.length ? chunks : [""];
}

/**
 * Persist the full cue list for one language, marking it customized. Other
 * languages' entries in the same blob are preserved untouched. Callers
 * must pass a FRESH fileRecord (re-fetched right before calling) to avoid
 * clobbering a concurrent edit to another language - same pattern as
 * lib/timingField.js's writeOverride.
 *
 * Ensures the field(s) exist before writing, rather than relying solely on
 * ensureLanguageCuesField having run at install time - orgs that installed
 * this app before this field existed would otherwise get a PATCH error on
 * their very first clone/delete, since Crowdin can't JSON-Patch a field
 * path that was never created. If the combined blob no longer needs as
 * many chunk fields as a previous write did (e.g. cues got deleted and the
 * data shrank), the now-unneeded higher-numbered fields are cleared to an
 * empty string rather than left holding stale data that readAll() would
 * otherwise wrongly concatenate back in.
 */
async function writeForLanguage(axios, accessToken, domain, projectId, fileRecord, languageId, cues) {
  const api = client(axios, accessToken, domain);
  const all = readAll(fileRecord);
  all[languageId] = { customized: true, cues };

  const serialized = JSON.stringify(all);
  const newChunks = splitIntoChunks(serialized);

  let previousMaxIndex = 0;
  for (let index = 1; readRawChunk(fileRecord, index) != null; index++) {
    previousMaxIndex = index;
  }

  await ensureChunkFields(axios, accessToken, domain, newChunks.length);

  const ops = newChunks.map((chunk, i) => ({
    op: "add",
    path: `/fields/${chunkSlug(i + 1)}`,
    value: chunk,
  }));
  for (let index = newChunks.length + 1; index <= previousMaxIndex; index++) {
    ops.push({ op: "add", path: `/fields/${chunkSlug(index)}`, value: "" });
  }

  try {
    // "add" (not "replace") - per JSON Patch semantics, "replace" requires
    // the key to already exist at that path, which it won't the first time
    // this specific file gets a value for this field (confirmed via
    // Crowdin's actual error: "invalidOperation - Key not found"). "add"
    // creates it if missing and overwrites it if present, either way.
    const { data } = await api.patch(`/projects/${projectId}/files/${fileRecord.id}`, ops);
    return data.data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Writing "${BASE_FIELD_NAME}" value failed: ${detail}`);
  }
}

module.exports = { FIELD_NAME, FIELD_SLUG, ensureLanguageCuesField, readForLanguage, writeForLanguage };
