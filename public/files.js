const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "json",
  "svg",
  "txt",
  "xml",
  "webmanifest",
  "map",
]);
const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "webm",
  "mp3",
  "ogg",
  "wav",
  "pdf",
]);
const EXCLUDED_PARTS = new Set([
  ".git",
  ".github",
  "node_modules",
  ".svn",
  ".hg",
]);
const encoder = new TextEncoder();

export function normalizePath(path) {
  if (typeof path !== "string" || path.length === 0)
    throw new TypeError("File path must be a non-empty string");
  if (path.includes("\0"))
    throw new Error("File path cannot contain a null byte");
  if (/[\u0001-\u001f\u007f]/.test(path))
    throw new Error("Control characters are not allowed in file paths");
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path))
    throw new Error("Absolute paths are not allowed");
  if (path.includes("\\"))
    throw new Error("Backslashes are not allowed in file paths");
  const parts = path.split("/");
  if (parts.some((part) => part === ".."))
    throw new Error("Path traversal is not allowed");
  if (parts.some((part) => part.startsWith("-")))
    throw new Error("Path segments cannot start with a hyphen");
  const normalized = parts
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  if (!normalized) throw new Error("File path must identify a file");
  if (normalized.split("/").some((part) => part.toLowerCase() === ".git"))
    throw new Error("Git metadata cannot be imported");
  return normalized;
}

export function isTextPath(path) {
  let normalized;
  try {
    normalized = normalizePath(path);
  } catch {
    return false;
  }
  const name = normalized.split("/").at(-1).toLowerCase();
  const extension = name.includes(".") ? name.split(".").at(-1) : name;
  return TEXT_EXTENSIONS.has(extension);
}

function isExcludedPath(path) {
  const parts = path.split("/");
  return parts.some(
    (part) =>
      part.startsWith(".") ||
      EXCLUDED_PARTS.has(part.toLowerCase()) ||
      /^\.env(?:\.|$)/i.test(part),
  );
}

function allowedKind(path) {
  if (isTextPath(path)) return "text";
  const extension = path.split("/").at(-1).toLowerCase().split(".").at(-1);
  return BINARY_EXTENSIONS.has(extension) ? "base64" : null;
}

function filePath(file) {
  const value =
    typeof file.webkitRelativePath === "string" && file.webkitRelativePath
      ? file.webkitRelativePath
      : file.name;
  return value;
}

export async function importFiles(fileList) {
  const input = Array.from(fileList ?? []);
  const entries = input.map((file) => {
    const path = filePath(file);
    // Validate path structure even for metadata paths, then filter metadata below.
    normalizePath(
      path
        .split("/")
        .map((part) => (part.toLowerCase() === ".git" ? "git-metadata" : part))
        .join("/"),
    );
    return { file, path };
  });
  const rooted =
    entries.length > 0 &&
    entries.every(({ path }) => path.includes("/")) &&
    new Set(entries.map(({ path }) => path.split("/")[0])).size === 1;
  const root = rooted ? entries[0].path.split("/")[0] : null;
  let total = 0;
  const result = [];
  const seen = new Set();
  for (const { file, path: originalPath } of entries) {
    const path = root ? originalPath.slice(root.length + 1) : originalPath;
    if (!path) continue;
    if (isExcludedPath(path)) continue;
    const normalized = normalizePath(path);
    const encoding = allowedKind(normalized);
    if (!encoding) continue;
    if (seen.has(normalized))
      throw new Error(`Duplicate file path: ${normalized}`);
    seen.add(normalized);
    if (result.length >= MAX_FILES)
      throw new RangeError(`A project can contain at most ${MAX_FILES} files`);
    total += Number(file.size) || 0;
    if (total > MAX_TOTAL_BYTES)
      throw new RangeError("A project can contain at most 20 MiB of files");
    const content =
      encoding === "text"
        ? await file.text()
        : bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    result.push({
      path: normalized,
      content,
      encoding: encoding === "text" ? "utf8" : "base64",
    });
  }
  return result;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function contentBytes(file) {
  if (file.encoding === "base64") {
    const binary = atob(file.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return encoder.encode(String(file.content ?? ""));
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}
function put32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

export function makeZip(files) {
  if (files.length > MAX_FILES)
    throw new RangeError(`A project can contain at most ${MAX_FILES} files`);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const file of files) {
    const path = normalizePath(file.path);
    if (isExcludedPath(path))
      throw new Error(`Excluded path cannot be archived: ${path}`);
    const name = encoder.encode(path);
    const data = contentBytes(file);
    if (name.length > 0xffff || data.length > 0xffffffff)
      throw new RangeError("ZIP entry exceeds the ZIP32 size limit");
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    put32(lv, 0, 0x04034b50);
    put16(lv, 4, 20);
    put16(lv, 6, 0x0800);
    put32(lv, 14, crc);
    put32(lv, 18, data.length);
    put32(lv, 22, data.length);
    put16(lv, 26, name.length);
    local.set(name, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    put32(cv, 0, 0x02014b50);
    put16(cv, 4, 20);
    put16(cv, 6, 20);
    put16(cv, 8, 0x0800);
    put32(cv, 16, crc);
    put32(cv, 20, data.length);
    put32(cv, 24, data.length);
    put16(cv, 28, name.length);
    put32(cv, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  if (
    files.length > 0xffff ||
    localOffset > 0xffffffff ||
    centralSize > 0xffffffff
  )
    throw new RangeError("Project exceeds ZIP32 limits");
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  put32(ev, 0, 0x06054b50);
  put16(ev, 8, files.length);
  put16(ev, 10, files.length);
  put32(ev, 12, centralSize);
  put32(ev, 16, localOffset);
  const parts = [...localParts, ...centralParts, end];
  const output = new Uint8Array(localOffset + centralSize + end.length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function downloadFile(name, content, type = "application/octet-stream") {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadProject(files) {
  downloadFile("site.zip", makeZip(files), "application/zip");
}
