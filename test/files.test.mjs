import test from "node:test";
import assert from "node:assert/strict";
import {
  importFiles,
  isTextPath,
  makeZip,
  normalizePath,
} from "../public/files.js";

const decoder = new TextDecoder();
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read16 = (o) => view.getUint16(o, true);
  const read32 = (o) => view.getUint32(o, true);
  assert.equal(
    read32(bytes.length - 22),
    0x06054b50,
    "end of central directory signature",
  );
  const count = read16(bytes.length - 12);
  const centralOffset = read32(bytes.length - 6);
  const output = [];
  let cursor = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(read32(cursor), 0x02014b50);
    const expectedCrc = read32(cursor + 16);
    const size = read32(cursor + 24);
    const nameLength = read16(cursor + 28);
    const extraLength = read16(cursor + 30);
    const commentLength = read16(cursor + 32);
    const localOffset = read32(cursor + 42);
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    assert.equal(read32(localOffset), 0x04034b50);
    const localNameLength = read16(localOffset + 26);
    const localExtraLength = read16(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.slice(dataStart, dataStart + size);
    assert.equal(crc32(data), expectedCrc, `CRC-32 for ${name}`);
    output.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return output;
}

test("normalizePath accepts nested site paths and rejects unsafe paths", () => {
  assert.equal(normalizePath("pages/index.html"), "pages/index.html");
  assert.equal(normalizePath("./index.html"), "index.html");
  for (const path of [
    "",
    "/index.html",
    "\\index.html",
    "C:/index.html",
    "../secret",
    "a/../../secret",
    "a\\b",
    "a\0b",
    "a\u0001b",
    "-flag/index.html",
    "assets/-flag.css",
    ".git/config",
    "assets/.git/config",
  ]) {
    assert.throws(() => normalizePath(path), undefined, path);
  }
});

test("isTextPath recognizes common web project text formats", () => {
  for (const path of [
    "index.html",
    "assets/site.css",
    "src/app.js",
    "data.json",
    "icons/mark.svg",
    "feed.xml",
    "robots.txt",
    "source.map",
  ]) {
    assert.equal(isTextPath(path), true, path);
  }
  for (const path of [
    "photo.png",
    "font.woff2",
    "report.pdf",
    "README.md",
    "source.py",
    "app.exe",
  ])
    assert.equal(isTextPath(path), false, path);
});

test("importFiles strips one shared directory and filters metadata and unsupported files", async () => {
  const files = [
    Object.assign(new File(["<h1>Hi</h1>"], "index.html"), {
      webkitRelativePath: "demo/index.html",
    }),
    Object.assign(new File(["body{}"], "site.css"), {
      webkitRelativePath: "demo/assets/site.css",
    }),
    Object.assign(new File(["secret"], ".env"), {
      webkitRelativePath: "demo/.env",
    }),
    Object.assign(new File(["metadata"], "config"), {
      webkitRelativePath: "demo/.git/config",
    }),
    Object.assign(new File(["binary executable"], "app.exe"), {
      webkitRelativePath: "demo/app.exe",
    }),
    Object.assign(new File([new Uint8Array([0, 255, 10])], "mark.png"), {
      webkitRelativePath: "demo/images/mark.png",
    }),
  ];
  const result = await importFiles(files);
  assert.deepEqual(
    result.map(({ path, encoding }) => [path, encoding]),
    [
      ["index.html", "utf8"],
      ["assets/site.css", "utf8"],
      ["images/mark.png", "base64"],
    ],
  );
  assert.equal(result[0].content, "<h1>Hi</h1>");
  assert.deepEqual(
    [...Uint8Array.from(atob(result[2].content), (char) => char.charCodeAt(0))],
    [0, 255, 10],
  );
});

test("importFiles preserves paths when files do not share one root", async () => {
  const files = [
    new File(["a"], "index.html"),
    new File(["b"], "assets/site.css"),
  ];
  assert.deepEqual(
    (await importFiles(files)).map((file) => file.path),
    ["index.html", "assets/site.css"],
  );
});

test("importFiles filters metadata before enforcing the cap and rejects duplicate normalized paths", async () => {
  const files = Array.from(
    { length: 301 },
    (_, i) => new File(["ignored"], `f${i}.txt`),
  );
  const ignored = files.map((file) =>
    Object.assign(file, {
      webkitRelativePath: `site/node_modules/pkg/${file.name}`,
    }),
  );
  ignored.push(
    Object.assign(new File(["ok"], "index.html"), {
      webkitRelativePath: "site/index.html",
    }),
  );
  assert.deepEqual(
    (await importFiles(ignored)).map((file) => file.path),
    ["index.html"],
  );
  await assert.rejects(
    importFiles([new File(["a"], "index.html"), new File(["b"], "index.html")]),
    /Duplicate file path/,
  );
});

test("importFiles enforces file count and supported-byte size limits", async () => {
  const tooMany = Array.from(
    { length: 301 },
    (_, i) => new File(["x"], `f${i}.txt`),
  );
  await assert.rejects(importFiles(tooMany), /at most 300 files/);
  await assert.rejects(
    importFiles([
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.png"),
    ]),
    /at most 20 MiB/,
  );
  const exactlyAtLimit = [
    new File([new Uint8Array(20 * 1024 * 1024)], "large.png"),
  ];
  assert.equal((await importFiles(exactlyAtLimit)).length, 1);
});

test("makeZip emits UTF-8 stored entries and valid CRC-32 central directory", () => {
  const archive = makeZip([
    { path: "index.html", content: "<h1>café</h1>", encoding: "utf8" },
    { path: "assets/表.png", content: "AP8K", encoding: "base64" },
  ]);
  assert.equal(new DataView(archive.buffer).getUint32(0, true), 0x04034b50);
  const entries = parseZip(archive);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["index.html", "assets/表.png"],
  );
  assert.equal(decoder.decode(entries[0].data), "<h1>café</h1>");
  assert.deepEqual([...entries[1].data], [0, 255, 10]);
  assert.throws(
    () => makeZip([{ path: "../escape.txt", content: "no" }]),
    /traversal/,
  );
});
