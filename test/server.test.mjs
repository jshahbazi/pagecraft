import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  createApp,
  isSitePath,
  validateBranch,
  validateDirectory,
  validateRepository,
} from "../server.mjs";

const BASE = "a".repeat(40);
const TREE = "b".repeat(40);
const HTML_BLOB = "c".repeat(40);
const IMAGE_BLOB = "d".repeat(40);
const NEW_BLOB = "e".repeat(40);
const NEW_TREE = "f".repeat(40);
const NEW_COMMIT = "1".repeat(40);

async function fixture(t, overrides = {}) {
  const calls = [];
  const fake = async (args, { input } = {}) => {
    const endpoint = args[3];
    const method = args[args.indexOf("--method") + 1];
    const body = input ? JSON.parse(input) : undefined;
    calls.push({ endpoint, method, body });
    const custom = overrides[`${method} ${endpoint}`];
    if (custom instanceof Error) throw custom;
    if (custom !== undefined)
      return JSON.stringify(
        typeof custom === "function" ? custom(body) : custom,
      );
    const responses = {
      "GET user": { login: "tester" },
      "GET repos/tester/site": { default_branch: "main" },
      "GET repos/tester/site/git/ref/heads/main": {
        object: { type: "commit", sha: BASE },
      },
      [`GET repos/tester/site/git/commits/${BASE}`]: { tree: { sha: TREE } },
      [`GET repos/tester/site/git/trees/${TREE}?recursive=1`]: {
        truncated: false,
        tree: [
          {
            path: "index.html",
            mode: "100644",
            type: "blob",
            sha: HTML_BLOB,
            size: 17,
          },
          {
            path: "images/a.png",
            mode: "100644",
            type: "blob",
            sha: IMAGE_BLOB,
            size: 4,
          },
          {
            path: ".env",
            mode: "100644",
            type: "blob",
            sha: HTML_BLOB,
            size: 10,
          },
          {
            path: ".github/workflows/ci.yml",
            mode: "100644",
            type: "blob",
            sha: HTML_BLOB,
            size: 10,
          },
          {
            path: "script.sh",
            mode: "100755",
            type: "blob",
            sha: HTML_BLOB,
            size: 10,
          },
        ],
      },
      [`GET repos/tester/site/git/blobs/${HTML_BLOB}`]: {
        encoding: "base64",
        content: Buffer.from("<h1>Hello</h1>").toString("base64"),
      },
      [`GET repos/tester/site/git/blobs/${IMAGE_BLOB}`]: {
        encoding: "base64",
        content: "AAECAw==",
      },
      "POST repos/tester/site/git/blobs": { sha: NEW_BLOB },
      "POST repos/tester/site/git/trees": { sha: NEW_TREE },
      "POST repos/tester/site/git/commits": { sha: NEW_COMMIT },
      "PATCH repos/tester/site/git/refs/heads/main": {
        object: { sha: NEW_COMMIT },
      },
    };
    assert.ok(
      `${method} ${endpoint}` in responses,
      `Unexpected GitHub call: ${method} ${endpoint}`,
    );
    return JSON.stringify(responses[`${method} ${endpoint}`]);
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "pagecraft-test-"));
  const publicDir = path.join(directory, "public");
  await mkdir(publicDir);
  await writeFile(
    path.join(publicDir, "index.html"),
    "<!doctype html><h1>Pagecraft</h1>",
  );
  await writeFile(path.join(directory, "secret.txt"), "outside");
  await symlink(
    path.join(directory, "secret.txt"),
    path.join(publicDir, "escape.txt"),
  );
  const server = createApp({
    runGh: fake,
    token: "test-session-token",
    publicDir,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const post = (endpoint, body, headers = {}) =>
    fetch(`${origin}${endpoint}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Pagecraft-Token": "test-session-token",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { origin, post, calls };
}

test("validates repository, branch and supported site paths", () => {
  assert.equal(validateRepository("tester/my-site"), "tester/my-site");
  assert.equal(validateBranch("feature/page-edit"), "feature/page-edit");
  assert.equal(validateDirectory(), "");
  assert.equal(validateDirectory("website/dist/"), "website/dist");
  for (const value of [
    "/website",
    "../website",
    "website/../dist",
    ".github",
    "website/.hidden",
    "a\\b",
    "website//dist",
    "website/-flag",
    "node_modules/site",
    "a\n",
    "a".repeat(513),
  ])
    assert.throws(() => validateDirectory(value));
  for (const value of [
    "https://github.com/tester/site",
    "tester/site/extra",
    "-tester/site",
    "tester/..",
  ])
    assert.throws(() => validateRepository(value));
  for (const value of [
    "-main",
    "../main",
    "main.lock",
    "feature/.hidden",
    "main\n",
    "a b",
    "a@{b",
    "main\\other",
  ])
    assert.throws(() => validateBranch(value));
  for (const value of [
    "index.html",
    "assets/photo.png",
    "css/site.css",
    "app.webmanifest",
  ])
    assert.equal(isSitePath(value), true);
  for (const value of [
    "../index.html",
    "/index.html",
    "assets/../index.html",
    ".env",
    ".github/a.js",
    "node_modules/a.js",
    "-file.html",
    "a\\b.html",
    "file.sh",
    "a//b.css",
  ])
    assert.equal(isSitePath(value), false);
});

test("serves the app, bounds static paths, and reports the local GitHub session", async (t) => {
  const { origin, calls } = await fixture(t);
  const index = await fetch(origin);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Pagecraft/);
  assert.equal(
    (await fetch(origin, { headers: { "Sec-Fetch-Site": "cross-site" } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(origin, {
        method: "HEAD",
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/session`, {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(`${origin}/%2e%2e%2fsecret.txt`)).status, 404);
  assert.equal((await fetch(`${origin}/escape.txt`)).status, 404);
  const session = await (await fetch(`${origin}/api/session`)).json();
  assert.deepEqual(session, {
    token: "test-session-token",
    github: { connected: true, login: "tester" },
  });
  assert.equal(calls.length, 1);
});

test("rejects hostile hosts, origins, fetch sites, and missing session tokens before GitHub calls", async (t) => {
  const { origin, post, calls } = await fixture(t);
  for (const headers of [
    { Origin: "https://attacker.example" },
    { "X-Pagecraft-Token": "" },
    { "Sec-Fetch-Site": "cross-site" },
    { Origin: "" },
  ]) {
    assert.equal(
      (await post("/api/github/open", { repository: "tester/site" }, headers))
        .status,
      403,
    );
  }
  const hostileHost = await new Promise((resolve) => {
    const request = http.get(
      origin,
      { headers: { Host: "attacker.example" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", (error) => {
      throw error;
    });
  });
  assert.equal(hostileHost, 403);
  assert.equal(calls.length, 0);
});

test("loads text and binary static files at an exact branch commit, excluding metadata", async (t) => {
  const { post, calls } = await fixture(t);
  const response = await post("/api/github/open", {
    repository: "tester/site",
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    repository: "tester/site",
    branch: "main",
    directory: "",
    baseCommit: BASE,
    files: [
      { path: "index.html", content: "<h1>Hello</h1>", encoding: "utf8" },
      { path: "images/a.png", content: "AAECAw==", encoding: "base64" },
    ],
  });
  assert.equal(
    calls.filter((call) => call.endpoint.includes("/git/blobs/")).length,
    2,
  );
});

test("opens only a selected subtree with paths relative to its site root", async (t) => {
  const websiteTree = "2".repeat(40);
  const distTree = "3".repeat(40);
  const { post, calls } = await fixture(t, {
    [`GET repos/tester/site/git/trees/${TREE}`]: {
      tree: [
        { path: "website", mode: "040000", type: "tree", sha: websiteTree },
        {
          path: "unrelated-link",
          mode: "120000",
          type: "blob",
          sha: IMAGE_BLOB,
        },
      ],
    },
    [`GET repos/tester/site/git/trees/${websiteTree}`]: {
      tree: [{ path: "dist", mode: "040000", type: "tree", sha: distTree }],
    },
    [`GET repos/tester/site/git/trees/${distTree}?recursive=1`]: {
      tree: [
        {
          path: "index.html",
          mode: "100644",
          type: "blob",
          sha: HTML_BLOB,
          size: 17,
        },
      ],
    },
  });
  const response = await post("/api/github/open", {
    repository: "tester/site",
    directory: "website/dist/",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    repository: "tester/site",
    branch: "main",
    directory: "website/dist",
    baseCommit: BASE,
    files: [
      { path: "index.html", content: "<h1>Hello</h1>", encoding: "utf8" },
    ],
  });
  assert.equal(
    calls.some(
      (call) =>
        call.endpoint === `repos/tester/site/git/trees/${TREE}?recursive=1`,
    ),
    false,
    "does not enumerate the full repository recursively",
  );
  assert.equal(
    calls.filter((call) => call.endpoint.includes("/git/blobs/")).length,
    1,
  );
});

test("rejects invalid, missing, symbolic, and submodule site directories", async (t) => {
  const invalid = await fixture(t);
  for (const directory of [
    "../website",
    "/website",
    "website/.env",
    "website/-flag",
    "website\\dist",
  ]) {
    assert.equal(
      (
        await invalid.post("/api/github/open", {
          repository: "tester/site",
          directory,
        })
      ).status,
      400,
    );
    assert.equal(
      (await invalid.post("/api/github/push", { ...pushInput(), directory }))
        .status,
      400,
    );
  }
  assert.equal(invalid.calls.length, 0);
  for (const entry of [
    null,
    { path: "website", mode: "120000", type: "blob", sha: HTML_BLOB },
    { path: "website", mode: "160000", type: "commit", sha: BASE },
  ]) {
    const { post } = await fixture(t, {
      [`GET repos/tester/site/git/trees/${TREE}`]: {
        tree: entry ? [entry] : [],
      },
    });
    assert.ok(
      [400, 404].includes(
        (
          await post("/api/github/open", {
            repository: "tester/site",
            directory: "website",
          })
        ).status,
      ),
    );
  }
});

test("rejects truncated repositories, symbolic links, and site size overflow", async (t) => {
  for (const tree of [
    { truncated: true, tree: [] },
    { tree: [{ mode: "120000", type: "blob", path: "link.html" }] },
    { tree: [{ mode: "160000", type: "commit", path: "vendor" }] },
    {
      tree: [
        {
          mode: "100644",
          type: "blob",
          path: "index.html",
          size: 21 * 1024 * 1024,
        },
      ],
    },
  ]) {
    const { post, calls } = await fixture(t, {
      [`GET repos/tester/site/git/trees/${TREE}?recursive=1`]: tree,
    });
    assert.ok(
      [400, 413].includes(
        (await post("/api/github/open", { repository: "tester/site" })).status,
      ),
    );
    assert.equal(
      calls.filter((call) => call.endpoint.includes("/git/blobs/")).length,
      0,
    );
  }
});

const pushInput = () => ({
  repository: "tester/site",
  branch: "main",
  baseCommit: BASE,
  message: "Update headline",
  files: [
    { path: "index.html", content: "<h1>Changed</h1>", encoding: "utf8" },
  ],
});

test("pushes changed files with the prior tree and a non-forced, single-parent commit", async (t) => {
  const { post, calls } = await fixture(t);
  const response = await post("/api/github/push", pushInput());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    commit: NEW_COMMIT,
    url: `https://github.com/tester/site/commit/${NEW_COMMIT}`,
    repository: "tester/site",
    branch: "main",
    directory: "",
  });
  const byEndpoint = (endpoint) =>
    calls.find((call) => call.endpoint === endpoint);
  assert.deepEqual(byEndpoint("repos/tester/site/git/blobs").body, {
    content: "<h1>Changed</h1>",
    encoding: "utf-8",
  });
  assert.deepEqual(byEndpoint("repos/tester/site/git/trees").body, {
    base_tree: TREE,
    tree: [{ path: "index.html", mode: "100644", type: "blob", sha: NEW_BLOB }],
  });
  assert.deepEqual(byEndpoint("repos/tester/site/git/commits").body, {
    message: "Update headline",
    tree: NEW_TREE,
    parents: [BASE],
  });
  assert.deepEqual(calls.at(-1), {
    endpoint: "repos/tester/site/git/refs/heads/main",
    method: "PATCH",
    body: { sha: NEW_COMMIT, force: false },
  });
});

test("prefixes subtree changes while preserving the repository root base tree and unrelated files", async (t) => {
  const { post, calls } = await fixture(t, {
    [`GET repos/tester/site/git/trees/${TREE}?recursive=1`]: {
      tree: [
        { path: "website", mode: "040000", type: "tree" },
        { path: "website/dist", mode: "040000", type: "tree" },
        {
          path: "website/dist/index.html",
          mode: "100644",
          type: "blob",
          sha: HTML_BLOB,
        },
        { path: "index.html", mode: "100644", type: "blob", sha: IMAGE_BLOB },
        {
          path: "private/database.rs",
          mode: "100644",
          type: "blob",
          sha: IMAGE_BLOB,
        },
      ],
    },
  });
  const response = await post("/api/github/push", {
    ...pushInput(),
    directory: "website/dist",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).directory, "website/dist");
  const written = calls.find(
    (call) =>
      call.endpoint === "repos/tester/site/git/trees" && call.method === "POST",
  ).body;
  assert.deepEqual(written, {
    base_tree: TREE,
    tree: [
      {
        path: "website/dist/index.html",
        mode: "100644",
        type: "blob",
        sha: NEW_BLOB,
      },
    ],
  });
  assert.equal(
    calls.filter((call) => call.endpoint === "repos/tester/site/git/blobs")
      .length,
    1,
  );
});

test("refuses a subtree push through an existing file or link ancestor", async (t) => {
  const { post, calls } = await fixture(t, {
    [`GET repos/tester/site/git/trees/${TREE}?recursive=1`]: {
      tree: [{ path: "website", mode: "120000", type: "blob" }],
    },
  });
  assert.equal(
    (
      await post("/api/github/push", {
        ...pushInput(),
        directory: "website/dist",
      })
    ).status,
    400,
  );
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("refuses stale branches before creating blobs or commits", async (t) => {
  const { post, calls } = await fixture(t, {
    "GET repos/tester/site/git/ref/heads/main": {
      object: { type: "commit", sha: NEW_COMMIT },
    },
  });
  const response = await post("/api/github/push", pushInput());
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /branch changed/);
  assert.equal(calls.length, 1);
});

test("rejects unsafe, duplicate, invalid encoded, and oversized changed files before remote calls", async (t) => {
  const { post, calls } = await fixture(t);
  for (const files of [
    [],
    [{ path: ".github/workflows/action.js", content: "x", encoding: "utf8" }],
    [{ path: "../index.html", content: "x", encoding: "utf8" }],
    [{ path: "image.png", content: "!!invalid!!", encoding: "base64" }],
    [
      { path: "index.html", content: "x", encoding: "utf8" },
      { path: "index.html", content: "y", encoding: "utf8" },
    ],
    [
      {
        path: "index.html",
        content: "x".repeat(20 * 1024 * 1024 + 1),
        encoding: "utf8",
      },
    ],
  ]) {
    assert.ok(
      [400, 413].includes(
        (await post("/api/github/push", { ...pushInput(), files })).status,
      ),
    );
  }
  assert.equal(calls.length, 0);
});

test("refuses edits targeting existing links, executable files, and submodule descendants", async (t) => {
  for (const entry of [
    { path: "index.html", mode: "120000" },
    { path: "index.html", mode: "100755" },
    { path: "assets", mode: "160000" },
  ]) {
    const { post, calls } = await fixture(t, {
      [`GET repos/tester/site/git/trees/${TREE}?recursive=1`]: {
        tree: [entry],
      },
    });
    const input = pushInput();
    if (entry.path === "assets") input.files[0].path = "assets/index.html";
    assert.equal((await post("/api/github/push", input)).status, 400);
    assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  }
});

test("reports authentication failure without exposing command errors", async (t) => {
  const { origin } = await fixture(t, {
    "GET user": new Error("some secret raw command output"),
  });
  const session = await (await fetch(`${origin}/api/session`)).json();
  assert.equal(session.github.connected, false);
  assert.equal(session.github.error, "Run gh auth login to connect GitHub.");
  assert.doesNotMatch(JSON.stringify(session), /secret/);
});

test("handles JSON errors and API method errors without GitHub calls", async (t) => {
  const { origin, calls } = await fixture(t);
  assert.equal((await fetch(`${origin}/api/github/open`)).status, 405);
  const response = await fetch(`${origin}/api/github/open`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Pagecraft-Token": "test-session-token",
    },
    body: "{broken",
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});
