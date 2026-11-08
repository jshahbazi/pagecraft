import { execFile } from "node:child_process";
import { mkdir, mkdtemp, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export class NativeProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "NativeProjectError";
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new NativeProjectError(status, message);
};

/** Normalize only GitHub repository identifiers, never arbitrary Git URLs. */
export function normalizeGitHubRepository(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value))
    fail(
      400,
      "Enter a GitHub repository as owner/repository or a GitHub repository URL.",
    );
  let repository = value.trim();
  if (repository.startsWith("https://")) {
    let url;
    try {
      url = new URL(repository);
    } catch {
      fail(400, "Enter a valid GitHub repository URL.");
    }
    if (
      url.hostname !== "github.com" ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[%?#]/.test(repository) ||
      repository
        .slice(repository.indexOf("://") + 3)
        .split("/")
        .slice(1)
        .some((part) => part === "." || part === "..")
    )
      fail(
        400,
        "Use an HTTPS github.com repository URL without credentials, query parameters, or fragments.",
      );
    repository = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  } else if (repository.startsWith("git@github.com:")) {
    repository = repository.slice("git@github.com:".length);
  }
  repository = repository.replace(/\.git$/, "");
  if (
    !/^[A-Za-z\d](?:[A-Za-z\d-]{0,38})\/[A-Za-z\d_.-]{1,100}$/.test(
      repository,
    ) ||
    repository.split("/")[1].startsWith("-") ||
    [".", ".."].includes(repository.split("/")[1])
  )
    fail(
      400,
      "Enter one GitHub owner and repository name. Other hosts, flags, and directory paths are not supported.",
    );
  return repository;
}

function runCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...options, shell: false, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          return reject(error);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

const MAC_PICKER =
  'POSIX path of (choose folder with prompt "Choose a site folder or repository")';
const WINDOWS_PICKER = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Choose a site folder or repository'",
  "$dialog.ShowNewFolderButton = $false",
  "try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) } else { exit 3 } } finally { $dialog.Dispose() }",
].join("; ");

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

/** Native picker and managed clones for the loopback app, with no browser upload. */
export function createNativeProjects({
  run = runCommand,
  platform = process.platform,
  checkoutRoot = path.join(os.homedir(), ".pagecraft", "checkouts"),
} = {}) {
  let pickerOpen = false;
  return {
    async pickDirectory() {
      if (pickerOpen)
        fail(
          409,
          "A folder picker is already open. Finish or cancel it before opening another.",
        );
      const command =
        platform === "darwin"
          ? { file: "/usr/bin/osascript", args: ["-e", MAC_PICKER] }
          : platform === "win32"
            ? {
                file: "powershell.exe",
                args: [
                  "-NoLogo",
                  "-NoProfile",
                  "-STA",
                  "-NonInteractive",
                  "-Command",
                  WINDOWS_PICKER,
                ],
              }
            : platform === "linux"
              ? {
                  file: "zenity",
                  args: [
                    "--file-selection",
                    "--directory",
                    "--title=Choose a site folder or repository",
                  ],
                }
              : null;
      if (!command)
        fail(
          503,
          "A native folder picker is not available on this operating system.",
        );
      pickerOpen = true;
      try {
        const result = await run(command.file, command.args, {
          timeout: 300_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        const output = typeof result === "string" ? result : result?.stdout;
        const directory =
          typeof output === "string" ? output.replace(/\r?\n$/, "") : "";
        const validPath =
          platform === "win32"
            ? path.win32.isAbsolute(directory)
            : path.posix.isAbsolute(directory);
        if (!directory || !validPath || /[\x00-\x1f\x7f]/.test(directory))
          fail(
            503,
            "The folder picker did not return a usable directory. Choose the folder again.",
          );
        return { directory };
      } catch (error) {
        if (error instanceof NativeProjectError) throw error;
        const detail = `${error?.stderr || ""}\n${error?.message || ""}`;
        if (
          (platform === "darwin" &&
            (error?.code === -128 ||
              /(?:^|[^0-9])-128(?:[^0-9]|$)/.test(detail))) ||
          (platform === "win32" && error?.code === 3) ||
          (platform === "linux" &&
            error?.code === 1 &&
            !String(error?.stderr || "").trim())
        )
          return { cancelled: true };
        if (error?.killed || error?.code === "ETIMEDOUT")
          fail(
            408,
            "The folder picker timed out. Open it again when you are ready to select a folder.",
          );
        if (platform === "linux" && error?.code === "ENOENT")
          fail(
            503,
            "The system folder picker requires zenity. Install zenity and run Pagecraft in a desktop session.",
          );
        fail(
          503,
          "The system folder picker could not open. Run Pagecraft in a desktop session and try again.",
        );
      } finally {
        pickerOpen = false;
      }
    },

    async cloneRepository({ repository: input } = {}) {
      const repository = normalizeGitHubRepository(input);
      if (
        typeof checkoutRoot !== "string" ||
        !path.isAbsolute(checkoutRoot) ||
        /[\x00-\x1f\x7f]/.test(checkoutRoot)
      )
        fail(
          503,
          "Pagecraft's checkout directory is not configured correctly.",
        );
      let directory;
      try {
        await mkdir(checkoutRoot, { recursive: true, mode: 0o700 });
        const info = await lstat(checkoutRoot);
        if (!info.isDirectory() || info.isSymbolicLink())
          fail(
            503,
            "Pagecraft's checkout directory must be a regular directory.",
          );
        const root = await realpath(checkoutRoot);
        // mkdtemp atomically reserves a new empty directory. Existing checkouts
        // are never reused, overwritten, or removed, including after failure.
        directory = await mkdtemp(
          path.join(root, `${repository.replace("/", "--")}-`),
        );
      } catch (error) {
        if (error instanceof NativeProjectError) throw error;
        fail(
          503,
          "Pagecraft could not create its local checkout directory. Check permissions and free disk space.",
        );
      }
      try {
        const commandOptions = {
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
          env: gitEnvironment(),
          windowsHide: true,
        };
        await run(
          "git",
          [
            "clone",
            "--filter=blob:none",
            "--no-checkout",
            "--single-branch",
            "--",
            `https://github.com/${repository}.git`,
            directory,
          ],
          commandOptions,
        );
        const treeNames = async (tree) => {
          const result = await run(
            "git",
            ["-C", directory, "ls-tree", "-z", "--name-only", tree],
            { ...commandOptions, timeout: 15_000 },
          );
          const output = typeof result === "string" ? result : result?.stdout;
          return String(output || "")
            .split("\0")
            .filter(Boolean);
        };
        const rootEntries = await treeNames("HEAD");
        let siteDirectory = null;
        if (!rootEntries.some((name) => /\.html?$/i.test(name))) {
          for (const candidate of [
            "website/public",
            "website/dist",
            "public",
            "dist",
          ]) {
            try {
              if (
                (await treeNames(`HEAD:${candidate}`)).some((name) =>
                  /\.html?$/i.test(name),
                )
              ) {
                siteDirectory = candidate;
                break;
              }
            } catch (error) {
              // Git exits 128 for a missing tree. Operational failures must
              // stop rather than fall back to downloading an entire checkout.
              if (error?.code !== 128) throw error;
            }
          }
        }
        if (siteDirectory) {
          await run(
            "git",
            ["-C", directory, "sparse-checkout", "init", "--cone"],
            commandOptions,
          );
          await run(
            "git",
            [
              "-C",
              directory,
              "sparse-checkout",
              "set",
              "--cone",
              "--",
              siteDirectory,
            ],
            commandOptions,
          );
        }
        await run("git", ["-C", directory, "checkout"], commandOptions);
        return {
          directory,
          repository,
          ...(siteDirectory ? { siteDirectory } : {}),
        };
      } catch (error) {
        const message =
          error?.code === "ENOENT"
            ? "Install Git to clone repositories into Pagecraft."
            : error?.killed || error?.code === "ETIMEDOUT"
              ? "The clone timed out. Check your connection and repository size, then try again."
              : "Git could not clone that repository. Check its name, your repository access, and Git authentication.";
        const result = new NativeProjectError(
          error?.killed || error?.code === "ETIMEDOUT" ? 408 : 502,
          `${message} The new incomplete checkout was retained in Pagecraft's checkouts folder.`,
        );
        result.directory = directory;
        throw result;
      }
    },
  };
}
