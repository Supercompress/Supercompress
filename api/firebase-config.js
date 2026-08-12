/** Public Firebase client config — read from env at runtime (no rebuild needed). */
const { json } = require("./_lib/http");

function clean(value) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

module.exports = (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method !== "GET") return json(res, 405, { detail: "Method not allowed", allow: "GET" });

  return json(res, 200, {
    apiKey: clean(process.env.FIREBASE_API_KEY),
    authDomain: clean(process.env.FIREBASE_AUTH_DOMAIN),
    projectId: clean(process.env.FIREBASE_PROJECT_ID),
    storageBucket: clean(process.env.FIREBASE_STORAGE_BUCKET || process.env.StorageBucket),
    messagingSenderId: clean(process.env.FIREBASE_MESSAGING_SENDER_ID),
    appId: clean(process.env.FIREBASE_APP_ID),
    measurementId: clean(process.env.FIREBASE_MEASUREMENT_ID),
  });
};
