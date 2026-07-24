/**
 * Thin wrapper around the parts of the Crowdin REST API this app needs.
 * Docs: https://developer.crowdin.com/api/v2/
 *
 * This app no longer reads or writes the source file's raw content: source
 * cue text/order/timing (in each string's `context` field) stay exactly as
 * Crowdin already has them. All calls here are either reads, or narrow
 * metadata writes (a string's custom field value, or a file's `context`
 * for the video link) - never a source file replace/re-upload.
 */

const axios = require("axios");

/**
 * Crowdin Enterprise organizations are served from a domain-scoped API host
 * (`https://{domain}.api.crowdin.com/api/v2`), not the shared
 * `https://api.crowdin.com/api/v2` used by crowdin.com. `domain` comes from
 * the events.installed payload (null for crowdin.com, e.g. "sinch" for
 * Sinch's Enterprise org) - see lib/store.js / server.js's requireJwt.
 * Hardcoding the crowdin.com host here originally caused every call for an
 * Enterprise install to 404.
 */
function client(accessToken, domain) {
  const baseURL = domain ? `https://${domain}.api.crowdin.com/api/v2` : "https://api.crowdin.com/api/v2";
  return axios.create({
    baseURL,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** GET file metadata - includes `context`, which this app reuses as the
 * video link field (matches how this Crowdin org already stores a video URL
 * per subtitle file - confirmed live on an existing project). */
async function getFile(accessToken, domain, projectId, fileId) {
  const api = client(accessToken, domain);
  const { data } = await api.get(`/projects/${projectId}/files/${fileId}`);
  return data.data;
}

/** PATCH a file's `context` field (used to store/update the video link). */
async function setFileContext(accessToken, domain, projectId, fileId, context) {
  const api = client(accessToken, domain);
  const { data } = await api.patch(`/projects/${projectId}/files/${fileId}`, [
    { op: "replace", path: "/context", value: context },
  ]);
  return data.data;
}

/**
 * List source strings for a file, in source order. Each string's `context`
 * field carries its default timing ("Start time: ... / End time: ..." -
 * Crowdin's own SRT importer puts it there), which lib/srt.js can parse.
 * `fields` on each string carries any custom-field values, including our
 * per-language timing overrides (see lib/timingField.js).
 */
async function listSourceStrings(accessToken, domain, projectId, fileId) {
  const api = client(accessToken, domain);
  const results = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const { data } = await api.get(`/projects/${projectId}/strings`, {
      params: { fileId, limit, offset },
    });
    results.push(...data.data.map((d) => d.data));
    if (data.data.length < limit) break;
    offset += limit;
  }
  return results;
}

/**
 * Bulk-fetch a target language's translations for a file. Returns a Map of
 * stringId -> translated text (only the latest/top translation per string;
 * good enough for building an export - swap for `list_translations` with
 * approval filtering if you need only-approved text).
 */
async function listLanguageTranslations(accessToken, domain, projectId, languageId, fileId) {
  const api = client(accessToken, domain);
  const results = new Map();
  let offset = 0;
  const limit = 500;
  for (;;) {
    const { data } = await api.get(`/projects/${projectId}/languages/${languageId}/translations`, {
      params: { fileId, limit, offset },
    });
    for (const item of data.data) {
      const row = item.data;
      // Response shape carries the source string under `.stringId`/`.string`
      // and the translation text under `.text` or `.translation.text`
      // depending on API version - handle both defensively.
      const stringId = row.stringId ?? row.string?.id;
      const text = row.text ?? row.translation?.text ?? row.translations?.[0]?.text;
      if (stringId != null && text != null) results.set(stringId, text);
    }
    if (data.data.length < limit) break;
    offset += limit;
  }
  return results;
}

module.exports = { getFile, setFileContext, listSourceStrings, listLanguageTranslations };
