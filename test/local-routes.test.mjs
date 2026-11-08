import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import { LocalWorkspaceError } from "../local-workspace.mjs";

async function fixture(t, options = {}) {
  const calls = [];
  const localWorkspaces = Object.fromEntries(
    ["open", "save", "push"].map((name) => [
      name,
      async (input) => {
        calls.push({ name, input });
        if (options.error) throw options.error;
        return { operation: name };
      },
    ]),
  );
  let githubCalls = 0;
  const server = createApp({
    localWorkspaces,
    nativeProjects: {
      pickDirectory: async () => {
        calls.push({ name: "pick" });
        return options.cancelPicker
          ? { cancelled: true }
          : { directory: "/tmp/chosen-site" };
      },
      cloneRepository: async (input) => {
        calls.push({ name: "clone", input });
        return {
          directory: "/tmp/managed-clone",
          siteDirectory: "website/public",
          repository: "owner/repo",
        };
      },
    },
    runGh: async () => {
      githubCalls++;
      throw Error("GitHub is unavailable");
    },
    startupDirectory: "/tmp/configured-site",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const session = await fetch(`${origin}/api/session?local=1`).then(
    (response) => response.json(),
  );
  const post = (endpoint, input, headers = {}) =>
    fetch(`${origin}${endpoint}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "x-pagecraft-token": session.token,
        ...headers,
      },
      body: JSON.stringify(input),
    });
  return {
    origin,
    session,
    post,
    calls,
    get githubCalls() {
      return githubCalls;
    },
  };
}

test("local directory session is immediate and independent of GitHub authentication", async (t) => {
  const app = await fixture(t);
  assert.equal(app.githubCalls, 0);
  assert.equal(app.session.directory, "/tmp/configured-site");
  assert.match(app.session.instanceId, /^[a-f\d]{32}$/);
  const again = await fetch(`${app.origin}/api/session?local=1`).then(
    (response) => response.json(),
  );
  assert.equal(again.instanceId, app.session.instanceId);
});

test("local open/save/push use the authenticated directory service", async (t) => {
  const app = await fixture(t);
  for (const [operation, input] of [
    ["open", { directory: "/tmp/site" }],
    ["save", { workspaceId: "grant", files: [] }],
    ["push", { workspaceId: "grant", paths: ["index.html"], message: "Edit" }],
  ]) {
    const response = await app.post(`/api/local/${operation}`, input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { operation });
    assert.deepEqual(app.calls.at(-1), { name: operation, input });
  }
  assert.equal(app.githubCalls, 0);
});

test("all local filesystem routes require the same origin and session token before accessing files", async (t) => {
  const app = await fixture(t);
  for (const operation of ["open", "save", "push", "browse", "pick", "clone"]) {
    const noToken = await app.post(
      `/api/local/${operation}`,
      { directory: "/tmp/site" },
      { "x-pagecraft-token": "invalid" },
    );
    assert.equal(noToken.status, 403);
    const remote = await app.post(
      `/api/local/${operation}`,
      { directory: "/tmp/site" },
      { Origin: "https://other.example" },
    );
    assert.equal(remote.status, 403);
  }
  assert.equal(app.calls.length, 0);
});

test("directory browser returns directories only and skips hidden/dependency/link entries", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pagecraft-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(
    ["site", ".git", "node_modules"].map((name) =>
      mkdir(path.join(directory, name)),
    ),
  );
  await symlink(
    path.join(directory, "site"),
    path.join(directory, "linked-site"),
  );
  const app = await fixture(t);
  const response = await app.post("/api/local/browse", { directory });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(
    result.directory,
    await import("node:fs/promises").then((fs) => fs.realpath(directory)),
  );
  assert.deepEqual(
    result.folders.map((folder) => folder.name),
    ["site"],
  );
  assert.equal(
    (await app.post("/api/local/browse", { directory: "../site" })).status,
    400,
  );
});

test("local save conflicts and retained push commits are returned without internal error details", async (t) => {
  const error = new LocalWorkspaceError(
    409,
    "A saved commit is waiting to push.",
  );
  error.pendingCommit = "a".repeat(40);
  const app = await fixture(t, { error });
  const response = await app.post("/api/local/push", {});
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: error.message,
    pendingCommit: "a".repeat(40),
  });
});

test("native picker opens its chosen directory without a browser upload", async (t) => {
  const app = await fixture(t);
  const response = await app.post("/api/local/pick", {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { operation: "open" });
  assert.deepEqual(app.calls, [
    { name: "pick" },
    { name: "open", input: { directory: "/tmp/chosen-site" } },
  ]);
});
test("cancelled native picker leaves the workspace untouched", async (t) => {
  const app = await fixture(t, { cancelPicker: true });
  const response = await app.post("/api/local/pick", {});
  assert.deepEqual(await response.json(), { cancelled: true });
  assert.deepEqual(app.calls, [{ name: "pick" }]);
});
test("GitHub cloning opens the selected source subtree of the local checkout", async (t) => {
  const app = await fixture(t);
  const response = await app.post("/api/local/clone", {
    repository: "owner/repo",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    operation: "open",
    clonedRepository: "owner/repo",
  });
  assert.deepEqual(app.calls, [
    { name: "clone", input: { repository: "owner/repo" } },
    { name: "open", input: { directory: "/tmp/managed-clone/website/public" } },
  ]);
});
