/**
 * Slack DM notification for the "Mark as Finished" panel button - sends
 * the exported .srt straight to Daniel's Slack DM as a real attachment (not
 * just a link), per his explicit ask. Uses a dedicated Slack bot ("Subtitle
 * Finish Notifier") installed in the Sinch workspace, NOT Crowdin's own
 * Slack integration or Zapier - both were considered and ruled out (Zapier
 * because it wasn't reliable at the time; a plain Incoming Webhook because
 * it can't attach real files, only text/links).
 *
 * Configuration (Render env vars):
 *   SLACK_BOT_TOKEN - Bot User OAuth Token (xoxb-...) for the "Subtitle
 *     Finish Notifier" app, scopes: chat:write, files:write, im:write,
 *     users:read.
 *   SLACK_NOTIFY_USER_ID - Slack member ID to DM (e.g. "U02NPLAHSE6").
 *
 * Both are optional by design: if either is missing, sendFinishedFile()
 * quietly no-ops (returns { sent: false, reason }) instead of throwing -
 * marking a file+language "finished" in Crowdin must always succeed even
 * if Slack isn't configured yet (e.g. the bot is still awaiting workspace
 * admin approval - see README).
 */

const axios = require("axios");

const SLACK_API = "https://slack.com/api";

function isConfigured() {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_NOTIFY_USER_ID);
}

/** Every Slack Web API response is HTTP 200 even on failure - the real
 * success/error signal is the `ok` field in the body, with the reason in
 * `error`. Checking only res.status (as a naive first pass might) would
 * silently treat Slack-side failures as success. */
function assertOk(data, step) {
  if (!data.ok) {
    throw new Error(`Slack API step "${step}" failed: ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

async function openDm(botToken) {
  const { data } = await axios.post(
    `${SLACK_API}/conversations.open`,
    { users: process.env.SLACK_NOTIFY_USER_ID },
    { headers: { Authorization: `Bearer ${botToken}` } }
  );
  assertOk(data, "conversations.open");
  return data.channel.id;
}

/**
 * Upload a file to Slack and share it into a DM with an initial comment, via
 * the current (2024+) three-step external-upload flow - the older single-
 * call `files.upload` endpoint is deprecated for newly created Slack apps,
 * so this app never had that option available.
 *   1. files.getUploadURLExternal - reserve an upload slot, get a URL + file_id.
 *   2. POST the raw file bytes straight to that URL (not a slack.com API call).
 *   3. files.completeUploadExternal - finalize it and share to the channel.
 */
async function uploadFile(botToken, channelId, filename, content, initialComment) {
  const { data: slot } = await axios.post(
    `${SLACK_API}/files.getUploadURLExternal`,
    null,
    {
      headers: { Authorization: `Bearer ${botToken}` },
      params: { filename, length: Buffer.byteLength(content) },
    }
  );
  assertOk(slot, "files.getUploadURLExternal");

  await axios.post(slot.upload_url, content, {
    headers: { "Content-Type": "application/octet-stream" },
  });

  const { data: completed } = await axios.post(
    `${SLACK_API}/files.completeUploadExternal`,
    {
      files: [{ id: slot.file_id, title: filename }],
      channel_id: channelId,
      initial_comment: initialComment,
    },
    { headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" } }
  );
  return assertOk(completed, "files.completeUploadExternal");
}

/**
 * Send the exported .srt to Daniel's Slack DM. Never throws on missing
 * config (see module doc comment) - DOES throw on a real Slack API error
 * once configured, so the caller (server.js's /api/finish handler) can
 * decide whether to still report success to the linguist (finishing the
 * file in Crowdin should not be undone just because the DM failed).
 */
async function sendFinishedFile({ filename, content, comment }) {
  if (!isConfigured()) {
    return { sent: false, reason: "SLACK_BOT_TOKEN / SLACK_NOTIFY_USER_ID not configured" };
  }
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = await openDm(botToken);
  await uploadFile(botToken, channelId, filename, content, comment);
  return { sent: true };
}

module.exports = { isConfigured, sendFinishedFile };
