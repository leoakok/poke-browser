/**
 * Smoke test: load insertTextIntoContentEditable from ../extension/content.js (single source of truth)
 * and run it in JSDOM with a minimal Draft.js-like listener (sync state on input).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentPath = path.join(__dirname, "../extension/content.js");
const content = fs.readFileSync(contentPath, "utf8");
const start = content.indexOf("function insertTextIntoContentEditable(");
const end = content.indexOf(
  "\n/**\n * @param {unknown} message\n * @param {(r: unknown) => void} sendResponse\n */\nfunction handleTypeText("
);
if (start < 0 || end < 0 || end <= start) {
  console.error("FAIL: could not extract insertTextIntoContentEditable from extension/content.js");
  process.exit(1);
}
const fnSrc = content.slice(start, end).trim();

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { pretendToBeVisual: true });
const { window } = dom;
/** JSDOM omits execCommand by default; the extension clear path still calls it before setting textContent. */
window.document.execCommand = () => true;
/**
 * Pass the real JSDOM `Window` in: `globalThis` inside `window.Function` is not the DOM window in all engines.
 */
const insertTextIntoContentEditable = window.Function(
  "W",
  `
  var window = W;
  var document = W.document;
  var InputEvent = W.InputEvent;
  var Event = W.Event;
  ${fnSrc}
  return insertTextIntoContentEditable;
`
)(window);
if (typeof insertTextIntoContentEditable !== "function") {
  console.error("FAIL: could not obtain insertTextIntoContentEditable from eval IIFE");
  process.exit(1);
}

function assert(name, ok, detail = "") {
  console.log(ok ? `PASS: ${name}` : `FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

let failed = false;

function runCase(label, run) {
  window.getSelection()?.removeAllRanges();
  const document = window.document;
  document.body.replaceChildren();
  const ed = document.createElement("div");
  ed.setAttribute("contenteditable", "true");
  document.body.appendChild(ed);

  /** Draft.js-style: mirror “React state” from DOM after synthetic input */
  let reactMirror = "";
  ed.addEventListener("input", (e) => {
    if (e instanceof window.InputEvent && e.inputType === "insertText") {
      reactMirror = ed.textContent ?? "";
    }
  });
  ed.addEventListener("change", () => {
    reactMirror = ed.textContent ?? "";
  });

  const beforeinput = [];
  const input = [];
  const change = [];
  ed.addEventListener("beforeinput", (e) => beforeinput.push(e));
  ed.addEventListener("input", (e) => input.push(e));
  ed.addEventListener("change", (e) => change.push(e));

  const result = run({ ed, document, window });
  const expectText = typeof result === "string" ? result : result.expectText;
  const eventData = typeof result === "string" ? result : result.eventData;

  failed |= !assert(
    `${label} — beforeinput fired`,
    beforeinput.length === 1,
    `got ${beforeinput.length}`
  );
  const be = beforeinput[0];
  failed |= !assert(
    `${label} — beforeinput cancelable + insertText`,
    be instanceof window.InputEvent &&
      be.cancelable === true &&
      be.bubbles === true &&
      be.inputType === "insertText" &&
      be.data === eventData,
    String(be && be.inputType)
  );

  failed |= !assert(`${label} — input fired`, input.length === 1, `got ${input.length}`);
  const ie = input[0];
  failed |= !assert(
    `${label} — input insertText + data`,
    ie instanceof window.InputEvent &&
      ie.bubbles === true &&
      ie.inputType === "insertText" &&
      ie.data === eventData,
    String(ie && ie.inputType)
  );

  failed |= !assert(`${label} — change fired`, change.length === 1, `got ${change.length}`);
  const ce = change[0];
  failed |= !assert(
    `${label} — change is Event bubbles only`,
    ce instanceof window.Event &&
      !(ce instanceof window.InputEvent) &&
      ce.bubbles === true,
    ce?.constructor?.name
  );

  failed |= !assert(
    `${label} — textContent`,
    ed.textContent === expectText,
    `expected ${JSON.stringify(expectText)} got ${JSON.stringify(ed.textContent)}`
  );

  failed |= !assert(
    `${label} — react mirror (input/change)`,
    reactMirror === expectText,
    `expected ${JSON.stringify(expectText)} got ${JSON.stringify(reactMirror)}`
  );
}

runCase("replace (clear)", ({ ed }) => {
  ed.textContent = "old";
  insertTextIntoContentEditable(ed, "hello", true);
  return "hello";
});

runCase("append at caret", ({ ed, document, window }) => {
  ed.textContent = "ab";
  const tn = ed.firstChild;
  const r = document.createRange();
  r.setStart(tn, 1);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  insertTextIntoContentEditable(ed, "X", false);
  return { expectText: "aXb", eventData: "X" };
});

if (failed) {
  console.error("\nOne or more assertions FAILED.");
  process.exit(1);
}
console.log("\nAll assertions PASS.");
