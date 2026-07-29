/**
 * Crowdin "crowdin_app" OAuth helper.
 *
 * Flow (per https://support.crowdin.com/developer/crowdin-apps-installation/
 * and crowdin-apps-security/):
 *   1. Org admin installs the app -> Crowdin POSTs to events.installed with
 *      { appId, appSecret, clientId, userId, organizationId, domain, baseUrl }.
 *      We persist that via lib/store.js.
 *   2. To call the Crowdin API on the org's behalf, exchange appSecret for
 *      an access token via POST https://accounts.crowdin.com/oauth/token
 *      with grant_type=crowdin_app.
 *   3. Every iframe load of our /panel URL carries a `jwtToken` query param
 *      signed (HS256) with the app's client secret. We must verify it
 *      before trusting the `domain`/`context` it carries.
 */

const axios = require("axios");
const jwt = require("jsonwebtoken");
const store = require("./store");

const OAUTH_TOKEN_URL = "https://accounts.crowdin.com/oauth/token";

async function exchangeForAccessToken(installation) {
  // client_id/client_secret identify our registered OAuth Application
  // (fixed, from Crowdin's Organization Settings -> OAuth apps) - NOT the
  // same as app_id/app_secret, which identify this specific installation
  // and come from the events.installed webhook payload.
  const { data } = await axios.post(OAUTH_TOKEN_URL, {
    grant_type: "crowdin_app",
    client_id: process.env.CROWDIN_CLIENT_ID || installation.clientId,
    client_secret: process.env.CROWDIN_CLIENT_SECRET,
    app_id: installation.appId,
    app_secret: installation.appSecret,
    domain: installation.domain,
    user_id: installation.userId,
  });
  // data: { access_token, refresh_token, expires_in, token_type, scope }
  const expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return store.saveInstallation(installation.domain, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessTokenExpiresAt: expiresAt,
  });
}

/** Returns a valid access token for the given domain, refreshing if needed. */
async function getAccessToken(domain) {
  let installation = await store.getInstallation(domain);
  if (!installation) {
    throw new Error(`No installation found for domain "${domain}". Is the app installed?`);
  }
  const isExpired =
    !installation.accessToken ||
    !installation.accessTokenExpiresAt ||
    Date.now() >= installation.accessTokenExpiresAt;

  if (isExpired) {
    installation = await exchangeForAccessToken(installation);
  }
  return installation.accessToken;
}

/**
 * Verify the jwtToken Crowdin appends to every iframe request.
 *
 * Per https://support.crowdin.com/developer/crowdin-apps-security/: "JWT
 * token is signed with an OAuth Client Secret known only to the two final
 * parties" - i.e. the STATIC secret from our registered OAuth Application
 * (CROWDIN_CLIENT_SECRET), not the per-installation `appSecret` from the
 * events.installed webhook. (Those two secrets were wrongly conflated here
 * originally, which made every panel request fail with "invalid signature"
 * even though the app had installed successfully.)
 */
async function verifyJwt(jwtToken) {
  const secret = process.env.CROWDIN_CLIENT_SECRET;
  if (!secret) {
    throw new Error("Server misconfigured: CROWDIN_CLIENT_SECRET is not set");
  }
  return jwt.verify(jwtToken, secret, { algorithms: ["HS256"] });
}

module.exports = { getAccessToken, verifyJwt, exchangeForAccessToken };
