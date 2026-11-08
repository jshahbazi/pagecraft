import { Editor } from "./editor.js";
import { downloadProject, normalizePath } from "./files.js";
import { createApiClient } from "./api-client.js";
import { sameFile, reconcileLocalWorkspace } from "./workspace-state.js";

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
  save: "M4 3h13l4 4v14H3V3zM7 3v6h10V3M7 21v-8h10v8",
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
  name: "No site open",
  files: [],
  baseline: [],
  remote: null,
  local: null,
  current: null,
};
let cachedProject = null;
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
const apiClient = createApiClient({ onRenew: renewDirectoryGrant });
const editor = new Editor({
  iframe: $("#preview"),
  onChange: (html) => recordChange(project.current, html),
  onSelect: showSelection,
  onReady: renderOutline,
  onUndo: undo,
  onRedo: redo,
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
function unsavedFiles() {
  if (!project.local) return [];
  return project.files.filter(
    (file) =>
      !sameFile(
        file,
        project.local.diskBaseline.find((old) => old.path === file.path),
      ),
  );
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
  const active = project.files.length > 0;
  $("#empty-workspace").hidden = active;
  $("#save-status").hidden = !active;
  $("#canvas-window").hidden = !active || view === "code";
  $("#code-panel").hidden = !active || view !== "code";
  $(".canvas-label").hidden = !active;
  $(".canvas-hint").hidden = !active;
  for (const id of [
    "download-button",
    "changes-button",
    "push-button",
    "new-page-button",
    "insert-button",
    "visual-tab",
    "code-tab",
  ])
    $("#" + id).disabled = !active;
  $("#connection-button").hidden = !active;
  const changes = changedFiles();
  $("#project-name").textContent = project.name;
  $("#change-count").textContent = changes.length
    ? `${changes.length} ${changes.length === 1 ? "change" : "changes"}`
    : "No changes";
  $("#connection-label").textContent = project.local
    ? `Local directory${project.local.git?.branch ? ` · ${project.local.git.branch}` : ""}`
    : project.remote
      ? `${project.remote.repository.split("/").at(-1)} · ${project.remote.branch}`
      : "Connect a repository";
  $("#connection-button").title =
    project.local?.directory || "Connect a repository";
  $("#save-files-button").hidden = !project.local;
  $("#save-files-button").disabled = busy || !unsavedFiles().length;
  $("#push-button").innerHTML =
    icon("upload") + (project.local ? " Commit & push" : " Push to GitHub");
  $("#footer-message").textContent = project.local
    ? `Editing ${project.local.directory}`
    : project.files.length
      ? "All changes stay on this device until you push."
      : "Open a directory or clone a repository to begin.";
  $("#footer-message").title = project.local?.directory || "";
  refreshSaveStatus();
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
  if (!path) return;
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
  if (!project.files.length) return;
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
  refreshSaveStatus("Saving browser backup…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}
function persist() {
  if (!project.files.length) return;
  const snapshot = structuredClone(project),
    version = ++persistVersion;
  saving = saving
    .catch(() => {})
    .then(async () => {
      if (!db) throw Error("Storage unavailable");
      await new Promise((resolve, reject) => {
        const tx = db.transaction("workspace", "readwrite");
        tx.objectStore("workspace").put(snapshot, "current");
        if (snapshot.local?.directory)
          tx.objectStore("workspace").put(
            snapshot,
            "directory:" + snapshot.local.directory,
          );
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      if (version === persistVersion) refreshSaveStatus();
    })
    .catch(() => {
      refreshSaveStatus("Browser backup unavailable");
    });
}
function refreshSaveStatus(backupStatus = "Browser backup saved") {
  const el = $("#save-status");
  el.replaceChildren();
  const dot = document.createElement("i");
  el.append(
    dot,
    document.createTextNode(
      project.local
        ? !project.local.workspaceId
          ? "Reconnect directory"
          : unsavedFiles().length
            ? `${unsavedFiles().length} unsaved ${unsavedFiles().length === 1 ? "file" : "files"}`
            : "Saved to files"
        : backupStatus,
    ),
  );
  el.title = project.local
    ? "Browser backup and saving to your original files are separate."
    : "A browser backup does not modify original files.";
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
    ) {
      cachedProject = saved;
      // Preserve pre-update single-workspace drafts without opening a site.
      if (saved.local?.directory)
        await new Promise((resolve, reject) => {
          const tx = db.transaction("workspace", "readwrite");
          const store = tx.objectStore("workspace"),
            key = "directory:" + saved.local.directory;
          const check = store.get(key);
          check.onsuccess = () => {
            if (!check.result) store.put(saved, key);
          };
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
    }
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
    .forEach(
      (b) =>
        (b.onclick = () => {
          if (!busy) $("#modal").close();
        }),
    );
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
async function renewDirectoryGrant({ endpoint, body, newSession }) {
  session = newSession;
  if (
    !/^\/api\/local\/(save|push)$/.test(endpoint) ||
    !project.local ||
    body.workspaceId !== project.local.workspaceId ||
    (project.local.workspaceId &&
      project.local.serverId === newSession.instanceId)
  )
    return body;
  try {
    if (project.local.pendingPush)
      throw Error(
        "The server restarted while a saved commit was waiting to push. That commit is still in your checkout. Finish or reconcile it in Git, then reopen the directory.",
      );
    const opened = await apiClient.request("/api/local/open", {
      directory: project.local.directory,
    });
    applySource();
    hydrateWorkspace(
      reconcileLocalWorkspace(project, opened, newSession.instanceId),
    );
    persist();
    return { ...body, workspaceId: opened.workspaceId };
  } catch (error) {
    project.local.workspaceId = null;
    updateHeader();
    persist();
    throw error;
  }
}
async function api(endpoint, body) {
  try {
    session = await apiClient.getSession();
    const prepared = await renewDirectoryGrant({
      endpoint,
      body,
      newSession: session,
    });
    return await apiClient.request(endpoint, prepared);
  } finally {
    session = apiClient.currentSession;
  }
}
function hydrateWorkspace(next, { resetView = false } = {}) {
  const desiredView = resetView ? "visual" : view;
  project = next;
  history = [];
  future = [];
  sourceDirty = false;
  selection = null;
  showSelection(null);
  if (project.current) {
    openFile(project.current);
    setView(desiredView);
  } else {
    editor.iframe.srcdoc = "";
    renderFiles();
    renderOutline();
  }
  updateHeader();
}
async function directoryDraft(directory) {
  if (!db) return null;
  const saved = await new Promise((resolve, reject) => {
    const request = db
      .transaction("workspace")
      .objectStore("workspace")
      .get("directory:" + directory);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return (
    saved ||
    (cachedProject?.local?.directory === directory ? cachedProject : null)
  );
}
function localMetadata(opened) {
  return {
    workspaceId: opened.workspaceId,
    directory: opened.directory,
    git: opened.git,
    serverId: session.instanceId,
    diskBaseline: structuredClone(opened.files),
    pendingPush: null,
  };
}
async function acceptLocalDirectory(opened) {
  applySource();
  clearTimeout(saveTimer);
  persist();
  await saving;
  const reopeningCurrent = project.local?.directory === opened.directory;
  const draft = reopeningCurrent
    ? project.local.workspaceId
      ? project
      : null
    : await directoryDraft(opened.directory);
  if (draft?.local) {
    try {
      const restored = reconcileLocalWorkspace(
        draft,
        opened,
        session.instanceId,
      );
      if (
        draft.local.pendingPush &&
        draft.local.serverId === session.instanceId
      )
        restored.local.workspaceId = draft.local.workspaceId;
      else if (draft.local.pendingPush) {
        restored.local.pendingPush = null;
        toast(
          "Your saved commit remains in Git. Finish its push in Git before creating another commit.",
          true,
        );
      }
      hydrateWorkspace(restored, { resetView: true });
      persist();
      return;
    } catch (error) {
      hydrateWorkspace(
        { ...draft, local: { ...draft.local, workspaceId: null } },
        { resetView: true },
      );
      throw error;
    }
  }
  setProject(
    opened.files,
    opened.git?.repository?.split("/").at(-1) ||
      opened.directory.split(/[\\/]/).filter(Boolean).at(-1) ||
      "Local site",
    null,
    localMetadata(opened),
  );
}
async function openLocalDirectory(directory) {
  const opened = await api("/api/local/open", { directory });
  await acceptLocalDirectory(opened);
}
async function restoreLocalDirectory() {
  try {
    session = await apiClient.getSession();
    if (session.directory) await openLocalDirectory(session.directory);
  } catch (error) {
    toast(error.message, true);
  }
}
async function saveLocalFiles({ files, quiet = false } = {}) {
  applySource();
  if (!project.local)
    throw Error(
      "Reopen the directory to reconnect it before saving. Your browser edits are still available.",
    );
  const sent = structuredClone(files || unsavedFiles());
  if (!sent.length) {
    if (!quiet) toast("Your files are already saved.");
    return [];
  }
  const ownsBusy = !busy;
  if (ownsBusy) {
    busy = true;
    updateHeader();
  }
  try {
    const result = await api("/api/local/save", {
      workspaceId: project.local.workspaceId,
      files: sent,
    });
    const disk = new Map(
      project.local.diskBaseline.map((file) => [file.path, file]),
    );
    sent.forEach((file) => disk.set(file.path, file));
    project.local.diskBaseline = [...disk.values()];
    persist();
    updateHeader();
    if (!quiet)
      toast(
        `Saved ${result.saved.length} ${result.saved.length === 1 ? "file" : "files"} to your directory.`,
      );
    return result.saved;
  } finally {
    if (ownsBusy) {
      busy = false;
      updateHeader();
    }
  }
}
function showLocalPushReview() {
  const local = project.local,
    pending = local.pendingPush;
  if (!local.git?.upstream) {
    modal(
      `${modalHeading("Save in this directory.")}<p class="modal-description">${local.git ? "This branch has no upstream. Set its Git upstream in your terminal, then reopen the directory." : "This directory is not in an initialized Git repository."}</p><p class="help-text">You can still save your edits to the existing files.</p><div class="modal-actions"><button class="button" data-close>Keep editing</button><button class="button primary" id="local-save-only">Save files</button></div>`,
    );
    $("#local-save-only").onclick = async () => {
      try {
        await saveLocalFiles();
        $("#modal").close();
      } catch (error) {
        modalError(error.message);
      }
    };
    return;
  }
  const files = pending
    ? pending.paths
        .map((path) => pending.sent.find((file) => file.path === path))
        .filter(Boolean)
    : changedFiles();
  modal(
    `${modalHeading(pending ? "Retry the saved commit." : "Commit these files and push.")}<p class="modal-description">${pending ? `Commit <strong>${escape(pending.commit.slice(0, 7))}</strong> is saved locally and waiting to push. Newer browser edits stay separate until this commit is pushed.` : `Save and commit ${files.length} ${files.length === 1 ? "file" : "files"} on <strong>${escape(local.git.branch)}</strong>, then push to <strong>${escape(local.git.upstream)}</strong>.`}</p><div class="change-list">${files.map((file) => `<div class="change-row"><span>${escape(file.path)}</span><small>local file</small></div>`).join("") || '<p class="help-text">No files have changed in this editing session.</p>'}</div>${pending ? "" : `<label>Commit message<input id="local-commit-message" value="Update site with Pagecraft" maxlength="2000"></label>`}<div class="review-note">${pending ? "Retry pushes the existing commit. It does not create another commit." : "The commit includes the current contents of these files, including edits already present when you opened them. Unrelated files stay untouched. Existing staged changes or unpushed commits must be resolved before Pagecraft can commit."}</div><div class="modal-actions"><button class="button" data-close>Keep editing</button><button id="confirm-local-push" class="button primary" ${files.length ? "" : "disabled"}>${icon("upload")}${pending ? "Retry push" : "Save, commit & push"}</button></div>`,
  );
  $("#confirm-local-push").onclick = pushLocalChanges;
}
async function pushLocalChanges() {
  const button = $("#confirm-local-push");
  button.disabled = true;
  button.textContent = "Pushing…";
  busy = true;
  const pending = project.local.pendingPush;
  const sent = pending?.sent || structuredClone(project.files);
  const files = pending
    ? pending.paths
        .map((path) => sent.find((file) => file.path === path))
        .filter(Boolean)
    : structuredClone(changedFiles());
  const paths = files.map((file) => file.path);
  const message = pending?.message || $("#local-commit-message").value;
  try {
    if (!pending) await saveLocalFiles({ files, quiet: true });
    const result = await api("/api/local/push", {
      workspaceId: project.local.workspaceId,
      paths,
      message,
    });
    project.baseline = structuredClone(sent);
    project.local.pendingPush = null;
    updateHeader();
    renderFiles();
    persist();
    modal(
      `${modalHeading("Committed and pushed.")}<p class="modal-description">Commit <strong>${escape(result.commit.slice(0, 7))}</strong> was pushed from your existing checkout on <strong>${escape(result.branch)}</strong>.</p><div class="review-note">Your changes are saved in ${escape(project.local.directory)}. Your hosting system controls deployment.</div>${result.url ? `<a class="success-link" href="${escape(result.url)}" target="_blank" rel="noopener noreferrer">View commit ↗</a>` : ""}<div class="modal-actions"><button class="button primary" data-close>Back to editing</button></div>`,
    );
    toast("Local files committed and pushed.");
  } catch (error) {
    if (error.pendingCommit) {
      project.local.pendingPush = {
        commit: error.pendingCommit,
        sent,
        paths,
        message,
      };
      persist();
    }
    modalError(error.message);
    button.disabled = false;
    button.textContent = project.local.pendingPush
      ? "Retry saved commit"
      : "Try again";
  } finally {
    busy = false;
    updateHeader();
  }
}

function openModal() {
  applySource();
  clearTimeout(saveTimer);
  persist();
  if (busy) return;
  modal(
    `${modalHeading("Open a site")}<button id="pick-local-directory" class="button directory-pick-button">${icon("folder")} Open directory</button><div class="open-divider"><span>or clone a GitHub repository</span></div><label for="clone-repository-input">GitHub repository</label><div class="clone-row"><input id="clone-repository-input" placeholder="https://github.com/owner/repository" autocomplete="off" spellcheck="false"><button id="clone-repository" class="button primary">Clone and open</button></div><p id="open-progress" class="help-text" role="status" hidden></p>`,
  );
  const openNative = async (endpoint, body) => {
    $("#modal-error")?.remove();
    busy = true;
    $("#pick-local-directory").disabled = true;
    $("#clone-repository").disabled = true;
    const progress = $("#open-progress");
    progress.hidden = false;
    progress.textContent = endpoint.endsWith("/pick")
      ? "Choose a folder in the system dialog."
      : "Cloning repository…";
    try {
      const opened = await api(endpoint, body);
      if (opened.cancelled) {
        progress.hidden = true;
        return;
      }
      await acceptLocalDirectory(opened);
      $("#modal").close();
    } catch (error) {
      progress.hidden = true;
      modalError(error.message);
    } finally {
      busy = false;
      $("#pick-local-directory") &&
        ($("#pick-local-directory").disabled = false);
      $("#clone-repository") && ($("#clone-repository").disabled = false);
      updateHeader();
    }
  };
  $("#pick-local-directory").onclick = () => openNative("/api/local/pick", {});
  $("#clone-repository").onclick = () =>
    openNative("/api/local/clone", {
      repository: $("#clone-repository-input").value.trim(),
    });
  $("#clone-repository-input").onkeydown = (event) => {
    if (event.key === "Enter" && !busy) $("#clone-repository").click();
  };
}

function setProject(files, name, remote = null, local = null) {
  if (!files.some((f) => /\.html?$/i.test(f.path)))
    throw Error(
      "No HTML files were found. Choose a static site folder containing an .html page.",
    );
  project = {
    name,
    files,
    baseline: structuredClone(files),
    remote,
    local,
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
function showChanges(push = false) {
  applySource();
  if (busy || !project.files.length) return;
  if (push) {
    showLocalPushReview();
    return;
  }
  const changes = changedFiles();
  modal(
    `${modalHeading("Your changes")}<p class="modal-description">${changes.length ? `${changes.length} changed ${changes.length === 1 ? "file" : "files"} since opening this site.` : "No changes yet."}</p>${changes.length ? `<select id="diff-select" class="diff-select" aria-label="File to review">${changes.map((file) => `<option value="${escape(file.path)}">${escape(file.path)}</option>`).join("")}</select><div id="file-diff" class="diff"></div><div class="modal-actions"><button class="button" data-close>Keep editing</button><button class="button primary" id="review-push">Commit & push</button></div>` : ""}`,
  );
  if (changes.length) {
    $("#diff-select").onchange = () => showDiff($("#diff-select").value);
    showDiff(changes[0].path);
    $("#review-push").onclick = showLocalPushReview;
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
$("#open-button").onclick = () => openModal();
$("#empty-open-button").onclick = () => openModal();
$("#project-button").onclick = () => openModal();
$("#connection-button").onclick = () => openModal();
$("#save-files-button").onclick = () =>
  saveLocalFiles().catch((error) => toast(error.message, true));
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
    if (busy || !project.files.length) return;
    applySource();
    if (project.local)
      saveLocalFiles().catch((error) => toast(error.message, true));
    else {
      persist();
      toast("Browser backup saved.");
    }
  }
  if (
    !typing &&
    !busy &&
    !$("#modal").open &&
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
await restoreLocalDirectory();
if (project.current) openFile(project.current);
else {
  renderFiles();
  renderOutline();
}
updateHeader();
