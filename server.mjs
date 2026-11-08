import {
  createNativeProjects,
  NativeProjectError,
} from "./native-projects.mjs";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat, readdir } from "node:fs/promises";
import os from "node:os";
import {
  createLocalWorkspaces,
  LocalWorkspaceError,
} from "./local-workspace.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILES = 300;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 29 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
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
const BINARY_EXTENSIONS = new Set([
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
const SHA = /^[a-f\d]{40}$/i;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new AppError(status, message);
}

export function validateRepository(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(value) ||
    value.endsWith("/.") ||
    value.endsWith("/..")
  ) {
    fail(400, "Enter a GitHub repository as owner/repository.");
  }
  return value;
}

export function validateBranch(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
    value
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    fail(400, "Enter a valid Git branch name.");
  }
  return value;
}

export function validateDirectory(value = "") {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(
      400,
      "Enter a relative site folder without hidden folders or path traversal.",
    );
  // A trailing slash is harmless; the returned path is canonical for pushes.
  const directory = value.replace(/\/+$/, "");
  if (
    value.startsWith("/") ||
    (directory &&
      directory
        .split("/")
        .some(
          (part) =>
            !part ||
            part.startsWith(".") ||
            part.startsWith("-") ||
            part === "node_modules",
        ))
  )
    fail(
      400,
      "Enter a relative site folder without hidden folders or path traversal.",
    );
  return directory;
}

export function isSitePath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    value.startsWith("-") ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return false;
  const parts = value.split("/");
  if (
    parts.some(
      (part) => !part || part.startsWith(".") || part === "node_modules",
    )
  )
    return false;
  const extension = path.posix.extname(value).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || BINARY_EXTENSIONS.has(extension);
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES)
    fail(400, `Choose between 1 and ${MAX_FILES} changed site files.`);
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    if (!file || !isSitePath(file.path) || seen.has(file.path))
      fail(
        400,
        "A changed file has an unsupported, duplicate, or unsafe path.",
      );
    seen.add(file.path);
    if (
      typeof file.content !== "string" ||
      !["utf8", "base64"].includes(file.encoding)
    )
      fail(400, "Every file needs string content and utf8 or base64 encoding.");
    if (
      file.encoding === "base64" &&
      (file.content.length % 4 !== 0 ||
        !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(
          file.content,
        ))
    )
      fail(400, "A file contains invalid base64 data.");
    total += Buffer.byteLength(
      file.content,
      file.encoding === "base64" ? "base64" : "utf8",
    );
    if (total > MAX_BYTES) fail(413, "Site changes exceed the 20 MiB limit.");
  }
  return files;
}

/** Run gh directly; request bodies go to stdin and credentials stay in gh. */
export function runGh(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === "ENOENT")
            return reject(
              new AppError(
                503,
                "Install GitHub CLI (gh), then run gh auth login.",
              ),
            );
          const status = /HTTP (\d{3})/.exec(stderr)?.[1];
          if (status === "404")
            return reject(
              new AppError(
                404,
                "Repository or branch not found. Check the name and your GitHub access.",
              ),
            );
          if (status === "401" || status === "403")
            return reject(
              new AppError(
                403,
                "GitHub access was refused. Check gh auth status and your repository permissions.",
              ),
            );
          if (status === "409" || status === "422")
            return reject(
              new AppError(
                409,
                "GitHub refused this update. Reload the branch; it may have changed or have protection rules.",
              ),
            );
          return reject(
            new AppError(
              502,
              "GitHub could not complete the request. Check gh auth status and try again.",
            ),
          );
        }
        resolve(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

function createGithub(run) {
  return async (endpoint, { method = "GET", body } = {}) => {
    const args = [
      "api",
      "--hostname",
      "github.com",
      endpoint,
      "--method",
      method,
    ];
    if (body !== undefined) args.push("--input", "-");
    const output = await run(args, {
      input: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      return JSON.parse(output);
    } catch {
      fail(502, "GitHub returned an unreadable response.");
    }
  };
}

async function concurrentMap(items, action, count = 5) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        result[index] = await action(items[index]);
      }
    }),
  );
  return result;
}

async function getHead(api, repository, branch) {
  const ref = await api(
    `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  if (!SHA.test(ref?.object?.sha ?? "") || ref.object.type !== "commit")
    fail(502, "GitHub returned an invalid branch reference.");
  return ref.object.sha;
}

async function openRepository(api, input) {
  const repository = validateRepository(input.repository);
  const directory = validateDirectory(input.directory);
  const repo = input.branch ? null : await api(`repos/${repository}`);
  const branch = validateBranch(input.branch || repo?.default_branch);
  const baseCommit = await getHead(api, repository, branch);
  const commit = await api(`repos/${repository}/git/commits/${baseCommit}`);
  if (!SHA.test(commit?.tree?.sha ?? ""))
    fail(502, "GitHub returned an invalid commit tree.");
  let selectedTree = commit.tree.sha;
  for (const component of directory ? directory.split("/") : []) {
    const parent = await api(`repos/${repository}/git/trees/${selectedTree}`);
    if (parent.truncated || !Array.isArray(parent.tree))
      fail(413, "This repository folder is too large to open safely.");
    const folder = parent.tree.find((entry) => entry.path === component);
    if (!folder) fail(404, "Site folder not found in this branch.");
    if (
      folder.mode !== "040000" ||
      folder.type !== "tree" ||
      !SHA.test(folder.sha ?? "")
    )
      fail(
        400,
        "The site folder must be an ordinary directory, not a file, symbolic link, or submodule.",
      );
    selectedTree = folder.sha;
  }
  const tree = await api(
    `repos/${repository}/git/trees/${selectedTree}?recursive=1`,
  );
  if (tree.truncated || !Array.isArray(tree.tree))
    fail(
      413,
      "This repository is too large to open safely. Use a smaller static site repository.",
    );
  if (
    tree.tree.some(
      (entry) => entry.mode === "120000" || entry.mode === "160000",
    )
  )
    fail(
      400,
      "Repositories containing symbolic links or submodules are not supported.",
    );
  const entries = tree.tree.filter(
    (entry) =>
      entry.type === "blob" &&
      entry.mode === "100644" &&
      isSitePath(entry.path),
  );
  if (
    entries.length > MAX_FILES ||
    entries.reduce((sum, entry) => sum + (entry.size || 0), 0) > MAX_BYTES
  )
    fail(413, "This site exceeds 300 supported files or 20 MiB.");
  if (!entries.some((entry) => /\.html?$/i.test(entry.path)))
    fail(
      400,
      "This repository has no editable HTML files. Open a static HTML site.",
    );
  let decodedBytes = 0;
  const files = await concurrentMap(entries, async (entry) => {
    if (!SHA.test(entry.sha ?? ""))
      fail(502, "GitHub returned an invalid file reference.");
    const blob = await api(`repos/${repository}/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string")
      fail(502, "GitHub returned an unsupported file encoding.");
    const bytes = Buffer.from(blob.content, "base64");
    decodedBytes += bytes.length;
    if (decodedBytes > MAX_BYTES)
      fail(413, "This site exceeds the 20 MiB limit.");
    const isText = TEXT_EXTENSIONS.has(
      path.posix.extname(entry.path).toLowerCase(),
    );
    return {
      path: entry.path,
      content: bytes.toString(isText ? "utf8" : "base64"),
      encoding: isText ? "utf8" : "base64",
    };
  });
  return { repository, branch, directory, baseCommit, files };
}

async function pushRepository(api, input) {
  const repository = validateRepository(input.repository);
  const branch = validateBranch(input.branch);
  const directory = validateDirectory(input.directory);
  if (typeof input.baseCommit !== "string" || !SHA.test(input.baseCommit))
    fail(400, "Open the repository before pushing changes.");
  if (
    typeof input.message !== "string" ||
    !input.message.trim() ||
    input.message.length > 2000 ||
    input.message.includes("\0")
  )
    fail(400, "Write a commit message between 1 and 2,000 characters.");
  const files = validateFiles(input.files).map((file) => ({
    ...file,
    path: directory ? `${directory}/${file.path}` : file.path,
  }));
  const baseCommit = input.baseCommit;
  if ((await getHead(api, repository, branch)) !== baseCommit)
    fail(
      409,
      "This branch changed on GitHub. Download your edits, then reopen the repository before pushing.",
    );
  const commit = await api(`repos/${repository}/git/commits/${baseCommit}`);
  if (!SHA.test(commit?.tree?.sha ?? ""))
    fail(502, "GitHub returned an invalid commit tree.");
  // Check existing modes so a supplied path cannot replace a symlink, submodule, or executable.
  const existing = await api(
    `repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`,
  );
  if (existing.truncated || !Array.isArray(existing.tree))
    fail(413, "This repository is too large to update safely.");
  const modes = new Map(existing.tree.map((entry) => [entry.path, entry.mode]));
  for (const file of files) {
    const segments = file.path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const mode = modes.get(segments.slice(0, i).join("/"));
      if (mode && mode !== (i === segments.length ? "100644" : "040000"))
        fail(
          400,
          "A changed path conflicts with an existing directory, executable, link, or submodule.",
        );
    }
  }
  const treeEntries = await concurrentMap(files, async (file) => {
    const blob = await api(`repos/${repository}/git/blobs`, {
      method: "POST",
      body: {
        content: file.content,
        encoding: file.encoding === "utf8" ? "utf-8" : "base64",
      },
    });
    if (!SHA.test(blob?.sha ?? ""))
      fail(502, "GitHub returned an invalid new file reference.");
    return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
  });
  const tree = await api(`repos/${repository}/git/trees`, {
    method: "POST",
    body: { base_tree: commit.tree.sha, tree: treeEntries },
  });
  if (!SHA.test(tree?.sha ?? ""))
    fail(502, "GitHub returned an invalid new tree reference.");
  const created = await api(`repos/${repository}/git/commits`, {
    method: "POST",
    body: {
      message: input.message.trim(),
      tree: tree.sha,
      parents: [baseCommit],
    },
  });
  if (!SHA.test(created?.sha ?? ""))
    fail(502, "GitHub returned an invalid new commit reference.");
  await api(
    `repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`,
    { method: "PATCH", body: { sha: created.sha, force: false } },
  );
  return {
    commit: created.sha,
    url: `https://github.com/${repository}/commit/${created.sha}`,
    repository,
    branch,
    directory,
  };
}

async function readJson(request) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")
  )
    fail(415, "Send application/json.");
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES)
      fail(413, "The request exceeds the site size limit.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(400, "Send a JSON object.");
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(400, "The request contains invalid JSON.");
  }
}

function json(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function sameToken(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function expandLocalPath(value) {
  if (typeof value !== "string") return value;
  return value === "~"
    ? os.homedir()
    : value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(2))
      : value;
}
async function browseDirectories(input) {
  const selected = expandLocalPath(input.directory || os.homedir());
  if (
    typeof selected !== "string" ||
    !path.isAbsolute(selected) ||
    selected.includes("\0")
  )
    fail(400, "Enter an absolute directory path.");
  let directory, entries;
  try {
    directory = await realpath(selected);
    if (!(await stat(directory)).isDirectory())
      fail(400, "Choose a directory.");
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail(
      400,
      "That directory could not be opened. Check its path and permissions.",
    );
  }
  return {
    directory,
    parent: path.dirname(directory),
    folders: entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules",
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 1000)
      .map((entry) => ({
        name: entry.name,
        directory: path.join(directory, entry.name),
      })),
  };
}

/** Create an unbound server. Tests can inject a fake gh runner; production uses gh. */
export function createApp({
  runGh: run = runGh,
  token = randomBytes(32).toString("hex"),
  publicDir = path.join(ROOT, "public"),
  localWorkspaces = createLocalWorkspaces(),
  nativeProjects = createNativeProjects(),
  startupDirectory = null,
  browseLocal = browseDirectories,
} = {}) {
  const instanceId = randomBytes(16).toString("hex");
  const api = createGithub(run);
  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const host = request.headers.host;
      if (!hosts.includes(host))
        fail(403, "Pagecraft only accepts requests to its local address.");
      const origin = `http://${host}`;
      if (request.headers.origin && request.headers.origin !== origin)
        fail(403, "Cross-origin requests are not allowed.");
      const url = new URL(request.url, origin);
      // Arriving from another site is a normal way to open the local app.
      // Cross-site API reads and every mutation remain unavailable.
      if (
        request.headers["sec-fetch-site"] === "cross-site" &&
        (url.pathname.startsWith("/api/") ||
          !["GET", "HEAD"].includes(request.method))
      )
        fail(403, "Cross-site requests are not allowed.");
      if (request.method === "GET" && url.pathname === "/api/session") {
        if (url.searchParams.get("local") === "1")
          return json(response, 200, {
            token,
            instanceId,
            directory: startupDirectory,
          });
        let github;
        try {
          const user = await api("user");
          github = user.login
            ? { connected: true, login: user.login }
            : {
                connected: false,
                error: "Run gh auth login to connect GitHub.",
              };
        } catch (error) {
          github = {
            connected: false,
            error:
              error instanceof AppError
                ? error.message
                : "Run gh auth login to connect GitHub.",
          };
        }
        return json(response, 200, {
          token,
          github,
          instanceId,
          directory: startupDirectory,
        });
      }
      if (url.pathname.startsWith("/api/")) {
        if (request.method !== "POST")
          fail(405, "Use POST for this API endpoint.");
        if (
          request.headers.origin !== origin ||
          !sameToken(request.headers["x-pagecraft-token"], token)
        )
          fail(
            403,
            "The local session expired. Refresh Pagecraft and try again.",
          );
        const input = await readJson(request);
        if (url.pathname === "/api/local/pick") {
          const picked = await nativeProjects.pickDirectory();
          return json(
            response,
            200,
            picked.cancelled
              ? picked
              : await localWorkspaces.open({ directory: picked.directory }),
          );
        }
        if (url.pathname === "/api/local/clone") {
          const cloned = await nativeProjects.cloneRepository(input);
          const opened = await localWorkspaces.open({
            directory: cloned.siteDirectory
              ? path.join(cloned.directory, cloned.siteDirectory)
              : cloned.directory,
          });
          return json(response, 200, {
            ...opened,
            clonedRepository: cloned.repository,
          });
        }
        if (url.pathname === "/api/local/browse")
          return json(response, 200, await browseLocal(input));
        if (url.pathname === "/api/local/open")
          return json(
            response,
            200,
            await localWorkspaces.open({
              ...input,
              directory: expandLocalPath(input.directory),
            }),
          );
        if (url.pathname === "/api/local/save")
          return json(response, 200, await localWorkspaces.save(input));
        if (url.pathname === "/api/local/push")
          return json(response, 200, await localWorkspaces.push(input));
        if (url.pathname === "/api/github/open")
          return json(response, 200, await openRepository(api, input));
        if (url.pathname === "/api/github/push")
          return json(response, 200, await pushRepository(api, input));
        fail(404, "API endpoint not found.");
      }
      if (!["GET", "HEAD"].includes(request.method))
        fail(405, "Method not allowed.");
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        fail(400, "Invalid file path.");
      }
      if (pathname.includes("\0") || pathname.includes("\\"))
        fail(400, "Invalid file path.");
      const root = await realpath(publicDir);
      const target = path.resolve(
        root,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
      if (target !== root && !target.startsWith(`${root}${path.sep}`))
        fail(404, "File not found.");
      const realTarget = await realpath(target);
      if (
        !realTarget.startsWith(`${root}${path.sep}`) ||
        !(await stat(realTarget)).isFile()
      )
        fail(404, "File not found.");
      const bytes = await readFile(realTarget);
      response.writeHead(200, {
        "Content-Type":
          MIME[path.extname(realTarget)] || "application/octet-stream",
        "Content-Length": bytes.length,
        "Cache-Control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      const status =
        error instanceof AppError ||
        error instanceof LocalWorkspaceError ||
        error instanceof NativeProjectError
          ? error.status
          : error.code === "ENOENT" || error.code === "ENOTDIR"
            ? 404
            : 500;
      const message =
        error instanceof AppError ||
        error instanceof LocalWorkspaceError ||
        error instanceof NativeProjectError
          ? error.message
          : status === 404
            ? "File not found."
            : "The local server could not complete the request.";
      if (!response.headersSent)
        json(response, status, {
          error: message,
          ...(error instanceof LocalWorkspaceError &&
          SHA.test(error.pendingCommit || "")
            ? { pendingCommit: error.pendingCommit }
            : {}),
        });
      else response.end();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const args = process.argv.slice(2);
  const directoryArg = args[0] === "--directory" ? args[1] : args[0];
  if (
    args.length > (args[0] === "--directory" ? 2 : 1) ||
    (args[0] === "--directory" && !directoryArg) ||
    directoryArg?.startsWith("-")
  )
    throw new Error(
      "Usage: npm start -- [--directory] /path/to/site-or-repository",
    );
  const server = createApp({
    startupDirectory: directoryArg
      ? path.resolve(expandLocalPath(directoryArg))
      : null,
  });
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Run with PORT=4174 npm start to choose another.`
        : "Pagecraft could not start its local server.",
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Pagecraft is ready at http://127.0.0.1:${port}`),
  );
}
