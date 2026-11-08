import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  rm,
  rename,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import {
  createLocalWorkspaces,
  LocalWorkspaceError,
} from "../local-workspace.mjs";

const execute = promisify(execFile);
const html = (content) => ({ path: "index.html", content, encoding: "utf8" });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pagecraft-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const site = path.join(root, "site");
  await mkdir(site);
  await writeFile(path.join(site, "index.html"), "<h1>Original</h1>");
  return { root, site, api: createLocalWorkspaces() };
}
async function git(root, ...args) {
  return (
    await execute("git", ["-C", root, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout.trim();
}
async function gitFixture(t) {
  const f = await fixture(t);
  const bare = path.join(f.root, "upstream.git");
  await execute("git", ["init", "--bare", "--initial-branch=main", bare]);
  await git(f.site, "init", "-b", "main");
  await git(f.site, "config", "user.name", "Pagecraft Test");
  await git(f.site, "config", "user.email", "pagecraft@example.invalid");
  await writeFile(path.join(f.site, "unrelated.txt"), "original unrelated");
  await git(f.site, "add", "--", "index.html", "unrelated.txt");
  await git(f.site, "commit", "-m", "Initial fixture");
  await git(f.site, "remote", "add", "origin", bare);
  await git(f.site, "push", "-u", "origin", "main");
  return { ...f, bare };
}
function rejects(status, pattern) {
  return (error) =>
    error instanceof LocalWorkspaceError &&
    error.status === status &&
    pattern.test(error.message);
}

test("opens a conventional site subdirectory and ignores metadata, dependencies and links", async (t) => {
  const { root, site, api } = await fixture(t);
  const repo = path.join(root, "project");
  const source = path.join(repo, "website", "public");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "index.html"), "<h1>Scoped</h1>");
  await mkdir(path.join(source, "assets"));
  await writeFile(
    path.join(source, "assets", "pixel.png"),
    Buffer.from([0, 1, 2]),
  );
  await mkdir(path.join(source, "node_modules"));
  await writeFile(path.join(source, "node_modules", "bad.html"), "excluded");
  await writeFile(path.join(source, ".env"), "SECRET=ignored");
  await symlink(site, path.join(source, "escape"));
  const opened = await api.open({ directory: repo });
  assert.equal(
    opened.directory,
    await import("node:fs/promises").then((fs) => fs.realpath(source)),
  );
  assert.deepEqual(
    opened.files.map((f) => f.path),
    ["assets/pixel.png", "index.html"],
  );
  assert.equal(opened.files[0].encoding, "base64");
  assert.equal(opened.files[0].content, "AAEC");
  assert.equal(opened.git, null);
  assert.equal(opened.skippedSymlinks, 1);
});

test("saves only selected files in place and can create nested assets", async (t) => {
  const { site, api } = await fixture(t);
  await writeFile(path.join(site, "styles.css"), "body{color:red}");
  const opened = await api.open({ directory: site });
  const saved = await api.save({
    workspaceId: opened.workspaceId,
    files: [
      html("<h1>Edited</h1>"),
      { path: "assets/new.svg", content: "<svg/>", encoding: "utf8" },
    ],
  });
  assert.deepEqual(saved.saved, ["index.html", "assets/new.svg"]);
  assert.equal(
    await readFile(path.join(site, "index.html"), "utf8"),
    "<h1>Edited</h1>",
  );
  assert.equal(
    await readFile(path.join(site, "styles.css"), "utf8"),
    "body{color:red}",
  );
  assert.equal(
    await readFile(path.join(site, "assets", "new.svg"), "utf8"),
    "<svg/>",
  );
  assert.ok(
    !(await readdir(site)).some((name) => name.startsWith(".pagecraft-")),
  );
  await api.save({
    workspaceId: opened.workspaceId,
    files: [html("<h1>Edited twice</h1>")],
  });
  assert.equal(
    await readFile(path.join(site, "index.html"), "utf8"),
    "<h1>Edited twice</h1>",
  );
});

test("preflights the entire save and refuses changed, removed, or newly occupied files", async (t) => {
  const { site, api } = await fixture(t);
  await writeFile(path.join(site, "styles.css"), "old");
  let opened = await api.open({ directory: site });
  await writeFile(path.join(site, "styles.css"), "external edit");
  await assert.rejects(
    api.save({
      workspaceId: opened.workspaceId,
      files: [
        html("should not save"),
        { path: "styles.css", content: "mine", encoding: "utf8" },
      ],
    }),
    rejects(409, /changed on disk/),
  );
  assert.equal(
    await readFile(path.join(site, "index.html"), "utf8"),
    "<h1>Original</h1>",
  );
  opened = await api.open({ directory: site });
  await rm(path.join(site, "index.html"));
  await assert.rejects(
    api.save({ workspaceId: opened.workspaceId, files: [html("gone")] }),
    rejects(409, /changed on disk/),
  );
  await writeFile(path.join(site, "index.html"), "restored");
  opened = await api.open({ directory: site });
  await writeFile(path.join(site, "new.html"), "external new file");
  await assert.rejects(
    api.save({
      workspaceId: opened.workspaceId,
      files: [{ path: "new.html", content: "mine", encoding: "utf8" }],
    }),
    rejects(409, /changed on disk/),
  );
});

test("rejects traversal, unsafe assets, symbolic files and replaced directory roots", async (t) => {
  const { root, site, api } = await fixture(t);
  let opened = await api.open({ directory: site });
  for (const name of [
    "../outside.html",
    "/outside.html",
    ".env",
    ".github/file.html",
    "node_modules/x.html",
    "bad\\file.html",
    "-name.html",
    "x/../y.html",
  ]) {
    await assert.rejects(
      api.save({
        workspaceId: opened.workspaceId,
        files: [{ path: name, content: "bad", encoding: "utf8" }],
      }),
      rejects(400, /path|Hidden|type/),
    );
  }
  await assert.rejects(
    api.save({
      workspaceId: opened.workspaceId,
      files: [{ path: "image.png", content: "!bad", encoding: "base64" }],
    }),
    rejects(400, /base64/),
  );
  await assert.rejects(
    api.save({
      workspaceId: opened.workspaceId,
      files: [html("x"), html("y")],
    }),
    rejects(400, /duplicate/),
  );
  await symlink(path.join(site, "index.html"), path.join(site, "link.html"));
  await assert.rejects(
    api.save({
      workspaceId: opened.workspaceId,
      files: [{ path: "link.html", content: "bad", encoding: "utf8" }],
    }),
    rejects(409, /symbolic/),
  );
  await symlink(root, path.join(site, "assets"));
  await assert.rejects(
    api.save({
      workspaceId: opened.workspaceId,
      files: [{ path: "assets/escape.html", content: "bad", encoding: "utf8" }],
    }),
    rejects(409, /symbolic/),
  );
  await rename(site, path.join(root, "moved"));
  await mkdir(site);
  await writeFile(path.join(site, "index.html"), "replacement");
  await assert.rejects(
    api.save({ workspaceId: opened.workspaceId, files: [html("bad")] }),
    rejects(409, /directory changed/),
  );
});

test("bounds imported site counts and bytes and refuses expired sessions", async (t) => {
  const { site, api } = await fixture(t);
  await assert.rejects(
    api.open({ directory: "relative/site" }),
    rejects(400, /absolute/),
  );
  await assert.rejects(
    api.open({ directory: path.join(site, "missing") }),
    rejects(404, /could not be opened/),
  );
  await assert.rejects(
    api.save({ workspaceId: "unknown", files: [] }),
    rejects(409, /expired/),
  );
  await writeFile(path.join(site, "large.png"), Buffer.alloc(20 * 1024 * 1024));
  await assert.rejects(api.open({ directory: site }), rejects(413, /20 MiB/));
  await rm(path.join(site, "large.png"));
  for (let index = 0; index < 300; index++)
    await writeFile(path.join(site, `file${index}.txt`), "");
  await assert.rejects(
    api.open({ directory: site }),
    rejects(413, /300 supported/),
  );
});

test("finds the owning checkout through an uninitialized nested Git directory", async (t) => {
  const { site, api } = await gitFixture(t);
  const web = path.join(site, "website");
  const source = path.join(web, "public");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "index.html"), "<h1>Nested</h1>");
  await git(site, "add", "website/public/index.html");
  await git(site, "commit", "-m", "Add website");
  await git(site, "push");
  await git(web, "init", "-b", "main");
  const opened = await api.open({ directory: source });
  assert.equal(
    opened.git.root,
    await import("node:fs/promises").then((fs) => fs.realpath(site)),
  );
  assert.equal(opened.git.branch, "main");
  assert.equal(opened.git.upstream, "origin/main");
});

test("commits and pushes only saved site paths, preserving unrelated dirty files", async (t) => {
  const { site, bare, api } = await gitFixture(t);
  const opened = await api.open({ directory: site });
  await writeFile(path.join(site, "unrelated.txt"), "keep my unrelated edit");
  await api.save({
    workspaceId: opened.workspaceId,
    files: [
      html("<h1>Published</h1>"),
      { path: "assets/new.svg", content: "<svg/>", encoding: "utf8" },
    ],
  });
  const result = await api.push({
    workspaceId: opened.workspaceId,
    paths: ["index.html", "assets/new.svg"],
    message: "Publish site edits",
  });
  assert.equal(result.pushed, true);
  assert.equal(result.branch, "main");
  assert.equal(result.remote, "origin");
  assert.equal(await git(bare, "rev-parse", "main"), result.commit);
  assert.deepEqual(
    (
      await git(
        site,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        result.commit,
      )
    )
      .split("\n")
      .sort(),
    ["assets/new.svg", "index.html"],
  );
  assert.equal(
    await readFile(path.join(site, "unrelated.txt"), "utf8"),
    "keep my unrelated edit",
  );
  assert.equal(await git(site, "status", "--porcelain"), "M unrelated.txt");
  await api.save({
    workspaceId: opened.workspaceId,
    files: [html("<h1>Next edit</h1>")],
  });
});

test("refuses preexisting staged edits and local commits without changing them", async (t) => {
  const { site, bare, api } = await gitFixture(t);
  let opened = await api.open({ directory: site });
  await api.save({
    workspaceId: opened.workspaceId,
    files: [html("<h1>Saved only</h1>")],
  });
  await writeFile(path.join(site, "unrelated.txt"), "staged work");
  await git(site, "add", "unrelated.txt");
  const before = await git(site, "rev-parse", "HEAD");
  const staged = await git(site, "diff", "--cached");
  await assert.rejects(
    api.push({
      workspaceId: opened.workspaceId,
      paths: ["index.html"],
      message: "Do not commit",
    }),
    rejects(409, /staged changes/),
  );
  assert.equal(await git(site, "rev-parse", "HEAD"), before);
  assert.equal(await git(site, "diff", "--cached"), staged);
  await git(site, "commit", "-m", "Unpushed independent work");
  opened = await api.open({ directory: site });
  await api.save({
    workspaceId: opened.workspaceId,
    files: [html("<h1>New save</h1>")],
  });
  const ahead = await git(site, "rev-parse", "HEAD");
  await assert.rejects(
    api.push({
      workspaceId: opened.workspaceId,
      paths: ["index.html"],
      message: "Refuse ahead",
    }),
    rejects(409, /checkout and remote branch differ/),
  );
  assert.equal(await git(site, "rev-parse", "HEAD"), ahead);
  assert.notEqual(await git(bare, "rev-parse", "main"), ahead);
});

test("refuses external file changes and branch switches before local commit", async (t) => {
  const { site, api } = await gitFixture(t);
  const opened = await api.open({ directory: site });
  await api.save({
    workspaceId: opened.workspaceId,
    files: [html("<h1>Saved</h1>")],
  });
  await writeFile(path.join(site, "index.html"), "external");
  await assert.rejects(
    api.push({
      workspaceId: opened.workspaceId,
      paths: ["index.html"],
      message: "Refuse changed",
    }),
    rejects(409, /changed on disk/),
  );
  await git(site, "switch", "-c", "another");
  await assert.rejects(
    api.save({ workspaceId: opened.workspaceId, files: [html("bad")] }),
    rejects(409, /branch or commit changed/),
  );
});

test("retains one failed push commit and retries it without duplicating commits", async (t) => {
  const { site, bare, api } = await gitFixture(t);
  const opened = await api.open({ directory: site });
  await api.save({
    workspaceId: opened.workspaceId,
    files: [html("<h1>Retry me</h1>")],
  });
  const hook = path.join(bare, "hooks", "pre-receive");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(
    api.push({
      workspaceId: opened.workspaceId,
      paths: ["index.html"],
      message: "One commit",
    }),
    (error) =>
      rejects(409, /local commit.*created.*Retry Push/)(error) &&
      /^[a-f\d]{40,64}$/.test(error.pendingCommit),
  );
  const pending = await git(site, "rev-parse", "HEAD");
  assert.equal(await git(site, "rev-list", "--count", "HEAD"), "2");
  assert.notEqual(await git(bare, "rev-parse", "main"), pending);
  await assert.rejects(
    api.save({
      workspaceId: opened.workspaceId,
      files: [html("further edit")],
    }),
    rejects(409, /waiting to be pushed/),
  );
  await rm(hook);
  const result = await api.push({
    workspaceId: opened.workspaceId,
    paths: ["index.html"],
    message: "Retry existing",
  });
  assert.equal(result.commit, pending);
  assert.equal(await git(site, "rev-list", "--count", "HEAD"), "2");
  assert.equal(await git(bare, "rev-parse", "main"), pending);
});

test("treats Git pathspec-looking filenames as literal selected paths", async (t) => {
  const { site, bare, api } = await gitFixture(t);
  const name = ":(glob)*.html";
  await writeFile(path.join(site, name), "<h1>Literal name</h1>");
  await writeFile(path.join(site, "other.html"), "<h1>Other page</h1>");
  await git(site, "--literal-pathspecs", "add", "--", name, "other.html");
  await git(site, "commit", "-m", "Add literal path fixture");
  await git(site, "push");
  const opened = await api.open({ directory: site });
  await writeFile(path.join(site, "other.html"), "unrelated working change");
  await api.save({
    workspaceId: opened.workspaceId,
    files: [
      { path: name, content: "<h1>Only this page</h1>", encoding: "utf8" },
    ],
  });
  const result = await api.push({
    workspaceId: opened.workspaceId,
    paths: [name],
    message: "Commit literal filename only",
  });
  assert.equal(
    await git(
      site,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      result.commit,
    ),
    name,
  );
  assert.equal(
    await readFile(path.join(site, "other.html"), "utf8"),
    "unrelated working change",
  );
  assert.equal(await git(bare, "rev-parse", "main"), result.commit);
});

test("pushes its immutable commit when a pre-push hook advances local HEAD", async (t) => {
  const { site, bare, api } = await gitFixture(t);
  const opened = await api.open({ directory: site });
  await api.save({
    workspaceId: opened.workspaceId,
    files: [html("<h1>Selected edit</h1>")],
  });
  const hook = path.join(site, ".git", "hooks", "pre-push");
  await writeFile(
    hook,
    "#!/bin/sh\ngit commit --allow-empty -m 'Concurrent local work' >/dev/null\n",
    { mode: 0o755 },
  );
  const result = await api.push({
    workspaceId: opened.workspaceId,
    paths: ["index.html"],
    message: "Publish exact selected commit",
  });
  assert.notEqual(await git(site, "rev-parse", "HEAD"), result.commit);
  assert.equal(await git(bare, "rev-parse", "main"), result.commit);
  assert.equal(
    await git(bare, "log", "-1", "--format=%s", "main"),
    "Publish exact selected commit",
  );
});

test("serializes writes across separate grants for the same directory", async (t) => {
  const { site, api } = await fixture(t);
  const first = await api.open({ directory: site });
  const second = await api.open({ directory: site });
  const results = await Promise.allSettled([
    api.save({ workspaceId: first.workspaceId, files: [html("first")] }),
    api.save({ workspaceId: second.workspaceId, files: [html("second")] }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /already saving/);
  assert.equal(await readFile(path.join(site, "index.html"), "utf8"), "first");
});
