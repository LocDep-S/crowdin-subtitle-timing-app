/* eslint-disable no-undef */
/**
 * Front end for the "Video & Timing" editor-right-panel.
 *
 * Per-language design: text and timing are both editable here, and both
 * stored as per-language overrides (see lib/timingField.js server side) -
 * so a French translator's edits never touch English or any other
 * language. Cues can also be cloned or deleted (to split/merge subtitles)
 * - the first time that happens for a given language on a file, this
 * language's ENTIRE cue list (text+timing+order+count) becomes owned by
 * the app instead of derived from Crowdin's source strings (see
 * lib/languageCues.js server side for why, and the trade-off that comes
 * with it: Crowdin's own translation grid/reports may no longer reflect
 * reality for that file+language - Export .srt is always correct though).
 *
 * The active language is read from Crowdin's own Editor context
 * (`editor.target_language_id` / `editor.active_target_language_id`),
 * confirmed against Crowdin's Apps JS SDK docs. In "multilingual" mode
 * `active_target_language_id` tracks the translator's cursor, so this
 * file polls context on an interval and re-renders if it changes.
 */

(function () {
  const qs = new URLSearchParams(location.search);
  // Fallback only - used when AP isn't available at all (e.g. this panel
  // loaded outside Crowdin, or the /dev harness). Inside the real Editor
  // this initial value goes stale fast: Crowdin's own jwtToken docs example
  // shows a token minted for only ~15 minutes, and the panel can easily
  // stay open longer than that while someone keeps translating. Reusing it
  // for every request caused "jwt expired" 401s on anything clicked a
  // while after the panel first loaded (Save, Export, etc).
  const fallbackJwtToken = qs.get("jwtToken");

  const state = {
    projectId: qs.get("projectId"),
    fileId: qs.get("fileId"),
    fileName: qs.get("fileName") || "subtitles.srt",
    languageId: null,
    cues: [],
    player: null,
    playerReady: false,
    activeCueId: null,
  };

  const els = {
    videoSetup: document.getElementById("video-setup"),
    videoUrlInput: document.getElementById("video-url-input"),
    videoUrlSave: document.getElementById("video-url-save"),
    changeVideoBtn: document.getElementById("change-video-btn"),
    langBadge: document.getElementById("lang-badge"),
    status: document.getElementById("status"),
    downloadVideoBtn: document.getElementById("download-video-btn"),
    exportBtn: document.getElementById("export-btn"),
    cueList: document.getElementById("cue-list"),
    subtitleOverlay: document.getElementById("subtitle-overlay"),
  };

  function setStatus(msg) {
    els.status.textContent = msg || "";
  }

  // Always fetch a fresh JWT right before a request instead of reusing the
  // one from the panel's initial URL - see AP.getJwtToken() in
  // https://support.crowdin.com/developer/crowdin-apps-js/.
  function getFreshJwtToken() {
    return new Promise((resolve) => {
      if (window.AP && AP.getJwtToken) {
        AP.getJwtToken((token) => resolve(token || fallbackJwtToken));
      } else {
        resolve(fallbackJwtToken);
      }
    });
  }

  async function apiUrl(path, params) {
    const jwtToken = await getFreshJwtToken();
    const u = new URL(path, location.origin);
    u.searchParams.set("jwtToken", jwtToken);
    Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  }

  // On failure, surface the server's actual { error: "..." } message rather
  // than just the HTTP status - server.js's handlers deliberately return
  // Crowdin's real validation detail in that field (see lib/timingField.js
  // / lib/languageCues.js), which was previously getting thrown away here.
  async function errorFromResponse(res, path) {
    try {
      const body = await res.json();
      if (body?.error) return new Error(body.error);
    } catch {
      /* body wasn't JSON - fall through to the generic message below */
    }
    return new Error(`${path} -> ${res.status}`);
  }

  async function apiGet(path, params) {
    const res = await fetch(await apiUrl(path, params));
    if (!res.ok) throw await errorFromResponse(res, path);
    return res.json();
  }

  async function apiPost(path, body) {
    const jwtToken = await getFreshJwtToken();
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, jwtToken }),
    });
    if (!res.ok) throw await errorFromResponse(res, path);
    return res.json();
  }

  // ---- YouTube embed ----------------------------------------------------

  function youTubeIdFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/\/embed\/([^/?]+)/);
      if (m) return m[1];
    } catch (e) {
      /* not a URL */
    }
    return null;
  }

  function loadYouTubeApiThen(cb) {
    if (window.YT && window.YT.Player) return cb();
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = cb;
  }

  function mountPlayer(videoUrl) {
    const videoId = youTubeIdFromUrl(videoUrl);
    if (!videoId) {
      setStatus("Could not parse a YouTube video ID from that URL.");
      return;
    }
    loadYouTubeApiThen(() => {
      state.player = new YT.Player("player", {
        videoId,
        // cc_load_policy: 0 suppresses YouTube's own caption track (which
        // would otherwise show the video's original/English captions if the
        // uploader or viewer has them on by default) - our own
        // #subtitle-overlay (driven by this language's cue list, see
        // startTimeSync below) is meant to be the only subtitle visible.
        playerVars: { rel: 0, modestbranding: 1, cc_load_policy: 0 },
        events: {
          onReady: () => {
            state.playerReady = true;
            startTimeSync();
          },
        },
      });
    });
  }

  function seekTo(ms) {
    if (state.playerReady) state.player.seekTo(ms / 1000, true);
  }

  // Burned-in subtitle overlay: always reflects THIS language's current cue
  // text (state.cues, including any not-yet-saved edit in the textarea),
  // never the source English - see panel.css's #subtitle-overlay and the
  // cc_load_policy: 0 above.
  function renderSubtitleOverlay(cue) {
    if (!cue || !cue.text) {
      els.subtitleOverlay.innerHTML = "";
      return;
    }
    els.subtitleOverlay.innerHTML = `<span>${escapeHtml(cue.text)}</span>`;
  }

  function startTimeSync() {
    setInterval(() => {
      if (!state.playerReady) return;
      const currentMs = state.player.getCurrentTime() * 1000;
      const active = state.cues.find((c) => currentMs >= c.startMs && currentMs < c.endMs);
      highlightCue(active ? active.id : null);
      renderSubtitleOverlay(active);
    }, 250);
  }

  // ---- Video URL setup (stored on the Crowdin file's own `context` field) --

  async function initVideo() {
    const { videoUrl } = await apiGet("/api/video", { projectId: state.projectId, fileId: state.fileId });
    if (videoUrl) {
      mountPlayer(videoUrl);
    } else {
      els.videoSetup.classList.remove("hidden");
    }
    els.videoUrlInput.value = videoUrl || "";
  }

  els.changeVideoBtn.addEventListener("click", () => {
    els.videoSetup.classList.toggle("hidden");
  });

  els.videoUrlSave.addEventListener("click", async () => {
    const videoUrl = els.videoUrlInput.value.trim();
    if (!videoUrl) return;
    setStatus("Saving video link…");
    try {
      await apiPost("/api/video", { projectId: state.projectId, fileId: state.fileId, videoUrl });
      els.videoSetup.classList.add("hidden");
      mountPlayer(videoUrl);
      setStatus("Video link saved.");
    } catch (err) {
      setStatus(`Could not save video link: ${err.message}`);
    }
  });

  // ---- Cue list rendering: text and timing are both editable; cues can --
  // also be cloned or deleted to split/merge subtitles (see server.js /
  // lib/languageCues.js for what that does behind the scenes).

  function msToInputValue(ms) {
    const total = Math.max(0, Math.round(ms));
    const mm = String(Math.floor(total / 60000)).padStart(2, "0");
    const ss = String(Math.floor((total % 60000) / 1000)).padStart(2, "0");
    const mss = String(total % 1000).padStart(3, "0");
    return `${mm}:${ss}.${mss}`;
  }

  function inputValueToMs(value) {
    const m = /^(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
    if (!m) return null;
    const [, mm, ss, mss] = m;
    return parseInt(mm, 10) * 60000 + parseInt(ss, 10) * 1000 + parseInt(mss || "0", 10);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Cues whose [startMs, endMs) range overlaps another cue in the same
  // language, regardless of their order in the list - sorted by start time
  // first so this catches overlaps even after a clone/split leaves cues
  // temporarily out of chronological order in the array.
  function computeOverlappingIds(cues) {
    const overlapping = new Set();
    const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startMs < sorted[i - 1].endMs) {
        overlapping.add(sorted[i].id);
        overlapping.add(sorted[i - 1].id);
      }
    }
    return overlapping;
  }

  function renderCues() {
    const overlapping = computeOverlappingIds(state.cues);
    els.cueList.innerHTML = "";
    state.cues.forEach((cue) => {
      const li = document.createElement("li");
      li.className = "cue" + (cue.isOverridden ? " overridden" : "") + (overlapping.has(cue.id) ? " overlap" : "");
      li.dataset.cueId = cue.id;

      li.innerHTML = `
        <div class="body">
          <div class="times">
            <button data-adj="-100" data-field="start">−</button>
            <input data-field="start" value="${msToInputValue(cue.startMs)}" />
            <button data-adj="100" data-field="start">+</button>
            <span>→</span>
            <button data-adj="-100" data-field="end">−</button>
            <input data-field="end" value="${msToInputValue(cue.endMs)}" />
            <button data-adj="100" data-field="end">+</button>
            ${cue.isOverridden ? '<span class="overridden-tag">custom timing</span>' : ""}
            ${overlapping.has(cue.id) ? '<span class="overlap-tag">overlaps another cue</span>' : ""}
          </div>
          <textarea class="text" rows="2">${escapeHtml(cue.text)}</textarea>
          <div class="cue-actions">
            <button data-action="clone" title="Clone this cue (e.g. to split it in two)">Clone</button>
            <button data-action="delete" title="Delete this cue">Delete</button>
          </div>
        </div>
      `;

      const textEl = li.querySelector(".text");
      textEl.addEventListener("click", () => seekTo(cue.startMs));
      textEl.addEventListener("change", () => saveText(cue.id, textEl.value));

      li.querySelectorAll("input[data-field]").forEach((input) => {
        input.addEventListener("change", () => onTimeInputChange(cue.id, input));
      });
      li.querySelectorAll("button[data-adj]").forEach((btn) => {
        btn.addEventListener("click", () => nudge(cue.id, btn.dataset.field, parseInt(btn.dataset.adj, 10)));
      });
      li.querySelector('[data-action="clone"]').addEventListener("click", () => cloneCue(cue.id));
      li.querySelector('[data-action="delete"]').addEventListener("click", () => deleteCue(cue.id));

      els.cueList.appendChild(li);
    });
  }

  function highlightCue(cueId) {
    if (String(cueId) === String(state.activeCueId)) return;
    state.activeCueId = cueId;
    els.cueList.querySelectorAll(".cue").forEach((li) => {
      li.classList.toggle("active", li.dataset.cueId === String(cueId));
    });
    if (cueId != null) {
      const el = els.cueList.querySelector(`[data-cue-id="${CSS.escape(String(cueId))}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  async function saveTiming(cueId, startMs, endMs) {
    try {
      await apiPost("/api/cues/timing", {
        projectId: state.projectId,
        fileId: state.fileId,
        languageId: state.languageId,
        cueId,
        startMs,
        endMs,
      });
      const cue = state.cues.find((c) => c.id === cueId);
      if (cue) cue.isOverridden = true;
      renderCues();
      setStatus("Timing saved.");
    } catch (err) {
      setStatus(`Could not save timing: ${err.message}`);
    }
  }

  async function saveText(cueId, text) {
    try {
      await apiPost("/api/cues/text", {
        projectId: state.projectId,
        fileId: state.fileId,
        languageId: state.languageId,
        cueId,
        text,
      });
      const cue = state.cues.find((c) => c.id === cueId);
      if (cue) {
        cue.text = text;
        cue.isOverridden = true;
      }
      setStatus("Text saved.");
    } catch (err) {
      setStatus(`Could not save text: ${err.message}`);
    }
  }

  async function onTimeInputChange(cueId, input) {
    const ms = inputValueToMs(input.value);
    if (ms === null) return;
    const cue = state.cues.find((c) => c.id === cueId);
    if (input.dataset.field === "start") cue.startMs = ms; else cue.endMs = ms;
    await saveTiming(cueId, cue.startMs, cue.endMs);
  }

  async function nudge(cueId, field, deltaMs) {
    const cue = state.cues.find((c) => c.id === cueId);
    if (field === "start") cue.startMs = Math.max(0, cue.startMs + deltaMs);
    else cue.endMs = Math.max(cue.startMs + 100, cue.endMs + deltaMs);
    await saveTiming(cueId, cue.startMs, cue.endMs);
  }

  // Cloning/deleting change the NUMBER of cues for this language, which
  // Crowdin has no way to represent per-string - the server snapshots this
  // language's full cue list into its own storage the first time either of
  // these is used on a file (see lib/languageCues.js). The server returns
  // the resulting full cue list, which we use directly rather than
  // recomputing it locally.

  async function cloneCue(cueId) {
    setStatus("Cloning cue…");
    try {
      const result = await apiPost("/api/cues/clone", {
        projectId: state.projectId,
        fileId: state.fileId,
        languageId: state.languageId,
        cueId,
      });
      state.cues = result.cues;
      renderCues();
      setStatus("Cue cloned - adjust timing/text on each half.");
    } catch (err) {
      setStatus(`Could not clone cue: ${err.message}`);
    }
  }

  async function deleteCue(cueId) {
    if (!confirm("Delete this cue? This only affects this language's subtitle list here - it won't delete the source string in Crowdin.")) {
      return;
    }
    setStatus("Deleting cue…");
    try {
      const result = await apiPost("/api/cues/delete", {
        projectId: state.projectId,
        fileId: state.fileId,
        languageId: state.languageId,
        cueId,
      });
      state.cues = result.cues;
      renderCues();
      setStatus("Cue deleted.");
    } catch (err) {
      setStatus(`Could not delete cue: ${err.message}`);
    }
  }

  // ---- Download video --------------------------------------------------
  // Only proxies real bytes for a direct video-file link (see server.js's
  // isDirectVideoUrl). For platform pages we can't get a raw file from
  // without scraping (notably YouTube - blocked with a 429 from Render's IP
  // when we tried it via ytdl-core, and not worth the cookie-auth
  // maintenance burden to chase - see server.js), we just open the source
  // in a new tab.

  els.downloadVideoBtn.addEventListener("click", async () => {
    setStatus("Checking video link…");
    try {
      const info = await apiGet("/api/video/download-info", {
        projectId: state.projectId,
        fileId: state.fileId,
      });
      if (!info.videoUrl) {
        setStatus(info.reason || "No video link saved for this file yet.");
        return;
      }
      if (!info.downloadable) {
        window.open(info.videoUrl, "_blank", "noopener");
        setStatus(info.reason || "Opened the source video in a new tab.");
        return;
      }
      setStatus("Downloading video…");
      const url = await apiUrl("/api/video/download", {
        projectId: state.projectId,
        fileId: state.fileId,
        filename: `${state.fileName.replace(/\.srt$/i, "")}.mp4`,
      });
      const res = await fetch(url);
      if (!res.ok) throw await errorFromResponse(res, "download");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${state.fileName.replace(/\.srt$/i, "")}.mp4`;
      a.click();
      setStatus("Video downloaded.");
    } catch (err) {
      setStatus(`Could not download video: ${err.message}`);
    }
  });

  // ---- Export --------------------------------------------------------------

  els.exportBtn.addEventListener("click", async () => {
    setStatus("Building export…");
    try {
      const url = await apiUrl("/api/export", {
        projectId: state.projectId,
        fileId: state.fileId,
        languageId: state.languageId,
        filename: `${state.fileName.replace(/\.srt$/i, "")}.${state.languageId}.srt`,
      });
      const res = await fetch(url);
      if (!res.ok) throw await errorFromResponse(res, "export");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${state.fileName.replace(/\.srt$/i, "")}.${state.languageId}.srt`;
      a.click();
      setStatus(`Exported ${state.languageId}.srt`);
    } catch (err) {
      setStatus(`Export failed: ${err.message}`);
    }
  });

  // ---- Active target language + reload on change ----------------------------

  async function loadForLanguage(languageId) {
    state.languageId = languageId;
    els.langBadge.textContent = languageId;
    state.cues = await apiGet("/api/cues", { projectId: state.projectId, fileId: state.fileId, languageId });
    renderCues();
    // Force the next startTimeSync tick to re-evaluate the active cue and
    // overlay against the NEW language's cue list - otherwise a coincidental
    // id match with the previous language's active cue would skip
    // re-applying the "active" highlight/overlay text.
    state.activeCueId = null;
    els.subtitleOverlay.innerHTML = "";
    setStatus(`${state.cues.length} cues loaded (${languageId}).`);
  }

  function currentLanguageFromContext(context) {
    const editor = context?.editor || {};
    return editor.active_target_language_id || editor.target_language_id || null;
  }

  function watchLanguage() {
    if (!window.AP || !AP.getContext) return;
    setInterval(() => {
      AP.getContext(async (context) => {
        const languageId = currentLanguageFromContext(context);
        if (languageId && languageId !== state.languageId) {
          try {
            await loadForLanguage(languageId);
          } catch (err) {
            setStatus(`Error loading ${languageId}: ${err.message}`);
          }
        }
      });
    }, 1500);
  }

  // ---- Boot ----------------------------------------------------

  async function init() {
    let initialLanguageId = null;

    if (window.AP && AP.getContext) {
      await new Promise((resolve) => {
        AP.getContext((context) => {
          // Per https://support.crowdin.com/developer/crowdin-apps-js/ the
          // real ContextDataObject has project id at the top level and the
          // open file under `editor` - NOT `context.project.id`/
          // `context.file.id` (there is no top-level `project`/`file` key).
          // Getting this wrong made every /api/* call go out as
          // ".../files/undefined" and 404/500.
          state.projectId = state.projectId || context?.project_id;
          state.fileId = state.fileId || context?.editor?.file;
          state.fileName = context?.editor?.fileData?.name || state.fileName;
          initialLanguageId = currentLanguageFromContext(context);
          resolve();
        });
      });
      AP.resize && AP.resize();
    }

    const hasAnyJwtSource = Boolean((window.AP && AP.getJwtToken) || fallbackJwtToken);
    if (!state.projectId || !state.fileId || !hasAnyJwtSource) {
      setStatus("Missing project/file context or jwtToken - open this panel from inside the Crowdin Editor.");
      return;
    }
    if (!initialLanguageId) {
      setStatus("Could not detect the active target language from Crowdin's Editor context.");
      return;
    }

    await initVideo();
    await loadForLanguage(initialLanguageId);
    watchLanguage();
  }

  init().catch((err) => setStatus(`Error: ${err.message}`));
})();
