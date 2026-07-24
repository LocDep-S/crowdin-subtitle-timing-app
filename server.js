require("dotenv").config();
const axios = require("axios");
const express = require("express");
const path = require("path");
const store = require("./lib/store");
const auth = require("./lib/crowdinAuth");
const crowdin = require("./lib/crowdinApi");
const timingField = require("./lib/timingField");
const languageCues = require("./lib/languageCues");
const srt = require("./lib/srt");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use("/public", express.static(path.join(__dirname, "public")));

// -----------------------------------------------------------------------
// Manifest
// -----------------------------------------------------------------------
app.get("/manifest.json", (req, res) => {
  const manifest = require("./manifest.json");
  const baseUrl = process.env.PUBLIC_BASE_URL || manifest.baseUrl;
  res.json({ ...manifest, baseUrl });
});

// -----------------------------------------------------------------------
// Install / uninstall lifecycle hooks
// -----------------------------------------------------------------------
app.post("/hooks/installed", async (req, res) => {
  const { appId, appSecret, clientId, userId, organizationId, domain, baseUrl } = req.body || {};
  if (!domain || !appSecret || !clientId) {
    return res.status(400).json({ error: "Missing required installation fields" });
  }
  await store.saveInstallation(domain, { appId, appSecret, clientId, userId, organizationId, domain, baseUrl });
  console.log(`[installed] app installed for domain=${domain}`);

  // Best-effort: make sure the "Subtitle Timing Overrides" custom field
  // exists so the first cue-timing edit doesn't have to create it inline.
  try {
    const accessToken = await auth.getAccessToken(domain);
    await timingField.ensureTimingField(axios, accessToken, domain);
    await languageCues.ensureLanguageCuesField(axios, accessToken, domain);
  } catch (err) {
    console.error("Could not ensure timing/cue fields at install time:", err.message);
  }

  res.status(204).end();
});

app.post("/hooks/uninstall", async (req, res) => {
  const { domain } = req.body || {};
  if (domain) await store.removeInstallation(domain);
  console.log(`[uninstall] app removed for domain=${domain}`);
  res.status(204).end();
});

// -----------------------------------------------------------------------
// The editor-right-panel UI itself
// -----------------------------------------------------------------------
app.get("/panel", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

// -----------------------------------------------------------------------
// API used by public/panel.js
// -----------------------------------------------------------------------

async function requireJwt(req, res, next) {
  try {
    const jwtToken = req.query.jwtToken || req.body.jwtToken;
    if (!jwtToken) return res.status(401).json({ error: "Missing jwtToken" });
    req.crowdinContext = await auth.verifyJwt(jwtToken);
    next();
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    res.status(401).json({ error: "Invalid jwtToken" });
  }
}

/**
 * Builds the working cue list for one (file, language).
 *
 * If this (file, language) has been "customized" (a linguist has cloned,
 * split, merged, or deleted a cue - see lib/languageCues.js), the app's own
 * per-language cue list is the sole source of truth: text, timing, order,
 * and count all come from there, fully decoupled from Crowdin's source
 * strings from this point on.
 *
 * Otherwise, cues are derived live exactly as before: one cue per source
 * string, in source order, with per-language text/timing overrides (see
 * lib/timingField.js) layered on top of Crowdin's own translation/context.
 */
async function buildCues(accessToken, domain, projectId, fileId, languageId) {
  const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
  const customCues = languageCues.readForLanguage(file, languageId);
  if (customCues) {
    return customCues.map((c) => ({ ...c, isOverridden: true, isCustom: true }));
  }

  const [stringRecords, translations] = await Promise.all([
    crowdin.listSourceStrings(accessToken, domain, projectId, fileId),
    crowdin.listLanguageTranslations(accessToken, domain, projectId, languageId, fileId),
  ]);

  return stringRecords.map((s) => {
    const overrides = timingField.readOverrides(s);
    const languageOverride = overrides[languageId];
    const defaultTiming = srt.parseContextTiming(s.context) || { startMs: 0, endMs: 0 };

    return {
      id: String(s.id),
      sourceStringId: s.id,
      startMs: languageOverride?.startMs ?? defaultTiming.startMs,
      endMs: languageOverride?.endMs ?? defaultTiming.endMs,
      text: languageOverride?.text ?? translations.get(s.id) ?? s.text, // fall back to source text if untranslated
      isOverridden: Boolean(languageOverride),
      isCustom: false,
    };
  });
}

// GET /api/video?projectId=&fileId=&jwtToken=
// The video link is just the file's own `context` field - reusing the
// convention this Crowdin org already follows (an existing subtitle
// project already had a Vimeo link stored exactly this way).
app.get("/api/video", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId } = req.query;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
    const looksLikeUrl = file.context && /^https?:\/\//.test(file.context);
    res.json({ videoUrl: looksLikeUrl ? file.context : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/video  { projectId, fileId, videoUrl, jwtToken }
app.post("/api/video", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, videoUrl } = req.body;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const updated = await crowdin.setFileContext(accessToken, domain, projectId, fileId, videoUrl);
    res.json({ videoUrl: updated.context });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Whether a video URL points straight at a video FILE (so we can proxy the
 * bytes for a real download) vs. a hosting-platform page (YouTube watch
 * page, a Vimeo review link, etc.) that has no public "give me the raw
 * file" API. We tried extracting YouTube streams server-side via
 * @distube/ytdl-core, but YouTube rate-limits/blocks requests from cloud
 * hosting IPs like Render's almost immediately (HTTP 429), regardless of
 * who owns the video - not something worth chasing with cookie-auth
 * workarounds given the ongoing credential-maintenance cost. For anything
 * that isn't a direct file link, the client opens the original URL in a
 * new tab and lets the linguist use whatever download path they're
 * actually authorized to use there (their own Vimeo "Download" button if
 * the owner enabled it, etc).
 */
function isDirectVideoUrl(url) {
  try {
    const { pathname } = new URL(url);
    return /\.(mp4|webm|mov|m4v|mkv|avi)$/i.test(pathname);
  } catch {
    return false;
  }
}

// GET /api/video/download-info?projectId=&fileId=&jwtToken=
// Tells the panel whether it can proxy-download the video file directly,
// or should just open the source page instead - see isDirectVideoUrl above.
app.get("/api/video/download-info", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId } = req.query;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
    const videoUrl = file.context && /^https?:\/\//.test(file.context) ? file.context : null;

    if (!videoUrl) {
      return res.json({ downloadable: false, videoUrl: null, reason: "No video link saved for this file yet." });
    }
    if (isDirectVideoUrl(videoUrl)) {
      return res.json({ downloadable: true, videoUrl });
    }
    let host = "this host";
    try {
      host = new URL(videoUrl).hostname.replace(/^www\./, "");
    } catch {
      /* keep default */
    }
    return res.json({
      downloadable: false,
      videoUrl,
      reason: `${host} doesn't provide a direct video file to download automatically - opening it in a new tab instead.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/video/download?projectId=&fileId=&jwtToken=
// Proxies the actual bytes for direct video-file links only (see
// isDirectVideoUrl) so the browser gets a same-origin download instead of
// hitting cross-origin/CORS issues fetching the video host directly.
app.get("/api/video/download", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, filename } = req.query;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
    const videoUrl = file.context && /^https?:\/\//.test(file.context) ? file.context : null;

    if (!videoUrl || !isDirectVideoUrl(videoUrl)) {
      return res.status(400).json({ error: "This video isn't a direct file link that can be proxy-downloaded." });
    }

    const upstream = await axios.get(videoUrl, { responseType: "stream" });
    res.setHeader("Content-Type", upstream.headers["content-type"] || "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${filename || "video.mp4"}"`);
    upstream.data.pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cues?projectId=&fileId=&languageId=&jwtToken=
app.get("/api/cues", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, languageId } = req.query;
    if (!languageId) return res.status(400).json({ error: "languageId is required" });
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const cues = await buildCues(accessToken, domain, projectId, fileId, languageId);
    res.json(cues);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cues/timing  { projectId, fileId, languageId, cueId, startMs, endMs, jwtToken }
// For a non-customized (file, language): writes only this language's entry
// into the string's timing-overrides field (source `context` and every
// other language's timing are untouched). For a customized (file,
// language) - see lib/languageCues.js - edits the cue directly in the
// app-owned cue list instead.
app.post("/api/cues/timing", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, languageId, cueId, startMs, endMs } = req.body;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
    const customCues = languageCues.readForLanguage(file, languageId);

    if (customCues) {
      const idx = customCues.findIndex((c) => c.id === String(cueId));
      if (idx === -1) return res.status(404).json({ error: "Cue not found" });
      customCues[idx] = { ...customCues[idx], startMs: Number(startMs), endMs: Number(endMs) };
      await languageCues.writeForLanguage(axios, accessToken, domain, projectId, file, languageId, customCues);
      return res.json({ ok: true });
    }

    // Not yet customized - legacy per-string override path. Re-fetch the
    // string to get its current fields blob before merging, avoiding
    // clobbering another language's override written concurrently.
    const stringRecords = await crowdin.listSourceStrings(accessToken, domain, projectId, fileId);
    const stringRecord = stringRecords.find((s) => s.id === Number(cueId));
    if (!stringRecord) return res.status(404).json({ error: "String not found" });
    const merged = {
      ...timingField.readOverrides(stringRecord)[languageId],
      startMs: Number(startMs),
      endMs: Number(endMs),
    };
    await timingField.writeOverride(axios, accessToken, domain, projectId, stringRecord, languageId, merged);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cues/text  { projectId, fileId, languageId, cueId, text, jwtToken }
// Same routing as /api/cues/timing above, but for a cue's text. Never
// touches Crowdin's own translation object - this is purely a per-language
// override (or, once customized, part of the app-owned cue list).
app.post("/api/cues/text", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, languageId, cueId, text } = req.body;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
    const customCues = languageCues.readForLanguage(file, languageId);

    if (customCues) {
      const idx = customCues.findIndex((c) => c.id === String(cueId));
      if (idx === -1) return res.status(404).json({ error: "Cue not found" });
      customCues[idx] = { ...customCues[idx], text };
      await languageCues.writeForLanguage(axios, accessToken, domain, projectId, file, languageId, customCues);
      return res.json({ ok: true });
    }

    const stringRecords = await crowdin.listSourceStrings(accessToken, domain, projectId, fileId);
    const stringRecord = stringRecords.find((s) => s.id === Number(cueId));
    if (!stringRecord) return res.status(404).json({ error: "String not found" });
    const merged = { ...timingField.readOverrides(stringRecord)[languageId], text };
    await timingField.writeOverride(axios, accessToken, domain, projectId, stringRecord, languageId, merged);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cues/clone  { projectId, fileId, languageId, cueId, jwtToken }
// Duplicates a cue right after itself, for this language only - the first
// time this is used on a (file, language), it "customizes" it (see
// lib/languageCues.js). Never touches Crowdin's source strings or any
// other language.
app.post("/api/cues/clone", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, languageId, cueId } = req.body;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);

    const cues = await buildCues(accessToken, domain, projectId, fileId, languageId);
    const idx = cues.findIndex((c) => c.id === String(cueId));
    if (idx === -1) return res.status(404).json({ error: "Cue not found" });

    const clone = { ...cues[idx], id: `${cues[idx].id}-clone-${Date.now()}` };
    cues.splice(idx + 1, 0, clone);

    const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
    await languageCues.writeForLanguage(axios, accessToken, domain, projectId, file, languageId, cues);
    res.json({ cues });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cues/delete  { projectId, fileId, languageId, cueId, jwtToken }
// Removes a cue from this language's view only - the underlying Crowdin
// source string (if any) and its translation are left completely
// untouched, per instruction. Also "customizes" the (file, language) if it
// wasn't already.
app.post("/api/cues/delete", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, languageId, cueId } = req.body;
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);

    const cues = await buildCues(accessToken, domain, projectId, fileId, languageId);
    const next = cues.filter((c) => c.id !== String(cueId));
    if (next.length === cues.length) return res.status(404).json({ error: "Cue not found" });

    const file = await crowdin.getFile(accessToken, domain, projectId, fileId);
    await languageCues.writeForLanguage(axios, accessToken, domain, projectId, file, languageId, next);
    res.json({ cues: next });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export?projectId=&fileId=&languageId=&jwtToken=
// Assembles the final, correctly-timed .srt for one language and returns
// it as a download. This - not Crowdin's own "Download translations" - is
// the place that reflects per-language timing corrections; see README for
// why Crowdin's native export can't (there's no per-language timing slot
// in its data model).
app.get("/api/export", requireJwt, async (req, res) => {
  try {
    const { projectId, fileId, languageId, filename } = req.query;
    if (!languageId) return res.status(400).json({ error: "languageId is required" });
    const domain = req.crowdinContext.domain;
    const accessToken = await auth.getAccessToken(domain);
    const cues = await buildCues(accessToken, domain, projectId, fileId, languageId);

    const body = srt.stringifySrt(cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })));
    const name = filename || `subtitles-${languageId}.srt`;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Crowdin Subtitle Video & Timing app listening on :${PORT}`);
  console.log(`Manifest:  http://localhost:${PORT}/manifest.json`);
  console.log(`Panel dev: http://localhost:${PORT}/dev (mock context, no Crowdin needed)`);
});

// -----------------------------------------------------------------------
// Local dev harness - no Crowdin/OAuth needed, see public/dev-harness.html
// -----------------------------------------------------------------------
app.get("/dev", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dev-harness.html"));
});
app.get("/dev/sample.srt", (req, res) => {
  res.sendFile(path.join(__dirname, "test", "sample.srt"));
});
