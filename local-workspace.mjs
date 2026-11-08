import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MAX_FILES = 300;
const MAX_BYTES = 20 * 1024 * 1024;
const TEXT = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".txt",
  ".xml",
  ".webmanifest",
  ".map",
]);
const BINARY = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".mp3",
  ".ogg",
  ".wav",
  ".pdf",
]);
const IGNORED = new Set([
  "node_modules",
  "target",
  "runtime",
  "coverage",
  "__pycache__",
  "venv",
]);
const SHA = /^[a-f\d]{40,64}$/i;

export class LocalWorkspaceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "LocalWorkspaceError";
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new LocalWorkspaceError(status, message);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, target) =>
  target === root || target.startsWith(`${root}${path.sep}`);

function filePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    path.posix.isAbsolute(value)
  )
    fail(400, "Choose a relative site file path.");
  if (
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          part.startsWith("-") ||
          IGNORED.has(part),
      )
  )
    fail(
      400,
      "Hidden folders, dependencies, and path traversal cannot be edited.",
    );
  const extension = path.posix.extname(value).toLowerCase();
  if (!TEXT.has(extension) && !BINARY.has(extension))
    fail(400, "This file type is not supported by the HTML editor.");
  return value;
}
function decodeFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES)
    fail(400, "Save at most 300 site files at a time.");
  const seen = new Set();
  let total = 0;
  return files.map((file) => {
    if (
      !file ||
      typeof file.content !== "string" ||
      !["utf8", "base64"].includes(file.encoding)
    )
      fail(400, "Every file needs string content and utf8 or base64 encoding.");
    const name = filePath(file.path);
    if (seen.has(name)) fail(400, "The save contains a duplicate file path.");
    seen.add(name);
    if (
      file.encoding === "base64" &&
      (file.content.length % 4 ||
        !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(
          file.content,
        ))
    )
      fail(400, "An asset contains invalid base64 data.");
    const bytes = Buffer.from(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    total += bytes.length;
    if (total > MAX_BYTES) fail(413, "Site changes exceed the 20 MiB limit.");
    return { path: name, bytes };
  });
}

function gitEnvironment() {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
  };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[name];
  return env;
}
function git(root, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { env: gitEnvironment(), timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !allowFailure) {
          const unavailable = error.code === "ENOENT";
          return reject(
            new LocalWorkspaceError(
              unavailable ? 503 : 409,
              unavailable
                ? "Install Git to commit and push this directory."
                : "Git could not complete this operation. Check the checkout, repository permissions, and Git authentication.",
            ),
          );
        }
        resolve({ ok: !error, code: error?.code, text: stdout.trimEnd() });
      },
    );
  });
}
function repositoryName(url) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(
      url,
    );
  return match?.[1];
}
async function gitInfo(directory) {
  // A nested, uninitialized .git directory must not hide its containing checkout.
  for (let candidate = directory; ; candidate = path.dirname(candidate)) {
    const root = await git(candidate, ["rev-parse", "--show-toplevel"], {
      allowFailure: true,
    });
    if (root.ok) {
      const head = await git(root.text, ["rev-parse", "--verify", "HEAD"], {
        allowFailure: true,
      });
      if (head.ok && SHA.test(head.text)) {
        const branch = await git(
          root.text,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          { allowFailure: true },
        );
        const remote = branch.ok
          ? await git(
              root.text,
              ["config", "--get", `branch.${branch.text}.remote`],
              { allowFailure: true },
            )
          : { ok: false };
        const merge = branch.ok
          ? await git(
              root.text,
              ["config", "--get", `branch.${branch.text}.merge`],
              { allowFailure: true },
            )
          : { ok: false };
        const url =
          remote.ok && remote.text !== "."
            ? await git(root.text, ["remote", "get-url", remote.text], {
                allowFailure: true,
              })
            : { ok: false };
        const upstream = branch.ok
          ? await git(
              root.text,
              [
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
              ],
              { allowFailure: true },
            )
          : { ok: false };
        return {
          root: await realpath(root.text),
          branch: branch.ok ? branch.text : null,
          remote: remote.ok ? remote.text : null,
          merge: merge.ok ? merge.text : null,
          upstream: upstream.ok ? upstream.text : null,
          repository: url.ok ? repositoryName(url.text) || null : null,
          head: head.text,
        };
      }
    }
    if (path.dirname(candidate) === candidate) return null;
  }
}
function publicGit(info) {
  if (!info) return null;
  const { head, merge, ...visible } = info;
  return visible;
}

async function rootUnchanged(workspace) {
  let info;
  try {
    info = await lstat(workspace.directory);
  } catch {
    fail(
      409,
      "The open directory moved or was removed. Reopen it before saving.",
    );
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== workspace.identity.dev ||
    info.ino !== workspace.identity.ino
  )
    fail(409, "The open directory changed. Reopen it before saving.");
}
async function safeTarget(workspace, relative, { createParents = false } = {}) {
  await rootUnchanged(workspace);
  const parts = filePath(relative).split("/");
  let parent = workspace.directory;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    let info;
    try {
      info = await lstat(parent);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!createParents)
        return {
          target: path.join(workspace.directory, ...parts),
          absentParent: true,
        };
      try {
        await mkdir(parent);
      } catch (cause) {
        if (cause.code !== "EEXIST") throw cause;
      }
      info = await lstat(parent);
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      fail(
        409,
        "A site path crosses a symbolic link or a non-directory. Reopen the directory before saving.",
      );
  }
  const actualParent = await realpath(parent);
  if (!inside(workspace.directory, actualParent))
    fail(409, "A site file is outside the selected directory.");
  return { target: path.join(parent, parts.at(-1)), parent };
}
async function diskState(workspace, relative) {
  const resolved = await safeTarget(workspace, relative);
  if (resolved.absentParent) return { exists: false };
  let handle;
  try {
    handle = await openFile(
      resolved.target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const info = await handle.stat();
    if (!info.isFile())
      fail(409, "A selected site file is no longer a regular file.");
    if (info.size > MAX_BYTES)
      fail(413, "A selected site file exceeds the 20 MiB limit.");
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_BYTES)
        fail(413, "A selected site file exceeds the 20 MiB limit.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    return {
      exists: true,
      hash: digest(bytes),
      mode: info.mode & 0o777,
      bytes,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    if (["ELOOP", "EISDIR"].includes(error.code))
      fail(
        409,
        "A site file became a symbolic link or directory. Reopen before saving.",
      );
    throw error;
  } finally {
    await handle?.close();
  }
}
function sameSnapshot(actual, expected) {
  return (
    actual.exists === !!expected &&
    (!actual.exists || actual.hash === expected.hash)
  );
}
async function verifySnapshot(workspace, relative) {
  const actual = await diskState(workspace, relative);
  if (!sameSnapshot(actual, workspace.snapshots.get(relative)))
    fail(
      409,
      `The file ${relative} changed on disk. Reopen the directory or export your edits before replacing it.`,
    );
  return actual;
}
async function verifyGitIdentity(workspace) {
  if (!workspace.git) return;
  const now = await gitInfo(workspace.directory);
  if (
    !now ||
    now.root !== workspace.git.root ||
    now.branch !== workspace.git.branch ||
    now.head !== workspace.git.head
  )
    fail(
      409,
      "The checkout branch or commit changed. Reopen the directory before saving or committing.",
    );
}
async function chooseSiteRoot(directory) {
  const direct = await readdir(directory, { withFileTypes: true });
  if (direct.some((entry) => entry.isFile() && /\.html?$/i.test(entry.name)))
    return directory;
  for (const relative of ["website/public", "website/dist", "public", "dist"]) {
    const candidate = path.join(directory, relative);
    try {
      const segments = relative.split("/");
      let check = directory;
      for (const segment of segments) {
        check = path.join(check, segment);
        const info = await lstat(check);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("not a direct directory");
      }
      if (
        (await readdir(candidate, { withFileTypes: true })).some(
          (entry) => entry.isFile() && /\.html?$/i.test(entry.name),
        )
      )
        return candidate;
    } catch {
      /* Try the next conventional static-site directory. */
    }
  }
  return directory;
}

/** In-memory directory grants are scoped to one local server process. */
export function createLocalWorkspaces() {
  const workspaces = new Map();
  const busyDirectories = new Set();
  const get = (id) => {
    const workspace = workspaces.get(id);
    if (!workspace)
      fail(
        409,
        "This directory session expired. Reopen the existing directory to continue.",
      );
    return workspace;
  };
  const exclusive = async (workspace, action) => {
    const lock = workspace.git?.root || workspace.directory;
    if (busyDirectories.has(lock))
      fail(
        409,
        "This directory is already saving or pushing. Wait for that operation to finish.",
      );
    busyDirectories.add(lock);
    try {
      return await action();
    } finally {
      busyDirectories.delete(lock);
    }
  };
  return {
    async open(input) {
      if (
        typeof input?.directory !== "string" ||
        !input.directory.trim() ||
        /[\x00-\x1f\x7f]/.test(input.directory)
      )
        fail(400, "Enter the existing directory's absolute path.");
      const requested = input.directory
        .trim()
        .replace(/^~(?=$|\/)/, os.homedir());
      if (!path.isAbsolute(requested))
        fail(
          400,
          "Enter an absolute directory path, such as /Users/you/projects/site.",
        );
      let directory;
      try {
        directory = await realpath(requested);
        if (!(await stat(directory)).isDirectory())
          fail(400, "Choose a directory rather than a file.");
      } catch (error) {
        if (error instanceof LocalWorkspaceError) throw error;
        fail(
          404,
          "That directory could not be opened. Check its path and permissions.",
        );
      }
      directory = await chooseSiteRoot(directory);
      const identity = await lstat(directory);
      const entries = [];
      let total = 0;
      let skippedSymlinks = 0;
      const walk = async (folder, prefix = "") => {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          if (
            entry.name.startsWith(".") ||
            entry.name.startsWith("-") ||
            IGNORED.has(entry.name)
          )
            continue;
          const name = prefix ? `${prefix}/${entry.name}` : entry.name;
          const absolute = path.join(folder, entry.name);
          const info = await lstat(absolute);
          if (info.isSymbolicLink()) {
            skippedSymlinks++;
            continue;
          }
          if (info.isDirectory()) {
            await walk(absolute, name);
            continue;
          }
          if (
            !info.isFile() ||
            (!TEXT.has(path.extname(name).toLowerCase()) &&
              !BINARY.has(path.extname(name).toLowerCase()))
          )
            continue;
          filePath(name);
          total += info.size;
          entries.push(name);
          if (entries.length > MAX_FILES || total > MAX_BYTES)
            fail(
              413,
              "This directory exceeds 300 supported files or 20 MiB. Open its site subfolder.",
            );
        }
      };
      await walk(directory);
      if (!entries.some((name) => /\.html?$/i.test(name)))
        fail(
          400,
          "No HTML files were found. Choose the existing static site's directory.",
        );
      const workspace = {
        directory,
        identity,
        snapshots: new Map(),
        savedPaths: new Set(),
        git: await gitInfo(directory),
        busy: false,
        pending: null,
      };
      total = 0;
      const files = [];
      for (const name of entries.sort()) {
        const state = await diskState(workspace, name);
        if (!state.exists)
          fail(
            409,
            "A site file changed while opening. Open the directory again.",
          );
        total += state.bytes.length;
        if (total > MAX_BYTES)
          fail(413, "This directory exceeds the 20 MiB limit.");
        workspace.snapshots.set(name, { hash: state.hash });
        const encoding = TEXT.has(path.extname(name).toLowerCase())
          ? "utf8"
          : "base64";
        files.push({
          path: name,
          content: state.bytes.toString(
            encoding === "utf8" ? "utf8" : "base64",
          ),
          encoding,
        });
      }
      const workspaceId = randomBytes(24).toString("hex");
      workspaces.set(workspaceId, workspace);
      return {
        workspaceId,
        directory,
        files,
        git: publicGit(workspace.git),
        skippedSymlinks,
      };
    },
    async save(input) {
      const workspace = get(input?.workspaceId);
      return exclusive(workspace, async () => {
        const files = decodeFiles(input.files);
        if (!files.length) return { saved: [] };
        if (workspace.pending)
          fail(
            409,
            "A local commit is waiting to be pushed. Retry that push before saving further edits, or reopen after reconciling it in Git.",
          );
        await verifyGitIdentity(workspace);
        const planned = [];
        for (const file of files)
          planned.push({
            ...file,
            before: await verifySnapshot(workspace, file.path),
          });
        const temps = [];
        const saved = [];
        try {
          for (const file of planned) {
            const resolved = await safeTarget(workspace, file.path, {
              createParents: true,
            });
            const temp = path.join(
              resolved.parent,
              `.pagecraft-${randomBytes(16).toString("hex")}.tmp`,
            );
            const handle = await openFile(
              temp,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
              file.before.mode ?? 0o644,
            );
            temps.push({
              path: file.path,
              temp,
              target: resolved.target,
              bytes: file.bytes,
            });
            try {
              await handle.writeFile(file.bytes);
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          // Recheck the complete batch after staging, before replacing any file.
          for (const file of planned)
            await verifySnapshot(workspace, file.path);
          for (const file of temps) {
            await verifySnapshot(workspace, file.path);
            const resolved = await safeTarget(workspace, file.path);
            if (resolved.target !== file.target)
              fail(
                409,
                "A site path changed while saving. Reopen the directory.",
              );
            await rename(file.temp, file.target);
            workspace.snapshots.set(file.path, { hash: digest(file.bytes) });
            workspace.savedPaths.add(file.path);
            saved.push(file.path);
          }
          return { saved };
        } catch (error) {
          if (saved.length)
            fail(
              error.status || 409,
              `Saved ${saved.join(", ")}, then stopped before the remaining files. ${error instanceof LocalWorkspaceError ? error.message : "Check disk permissions and reopen the directory."}`,
            );
          if (error instanceof LocalWorkspaceError) throw error;
          fail(
            409,
            "The files could not be saved. Check disk permissions and free space; your edits remain in the browser.",
          );
        } finally {
          await Promise.all(
            temps.map((file) => rm(file.temp, { force: true }).catch(() => {})),
          );
        }
      });
    },
    async push(input) {
      const workspace = get(input?.workspaceId);
      return exclusive(workspace, async () => {
        const info = workspace.git;
        if (!info || !info.branch)
          fail(
            409,
            "Open a Git working directory on a branch before committing and pushing.",
          );
        if (
          !info.remote ||
          info.remote === "." ||
          !info.merge?.startsWith("refs/heads/") ||
          !info.upstream
        )
          fail(
            409,
            "This branch needs an existing remote upstream. Set it in Git, then reopen the directory.",
          );
        if (
          typeof input.message !== "string" ||
          !input.message.trim() ||
          input.message.length > 2000 ||
          /[\x00]/.test(input.message)
        )
          fail(400, "Write a commit message between 1 and 2,000 characters.");
        const paths = input.paths;
        if (
          !Array.isArray(paths) ||
          !paths.length ||
          paths.length > MAX_FILES ||
          new Set(paths).size !== paths.length
        )
          fail(400, "Select between 1 and 300 saved files to commit.");
        paths.forEach(filePath);
        if (paths.some((name) => !workspace.savedPaths.has(name)))
          fail(
            409,
            "Save the selected files to this directory before committing them.",
          );
        await verifyGitIdentity(workspace);
        const fresh = await gitInfo(workspace.directory);
        if (
          fresh.remote !== info.remote ||
          fresh.merge !== info.merge ||
          fresh.upstream !== info.upstream
        )
          fail(
            409,
            "The branch's push destination changed. Reopen the directory before pushing.",
          );
        const staged = await git(info.root, ["diff", "--cached", "--quiet"], {
          allowFailure: true,
        });
        if (!staged.ok)
          fail(
            409,
            "This checkout already has staged changes. Commit or unstage them in Git before Pagecraft creates its commit.",
          );
        for (const name of paths) await verifySnapshot(workspace, name);
        const repoPaths = paths.map((name) =>
          path
            .relative(
              info.root,
              path.join(workspace.directory, ...name.split("/")),
            )
            .split(path.sep)
            .join("/"),
        );
        if (
          repoPaths.some(
            (name) => name.startsWith("../") || path.isAbsolute(name),
          )
        )
          fail(409, "The site files are outside the owning Git checkout.");
        if (workspace.pending) {
          if (
            workspace.pending.blocked ||
            paths.length !== workspace.pending.paths.length ||
            paths.some((name) => !workspace.pending.paths.includes(name))
          )
            fail(
              409,
              "Inspect the pending local commit in Git and reopen this directory before changing its selected files.",
            );
        } else {
          // Fetch only the configured upstream into FETCH_HEAD. Never merge,
          // reset, stash, change branches, or push someone else's local commits.
          await git(info.root, [
            "fetch",
            "--no-tags",
            "--",
            info.remote,
            info.merge,
          ]);
          const remoteHead = await git(info.root, ["rev-parse", "FETCH_HEAD"]);
          if (remoteHead.text !== info.head)
            fail(
              409,
              "The checkout and remote branch differ. Reconcile them in Git, then reopen this directory; Pagecraft has not created a commit.",
            );
          await verifyGitIdentity(workspace);
          for (const name of paths) await verifySnapshot(workspace, name);
          const changes = await git(
            info.root,
            ["diff", "--quiet", "HEAD", "--", ...repoPaths],
            { allowFailure: true },
          );
          const untracked = [];
          for (const name of repoPaths)
            if (
              !(
                await git(
                  info.root,
                  ["ls-files", "--error-unmatch", "--", name],
                  { allowFailure: true },
                )
              ).ok
            )
              untracked.push(name);
          if (changes.ok && !untracked.length)
            fail(
              409,
              "The selected files already match the current commit. There is nothing to push.",
            );
          // --only builds a commit from these worktree paths while preserving
          // unrelated index entries. Intent-to-add lets it include new files.
          if (untracked.length)
            await git(info.root, [
              "add",
              "--intent-to-add",
              "--",
              ...untracked,
            ]);
          const result = await git(
            info.root,
            [
              "commit",
              "--only",
              "-m",
              input.message.trim(),
              "--",
              ...repoPaths,
            ],
            { allowFailure: true },
          );
          if (!result.ok)
            fail(
              409,
              "Git could not create the commit. Check your Git author settings and repository hooks. Your file edits remain saved; newly added paths may be marked intent-to-add.",
            );
          const committed = (await git(info.root, ["rev-parse", "HEAD"])).text;
          const parent = (await git(info.root, ["rev-parse", "HEAD^"])).text;
          workspace.pending = {
            commit: committed,
            paths: [...paths],
            blocked: false,
          };
          info.head = committed;
          const committedPaths = (
            await git(info.root, [
              "diff-tree",
              "--no-commit-id",
              "--name-only",
              "-r",
              "-z",
              committed,
            ])
          ).text
            .split("\0")
            .filter(Boolean);
          if (
            parent !== remoteHead.text ||
            committedPaths.some((name) => !repoPaths.includes(name))
          ) {
            workspace.pending.blocked = true;
            fail(
              409,
              "The Git commit changed outside the selected files, possibly through a repository hook. It remains local. Inspect it in Git before pushing, then reopen this directory.",
            );
          }
        }
        const pending = workspace.pending;
        try {
          await verifyGitIdentity(workspace);
        } catch (error) {
          error.pendingCommit = pending.commit;
          throw error;
        }
        // Push the immutable commit we created, never whichever HEAD another
        // local client might install after the final identity check.
        const result = await git(
          info.root,
          ["push", "--", info.remote, `${pending.commit}:${info.merge}`],
          { allowFailure: true },
        );
        if (!result.ok) {
          const error = new LocalWorkspaceError(
            409,
            `The local commit ${pending.commit.slice(0, 7)} was created, but Git could not confirm its push. Retry Push to send that same commit; do not create another commit. Check Git authentication and the remote branch if it continues to fail.`,
          );
          error.pendingCommit = pending.commit;
          throw error;
        }
        for (const name of pending.paths) workspace.savedPaths.delete(name);
        workspace.pending = null;
        const answer = {
          commit: pending.commit,
          branch: info.branch,
          remote: info.remote,
          pushed: true,
        };
        if (info.repository)
          answer.url = `https://github.com/${info.repository}/commit/${pending.commit}`;
        return answer;
      });
    },
  };
}
