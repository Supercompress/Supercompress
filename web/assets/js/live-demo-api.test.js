const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "live-demo.js"), "utf8");

assert.match(
  src,
  /const API_URL = "https:\/\/www\.supercompress\.dev\/api\/v1\/compress"/,
  "live-demo.js must call the www API host"
);
assert.doesNotMatch(
  src,
  /const API_URL = ["']https:\/\/supercompress\.dev/,
  "live-demo.js must not call the apex host (CORS 308)"
);
assert.doesNotMatch(
  src,
  /const API_URL = ["']\/api\//,
  "live-demo.js must use an absolute working API base, not a same-origin relative path"
);

console.log("live-demo-api.test.js: ok");
