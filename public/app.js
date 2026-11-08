import { Editor } from "./editor.js";
import {
  importFiles,
  downloadProject,
  normalizePath,
  isTextPath,
} from "./files.js";
import { sampleFiles } from "./sample.js";

const $ = (selector) => document.querySelector(selector);
const paths = {
  "chevron-down": "m6 9 6 6 6-6",
  folder: "M3 7h6l2-3h10v16H3z",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  upload: "M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5",
  "git-branch":
    "M6 3v12a4 4 0 0 0 4 4h5M18 7v5a4 4 0 0 1-4 4H6M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0m12 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0m-2 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
  plus: "M12 5v14M5 12h14",
  github:
    "M9 19c-5 2-5-2-7-2m14 5v-4c0-1-1-2-1-2 4 0 6-2 6-6 0-2-1-3-2-4 0-1 0-3-1-4-2 0-4 2-4 2a14 14 0 0 0-6 0S6 2 4 2C3 3 3 5 4 6 3 7 2 8 2 10c0 4 2 6 6 6 0 0-1 1-1 2v4",
  "arrow-up-right": "M6 18 18 6M6 6h12v12",
  cursor: "m4 3 16 10-8 1-4 7z",
  code: "m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 20",
  monitor: "M3 3h18v13H3zM8 21h8m-4-5v5",
  tablet: "M5 2h14v20H5zM11 18h2",
  smartphone: "M7 2h10v20H7zM11 18h2",
  undo: "M3 9h12a6 6 0 0 1 0 12M3 9l5-5M3 9l5 5",
  redo: "M21 9H9a6 6 0 0 0 0 12m12-12-5-5m5 5-5 5",
  lock: "M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4",
  mouse: "M8 2h8v12a4 4 0 0 1-8 0zM12 2v6m-4 0h8",
  shield: "m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6zM8 12l3 3 5-6",
  copy: "M8 8h13v13H8zM16 8V3H3v13h5",
  trash: "M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
  sparkle: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  file: "M5 2h9l5 5v15H5zM14 2v6h5",
  layers: "m12 3 10 6-10 6L2 9zM2 13l10 6 10-6M2 17l10 6 10-6",
  close: "m6 6 12 12M6 18 18 6",
  heading: "M5 4v16M19 4v16M5 12h14",
  text: "M4 4h16M12 4v17M8 21h8",
  button: "M2 6h20v12H2zM8 12h8",
  section: "M3 3h18v18H3zM3 9h18",
  image: "M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M15 7h1",
  check: "m5 12 4 4L19 6",
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
function icons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
}
icons();
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let project = {
  name: "Forma Studio",
  files: structuredClone(sampleFiles),
  baseline: structuredClone(sampleFiles),
  remote: null,
  current: "index.html",
};
let selection = null,
  view = "visual",
  history = [],
  future = [],
  sourceDirty = false,
  session = null,
  toastTimer,
  saveTimer,
  db;
let saving = Promise.resolve(),
  persistVersion = 0,
  busy = false;
const editor = new Editor({
  iframe: $("#preview"),
  onChange: (html) => recordChange(project.current, html),
  onSelect: showSelection,
  onReady: renderOutline,
});

function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 7000 : 3600);
}
function currentFile() {
  return project.files.find((f) => f.path === project.current);
}
function changedFiles() {
  return project.files.filter((file) => {
    const original = project.baseline.find((f) => f.path === file.path);
    return (
      !original ||
      file.content !== original.content ||
      file.encoding !== original.encoding
    );
  });
}
function updateHeader() {
  const changes = changedFiles();
  $("#project-name").textContent = project.name;
  $("#change-count").textContent = changes.length
    ? `${changes.length} ${changes.length === 1 ? "change" : "changes"}`
    : "No changes";
  $("#connection-label").textContent = project.remote
    ? `${project.remote.repository.split("/").at(-1)} · ${project.remote.branch}`
    : "Connect a repository";
  $("#undo-button").disabled = !history.length;
  $("#redo-button").disabled = !future.length;
}
function renderFiles() {
  const files = project.files
    .filter(
      (f) =>
        /\.html?$/i.test(f.path) ||
        (f.encoding === "utf8" && /\.(css|js|json|svg)$/i.test(f.path)),
    )
    .sort(
      (a, b) =>
        Number(!/\.html?$/i.test(a.path)) - Number(!/\.html?$/i.test(b.path)) ||
        a.path.localeCompare(b.path),
    );
  const changed = new Set(changedFiles().map((f) => f.path));
  $("#file-list").innerHTML = files
    .map(
      (f) =>
        `<button class="file-button ${project.current === f.path ? "active" : ""}" data-path="${escape(f.path)}" title="${escape(f.path)}">${icon(/\.html?$/i.test(f.path) ? "file" : "code")}<span>${escape(f.path)}</span>${changed.has(f.path) ? '<span class="file-dirty">·</span>' : ""}</button>`,
    )
    .join("");
  $("#file-list")
    .querySelectorAll("button")
    .forEach(
      (button) => (button.onclick = () => openFile(button.dataset.path)),
    );
}
function renderOutline() {
  if (!/\.html?$/i.test(project.current)) {
    $("#outline").innerHTML =
      '<p class="help-text" style="padding:0 10px">Choose an HTML page to explore its layers.</p>';
    return;
  }
  $("#outline").innerHTML = editor
    .getOutline()
    .map(
      (item) =>
        `<button class="layer ${item.id === editor.selectedId ? "active" : ""}" data-node="${item.id}" style="padding-left:${8 + Math.min(item.depth, 5) * 10}px" title="${escape(item.label)}">${icon(["section", "main", "header", "footer", "nav", "div"].includes(item.tag) ? "layers" : /^h\d$/.test(item.tag) ? "heading" : item.tag === "img" ? "image" : "text")}<span class="layer-label">${escape(item.label)}</span><span class="layer-tag">${escape(item.tag)}</span></button>`,
    )
    .join("");
  $("#outline")
    .querySelectorAll("button")
    .forEach(
      (button) => (button.onclick = () => editor.select(button.dataset.node)),
    );
}
function showSelection(value) {
  selection = value;
  $("#empty-inspector").hidden = !!value || view === "code";
  $("#element-properties").hidden = !value || view === "code";
  $("#code-inspector").hidden = view !== "code";
  if (!value) return;
  $("#selected-tag").textContent = value.tag;
  $("#selected-name").textContent = value.parentPath || "Selected element";
  const active = document.activeElement?.id;
  const set = (id, val) => {
    if (active !== id) $("#" + id).value = val ?? "";
  };
  set("element-text", value.text);
  set("element-href", value.href);
  set("element-src", value.src);
  set("element-alt", value.alt);
  $("#text-field").hidden = !value.editable;
  $("#element-text").title = value.hasChildren
    ? "Replacing this text removes its inline formatting. Double-click on the canvas to keep formatting."
    : "Edit plain text";
  $("#href-field").hidden = value.tag !== "a";
  $("#src-field").hidden = value.tag !== "img";
  $("#alt-field").hidden = value.tag !== "img";
  set("font-size", parseFloat(value.styles.fontSize) || "");
  const weightSelect = $("#font-weight");
  weightSelect.querySelector("[data-current]")?.remove();
  const currentWeight = value.styles.fontWeight || "400";
  if (
    ![...weightSelect.options].some((option) => option.value === currentWeight)
  ) {
    const option = new Option(`${currentWeight} (current)`, currentWeight);
    option.dataset.current = "true";
    weightSelect.add(option);
  }
  set("font-weight", currentWeight);
  set(
    "font-family",
    [...$("#font-family").options].some(
      (o) => o.value === value.styles.fontFamily,
    )
      ? value.styles.fontFamily
      : "",
  );
  set(
    "text-align",
    ["left", "center", "right", "justify"].includes(value.styles.textAlign)
      ? value.styles.textAlign
      : "left",
  );
  set("element-padding", parseFloat(value.styles.padding) || 0);
  set("border-radius", parseFloat(value.styles.borderRadius) || 0);
  const color = hexColor(value.styles.color, "#393b2e"),
    background = hexColor(value.styles.backgroundColor, "#ffffff");
  set("text-color", color);
  set("background-color", background);
  $("#text-color-value").textContent = color.toUpperCase();
  $("#background-value").textContent =
    /^(transparent|rgba\([^)]*[,/]\s*0\s*\))$/.test(
      value.styles.backgroundColor,
    )
      ? "Transparent"
      : background.toUpperCase();
  $("#outline")
    .querySelectorAll("button")
    .forEach((b) => b.classList.toggle("active", b.dataset.node === value.id));
}
function hexColor(value, fallback) {
  if (/^#[\da-f]{6}$/i.test(value)) return value;
  const rgb = value?.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
  return rgb
    ? "#" +
        rgb
          .slice(1, 4)
          .map((n) => Number(n).toString(16).padStart(2, "0"))
          .join("")
    : fallback;
}
function recordChange(path, content) {
  const file = project.files.find((f) => f.path === path);
  if (!file || file.content === content) return;
  const last = history.at(-1),
    now = Date.now();
  if (last && last.path === path && now - last.time < 550) {
    last.after = content;
    last.time = now;
  } else {
    history.push({ path, before: file.content, after: content, time: now });
    if (history.length > 80) history.shift();
  }
  future = [];
  file.content = content;
  updateHeader();
  renderFiles();
  renderOutline();
  scheduleSave();
}
function applySource() {
  if (!sourceDirty) return;
  recordChange(project.current, $("#source-code").value);
  sourceDirty = false;
  if (/\.html?$/i.test(project.current))
    editor.load(currentFile().content, {
      path: project.current,
      files: project.files,
    });
}
function openFile(path) {
  applySource();
  project.current = path;
  const file = currentFile();
  if (!file) return;
  showSelection(null);
  $("#page-path").textContent = path;
  $("#code-filename").textContent = path;
  $("#source-code").value = file.content;
  sourceDirty = false;
  if (/\.html?$/i.test(path)) {
    editor.load(file.content, { path, files: project.files });
  } else {
    setView("code");
  }
  renderFiles();
  renderOutline();
  updateHeader();
  scheduleSave();
}
function setView(next) {
  applySource();
  if (next === "visual" && !/\.html?$/i.test(project.current)) {
    const page = project.files.find((f) => /\.html?$/i.test(f.path));
    if (page) openFile(page.path);
  }
  view = next;
  $("#visual-tab").classList.toggle("active", next === "visual");
  $("#code-tab").classList.toggle("active", next === "code");
  $("#canvas-window").hidden = next === "code";
  $("#code-panel").hidden = next !== "code";
  if (next === "code") $("#source-code").value = currentFile()?.content || "";
  showSelection(selection);
}
function restore(entry, reverse) {
  const file = project.files.find((f) => f.path === entry.path);
  if (!file) return;
  file.content = reverse ? entry.before : entry.after;
  openFile(entry.path);
  updateHeader();
  scheduleSave();
}
function undo() {
  applySource();
  const entry = history.pop();
  if (entry) {
    future.push(entry);
    restore(entry, true);
  }
}
function redo() {
  applySource();
  const entry = future.pop();
  if (entry) {
    history.push(entry);
    restore(entry, false);
  }
}

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pagecraft", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function scheduleSave() {
  $("#save-status").innerHTML = "<i></i> Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}
function persist() {
  const snapshot = structuredClone(project),
    version = ++persistVersion;
  saving = saving
    .catch(() => {})
    .then(async () => {
      if (!db) throw Error("Storage unavailable");
      await new Promise((resolve, reject) => {
        const tx = db.transaction("workspace", "readwrite");
        tx.objectStore("workspace").put(snapshot, "current");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      if (version === persistVersion)
        $("#save-status").innerHTML = "<i></i> Saved locally";
    })
    .catch(() => {
      $("#save-status").textContent = "Export to keep your edits";
    });
}
async function loadSaved() {
  try {
    db = await openDatabase();
    const saved = await new Promise((resolve, reject) => {
      const request = db
        .transaction("workspace")
        .objectStore("workspace")
        .get("current");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (
      saved?.files?.length &&
      saved.baseline &&
      saved.files.some((f) => /\.html?$/i.test(f.path))
    )
      project = saved;
  } catch {
    toast(
      "Local autosave is unavailable. Export your project to keep your edits.",
      true,
    );
  }
}

function modal(body) {
  $("#modal-content").innerHTML = `<div class="modal-body">${body}</div>`;
  icons($("#modal"));
  $("#modal-content")
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = () => $("#modal").close()));
  if (!$("#modal").open) $("#modal").showModal();
}
const modalHeading = (title) =>
  `<div class="modal-heading"><h2>${title}</h2><button class="icon-button" data-close aria-label="Close dialog">${icon("close")}</button></div>`;
function modalError(message) {
  let el = $("#modal-error");
  if (!el) {
    el = document.createElement("div");
    el.id = "modal-error";
    el.className = "inline-error";
    $("#modal-content .modal-body").append(el);
  }
  el.textContent = message;
}
async function api(endpoint, body) {
  if (!session) session = await fetch("/api/session").then((r) => r.json());
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pagecraft-token": session.token,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(result.error || "The request could not be completed.");
  return result;
}
function openModal(tab = "files", connect = false) {
  applySource();
  if (busy) return;
  modal(
    `${modalHeading("A fresh starting point.")}<p class="modal-description">${connect ? "Choose a GitHub repository as the destination for this site. Your current files and edits stay in the editor." : "Bring in a site, then make it your own. Opening replaces this local workspace. Export any edits you want to keep."}</p><div class="modal-tabs"><button class="button small ${tab === "files" ? "active" : ""}" data-tab="files">Local files</button><button class="button small ${tab === "paste" ? "active" : ""}" data-tab="paste">Paste HTML</button><button class="button small ${tab === "github" ? "active" : ""}" data-tab="github">GitHub</button></div><div id="open-content"></div>`,
  );
  $("#modal")
    .querySelectorAll("[data-tab]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          openModal(b.dataset.tab, connect && b.dataset.tab === "github")),
    );
  if (tab === "files") {
    $("#open-content").innerHTML =
      `<button id="choose-folder" class="dropzone" style="width:100%">${icon("folder")}<strong>Open a site folder</strong><p>HTML, CSS, images, and fonts. Up to 300 site files / 20 MB.</p></button><div class="open-alternatives"><button class="button" id="choose-html">Open an HTML file</button><button class="button" id="load-example">Try the example site</button></div><p class="help-text">Choose a static site folder. Select the built output for React or Next.js projects. Original local files stay untouched; export the edited project when you’re ready.</p>`;
    $("#choose-folder").onclick = () => $("#folder-input").click();
    $("#choose-html").onclick = () => $("#html-input").click();
    $("#load-example").onclick = () =>
      setProject(structuredClone(sampleFiles), "Forma Studio");
  } else if (tab === "paste") {
    $("#open-content").innerHTML =
      `<label>Page name<input id="paste-name" value="index.html"></label><label>Your HTML<textarea id="paste-html" class="paste-area" spellcheck="false" placeholder="Paste the HTML from ChatGPT here…"></textarea></label><div class="modal-actions"><button class="button" data-cancel>Cancel</button><button class="button primary" id="import-paste">Open in editor</button></div>`;
    $("#import-paste").onclick = () => {
      try {
        const path = normalizePath($("#paste-name").value.trim());
        if (!/\.html?$/i.test(path))
          throw Error("Choose a filename ending in .html.");
        const html = $("#paste-html").value;
        if (!html.trim()) throw Error("Paste some HTML first.");
        if (new TextEncoder().encode(html).length > 20 * 1024 * 1024)
          throw Error("HTML must be smaller than 20 MB.");
        setProject(
          [{ path, content: html, encoding: "utf8" }],
          path.replace(/\.html?$/i, ""),
        );
      } catch (e) {
        modalError(e.message);
      }
    };
    $("#open-content [data-cancel]").onclick = () => $("#modal").close();
  } else {
    $("#open-content").innerHTML =
      `<label>Repository<input id="repository-input" placeholder="owner/repository" value="${escape(project.remote?.repository || "")}" autocomplete="off"></label><label>Site folder <span class="small-label">(optional)</span><input id="directory-input" placeholder="e.g. website/public" value="${escape(project.remote?.directory || "")}"></label><label>Branch <span class="small-label">(optional)</span><input id="branch-input" placeholder="Repository default branch" value="${escape(project.remote?.branch || "")}"></label><p class="help-text">Stark: <code>website/public</code> · Planetable: <code>website/dist</code>. Leave blank for a site at the repository root. Edit script-generated content in Code view.</p><p class="help-text" id="github-status">Checking your GitHub connection…</p><div class="modal-actions"><button class="button" data-cancel>Cancel</button><button class="button primary" id="load-repository">${connect ? "Connect this site" : "Open repository"}</button></div>`;
    $("#open-content [data-cancel]").onclick = () => $("#modal").close();
    fetch("/api/session")
      .then((r) => r.json())
      .then((result) => {
        session = result;
        if ($("#github-status"))
          $("#github-status").textContent = result.github.connected
            ? `Connected as ${result.github.login} through GitHub CLI.`
            : result.github.error;
      })
      .catch(() => {
        if ($("#github-status"))
          $("#github-status").textContent =
            "Start Pagecraft with npm start to connect GitHub.";
      });
    $("#load-repository").onclick = async () => {
      const button = $("#load-repository");
      button.disabled = true;
      button.textContent = "Opening…";
      busy = true;
      try {
        const result = await api("/api/github/open", {
          repository: $("#repository-input")
            .value.trim()
            .replace(/^https:\/\/github.com\//, "")
            .replace(/\.git$/, ""),
          branch: $("#branch-input").value.trim() || undefined,
          directory: $("#directory-input").value.trim(),
        });
        const remote = {
          repository: result.repository,
          branch: result.branch,
          baseCommit: result.baseCommit,
          directory: result.directory || "",
        };
        if (connect) {
          project.remote = remote;
          project.baseline = structuredClone(result.files);
          updateHeader();
          renderFiles();
          persist();
          busy = false;
          showChanges(true);
        } else {
          setProject(result.files, result.repository.split("/").at(-1), remote);
          toast(`Opened ${result.repository} on ${result.branch}.`);
        }
      } catch (e) {
        modalError(e.message);
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = "Open repository";
      }
    };
  }
}
function setProject(files, name, remote = null) {
  if (!files.some((f) => /\.html?$/i.test(f.path)))
    throw Error(
      "No HTML files were found. Choose a static site folder containing an .html page.",
    );
  project = {
    name,
    files,
    baseline: structuredClone(files),
    remote,
    current:
      files.find((f) => f.path === "index.html")?.path ||
      files.find((f) => /\.html?$/i.test(f.path)).path,
  };
  history = [];
  future = [];
  sourceDirty = false;
  view = "visual";
  setView("visual");
  openFile(project.current);
  $("#modal").close();
  persist();
}
async function handleImport(event) {
  try {
    const files = await importFiles(event.target.files);
    setProject(
      files,
      event.target.files[0]?.webkitRelativePath?.split("/")[0] ||
        event.target.files[0]?.name?.replace(/\.html?$/i, "") ||
        "My site",
    );
    toast(`Opened ${files.length} site files.`);
  } catch (e) {
    modalError(e.message);
  } finally {
    event.target.value = "";
  }
}

function showChanges(push = false) {
  applySource();
  if (busy) return;
  const changes = changedFiles();
  if (push && !project.remote) {
    openModal("github", true);
    return;
  }
  modal(
    `${modalHeading(push ? "Ready when you are." : "Your changes, at a glance.")}<p class="modal-description">${push ? `Push ${changes.length} changed ${changes.length === 1 ? "file" : "files"} to <strong>${escape(project.remote.repository)}</strong> on <strong>${escape(project.remote.branch)}</strong>${project.remote.directory ? ` in <strong>${escape(project.remote.directory)}</strong>` : ""}.` : "Review the edits made since opening this site."}</p>${changes.length ? `<div class="change-list">${changes.map((f) => `<div class="change-row"><span>${escape(f.path)}</span><small>${project.baseline.some((o) => o.path === f.path) ? "modified" : "new file"}</small></div>`).join("")}</div>` : '<div class="review-note">Your site is up to date. Make an edit on the canvas to get started.</div>'}${push ? `<label>Commit message<input id="commit-message" value="Update site with Pagecraft" maxlength="2000"></label><div class="review-note">This creates a commit on the selected branch. Connected hosting may deploy it automatically. Stark and Planetable require their separate Sites deployment step. Pagecraft never forces an update over someone else’s changes.</div><div class="modal-actions"><button class="button" data-cancel>Keep editing</button><button id="confirm-push" class="button primary" ${changes.length ? "" : "disabled"}>${icon("upload")} Push ${changes.length} ${changes.length === 1 ? "file" : "files"}</button></div>` : changes.length ? `<select id="diff-select" class="diff-select" aria-label="File to review">${changes.map((f) => `<option value="${escape(f.path)}">${escape(f.path)}</option>`).join("")}</select><div class="diff" id="file-diff"></div><div class="modal-actions"><button class="button" id="review-export">Export ZIP</button><button class="button primary" id="review-push">Push to GitHub</button></div>` : ""}`,
  );
  if (push) {
    $("#modal-content [data-cancel]").onclick = () => $("#modal").close();
    $("#confirm-push").onclick = pushChanges;
  } else if (changes.length) {
    $("#diff-select").onchange = () => showDiff($("#diff-select").value);
    showDiff(changes[0].path);
    $("#review-export").onclick = () => downloadProject(project.files);
    $("#review-push").onclick = () => showChanges(true);
  }
}
function showDiff(path) {
  const file = project.files.find((f) => f.path === path),
    before = project.baseline.find((f) => f.path === path);
  if (file.encoding === "base64") {
    $("#file-diff").textContent = "Binary asset changed.";
    return;
  }
  const old = before?.content.split("\n") || [],
    next = file.content.split("\n");
  let prefix = 0;
  while (
    prefix < old.length &&
    prefix < next.length &&
    old[prefix] === next[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const removed = old.slice(prefix, old.length - suffix),
    added = next.slice(prefix, next.length - suffix);
  $("#file-diff").innerHTML = old
    .slice(Math.max(0, prefix - 2), prefix)
    .map((l) => "  " + escape(l))
    .concat(
      removed
        .slice(0, 150)
        .map((l) => `<span class="removed">− ${escape(l)}</span>`),
      added
        .slice(0, 150)
        .map((l) => `<span class="added">+ ${escape(l)}</span>`),
      next
        .slice(next.length - suffix, next.length - suffix + 2)
        .map((l) => "  " + escape(l)),
    )
    .join("\n");
  if (removed.length > 150 || added.length > 150)
    $("#file-diff").append(
      document.createTextNode(
        "\n… Display limited to 150 changed lines per side. Export to inspect the full source.",
      ),
    );
}
async function pushChanges() {
  const button = $("#confirm-push");
  button.disabled = true;
  button.textContent = "Pushing…";
  busy = true;
  const sent = structuredClone(project.files),
    sentChanges = structuredClone(changedFiles());
  try {
    const result = await api("/api/github/push", {
      ...project.remote,
      files: sentChanges,
      message: $("#commit-message").value,
    });
    project.remote.baseCommit = result.commit;
    project.baseline = sent;
    updateHeader();
    renderFiles();
    persist();
    modal(
      `${modalHeading("A little more you. Now on GitHub.")}<p class="modal-description">Pushed ${sentChanges.length} ${sentChanges.length === 1 ? "file" : "files"} to ${escape(result.repository)} on ${escape(result.branch)}.</p><div class="review-note">The commit is saved on GitHub. Your hosting provider controls when the live site updates.</div><a class="success-link" href="${escape(result.url)}" target="_blank" rel="noopener noreferrer">View commit ${escape(result.commit.slice(0, 7))} ↗</a><div class="modal-actions"><button class="button primary" data-close>Back to editing</button></div>`,
    );
    toast("Changes pushed to GitHub.");
  } catch (e) {
    modalError(e.message);
    button.disabled = false;
    button.innerHTML = icon("upload") + " Try again";
  } finally {
    busy = false;
  }
}

$("#open-button").onclick = () => openModal();
$("#project-button").onclick = () => openModal();
$("#connection-button").onclick = () => openModal("github", !project.remote);
$("#folder-input").onchange = handleImport;
$("#html-input").onchange = handleImport;
$("#download-button").onclick = () => {
  applySource();
  try {
    downloadProject(project.files);
    toast("Project exported as site.zip.");
  } catch (e) {
    toast(e.message, true);
  }
};
$("#changes-button").onclick = () => showChanges();
$("#push-button").onclick = () => showChanges(true);
$("#visual-tab").onclick = () => setView("visual");
$("#code-tab").onclick = () => setView("code");
$("#undo-button").onclick = undo;
$("#redo-button").onclick = redo;
$("#source-code").oninput = () => {
  sourceDirty = true;
  $("#save-status").textContent = "Code not applied";
};
$("#source-code").onkeydown = (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const el = event.target;
    el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
    sourceDirty = true;
  }
};
$("#apply-code-button").onclick = () => {
  applySource();
  toast("Source changes applied.");
};
$("#modal").addEventListener("click", (event) => {
  if (event.target === $("#modal") && !busy) $("#modal").close();
});
$("#modal").addEventListener("cancel", (event) => {
  if (busy) event.preventDefault();
});
$("#new-page-button").onclick = () => {
  modal(
    `${modalHeading("Room for a new page.")}<label>Filename<input id="new-filename" value="about.html"></label><p class="help-text">Add a blank HTML page to this project.</p><div class="modal-actions"><button class="button" data-close>Cancel</button><button class="button primary" id="create-page">Create page</button></div>`,
  );
  $("#create-page").onclick = () => {
    try {
      applySource();
      const path = normalizePath($("#new-filename").value.trim());
      if (
        !/\.html?$/i.test(path) ||
        path.split("/").some((p) => p.startsWith("."))
      )
        throw Error("Use a filename ending in .html without hidden folders.");
      if (project.files.some((f) => f.path === path))
        throw Error("That file already exists.");
      if (project.files.length >= 300)
        throw Error("The project has reached the 300 file limit.");
      const content =
        '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>A new page</title><style>body{font-family:system-ui,sans-serif;padding:64px;max-width:900px;margin:auto;color:#34343b}h1{font-size:48px}</style></head><body><h1>A fresh page.</h1><p>Double-click to make it yours.</p></body></html>';
      project.files.push({ path, content, encoding: "utf8" });
      openFile(path);
      setView("visual");
      persist();
      $("#modal").close();
    } catch (e) {
      modalError(e.message);
    }
  };
};
$("#insert-button").onclick = () => {
  if (view === "code") setView("visual");
  modal(
    `${modalHeading("Make room for something good.")}<p class="modal-description">Add a block after the selected element, or at the end of the page.</p><div class="insert-grid">${[
      ["heading", "Heading", "Make a statement"],
      ["text", "Paragraph", "Tell your story"],
      ["button", "Button link", "A next step"],
      ["section", "Section", "A little more space"],
      ["image", "Image", "Set a source in Design"],
    ]
      .map(
        ([type, label, description]) =>
          `<button class="insert-card" data-insert="${type}">${icon(type)}<span><strong>${label}</strong><small>${description}</small></span></button>`,
      )
      .join("")}</div>`,
  );
  $("#modal")
    .querySelectorAll("[data-insert]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          editor.insertBlock(b.dataset.insert);
          $("#modal").close();
        }),
    );
};
for (const [id, key] of [
  ["element-text", "text"],
  ["element-href", "href"],
  ["element-src", "src"],
  ["element-alt", "alt"],
])
  $("#" + id).onchange = (event) =>
    editor.updateSelected({ [key]: event.target.value });
for (const [id, key, unit] of [
  ["font-size", "fontSize", "px"],
  ["font-family", "fontFamily", ""],
  ["font-weight", "fontWeight", ""],
  ["text-align", "textAlign", ""],
  ["text-color", "color", ""],
  ["background-color", "backgroundColor", ""],
  ["element-padding", "padding", "px"],
  ["border-radius", "borderRadius", "px"],
])
  $("#" + id).onchange = (event) =>
    editor.updateSelected({
      styles: { [key]: event.target.value ? event.target.value + unit : "" },
    });
$("#clear-background").onclick = () =>
  editor.updateSelected({ styles: { backgroundColor: "" } });
$("#duplicate-button").onclick = () => editor.duplicateSelected();
$("#delete-button").onclick = () => editor.deleteSelected();
document.querySelectorAll("[data-device]").forEach(
  (button) =>
    (button.onclick = () => {
      const device = button.dataset.device;
      document
        .querySelectorAll("[data-device]")
        .forEach((b) => b.classList.toggle("active", b === button));
      $("#canvas-window").style.width =
        device === "mobile" ? "375px" : device === "tablet" ? "768px" : "100%";
      $("#viewport-label").textContent =
        device === "desktop"
          ? "Desktop · responsive"
          : device === "tablet"
            ? "Tablet · 768 px"
            : "Mobile · 375 px";
    }),
);
document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(
    document.activeElement?.tagName,
  );
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    applySource();
    persist();
    toast("Saved on this device.");
  }
  if (
    !typing &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "z"
  ) {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (sourceDirty || busy) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    applySource();
    clearTimeout(saveTimer);
    persist();
  }
});
await loadSaved();
openFile(project.current);
updateHeader();
