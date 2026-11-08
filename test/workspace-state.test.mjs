import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcileLocalWorkspace,
  sameFile,
} from "../public/workspace-state.js";

const file = (path, content, encoding = "utf8") => ({
  path,
  content,
  encoding,
});
const fixture = (overrides = {}) => ({
  name: "Site",
  files: [file("index.html", "old"), file("style.css", "old-style")],
  baseline: [file("index.html", "old"), file("style.css", "old-style")],
  current: "index.html",
  local: {
    workspaceId: "old-workspace",
    directory: "/sites/example",
    serverId: "old-server",
    diskBaseline: [file("index.html", "old"), file("style.css", "old-style")],
  },
  ...overrides,
});
const opened = (files, overrides = {}) => ({
  workspaceId: "new-workspace",
  directory: "/sites/example",
  files,
  git: { branch: "main" },
  ...overrides,
});
const byPath = (files, path) => files.find((item) => item.path === path);

test("sameFile compares content and encoding and treats missing pairs as equal", () => {
  assert.equal(sameFile(undefined, undefined), true);
  assert.equal(sameFile(null, undefined), true);
  assert.equal(sameFile(file("a", "x"), undefined), false);
  assert.equal(sameFile(file("a", "x"), file("b", "x")), true);
  assert.equal(sameFile(file("a", "x"), file("a", "y")), false);
  assert.equal(
    sameFile(file("a", "x", "utf8"), file("a", "x", "base64")),
    false,
  );
});

test("refreshes disk changes when the browser has no edits and drops removed files", () => {
  const previous = fixture({
    files: [...fixture().files, file("old.txt", "gone")],
    baseline: [...fixture().baseline, file("old.txt", "gone")],
    local: {
      ...fixture().local,
      diskBaseline: [...fixture().local.diskBaseline, file("old.txt", "gone")],
    },
  });
  const result = reconcileLocalWorkspace(
    previous,
    opened([
      file("index.html", "new"),
      file("style.css", "new-style"),
      file("added.txt", "fresh"),
    ]),
    "new-server",
  );
  assert.equal(byPath(result.files, "index.html").content, "new");
  assert.equal(byPath(result.files, "style.css").content, "new-style");
  assert.equal(byPath(result.files, "added.txt").content, "fresh");
  assert.equal(byPath(result.files, "old.txt"), undefined);
  assert.equal(byPath(result.baseline, "index.html").content, "new");
});

test("overlays unsaved browser edits and retains their prior baseline", () => {
  const previous = fixture({
    files: [file("index.html", "browser edit"), file("style.css", "old-style")],
  });
  const result = reconcileLocalWorkspace(
    previous,
    opened([file("index.html", "old"), file("style.css", "fresh-style")]),
    "new-server",
  );
  assert.equal(byPath(result.files, "index.html").content, "browser edit");
  assert.equal(byPath(result.baseline, "index.html").content, "old");
  assert.equal(byPath(result.files, "style.css").content, "fresh-style");
  assert.equal(byPath(result.baseline, "style.css").content, "fresh-style");
});

test("retains saved but unpublished browser changes against the old baseline", () => {
  const previous = fixture({
    files: [file("index.html", "saved edit"), file("style.css", "old-style")],
    local: {
      ...fixture().local,
      diskBaseline: [
        file("index.html", "saved edit"),
        file("style.css", "old-style"),
      ],
    },
  });
  const result = reconcileLocalWorkspace(
    previous,
    opened([file("index.html", "saved edit"), file("style.css", "old-style")]),
    "new-server",
  );
  assert.equal(byPath(result.files, "index.html").content, "saved edit");
  assert.equal(byPath(result.baseline, "index.html").content, "old");
});

test("retains a new unsaved browser file while keeping it absent from baseline", () => {
  const previous = fixture({
    files: [...fixture().files, file("new.html", "new page")],
  });
  const result = reconcileLocalWorkspace(
    previous,
    opened(fixture().files),
    "new-server",
  );
  assert.equal(byPath(result.files, "new.html").content, "new page");
  assert.equal(byPath(result.baseline, "new.html"), undefined);
  assert.equal(result.current, "index.html");
});

test("refuses to overlay browser edits when the corresponding disk file changed", () => {
  const previous = fixture({
    files: [file("index.html", "browser edit"), file("style.css", "old-style")],
  });
  assert.throws(
    () =>
      reconcileLocalWorkspace(
        previous,
        opened([
          file("index.html", "external edit"),
          file("style.css", "old-style"),
        ]),
        "new-server",
      ),
    /index\.html.*changed.*Export.*reopen/i,
  );
});

test("refuses a different directory", () => {
  assert.throws(
    () =>
      reconcileLocalWorkspace(
        fixture(),
        opened(fixture().files, { directory: "/sites/other" }),
        "new-server",
      ),
    /different directory.*Export/i,
  );
});

test("refuses reattachment when the checkout branch or upstream changes", () => {
  const git = {
    root: "/sites/example",
    branch: "main",
    remote: "origin",
    upstream: "origin/main",
  };
  const previous = fixture({ local: { ...fixture().local, git } });
  for (const changed of [
    { ...git, branch: "release" },
    { ...git, remote: "backup" },
    { ...git, upstream: "origin/release" },
    null,
  ]) {
    assert.throws(
      () =>
        reconcileLocalWorkspace(
          previous,
          opened(fixture().files, { git: changed }),
          "new-server",
        ),
      /checkout or push destination changed.*Export.*original checkout/i,
    );
  }
});

test("allows reattachment on the same branch and destination after HEAD advances", () => {
  const git = {
    root: "/sites/example",
    branch: "main",
    remote: "origin",
    upstream: "origin/main",
    head: "old-head",
  };
  const previous = fixture({ local: { ...fixture().local, git } });
  const refreshed = {
    ...git,
    head: "new-head",
  };
  const result = reconcileLocalWorkspace(
    previous,
    opened(fixture().files, { git: refreshed }),
    "new-server",
  );
  assert.deepEqual(result.local.git, refreshed);
});

test("does not mutate inputs and refreshes server attachment metadata", () => {
  const previous = fixture({
    files: [file("index.html", "browser edit"), file("style.css", "old-style")],
  });
  const disk = opened([
    file("index.html", "old"),
    file("style.css", "old-style"),
  ]);
  const beforePrevious = structuredClone(previous);
  const beforeDisk = structuredClone(disk);
  const result = reconcileLocalWorkspace(previous, disk, "new-server");
  assert.deepEqual(previous, beforePrevious);
  assert.deepEqual(disk, beforeDisk);
  assert.equal(result.local.workspaceId, "new-workspace");
  assert.equal(result.local.serverId, "new-server");
  assert.deepEqual(result.local.git, { branch: "main" });
  assert.deepEqual(result.local.diskBaseline, disk.files);
  assert.notEqual(result.files, previous.files);
});

test("keeps an undo-after-save state protected from disk refresh", () => {
  const previous = fixture({
    files: [file("index.html", "old"), file("style.css", "old-style")],
    baseline: [file("index.html", "old"), file("style.css", "old-style")],
    local: {
      ...fixture().local,
      diskBaseline: [
        file("index.html", "saved edit"),
        file("style.css", "old-style"),
      ],
    },
  });
  const result = reconcileLocalWorkspace(
    previous,
    opened([file("index.html", "saved edit"), file("style.css", "old-style")]),
    "new-server",
  );
  assert.equal(byPath(result.files, "index.html").content, "old");
  assert.equal(byPath(result.baseline, "index.html").content, "old");
});
