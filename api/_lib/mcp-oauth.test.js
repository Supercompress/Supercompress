/**
 * MCP OAuth unit tests (memory store — no Firebase).
 * Run: SC_OAUTH_MEMORY=1 node api/_lib/mcp-oauth.test.js
 */
process.env.SC_OAUTH_MEMORY = "1";

const assert = require("node:assert/strict");
const {
  _resetMemoryForTests,
  registerClient,
  approveAuthorization,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  issuerMetadata,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  verifyPkce,
  sha256b64url,
  upsertClient,
  MCP_RESOURCE,
} = require("./mcp-oauth");

_resetMemoryForTests();

assert.equal(issuerMetadata().issuer, "https://www.supercompress.dev");
assert.ok(issuerMetadata().authorization_endpoint.includes("/api/oauth/authorize"));
assert.ok(issuerMetadata().code_challenge_methods_supported.includes("S256"));
assert.equal(protectedResourceMetadata().resource, MCP_RESOURCE);
assert.ok(wwwAuthenticateHeader().includes("resource_metadata="));
assert.ok(wwwAuthenticateHeader().includes("oauth-protected-resource"));

const verifier = "a".repeat(64);
const challenge = sha256b64url(verifier);
assert.equal(verifyPkce(verifier, challenge), true);
assert.equal(verifyPkce("wrong", challenge), false);

(async () => {
  const reg = await registerClient({
    redirect_uris: ["http://127.0.0.1:8787/callback"],
    client_name: "Test MCP",
  });
  assert.ok(reg.client_id.startsWith("sc_oauth_"));

  await upsertClient({
    clientId: "cursor-test",
    redirectUris: ["http://localhost:3000/oauth"],
    clientName: "Cursor",
  });

  const approved = await approveAuthorization({
    ownerUid: "user_test_1",
    clientId: reg.client_id,
    redirectUri: "http://127.0.0.1:8787/callback",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: "xyz",
    accessTokenSecret: "sc_live_test_access_token_value_ok",
    keyId: "sck_test",
  });
  assert.ok(approved.redirect_to.includes("code=sc_ac_"));
  assert.ok(approved.redirect_to.includes("state=xyz"));
  const code = new URL(approved.redirect_to).searchParams.get("code");

  const token = await exchangeAuthorizationCode({
    code,
    redirectUri: "http://127.0.0.1:8787/callback",
    codeVerifier: verifier,
    clientId: reg.client_id,
  });
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.access_token, "sc_live_test_access_token_value_ok");
  assert.ok(token.refresh_token.startsWith("sc_rt_"));

  // Code is single-use
  await assert.rejects(
    () =>
      exchangeAuthorizationCode({
        code,
        redirectUri: "http://127.0.0.1:8787/callback",
        codeVerifier: verifier,
        clientId: reg.client_id,
      }),
    /invalid_grant/
  );

  const refreshed = await exchangeRefreshToken({
    refreshToken: token.refresh_token,
    clientId: reg.client_id,
  });
  assert.equal(refreshed.access_token, token.access_token);
  assert.ok(refreshed.refresh_token.startsWith("sc_rt_"));
  assert.notEqual(refreshed.refresh_token, token.refresh_token);

  console.log("✔ mcp-oauth unit");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
