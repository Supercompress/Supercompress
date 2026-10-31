const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../tui/sc.ts"), "utf8");
const start = source.indexOf("export async function fetchUsage()");
const end = source.indexOf("export async function fetchAccount()", start);
const fetchUsage = source.slice(start, end).replace("export ", "").replace(": Promise<UsageSnap>", "");

test("account enrichment cannot overwrite ledger-backed quota or wallet state", async () => {
  const usage = { tokens_used_this_period: 1_000_000, tokens_remaining: 0, usage_pct: 100, limit_reached: true, credit_balance_usd: 0 };
  const account = { email: "recipient@product.example.test", tokens_used_this_period: 50, tokens_remaining: 999_950, usage_pct: 0, limit_reached: false, credit_balance_usd: 10, tokens_per_month: 1_000_000 };
  const context = vm.createContext({
    loadConfig: () => ({ api_key: "offline" }), USAGE_URL: "usage", ME_URL: "account",
    fetchJson: async url => ({ ...(url === "usage" ? usage : account) }),
    usageFromApi: data => data, emptyUsage: error => { throw Error(error); },
  });
  vm.runInContext(fetchUsage, context);
  const result = await context.fetchUsage();
  for (const [field, value] of Object.entries(usage)) assert.equal(result[field], value, field);
  assert.equal(result.email, account.email);
  assert.equal(result.tokens_per_month, 1_000_000);
});
