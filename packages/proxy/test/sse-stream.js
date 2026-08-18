#!/usr/bin/env node
/**
 * SSE relay must survive arbitrary TCP chunk boundaries.
 *
 * Lines were already buffered across chunks, but each chunk was decoded on its
 * own with `chunk.toString()`. A multi-byte character straddling a chunk
 * boundary decoded to U+FFFD on both sides, so any response containing
 * non-ASCII text — accented words, CJK, emoji — was corrupted in transit
 * whenever the boundary happened to land inside the character.
 *
 * Both stream flavours are covered: undici hands back a web ReadableStream,
 * a polyfilled fetch hands back a Node Readable, and the two used to decode
 * through separate code paths.
 */

const assert = require("assert");
const { Readable } = require("stream");
const { pipeBufferedSSE, readDecodedStream } = require("../src/forwarder.js");

function chunksOf(payload, size) {
  const buf = Buffer.from(payload, "utf8");
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

/** Node Readable body, as a polyfilled fetch would hand it over. */
const nodeBody = (chunks) => Readable.from(chunks);

/** Web ReadableStream body, as undici hands it over. */
const webBody = (chunks) => ({
  getReader() {
    let i = 0;
    return {
      read: async () =>
        i < chunks.length
          ? { done: false, value: new Uint8Array(chunks[i++]) }
          : { done: true, value: undefined },
    };
  },
});

/** Feed `payload` through the relay in `size`-byte chunks; resolve once ended. */
function relay(payload, size, opts = {}, flavour = nodeBody) {
  return new Promise((resolve) => {
    const res = {
      out: "",
      writableEnded: false,
      write(s) { this.out += s; },
      end() { this.writableEnded = true; resolve(this); },
    };
    pipeBufferedSSE({ body: flavour(chunksOf(payload, size)) }, res, opts);
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
  // 1. One byte at a time is the harshest split there is: every multi-byte
  //    character is guaranteed to straddle a boundary.
  {
    const res = await relay(SSE, 1);
    assert.ok(!res.out.includes("�"), "relay must not emit replacement characters");
    assert.strictEqual(res.out, SSE, "relay must reproduce the stream byte for byte");
    assert.ok(res.writableEnded, "relay must end the response");
    console.log("✔ multi-byte characters survive single-byte chunking");
    passed++;
  }

  // 2. Every chunk size, so no single lucky alignment carries the suite —
  //    and both stream flavours, which decode through different branches.
  {
    for (const [name, flavour] of [["node", nodeBody], ["web", webBody]]) {
      for (let size = 1; size <= 64; size++) {
        const res = await relay(SSE, size, {}, flavour);
        assert.strictEqual(res.out, SSE, `${name} stream corrupted at chunk size ${size}`);
      }
    }
    console.log("✔ node and web streams are intact at every chunk size from 1 to 64");
    passed++;
  }

  // 3. Line boundaries still hold: each data line reaches onDataLine once,
  //    fully parsed, wherever the chunks fall.
  {
    const seen = [];
    const res = await relay(SSE, 3, {
      onDataLine: (parsed) => {
        seen.push(parsed.choices[0].delta.content);
        return null; // drop, so the assertion is purely on what was parsed
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

  // 4. A stream cut mid-character must still terminate, and must not silently
  //    swallow the truncated bytes — the decoder tail has to be flushed.
  {
    const full = Buffer.from('data: {"content":"🎉"}\n\n', "utf8");
    const cut = full.subarray(0, full.length - 6); // slice into the emoji
    for (const [name, flavour] of [["node", nodeBody], ["web", webBody]]) {
      const res = await new Promise((resolve) => {
        const r = {
          out: "",
          writableEnded: false,
          write(s) { this.out += s; },
          end() { this.writableEnded = true; resolve(this); },
        };
        pipeBufferedSSE({ body: flavour([cut]) }, r, {});
      });
      assert.ok(res.writableEnded, `${name}: a truncated stream must still end the response`);
      assert.ok(
        res.out.includes("�"),
        `${name}: truncated trailing bytes must be flushed, not dropped`
      );
    }
    console.log("✔ a stream cut mid-character flushes its tail and still ends");
    passed++;
  }

  // 5. The two flavours share one decoder path now; hold them to identical
  //    output so they cannot drift apart again.
  {
    const text = "aé🎉世b";
    for (let size = 1; size <= 12; size++) {
      const collect = (flavour) =>
        new Promise((resolve) => {
          let got = "";
          readDecodedStream(flavour(chunksOf(text, size)), {
            onText: (t) => { got += t; },
            onEnd: () => resolve(got),
            onError: (e) => resolve(`ERROR:${e.message}`),
          });
        });
      const [a, b] = [await collect(nodeBody), await collect(webBody)];
      assert.strictEqual(a, text, `node decode wrong at chunk size ${size}`);
      assert.strictEqual(b, text, `web decode wrong at chunk size ${size}`);
    }
    console.log("✔ node and web decoding agree exactly, at every chunk size");
    passed++;
  }

  console.log(`\nsse-stream: ${passed} checks passed`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
