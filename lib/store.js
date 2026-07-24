/**
 * Storage for OAuth installation credentials, backed by Upstash Redis.
 *
 * Why not local JSON files anymore: this app is meant to run on a free host
 * (e.g. Render's free web service), and free tiers on basically every such
 * host have no persistent local disk - a restart or redeploy would silently
 * wipe a JSON file and lose the org's Crowdin connection. Upstash's free
 * Redis tier is small but genuinely persistent and reachable over the
 * network from anywhere, which fixes that regardless of where the app
 * itself runs.
 *
 * Needs two env vars (see .env.example): UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN, from the Upstash console for the database this
 * app should use.
 *
 * All functions are async now (Redis is a network call) - see
 * lib/crowdinAuth.js and server.js for the corresponding `await`s.
 */

const { Redis } = require("@upstash/redis");

const redis = Redis.fromEnv();
const KEY = "installations";

async function getInstallations() {
  const all = await redis.get(KEY);
  return all || {};
}

async function saveInstallation(domain, record) {
  const all = await getInstallations();
  all[domain] = { ...all[domain], ...record };
  await redis.set(KEY, all);
  return all[domain];
}

async function getInstallation(domain) {
  const all = await getInstallations();
  return all[domain];
}

async function removeInstallation(domain) {
  const all = await getInstallations();
  delete all[domain];
  await redis.set(KEY, all);
}

module.exports = { getInstallations, saveInstallation, getInstallation, removeInstallation };
