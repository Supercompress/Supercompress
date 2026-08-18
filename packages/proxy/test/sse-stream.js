#!/usr/bin/env node
/**
 * SSE relay must survive arbitrary TCP chunk boundaries.
 *
 * Lines are buffered across chunks, but the Node stream path decoded each
 * chunk with `chunk.toString()`. A multi-byte character straddling a chunk
 * boundary decoded to U+FFFD on both sides, so any response containing
 * non-ASCII text — accented words, CJK, emoji — was corrupted in transit
 * whenever the boundary happened to land inside the character.
 */

const assert = require("assert");
const { Readable } = require("stream");
const { pipeBufferedSSE } = require("../src/forwarder.js");

/** Minimal res double: records everything written. */
function fakeRes() {
  return {
    out: "",
    writableEnded: false,
    write(s) { this.out += s; },
    end() { this.writableEnded = true; },
  };
}

/** Feed `payload` through the relay in chunks of exactly `size` bytes. */
function relay(payload, size, opts) {
  return new Promise((resolve) => {
    const buf = Buffer.from(payload, "utf8");
    const chunks = [];
    for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size));
    const res = fakeRes();
    const body = Readable.from(chunks);
    body.on("close", () => setImmediate(() => resolve(res)));
    pipeBufferedSSE({ body }, res, opts || {});
  });
}

const SSE = [
  'data: {"choices":[{"delta":{"content":"héllo"}}]}',
  "",
  'data: {"choices":[{"delta":{"content":"世界 🎉"}}]}',
  "",
  'data: {"choices":[{"delta":{"content":"naïve café — ünïcödé"}}]}',
  "",
  "data: [DONE]",
  "",
].join("\n");

let passed = 0;

(async () => {
  // 1. Byte boundaries: one byte at a time is the harshest split there is —
  //    every multi-byte character is guaranteed to straddle a boundary.
  {
    const res = await relay(SSE, 1);
    assert.ok(!res.out.includes("�"), "relay must not emit replacement characters");
    assert.strictEqual(res.out, SSE, "relay must reproduce the stream byte for byte");
    assert.ok(res.writableEnded, "relay must end the response");
    console.log("✔ multi-byte characters survive single-byte chunking");
    passed++;
  }

  // 2. Every other chunk size, so no single lucky alignment carries the suite.
  {
    for (let size = 2; size <= 64; size++) {
      const res = await relay(SSE, size);
      assert.strictEqual(res.out, SSE, `stream corrupted at chunk size ${size}`);
    }
    console.log("✔ stream is intact at every chunk size from 2 to 64");
    passed++;
  }

  // 3. Line boundaries stay intact too: each data line must reach onDataLine
  //    exactly once, fully parsed, regardless of where chunks fall.
  {
    const seen = [];
    const res = await relay(SSE, 3, {
      onDataLine: (parsed) => {
        seen.push(parsed.choices[0].delta.content);
        return null; // drop, so we assert purely on what was parsed
      },
    });
    assert.deepStrictEqual(
      seen,
      ["héllo", "世界 🎉", "naïve café — ünïcödé"],
      "every data line must be parsed once, with its text intact"
    );
    assert.ok(res.out.includes("data: [DONE]"), "the terminator must still be relayed");
    console.log("✔ data lines are parsed once with text intact");
    passed++;
  }

  console.log(`\nsse-stream: ${passed} checks passed`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
