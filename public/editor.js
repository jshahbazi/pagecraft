/**
 * Browser-native HTML editing. The source document stays in the parent window;
 * the iframe receives a disposable, script-free rendering with an isolated
 * origin. Editor instrumentation and rewritten asset URLs never enter exports.
 */
const NODE = "data-pagecraft-node";
const SELECTED = "data-pagecraft-selected";
const EDITING = "data-pagecraft-editing";
const STYLE_NAMES = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "textAlign",
  "padding",
  "margin",
  "borderRadius",
  "maxWidth",
  "width",
  "height",
  "lineHeight",
  "letterSpacing",
  "display",
  "gap",
];
const TEXT_TAGS =
  /^(H[1-6]|P|A|SPAN|SMALL|EM|STRONG|LI|BUTTON|BLOCKQUOTE|FIGCAPTION|LABEL|TD|TH|DIV)$/;
const MIME = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};
const MAX_PREVIEW_CSS_UNITS = 128 * 1024 * 1024;
const MAX_PREVIEW_CSS_OPERATIONS = 10_000;
const MAX_PREVIEW_OUTPUT_UNITS = 128 * 1024 * 1024;

class PreviewLimitError extends Error {}

function randomId() {
  return crypto.randomUUID().replaceAll("-", "");
}
function encodeBase64(value) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}
function resolvePath(reference, from) {
  try {
    const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    return normalizePath(
      clean.startsWith("/")
        ? clean.slice(1)
        : `${from.slice(0, from.lastIndexOf("/") + 1)}${clean}`,
    );
  } catch {
    return null;
  }
}
function safeRemote(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      !host.includes(".") ||
      /^[\d.]+$/.test(host) ||
      host.includes(":")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
function escapeScript(value) {
  return value.replace(/<\/script/gi, "<\\/script");
}
function escapeStyle(value) {
  // A style element is an HTML raw-text context when srcdoc is reparsed.
  return value.replace(/<\/style(?=[\s/>])/gi, (match) => `<\\/${match.slice(2)}`);
}
function serialize(document, doctype) {
  return `${doctype ? doctype + "\n" : ""}${document.documentElement.outerHTML}`;
}

export class Editor {
  constructor({
    iframe,
    onSelect = () => {},
    onChange = () => {},
    onReady = () => {},
    onUndo = () => {},
    onRedo = () => {},
  }) {
    this.iframe = iframe;
    this.onSelect = onSelect;
    this.onChange = onChange;
    this.onReady = onReady;
    this.onUndo = onUndo;
    this.onRedo = onRedo;
    this.selectedId = null;
    this.activeEditingId = null;
    this.nodes = new Map();
    this.ids = new WeakMap();
    this.computedStyles = new Map();
    this.urls = new Map();
    this.remoteOrigins = new Set();
    this.counter = 0;
    this.document = null;
    this.channel = randomId();
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.listener = (event) => this.receive(event);
    window.addEventListener("message", this.listener);
  }

  load(html, { path = "index.html", files = [] } = {}) {
    this.revokeURLs();
    this.remoteOrigins.clear();
    this.path = path;
    this.files = new Map(files.map((file) => [file.path, file]));
    this.document = new DOMParser().parseFromString(html, "text/html");
    const dt = this.document.doctype;
    this.doctype = dt
      ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ""}${dt.systemId ? `${dt.publicId ? "" : " SYSTEM"} "${dt.systemId}"` : ""}>`
      : "";
    this.nodes = new Map();
    this.ids = new WeakMap();
    this.computedStyles.clear();
    this.counter = 0;
    this.selectedId = null;
    this.indexNodes();
    this.render();
  }

  indexNodes() {
    const live = new Set();
    for (const node of this.document.querySelectorAll("*")) {
      let id = this.ids.get(node);
      if (!id) {
        id = `n${++this.counter}`;
        this.ids.set(node, id);
      }
      this.nodes.set(id, node);
      live.add(id);
    }
    for (const id of this.nodes.keys())
      if (!live.has(id)) {
        this.nodes.delete(id);
        this.computedStyles.delete(id);
      }
  }

  getHtml() {
    return this.document ? serialize(this.document, this.doctype) : "";
  }

  getOutline() {
    if (!this.document) return [];
    const result = [];
    const visit = (element, depth) => {
      if (
        /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE|BR|WBR)$/.test(
          element.tagName,
        )
      )
        return;
      const tag = element.tagName.toLowerCase();
      const text = element.textContent.trim().replace(/\s+/g, " ");
      result.push({
        id: this.ids.get(element),
        tag,
        label: element.id
          ? `#${element.id}`
          : text.slice(0, 42) || element.getAttribute("alt") || tag,
        depth,
      });
      for (const child of element.children) visit(child, depth + 1);
    };
    for (const child of this.document.body.children) visit(child, 0);
    return result;
  }

  selection(computed = this.computedStyles.get(this.selectedId) || {}) {
    const element = this.nodes.get(this.selectedId);
    if (!element) return null;
    const styles = {};
    for (const name of STYLE_NAMES)
      styles[name] = element.style[name] || computed[name] || "";
    const parents = [];
    for (
      let parent = element.parentElement;
      parent && parent !== this.document.documentElement;
      parent = parent.parentElement
    )
      parents.unshift(parent.tagName.toLowerCase());
    return {
      id: this.selectedId,
      tag: element.tagName.toLowerCase(),
      text: element.textContent,
      href: element.getAttribute("href") || "",
      src: element.getAttribute("src") || "",
      alt: element.getAttribute("alt") || "",
      styles,
      parentPath: parents.join(" / "),
      editable: this.editable(element),
      hasChildren: element.children.length > 0,
    };
  }

  select(id) {
    if (!this.nodes.has(id)) return;
    this.selectedId = id;
    this.send({ action: "select", id });
    this.onSelect(this.selection());
  }

  updateSelected(patch = {}) {
    const element = this.nodes.get(this.selectedId);
    if (!element) return false;
    if (
      Object.hasOwn(patch, "text") &&
      !/^(SCRIPT|STYLE|HTML|HEAD|BODY)$/.test(element.tagName)
    )
      element.textContent = String(patch.text);
    for (const attr of ["href", "src", "alt"])
      if (Object.hasOwn(patch, attr)) {
        const value = String(patch[attr]);
        if (value) element.setAttribute(attr, value);
        else element.removeAttribute(attr);
      }
    for (const [name, value] of Object.entries(patch.styles || {})) {
      if (STYLE_NAMES.includes(name)) element.style[name] = String(value);
    }
    this.changed();
    return true;
  }

  duplicateSelected() {
    const element = this.nodes.get(this.selectedId);
    if (
      !element ||
      !element.parentElement ||
      /^(HTML|HEAD|BODY)$/.test(element.tagName)
    )
      return false;
    const clone = element.cloneNode(true);
    // Duplicate HTML ids would redirect labels, anchors and CSS unexpectedly.
    for (const node of [clone, ...clone.querySelectorAll("[id]")])
      node.removeAttribute("id");
    element.after(clone);
    this.indexNodes();
    this.selectedId = this.ids.get(clone);
    this.changed();
    return true;
  }

  deleteSelected() {
    const element = this.nodes.get(this.selectedId);
    if (!element || /^(HTML|HEAD|BODY)$/.test(element.tagName)) return false;
    const parent = element.parentElement;
    element.remove();
    this.selectedId = parent ? this.ids.get(parent) : null;
    this.changed();
    return true;
  }

  insertBlock(type = "text") {
    if (!this.document) return;
    const blocks = {
      heading: "<h2>Your next big idea</h2>",
      text: "<p>Double-click this text to make it yours.</p>",
      button:
        '<a href="#" style="display:inline-block;padding:12px 22px;background:#232d28;color:white;border-radius:8px;text-decoration:none">Learn more</a>',
      section:
        '<section style="padding:48px 32px"><h2>A new section</h2><p>Make a little room for something good.</p></section>',
      image:
        '<img src="" alt="Describe your image" style="display:block;width:100%;max-width:640px;min-height:120px;background:#eee;border-radius:12px">',
    };
    const holder = this.document.createElement("template");
    holder.innerHTML = blocks[type] || blocks.text;
    const element = holder.content.firstElementChild;
    const selected = this.nodes.get(this.selectedId);
    if (
      selected &&
      selected !== this.document.body &&
      selected.parentElement &&
      selected.closest("body")
    )
      selected.after(element);
    else this.document.body.append(element);
    this.indexNodes();
    this.selectedId = this.ids.get(element);
    this.changed();
  }

  changed() {
    this.indexNodes();
    this.onChange(this.getHtml());
    this.render();
    this.onSelect(this.selection());
  }

  send(message) {
    this.iframe.contentWindow?.postMessage(
      { pagecraft: this.channel, ...message },
      "*",
    );
  }

  receive(event) {
    if (
      event.source !== this.iframe.contentWindow ||
      !event.data ||
      event.data.pagecraft !== this.channel
    )
      return;
    const data = event.data;
    if (data.action === "ready") {
      if (this.selectedId)
        this.send({ action: "select", id: this.selectedId, scroll: false });
      this.onReady();
    } else if (data.action === "select" && this.nodes.has(data.id)) {
      this.selectedId = data.id;
      this.computedStyles.set(data.id, data.styles || {});
      this.onSelect(this.selection());
    } else if (data.action === "editing-start" && this.nodes.has(data.id)) {
      if (
        this.activeEditingId === data.id ||
        this.editable(this.nodes.get(data.id))
      ) {
        this.activeEditingId = data.id;
      }
    } else if (
      data.action === "change" &&
      this.nodes.has(data.id) &&
      typeof data.html === "string"
    ) {
      const target = this.nodes.get(data.id);
      // Eligibility is checked when an edit starts. Enter can add a child
      // div/p while typing; that must not silently disable later keystrokes.
      if (this.activeEditingId !== data.id || data.html.length > 1_000_000)
        return;
      const holder = this.document.createElement("template");
      holder.innerHTML = data.html;
      const reconciledIds = new Set();
      for (const element of holder.content.querySelectorAll("*")) {
        const incomingId = element.getAttribute(NODE);
        const original = this.nodes.get(incomingId);
        if (original) {
          // Restore every authored attribute (including script handlers, which
          // remain inert in the source model). Preview URLs and flags are never
          // written back. Preserve IDs during a live edit so repeated input
          // events still refer to the same source descendants.
          this.ids.set(element, this.ids.get(original));
          for (const attr of [...element.attributes])
            element.removeAttribute(attr.name);
          for (const attr of original.attributes)
            element.setAttribute(attr.name, attr.value);
        } else {
          // The bridge assigns session-scoped IDs to new rich-text nodes.
          // Keep those identities in the source model without exporting the
          // instrumentation, so new Enter-created lines can be selected later.
          if (
            typeof incomingId === "string" &&
            new RegExp(`^live-${this.channel}-[1-9]\\d{0,8}$`).test(incomingId) &&
            !reconciledIds.has(incomingId)
          )
            this.ids.set(element, incomingId);
          for (const attr of [...element.attributes]) {
            if (
              attr.name.startsWith("data-pagecraft-") ||
              attr.name === "contenteditable" ||
              /^on/i.test(attr.name)
            )
              element.removeAttribute(attr.name);
          }
        }
        if (incomingId) reconciledIds.add(incomingId);
        if (
          /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|BASE|META|LINK|FORM)$/.test(
            element.tagName,
          )
        )
          element.remove();
      }
      // Move the parsed nodes instead of serializing and reparsing them: the
      // WeakMap IDs restored above must survive subsequent live input events.
      target.replaceChildren(holder.content);
      this.indexNodes();
      this.onChange(this.getHtml());
      this.computedStyles.set(data.id, data.styles || {});
      this.onSelect(this.selection());
      // Keep the live DOM and caret in place. Its IDs already match the source
      // model, including newly inserted rich text; no iframe reload is needed.
    } else if (
      data.action === "editing-end" &&
      data.id === this.activeEditingId
    ) {
      this.activeEditingId = null;
    } else if (data.action === "delete") {
      this.deleteSelected();
    } else if (data.action === "undo") {
      this.onUndo();
    } else if (data.action === "redo") {
      this.onRedo();
    }
  }

  editable(element) {
    return (
      TEXT_TAGS.test(element.tagName) &&
      !element.querySelector(
        "script,style,iframe,object,embed,form,section,article,header,footer,nav,main,div,p,h1,h2,h3,h4,h5,h6,ul,ol,table",
      )
    );
  }

  chargeCSS(units = 0) {
    if (!this.cssBudget) return;
    this.cssBudget.operations++;
    this.cssBudget.units += units;
    if (
      this.cssBudget.operations > MAX_PREVIEW_CSS_OPERATIONS ||
      this.cssBudget.units > MAX_PREVIEW_CSS_UNITS
    )
      throw new PreviewLimitError("The stylesheet is too complex to preview.");
  }

  chargePreviewOutput(units) {
    this.previewUnits += units;
    if (this.previewUnits > MAX_PREVIEW_OUTPUT_UNITS)
      throw new PreviewLimitError("The site is too large to preview.");
  }

  assetURL(reference, from = this.path, depth = 0) {
    if (!reference) return "about:blank";
    if (reference.startsWith("#")) return reference;
    if (/^data:/i.test(reference)) return reference;
    if (/^[a-z][a-z\d+.-]*:/i.test(reference) || reference.startsWith("//")) {
      const remote = safeRemote(reference);
      if (remote) this.remoteOrigins.add(new URL(remote).origin);
      return remote || "about:blank";
    }
    const path = resolvePath(reference, from);
    const file = this.files.get(path);
    if (!file || depth > 8) return "about:blank";
    if (this.urls.has(path)) return this.urls.get(path);
    const extension = path.split(".").at(-1).toLowerCase();
    let encoded;
    if (file.encoding === "base64") encoded = file.content;
    else {
      const content =
        extension === "css"
          ? this.rewriteCSS(file.content, path, depth + 1)
          : file.content;
      this.chargeCSS(content.length);
      encoded = encodeBase64(content);
    }
    // A sandbox without allow-same-origin has an opaque origin. Parent-created
    // blob URLs fail to load there in Chromium; data URLs work in the isolated
    // document and cannot navigate back to local application endpoints.
    const url = `data:${MIME[extension] || "application/octet-stream"};base64,${encoded}`;
    this.urls.set(path, url);
    return url;
  }

  rewriteCSS(css, from, depth = 0, imports = new Set([from])) {
    if (depth > 8) return "";
    const input = String(css);
    this.chargeCSS(input.length);
    // Local imports are inlined, so nested url() paths resolve to their own file.
    // Search for each terminating semicolon once. A regex that looks ahead to
    // one from every unterminated @import can take quadratic time.
    let result = "";
    let cursor = 0;
    const starts = /@import\s+/gi;
    for (let start; (start = starts.exec(input)); ) {
      const end = input.indexOf(";", start.index + start[0].length);
      if (end < 0) break;
      const directive = input.slice(start.index, end + 1);
      const parsed = /^@import\s+(?:url\(\s*)?["']?([^"'\s;)]+)["']?\s*\)?[^;]*;$/i.exec(directive);
      this.chargeCSS(directive.length);
      result += input.slice(cursor, start.index);
      if (parsed) {
        const ref = parsed[1];
        const path = resolvePath(ref, from);
        const file =
          !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(ref) && this.files.get(path);
        if (file?.encoding === "utf8" && !imports.has(path)) {
          const expanded = this.rewriteCSS(
            file.content,
            path,
            depth + 1,
            new Set([...imports, path]),
          );
          this.chargeCSS(expanded.length);
          result += expanded;
        }
      } else result += directive;
      cursor = end + 1;
      starts.lastIndex = cursor;
    }
    result += input.slice(cursor);
    // Walk each URL once. A global regex can rescan the entire remaining
    // stylesheet for every malformed url( with no closing quote or parenthesis.
    const original = result;
    result = "";
    cursor = 0;
    let inComment = false;
    let inString = "";
    for (let start = 0; start < original.length; ) {
      if (inComment) {
        if (original[start] === "*" && original[start + 1] === "/") {
          inComment = false;
          start += 2;
        } else start++;
        continue;
      }
      if (inString) {
        if (original[start] === "\\") start += 2;
        else if (original[start++] === inString) inString = "";
        continue;
      }
      if (original[start] === "/" && original[start + 1] === "*") {
        inComment = true;
        start += 2;
        continue;
      }
      if (original[start] === '"' || original[start] === "'") {
        inString = original[start++];
        continue;
      }
      if (original.slice(start, start + 4).toLowerCase() !== "url(") {
        start++;
        continue;
      }
      let index = start + 4;
      while (/\s/.test(original[index] || "")) index++;
      let reference;
      if (original[index] === '"' || original[index] === "'") {
        const quote = original[index++];
        const valueStart = index;
        while (index < original.length && original[index] !== quote) {
          index += original[index] === "\\" ? 2 : 1;
        }
        if (index >= original.length) break;
        reference = original.slice(valueStart, index++);
        while (/\s/.test(original[index] || "")) index++;
        if (original[index] !== ")") {
          start = index;
          continue;
        }
      } else {
        const close = original.indexOf(")", index);
        if (close < 0) break;
        reference = original.slice(index, close);
        index = close;
      }
      const url = this.assetURL(reference.trim(), from, depth).replaceAll('"', "%22");
      this.chargeCSS(url.length + 7);
      result += original.slice(cursor, start) + `url("${url}")`;
      cursor = index + 1;
      start = cursor;
    }
    result += original.slice(cursor);
    this.chargeCSS(result.length);
    return result;
  }

  render() {
    if (!this.document) return;
    this.activeEditingId = null;
    this.channel = randomId();
    const nonce = randomId();
    this.cssBudget = { operations: 0, units: 0 };
    this.previewUnits = 0;
    try {
      this.renderPreview(nonce);
    } catch (error) {
      if (!(error instanceof PreviewLimitError)) throw error;
      this.iframe.srcdoc = '<!DOCTYPE html><html><body><p>The site is too large or complex to preview. You can edit it in Code view.</p></body></html>';
    } finally {
      this.cssBudget = null;
    }
  }

  renderPreview(nonce) {
    const projection = this.document.cloneNode(true);
    const sourceNodes = [...this.document.querySelectorAll("*")];
    const projectedNodes = [...projection.querySelectorAll("*")];
    for (let i = 0; i < projectedNodes.length; i++) {
      const element = projectedNodes[i];
      element.setAttribute(NODE, this.ids.get(sourceNodes[i]));
      element.removeAttribute(SELECTED);
      element.removeAttribute(EDITING);
      element.removeAttribute("contenteditable");
      for (const attribute of [...element.attributes]) {
        if (
          /^on/i.test(attribute.name) ||
          [
            "autofocus",
            "autoplay",
            "formaction",
            "action",
            "srcdoc",
            "ping",
          ].includes(attribute.name)
        )
          element.removeAttribute(attribute.name);
      }
      if (
        /^(SCRIPT|IFRAME|OBJECT|EMBED|BASE|TEMPLATE)$/.test(element.tagName.toUpperCase()) ||
        (element.tagName === "META" && element.hasAttribute("http-equiv"))
      ) {
        element.remove();
        continue;
      }
      if (element.tagName === "LINK") {
        const href = element.getAttribute("href") || "";
        if (
          element.rel === "stylesheet" &&
          !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)
        ) {
          const file = this.files.get(resolvePath(href, this.path));
          if (file?.encoding === "utf8") {
            const style = projection.createElement("style");
            style.textContent = escapeStyle(this.rewriteCSS(file.content, file.path));
            this.chargePreviewOutput(style.textContent.length);
            element.replaceWith(style);
          } else element.remove();
        } else element.remove();
        continue;
      }
      if (element.tagName.toUpperCase() === "STYLE") {
        element.textContent = escapeStyle(this.rewriteCSS(element.textContent, this.path));
        this.chargePreviewOutput(element.textContent.length);
      }
      if (element.hasAttribute("style")) {
        const value = this.rewriteCSS(element.getAttribute("style"), this.path);
        this.chargePreviewOutput(value.length);
        element.setAttribute("style", value);
      }
      for (const attr of ["src", "poster"])
        if (element.hasAttribute(attr)) {
          const value = this.assetURL(element.getAttribute(attr));
          this.chargePreviewOutput(value.length);
          element.setAttribute(attr, value);
        }
      if (element.hasAttribute("srcset")) element.removeAttribute("srcset");
      if (element.tagName === "A" || element.tagName === "AREA") {
        element.setAttribute("href", "#");
        element.removeAttribute("target");
        element.removeAttribute("download");
      }
      if (element.tagName === "USE" || element.tagName === "IMAGE") {
        for (const attr of ["href", "xlink:href"])
          if (element.hasAttribute(attr)) {
            const value = this.assetURL(element.getAttribute(attr));
            this.chargePreviewOutput(value.length);
            element.setAttribute(attr, value);
          }
      }
    }
    const csp = projection.createElement("meta");
    csp.httpEquiv = "Content-Security-Policy";
    const remoteSources = [...this.remoteOrigins].join(" ");
    csp.content = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' blob:; img-src blob: data: ${remoteSources}; font-src blob: data: ${remoteSources}; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    projection.head.prepend(csp);
    const style = projection.createElement("style");
    style.textContent = `[${NODE}]{cursor:default!important}a[${NODE}],button[${NODE}]{cursor:pointer!important}[${SELECTED}]{outline:2px solid #739b6c!important;outline-offset:3px!important}[${EDITING}]{cursor:text!important;outline:2px solid #739b6c!important;min-width:1ch}::selection{background:#cbe4c1;color:#19271c}`;
    projection.head.append(style);
    const script = projection.createElement("script");
    script.setAttribute("nonce", nonce);
    script.textContent = escapeScript(
      `(${bridge.toString()})(${JSON.stringify(this.channel)},${JSON.stringify(STYLE_NAMES)});`,
    );
    projection.body.append(script);
    this.iframe.srcdoc = serialize(projection, this.doctype);
  }

  revokeURLs() {
    this.urls.clear();
  }
  destroy() {
    this.revokeURLs();
    window.removeEventListener("message", this.listener);
    this.iframe.srcdoc = "";
  }
}

function bridge(channel, styleNames) {
  const nodeAttr = "data-pagecraft-node";
  const selectedAttr = "data-pagecraft-selected";
  const editingAttr = "data-pagecraft-editing";
  let selected = null;
  let editing = null;
  let liveCounter = 0;
  const post = (action, data = {}) =>
    parent.postMessage({ pagecraft: channel, action, ...data }, "*");
  const styles = (element) => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(styleNames.map((name) => [name, computed[name]]));
  };
  const select = (element, notify = true) => {
    if (!element?.hasAttribute(nodeAttr)) return;
    selected?.removeAttribute(selectedAttr);
    selected = element;
    selected.setAttribute(selectedAttr, "");
    if (notify)
      post("select", {
        id: element.getAttribute(nodeAttr),
        styles: styles(element),
      });
  };
  const endEditing = () => {
    if (!editing) return;
    const element = editing;
    editing = null;
    element.removeAttribute("contenteditable");
    element.removeAttribute(editingAttr);
    post("editing-end", { id: element.getAttribute(nodeAttr) });
  };
  document.addEventListener(
    "click",
    (event) => {
      // srcdoc inherits the parent's base URL, so even a fragment href can
      // navigate away from this document. Keep links inert during text edits
      // as well as selection, including clicks on their nested inline nodes.
      if (event.target.closest?.("a,area")) event.preventDefault();
      if (editing && editing.contains(event.target)) return;
      if (editing) endEditing();
      event.preventDefault();
      event.stopPropagation();
      const element = event.target.closest?.(`[${nodeAttr}]`);
      select(element);
    },
    true,
  );
  document.addEventListener(
    "auxclick",
    (event) => {
      const link = event.target.closest?.("a,area");
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      if (editing && !editing.contains(link)) endEditing();
      select(link);
    },
    true,
  );
  document.addEventListener(
    "dblclick",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      const element = event.target.closest?.(`[${nodeAttr}]`);
      if (
        !element ||
        !/^(H[1-6]|P|A|SPAN|SMALL|EM|STRONG|LI|BUTTON|BLOCKQUOTE|FIGCAPTION|LABEL|TD|TH|DIV)$/.test(
          element.tagName,
        ) ||
        element.querySelector(
          "script,style,iframe,object,embed,form,section,article,header,footer,nav,main,div,p,h1,h2,h3,h4,h5,h6,ul,ol,table",
        )
      )
        return;
      if (editing && editing !== element) endEditing();
      select(element);
      editing = element;
      post("editing-start", { id: element.getAttribute(nodeAttr) });
      element.setAttribute("contenteditable", "true");
      element.setAttribute(editingAttr, "");
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
    true,
  );
  document.addEventListener("input", (event) => {
    if (editing && editing.contains(event.target)) {
      // Browser editing may insert or clone elements when Enter splits a line.
      // Assign identities before sending markup, including replacing duplicate
      // IDs copied from the editing root or another live descendant.
      const seen = new Set(
        [...document.querySelectorAll(`[${nodeAttr}]`)]
          .filter((element) => element === editing || !editing.contains(element))
          .map((element) => element.getAttribute(nodeAttr)),
      );
      for (const element of editing.querySelectorAll("*")) {
        let id = element.getAttribute(nodeAttr);
        if (!id || seen.has(id)) {
          id = `live-${channel}-${++liveCounter}`;
          element.setAttribute(nodeAttr, id);
        }
        seen.add(id);
      }
      post("change", {
        id: editing.getAttribute(nodeAttr),
        html: editing.innerHTML,
        styles: styles(editing),
      });
    }
  });
  document.addEventListener("paste", (event) => {
    if (!editing) return;
    event.preventDefault();
    // Text paste avoids importing executable markup or remote asset attributes.
    document.execCommand(
      "insertText",
      false,
      event.clipboardData.getData("text/plain"),
    );
  });
  document.addEventListener("focusout", (event) => {
    if (editing === event.target) endEditing();
  });
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  document.addEventListener(
    "dragstart",
    (event) => event.preventDefault(),
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      const link = event.target.closest?.("a,area");
      const key = event.key.toLowerCase();
      if (
        !editing &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (key === "z" || key === "y")
      ) {
        event.preventDefault();
        event.stopPropagation();
        post(key === "y" || event.shiftKey ? "redo" : "undo");
      } else if (!editing && event.key === "Enter" && link) {
        event.preventDefault();
        event.stopPropagation();
        select(link);
      } else if (event.key === "Escape" && editing) {
        event.preventDefault();
        endEditing();
      } else if (
        !editing &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        if (selected) post("delete");
      }
    },
    true,
  );
  addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.pagecraft !== channel) return;
    if (event.data.action === "select") {
      const element = [...document.querySelectorAll(`[${nodeAttr}]`)].find(
        (node) => node.getAttribute(nodeAttr) === event.data.id,
      );
      select(element);
      if (event.data.scroll !== false)
        element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
  post("ready");
}
