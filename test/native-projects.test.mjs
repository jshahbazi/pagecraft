import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createNativeProjects,
  NativeProjectError,
  normalizeGitHubRepository,
} from "../native-projects.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pagecraft-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const rejects = (status, pattern) => (error) =>
  error instanceof NativeProjectError &&
  error.status === status &&
  pattern.test(error.message);

test("normalizes only supported GitHub repository identifiers", () => {
  for (const value of [
    "owner/repository",
    "https://github.com/owner/repository",
    "https://github.com/owner/repository.git",
    "https://github.com/owner/repository/",
    "git@github.com:owner/repository.git",
    " owner/repository ",
  ])
    assert.equal(normalizeGitHubRepository(value), "owner/repository");
  for (const value of [
    "--upload-pack=bad",
    "-owner/repository",
    "owner/-repository",
    "owner/..",
    "owner/.",
    "owner/repo/extra",
    "owner/repo\n",
    "https://example.com/owner/repo",
    "https://github.com.evil.test/owner/repo",
    "https://user:secret@github.com/owner/repo",
    "https://github.com:443/owner/repo?secret=x",
    "https://github.com/owner/repo#fragment",
    "https://github.com/owner/repo?query=value",
    "http://github.com/owner/repo",
    "ssh://git@github.com/owner/repo.git",
    "git@evil.test:owner/repo.git",
    "owner/repo;touch hacked",
    "../repository",
    "https://github.com/owner/%2e%2e",
    "https://github.com/owner/repo/../other",
    "https://github.com/owner/repo/%2e%2e/other",
    "https://github.com/owner/repo?",
  ])
    assert.throws(
      () => normalizeGitHubRepository(value),
      NativeProjectError,
      value,
    );
});

test("macOS picker runs a fixed native script and returns the chosen path", async () => {
  const calls = [];
  const api = createNativeProjects({
    platform: "darwin",
    run: async (...args) => {
      calls.push(args);
      return { stdout: "/Users/test/Site Folder/\n" };
    },
  });
  assert.deepEqual(await api.pickDirectory(), {
    directory: "/Users/test/Site Folder/",
  });
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.deepEqual(calls[0][1], [
    "-e",
    'POSIX path of (choose folder with prompt "Choose a site folder or repository")',
  ]);
  assert.equal(calls[0][2].timeout, 300000);
});

test("native picker cancellation is handled without exposing command output", async () => {
  for (const [platform, error] of [
    ["darwin", { code: 1, stderr: "execution error: User canceled. (-128)" }],
    ["win32", { code: 3 }],
    ["linux", { code: 1, stderr: "" }],
  ]) {
    const api = createNativeProjects({
      platform,
      run: async () => {
        throw error;
      },
    });
    assert.deepEqual(await api.pickDirectory(), { cancelled: true });
  }
  const api = createNativeProjects({
    platform: "darwin",
    run: async () => {
      throw { code: 1, stderr: "secret native command stderr" };
    },
  });
  await assert.rejects(
    api.pickDirectory(),
    (error) =>
      rejects(503, /could not open/)(error) &&
      !error.message.includes("secret"),
  );
});

test("Windows and Linux picker commands are fixed and return absolute paths", async () => {
  const windows = [];
  const win = createNativeProjects({
    platform: "win32",
    run: async (...args) => {
      windows.push(args);
      return { stdout: "C:\\Users\\test\\site\r\n" };
    },
  });
  assert.deepEqual(await win.pickDirectory(), {
    directory: "C:\\Users\\test\\site",
  });
  assert.equal(windows[0][0], "powershell.exe");
  assert.ok(windows[0][1].includes("-STA"));
  assert.match(windows[0][1].at(-1), /FolderBrowserDialog/);
  const linux = [];
  const lin = createNativeProjects({
    platform: "linux",
    run: async (...args) => {
      linux.push(args);
      return "/home/test/site\n";
    },
  });
  assert.deepEqual(await lin.pickDirectory(), { directory: "/home/test/site" });
  assert.deepEqual(linux[0][1], [
    "--file-selection",
    "--directory",
    "--title=Choose a site folder or repository",
  ]);
});

test("only one picker can run at once and cancellation releases it", async () => {
  let finish;
  let calls = 0;
  const api = createNativeProjects({
    platform: "darwin",
    run: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = api.pickDirectory();
  await assert.rejects(api.pickDirectory(), rejects(409, /already open/));
  assert.equal(calls, 1);
  finish({ stdout: "/tmp/site\n" });
  await first;
  const second = api.pickDirectory();
  assert.equal(calls, 2);
  finish({ stdout: "/tmp/next\n" });
  await second;
});

test("picker dependencies, timeouts, platforms, and malformed output give safe errors", async () => {
  await assert.rejects(
    createNativeProjects({
      platform: "linux",
      run: async () => {
        throw { code: "ENOENT" };
      },
    }).pickDirectory(),
    rejects(503, /requires zenity/),
  );
  await assert.rejects(
    createNativeProjects({
      platform: "darwin",
      run: async () => {
        throw { killed: true };
      },
    }).pickDirectory(),
    rejects(408, /timed out/),
  );
  await assert.rejects(
    createNativeProjects({
      platform: "unknown",
      run: async () => {
        assert.fail("must not run");
      },
    }).pickDirectory(),
    rejects(503, /not available/),
  );
  for (const stdout of ["", "relative/site\n", "/tmp/a\n/tmp/b\n"])
    await assert.rejects(
      createNativeProjects({
        platform: "darwin",
        run: async () => ({ stdout }),
      }).pickDirectory(),
      rejects(503, /usable directory/),
    );
});

test("clone commands use isolated unique checkouts and literal HTTPS GitHub arguments", async (t) => {
  const root = await fixture(t);
  const checkoutRoot = path.join(root, "checkouts");
  await mkdir(checkoutRoot);
  const existing = path.join(checkoutRoot, "owner--repository-existing");
  await mkdir(existing);
  await writeFile(path.join(existing, "keep.txt"), "existing content");
  const calls = [];
  const api = createNativeProjects({
    checkoutRoot,
    run: async (...args) => {
      calls.push(args);
      return { stdout: "" };
    },
  });
  const first = await api.cloneRepository({
    repository: "git@github.com:owner/repository.git",
  });
  const second = await api.cloneRepository({ repository: "owner/repository" });
  assert.notEqual(first.directory, second.directory);
  assert.equal(first.repository, "owner/repository");
  const clones = calls.filter(([, args]) => args[0] === "clone");
  assert.equal(clones.length, 2);
  for (const [file, args, options] of calls) {
    assert.equal(file, "git");
    if (args[0] === "clone") {
      assert.deepEqual(args.slice(0, -1), [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--single-branch",
        "--",
        "https://github.com/owner/repository.git",
      ]);
      assert.equal(path.dirname(args.at(-1)), await realpath(checkoutRoot));
      assert.match(path.basename(args.at(-1)), /^owner--repository-/);
    } else {
      assert.equal(args[0], "-C");
      assert.ok([first.directory, second.directory].includes(args[1]));
    }
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(options.env.GIT_LITERAL_PATHSPECS, "1");
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ])
      assert.equal(options.env[key], undefined);
  }
  assert.equal(
    await readFile(path.join(existing, "keep.txt"), "utf8"),
    "existing content",
  );
  assert.equal((await readdir(checkoutRoot)).length, 3);
});

test("clone rejects unsafe repositories before touching the checkout directory", async (t) => {
  const root = await fixture(t);
  const checkoutRoot = path.join(root, "not-created");
  let calls = 0;
  const api = createNativeProjects({
    checkoutRoot,
    run: async () => {
      calls++;
    },
  });
  await assert.rejects(
    api.cloneRepository({ repository: "https://evil.test/owner/repo" }),
    rejects(400, /github.com/),
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(root), []);
});

test("failed clones retain their own incomplete directory and hide stderr", async (t) => {
  const root = await fixture(t);
  const checkoutRoot = path.join(root, "checkouts");
  const api = createNativeProjects({
    checkoutRoot,
    run: async () => {
      throw { code: 128, stderr: "https://token-secret@github.com denied" };
    },
  });
  let failure;
  try {
    await api.cloneRepository({ repository: "owner/repo" });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof NativeProjectError);
  assert.equal(failure.status, 502);
  assert.ok(!failure.message.includes("token-secret"));
  assert.match(failure.message, /incomplete checkout was retained/);
  assert.equal(path.dirname(failure.directory), await realpath(checkoutRoot));
  assert.deepEqual(await readdir(failure.directory), []);
  assert.equal((await readdir(checkoutRoot)).length, 1);
});

test("clone setup failures do not follow a configured checkout-root symlink", async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  const checkoutRoot = path.join(root, "linked-checkouts");
  await symlink(outside, checkoutRoot);
  const api = createNativeProjects({
    checkoutRoot,
    run: async () => {
      assert.fail("must not clone");
    },
  });
  await assert.rejects(
    api.cloneRepository({ repository: "owner/repo" }),
    rejects(503, /regular directory/),
  );
  assert.deepEqual(await readdir(outside), []);
});

test("clone chooses a conventional site tree before checking out unrelated blobs", async (t) => {
  const checkoutRoot = path.join(await fixture(t), "checkouts");
  const calls = [];
  const api = createNativeProjects({
    checkoutRoot,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes("ls-tree")) {
        const tree = args.at(-1);
        if (tree === "HEAD")
          return { stdout: "README.md\0benchmarks\0website\0" };
        if (tree === "HEAD:website/public") throw { code: 128 };
        if (tree === "HEAD:website/dist")
          return { stdout: "index.html\0styles.css\0" };
        assert.fail(`unexpected tree ${tree}`);
      }
      return { stdout: "" };
    },
  });
  const result = await api.cloneRepository({ repository: "owner/repo" });
  assert.equal(result.siteDirectory, "website/dist");
  const operations = calls.map((call) => call.args.slice(2));
  assert.deepEqual(operations.slice(-3), [
    ["sparse-checkout", "init", "--cone"],
    ["sparse-checkout", "set", "--cone", "--", "website/dist"],
    ["checkout"],
  ]);
  assert.ok(calls[0].args.includes("--no-checkout"));
});

test("a root HTML site uses a normal checkout without subtree probes", async (t) => {
  const calls = [];
  const api = createNativeProjects({
    checkoutRoot: path.join(await fixture(t), "checkouts"),
    run: async (_file, args) => {
      calls.push(args);
      return { stdout: args.includes("ls-tree") ? "index.html\0assets\0" : "" };
    },
  });
  const result = await api.cloneRepository({ repository: "owner/repo" });
  assert.equal(result.siteDirectory, undefined);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1), ["-C", result.directory, "checkout"]);
});

test("sparse clone keeps a normal upstream and omits unrelated working files with real Git", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const root = await fixture(t);
  const source = path.join(root, "source");
  await mkdir(source);
  const git = async (...args) => execute("git", ["-C", source, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Pagecraft test");
  await git("config", "user.email", "pagecraft@example.invalid");
  await mkdir(path.join(source, "website", "dist"), { recursive: true });
  await mkdir(path.join(source, "benchmarks"));
  await writeFile(
    path.join(source, "website", "dist", "index.html"),
    "<h1>Site</h1>",
  );
  await writeFile(
    path.join(source, "benchmarks", "large.txt"),
    "unrelated fixture",
  );
  await writeFile(path.join(source, "README.md"), "source fixture");
  await git("add", ".");
  await git("-c", "commit.gpgsign=false", "commit", "-m", "Initial fixture");
  const api = createNativeProjects({
    checkoutRoot: path.join(root, "checkouts"),
    run: async (file, args, options) => {
      const actual = [...args];
      if (actual[0] === "clone") actual[actual.length - 2] = source;
      return execute(file, actual, { ...options, encoding: "utf8" });
    },
  });
  const result = await api.cloneRepository({ repository: "owner/repo" });
  assert.equal(result.siteDirectory, "website/dist");
  assert.equal(
    await readFile(
      path.join(result.directory, "website", "dist", "index.html"),
      "utf8",
    ),
    "<h1>Site</h1>",
  );
  await assert.rejects(
    readFile(path.join(result.directory, "benchmarks", "large.txt")),
    { code: "ENOENT" },
  );
  const upstream = await execute("git", [
    "-C",
    result.directory,
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  assert.equal(upstream.stdout.trim(), "origin/main");
});

test("a site-tree inspection timeout stops before a full checkout", async (t) => {
  const calls = [];
  const api = createNativeProjects({
    checkoutRoot: path.join(await fixture(t), "checkouts"),
    run: async (_file, args) => {
      calls.push(args);
      if (args.includes("ls-tree")) {
        if (args.at(-1) === "HEAD") return { stdout: "website\0benchmarks\0" };
        throw { killed: true };
      }
      return { stdout: "" };
    },
  });
  await assert.rejects(
    api.cloneRepository({ repository: "owner/repo" }),
    rejects(408, /timed out/),
  );
  assert.equal(
    calls.some((args) => args.at(-1) === "checkout"),
    false,
  );
});
