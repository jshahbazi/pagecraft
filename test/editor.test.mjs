import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { Editor } from "../public/editor.js";

const source = await readFile(new URL("../public/editor.js", import.meta.url), "utf8");
const bridgeStart = source.lastIndexOf("\nfunction bridge(");
assert.notEqual(bridgeStart, -1, "test must exercise the actual iframe bridge");
const bridgeSource = source.slice(bridgeStart);
const NODE = "data-pagecraft-node";

// A small DOM adapter supplies the platform operations used by the bridge.
// Editing, keyboard, message, reconciliation, and selection logic comes from
// the production module rather than a second implementation in this test.
class Element {
  constructor(tag, attributes = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attributes));
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.text = text;
    this.scrollCalls = 0;
  }
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  get innerHTML() {
    return this.text + this.children.map((child) => child.outerHTML).join("");
  }
  get outerHTML() {
    const attributes = [...this.attrs]
      .map(([key, value]) => ` ${key}="${value}"`)
      .join("");
    return `<${this.tagName.toLowerCase()}${attributes}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  append(child) {
    child.parentElement = this;
    this.children.push(child);
  }
  replaceChildren(fragment) {
    this.children = fragment.children;
    for (const child of this.children) child.parentElement = this;
  }
  contains(element) {
    return this === element || this.children.some((child) => child.contains(element));
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    return selector === "*"
      ? descendants
      : descendants.filter((child) => child.hasAttribute(NODE));
  }
  querySelector(selector) {
    const tags = selector.split(",").map((tag) => tag.toUpperCase());
    return this.querySelectorAll("*").find((child) => tags.includes(child.tagName)) || null;
  }
  closest(selector) {
    if (selector === "a,area") {
      if (this.tagName === "A" || this.tagName === "AREA") return this;
      return this.parentElement?.closest(selector) || null;
    }
    if (this.hasAttribute(NODE)) return this;
    return this.parentElement?.closest(selector) || null;
  }
  focus() {}
  scrollIntoView() {
    this.scrollCalls++;
  }
}

function event(target, key = "") {
  return {
    target,
    key,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
}

function bridgeHarness(root, channel = "test") {
  const listeners = new Map();
  const messages = [];
  const parent = { postMessage: (message) => messages.push(message) };
  const context = vm.createContext({
    parent,
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      querySelectorAll: () => [root, ...root.querySelectorAll("*")].filter((element) => element.hasAttribute(NODE)),
      createRange: () => ({ selectNodeContents() {} }),
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    getComputedStyle: () => ({ color: "rgb(10, 20, 30)" }),
    addEventListener: (name, listener) => listeners.set(`window:${name}`, listener),
  });
  vm.runInContext(`(${bridgeSource})(${JSON.stringify(channel)}, ["color"]);`, context);
  return {
    channel,
    messages,
    dispatch(name, value) {
      assert.ok(listeners.has(name), `missing production listener: ${name}`);
      listeners.get(name)(value);
    },
    send(data) {
      listeners.get("window:message")({ source: parent, data: { pagecraft: channel, ...data } });
    },
  };
}

function editorHarness(root, channel = "test") {
  let srcdocWrites = 0;
  const contentWindow = { postMessage() {} };
  const iframe = {
    contentWindow,
    set srcdoc(_value) {
      srcdocWrites++;
    },
  };
  const document = {
    documentElement: root,
    body: { children: [root] },
    nextFragment: null,
    querySelectorAll: () => [root, ...root.querySelectorAll("*")],
    createElement(tag) {
      assert.equal(tag, "template");
      assert.ok(this.nextFragment, "provide the browser-parsed fixture fragment");
      return { content: this.nextFragment, innerHTML: "" };
    },
  };
  const editor = Object.assign(Object.create(Editor.prototype), {
    iframe,
    channel,
    document,
    doctype: "",
    selectedId: "n1",
    activeEditingId: null,
    counter: 1,
    nodes: new Map([["n1", root]]),
    ids: new WeakMap([[root, "n1"]]),
    computedStyles: new Map(),
    onReady() {},
    onUndo() {
      this.undoCalls = (this.undoCalls || 0) + 1;
    },
    onRedo() {
      this.redoCalls = (this.redoCalls || 0) + 1;
    },
    onSelect(selection) {
      this.lastSelection = selection;
    },
    onChange(html) {
      this.lastHtml = html;
    },
    render() {
      this.renderCalls = (this.renderCalls || 0) + 1;
      iframe.srcdoc = "unexpected reload";
    },
  });
  return {
    editor,
    document,
    get srcdocWrites() {
      return srcdocWrites;
    },
    receive(data) {
      editor.receive({ source: contentWindow, data: { pagecraft: channel, ...data } });
    },
  };
}

test("Backspace and Delete delete selected elements outside inline editing", () => {
  for (const tag of ["p", "section"]) {
    const root = new Element(tag, { [NODE]: "n1" }, "Keep this content");
    const harness = bridgeHarness(root);
    harness.dispatch("click", event(root));
    for (const key of ["Backspace", "Delete"]) {
      const keyEvent = event(root, key);
      harness.dispatch("keydown", keyEvent);
      assert.equal(keyEvent.defaultPrevented, true, `${tag}: ${key} handles element deletion outside text editing`);
    }
    assert.equal(harness.messages.filter((message) => message.action === "delete").length, 2);
    assert.equal(root.textContent, "Keep this content");

    const receiver = editorHarness(root);
    let deletions = 0;
    receiver.editor.deleteSelected = () => deletions++;
    receiver.receive({ action: "delete" });
    assert.equal(deletions, 1, "the parent deletes the selected element");
  }
});

test("Backspace and Delete preserve native character deletion during text editing", () => {
  const root = new Element("p", { [NODE]: "n1" }, "Editable text");
  const harness = bridgeHarness(root);
  harness.dispatch("dblclick", event(root));
  assert.equal(harness.messages.at(-1).action, "editing-start");
  for (const key of ["Backspace", "Delete"]) {
    const keyEvent = event(root, key);
    harness.dispatch("keydown", keyEvent);
    assert.equal(keyEvent.defaultPrevented, false, `${key} retains native text behavior`);
  }
  assert.equal(harness.messages.some((message) => message.action === "delete"), false);
});

test("canvas undo and redo shortcuts reach the parent callbacks", () => {
  const root = new Element("section", { [NODE]: "n1" }, "Selected content");
  const bridge = bridgeHarness(root);
  const parent = editorHarness(root);
  bridge.dispatch("click", event(root));
  const shortcuts = [
    { key: "z", metaKey: true, action: "undo" },
    { key: "z", ctrlKey: true, action: "undo" },
    { key: "Z", metaKey: true, shiftKey: true, action: "redo" },
    { key: "z", ctrlKey: true, shiftKey: true, action: "redo" },
    { key: "y", ctrlKey: true, action: "redo" },
  ];
  for (const shortcut of shortcuts) {
    const keyEvent = Object.assign(event(root, shortcut.key), shortcut);
    bridge.dispatch("keydown", keyEvent);
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(bridge.messages.at(-1).action, shortcut.action);
    parent.receive(bridge.messages.at(-1));
  }
  assert.equal(parent.editor.undoCalls, 2);
  assert.equal(parent.editor.redoCalls, 3);
});

test("undo and redo stay native while editing inline text", () => {
  const root = new Element("p", { [NODE]: "n1" }, "Editable text");
  const bridge = bridgeHarness(root);
  bridge.dispatch("dblclick", event(root));
  const messageCount = bridge.messages.length;
  for (const shortcut of [
    { key: "z", metaKey: true },
    { key: "z", ctrlKey: true },
    { key: "Z", metaKey: true, shiftKey: true },
    { key: "y", ctrlKey: true },
  ]) {
    const keyEvent = Object.assign(event(root, shortcut.key), shortcut);
    bridge.dispatch("keydown", keyEvent);
    assert.equal(keyEvent.defaultPrevented, false);
  }
  assert.equal(bridge.messages.length, messageCount, "native text history does not dispatch app history commands");
});

test("finishing an inline edit keeps the live iframe and its scroll position", () => {
  const root = new Element("p", { [NODE]: "n1" }, "Editable text");
  const bridge = bridgeHarness(root);
  const parent = editorHarness(root);
  bridge.dispatch("dblclick", event(root));
  parent.receive(bridge.messages.at(-1));
  assert.equal(parent.editor.activeEditingId, "n1");
  bridge.dispatch("focusout", event(root));
  assert.equal(root.hasAttribute("contenteditable"), false);
  assert.equal(bridge.messages.at(-1).action, "editing-end");
  parent.receive(bridge.messages.at(-1));
  assert.equal(parent.editor.activeEditingId, null);
  assert.equal(parent.editor.renderCalls || 0, 0);
  assert.equal(parent.srcdocWrites, 0);
});

test("new inline lines keep live IDs across input, source reconciliation, and selection", () => {
  const root = new Element("p", { [NODE]: "n1" }, "First line");
  const bridge = bridgeHarness(root);
  bridge.dispatch("dblclick", event(root));
  const parentRoot = new Element("p", {}, "First line");
  const parent = editorHarness(parentRoot);
  parent.receive(bridge.messages.at(-1));

  // A browser-created line has no editor identity until the input listener runs.
  const line = new Element("div", {}, "Second line");
  root.append(line);
  bridge.dispatch("input", { target: root });
  const liveId = line.getAttribute(NODE);
  assert.equal(liveId, "live-test-1");
  const parsedLine = new Element("div", { [NODE]: liveId }, "Second line");
  parent.document.nextFragment = { children: [parsedLine], querySelectorAll: () => [parsedLine] };
  parent.receive(bridge.messages.at(-1));
  assert.equal(parent.editor.nodes.get(liveId), parsedLine, "canonical node retains the iframe identity");
  assert.equal(parentRoot.children[0], parsedLine, "reconciliation moves the actual parsed node");
  assert.equal(parsedLine.hasAttribute(NODE), false, "instrumentation is not stored in source");

  line.text = "Second line updated";
  bridge.dispatch("input", { target: root });
  assert.equal(line.getAttribute(NODE), liveId);
  const updatedLine = new Element("div", { [NODE]: liveId }, line.text);
  parent.document.nextFragment = { children: [updatedLine], querySelectorAll: () => [updatedLine] };
  parent.receive(bridge.messages.at(-1));
  assert.equal(parent.editor.nodes.get(liveId), updatedLine);
  assert.match(parent.editor.lastHtml, /Second line updated/);
  assert.doesNotMatch(parent.editor.lastHtml, /data-pagecraft-/);
  assert.ok(parent.editor.getOutline().some((entry) => entry.id === liveId));

  bridge.dispatch("focusout", event(root));
  parent.receive(bridge.messages.at(-1));
  bridge.dispatch("click", event(line));
  assert.equal(bridge.messages.at(-1).id, liveId);
  parent.receive(bridge.messages.at(-1));
  assert.equal(parent.editor.selectedId, liveId);
  assert.equal(parent.editor.lastSelection.tag, "div");
  assert.equal(parent.editor.lastSelection.text, "Second line updated");
  assert.equal(parent.editor.lastSelection.styles.color, "rgb(10, 20, 30)");
  assert.equal(parent.srcdocWrites, 0);
});

test("restoring selection with scroll:false never scrolls the canvas", () => {
  const root = new Element("p", { [NODE]: "n1" }, "Selected text");
  const bridge = bridgeHarness(root);
  bridge.send({ action: "select", id: "n1", scroll: false });
  assert.equal(root.scrollCalls, 0);
  assert.equal(bridge.messages.at(-1).id, "n1");
  bridge.send({ action: "select", id: "n1" });
  assert.equal(root.scrollCalls, 1, "an explicit layer selection can reveal its target");

  const parent = editorHarness(root);
  let sent;
  parent.editor.send = (message) => (sent = message);
  parent.receive({ action: "ready" });
  assert.deepEqual(sent, { action: "select", id: "n1", scroll: false });
});
