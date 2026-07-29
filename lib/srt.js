/**
 * SRT helpers: timecode <-> ms conversion, source-string "context" timing
 * parsing, and .srt serialization for exports.
 *
 * Verified live against a real Crowdin Enterprise subtitle project: Crowdin's
 * own SRT importer writes each cue's timecodes into the SOURCE STRING's
 * `context` field, formatted like:
 *   "Start time: 00:00:09,503\r\n End time: 00:00:12,971"
 * That's a single value per string, shared by every target language - there
 * is no per-language timing anywhere in Crowdin's data model (confirmed: the
 * Translation object is text-only, and custom Fields don't support a
 * per-translation/per-language scope). So this app treats that context value
 * purely as the DEFAULT starting timing for a language the first time it's
 * opened - per-language corrections are stored separately (see
 * lib/timingField.js) and never written back into this context field.
 */

const TIME_RE = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
const CUE_HEADER_RE = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/;
const CONTEXT_TIMING_RE = /Start time:\s*(\d{2}:\d{2}:\d{2}[,.]\d{3}).*End time:\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/s;

function timeToMs(t) {
  const m = TIME_RE.exec(t);
  if (!m) return 0;
  const [, hh, mm, ss, ms] = m;
  return (
    parseInt(hh, 10) * 3600000 +
    parseInt(mm, 10) * 60000 +
    parseInt(ss, 10) * 1000 +
    parseInt(ms, 10)
  );
}

function msToTime(totalMs) {
  totalMs = Math.max(0, Math.round(totalMs));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const ss = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;
  const hh = Math.floor(totalMin / 60);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`;
}

/**
 * Parse a source string's `context` field for its default (source-language)
 * timing. Returns null if the context doesn't match the "Start time: ... /
 * End time: ..." convention Crowdin's SRT importer uses.
 */
function parseContextTiming(context) {
  if (!context) return null;
  const m = CONTEXT_TIMING_RE.exec(context);
  if (!m) return null;
  return { startMs: timeToMs(m[1]), endMs: timeToMs(m[2]) };
}

/**
 * Parse raw SRT text into an ordered array of cues: { index, startMs, endMs, text }.
 * Not used in the main Crowdin-connected flow anymore (timing now comes from
 * the `context` field per string) - kept for the standalone /dev harness and
 * for anyone testing against a raw .srt file directly.
 */
function parseSrt(raw) {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/﻿/g, "");
  const blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (!lines.length) continue;

    let cursor = 0;
    let index = cues.length + 1;
    if (/^\d+$/.test(lines[cursor].trim())) {
      index = parseInt(lines[cursor].trim(), 10);
      cursor += 1;
    }
    if (cursor >= lines.length) continue;

    const headerMatch = CUE_HEADER_RE.exec(lines[cursor].trim());
    if (!headerMatch) continue;
    cursor += 1;

    const text = lines.slice(cursor).join("\n").trim();

    cues.push({
      index,
      startMs: timeToMs(headerMatch[1]),
      endMs: timeToMs(headerMatch[2]),
      text,
    });
  }
  return cues;
}

/**
 * Serialize a cue array (in a given order, with given timings/text) into a
 * valid .srt file. Used to assemble the final per-language export - cue
 * order always mirrors the untouched English source order.
 */
function stringifySrt(cues) {
  return cues
    .map((cue, i) => {
      const n = i + 1;
      return `${n}\n${msToTime(cue.startMs)} --> ${msToTime(cue.endMs)}\n${cue.text}\n`;
    })
    .join("\n");
}

module.exports = { parseSrt, stringifySrt, timeToMs, msToTime, parseContextTiming };
