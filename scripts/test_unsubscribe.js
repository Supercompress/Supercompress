#!/usr/bin/env node
/**
 * Local smoke for weekly unsubscribe tokens + handler shape.
 * Usage: node scripts/test_unsubscribe.js
 */
const assert = require("assert");
const {
  unsubToken,
  verifyUnsubToken,
  unsubUrlFor,
  unsubApiUrlFor,
} = require("../api/_lib/weekly");
const { readBody } = require("../api/_lib/http");

const email = "test.user+tag@example.com";
const token = unsubToken(email);
assert(verifyUnsubToken(email, token), "token should verify");
assert(verifyUnsubToken(email, token.toUpperCase()), "token case-insensitive");

const pageUrl = unsubUrlFor(email);
const apiUrl = unsubApiUrlFor(email);
assert(pageUrl.includes("/unsubscribe?"), "page url");
assert(apiUrl.includes("/api/weekly/unsubscribe?"), "api url");
assert(apiUrl.includes("token="), "api url has token");

const parsed = new URL(apiUrl);
const qEmail = decodeURIComponent(parsed.searchParams.get("email"));
const qToken = parsed.searchParams.get("token");
assert(qEmail === email.toLowerCase(), "round-trip email");
assert(verifyUnsubToken(qEmail, qToken), "query token verifies");

const req = {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: "List-Unsubscribe=One-Click",
  query: { email: encodeURIComponent(email), token },
};
const body = readBody(req);
assert(body["List-Unsubscribe"] === "One-Click", "one-click body parse");

console.log(JSON.stringify({ ok: true, email, pageUrl, apiUrl }, null, 2));
