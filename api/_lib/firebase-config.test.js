const assert = require("node:assert/strict");
const test = require("node:test");
const handler = require("../firebase-config");

test("Firebase OAuth callback follows trusted config on every request host", () => {
  const previous = process.env.FIREBASE_AUTH_DOMAIN;
  try {
    process.env.FIREBASE_AUTH_DOMAIN = "supercompress.firebaseapp.com";
    for (const host of ["www.supercompress.dev", "supercompress.dev", "docs.supercompress.dev", "supercompress-preview.vercel.app", "attacker.example"]) {
      const headers = {};
      let body;
      const response = {
        setHeader(name, value) { headers[name] = value; },
        status(code) { assert.equal(code, 200); return this; },
        json(value) { body = value; },
        end(value) { body = JSON.parse(value); },
      };
      handler({ method: "GET", headers: { host, "x-forwarded-host": host } }, response);
      assert.equal(body.authDomain, "supercompress.firebaseapp.com");
      assert.equal(headers["Cache-Control"], "no-store");
    }
  } finally {
    if (previous === undefined) delete process.env.FIREBASE_AUTH_DOMAIN;
    else process.env.FIREBASE_AUTH_DOMAIN = previous;
  }
});

test("Missing auth domain is never synthesized from request headers", () => {
  const previous = process.env.FIREBASE_AUTH_DOMAIN;
  delete process.env.FIREBASE_AUTH_DOMAIN;
  try {
    let body;
    handler({ method: "GET", headers: { host: "www.supercompress.dev" } }, {
      setHeader() {}, status() { return this; }, json(value) { body = value; },
      end(value) { body = JSON.parse(value); },
    });
    assert.equal(body.authDomain, "");
  } finally {
    if (previous !== undefined) process.env.FIREBASE_AUTH_DOMAIN = previous;
  }
});
