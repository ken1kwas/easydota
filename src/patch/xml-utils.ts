import fs from "node:fs";
import path from "node:path";

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import { isPlainObject } from "../core/jsonc";
import * as log from "../core/log";
import { evaluateCondition, interpolateVariables } from "./manifest-utils";

// xmldom ships its own DOM typings; keep these loose.
type XNode = any;
type XElement = any;
type XDocument = any;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

const SELECTOR_RE =
  /^([a-zA-Z0-9_-]+)?(?:#([a-zA-Z0-9_-]+))?((?:\.[a-zA-Z0-9_-]+)*)((?:\[[a-zA-Z0-9_-]+=['"]?[^'"\]]+['"]?\])*)$/;
const ATTRIBUTE_RE = /\[([a-zA-Z0-9_-]+)=['"]?([^'"\]]+)['"]?\]/g;

export class XmlParseError extends Error {}

function makeParser(): DOMParser {
  return new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (msg: string) => {
        throw new XmlParseError(msg);
      },
      fatalError: (msg: string) => {
        throw new XmlParseError(msg);
      },
    },
  });
}

export function parseXml(text: string): XDocument {
  const doc = makeParser().parseFromString(text, "text/xml");
  if (!doc.documentElement) throw new XmlParseError("Document has no root element");
  return doc;
}

/** Parses an XML snippet and imports its root element into `doc`. */
export function fromString(doc: XDocument, snippet: string): XElement {
  return doc.importNode(parseXml(snippet).documentElement, true);
}

export function elementChildren(el: XElement): XElement[] {
  const out: XElement[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === ELEMENT_NODE) out.push(n);
  return out;
}

/** Pre-order traversal like ElementTree's `iter()`. */
export function* iterElements(root: XElement): Generator<XElement> {
  yield root;
  for (const child of elementChildren(root)) yield* iterElements(child);
}

/** `.//Tag` search like ElementTree's `find(".//Tag")`. */
export function findDescendant(root: XElement, tagName: string): XElement | null {
  for (const el of iterElements(root)) if (el !== root && el.tagName === tagName) return el;
  return null;
}

function compileSelector(selector: string | undefined | null): ((el: XElement) => boolean) | null {
  if (!selector) return null;
  const m = selector.match(SELECTOR_RE);
  if (!m) return null;
  const [, tagName, elementId, classesStr, attrsStr] = m;
  const targetClasses = (classesStr ?? "").split(".").filter(Boolean);
  const targetAttrs: Record<string, string> = {};
  for (const am of (attrsStr ?? "").matchAll(ATTRIBUTE_RE)) targetAttrs[am[1]] = am[2];

  return (el) => {
    if (tagName && el.tagName !== tagName) return false;
    if (elementId && el.getAttribute("id") !== elementId) return false;
    if (targetClasses.length) {
      const classes = (el.getAttribute("class") || "").split(/\s+/);
      if (!targetClasses.every((c) => classes.includes(c))) return false;
    }
    for (const [k, v] of Object.entries(targetAttrs)) if (el.getAttribute(k) !== v) return false;
    return true;
  };
}

export function findBySelector(root: XElement, selector: string | undefined | null): XElement | null {
  const matches = compileSelector(selector);
  if (!matches) return null;
  for (const el of iterElements(root)) if (matches(el)) return el;
  return null;
}

export function findWithParentBySelector(root: XElement, selector: string | undefined | null): [XElement | null, XElement | null] {
  const matches = compileSelector(selector);
  if (!matches) return [null, null];
  if (matches(root)) return [root, null];
  for (const parent of iterElements(root)) {
    for (const child of elementChildren(parent)) if (matches(child)) return [child, parent];
  }
  return [null, null];
}

export function ensureUniqueInclude(doc: XDocument, root: XElement, containerTag: string, src: string): void {
  let container = elementChildren(root).find((c) => c.tagName === containerTag);
  if (!container) {
    container = doc.createElement(containerTag);
    // put styles/scripts at the top for readability
    root.insertBefore(container, root.firstChild);
  }
  if (elementChildren(container).some((inc) => inc.tagName === "include" && inc.getAttribute("src") === src)) return;
  const include = doc.createElement("include");
  include.setAttribute("src", src);
  container.appendChild(include);
}

/** Re-indents the tree with tabs, like `ElementTree.indent(tree, space="\t")`. */
export function indent(doc: XDocument, el: XElement, level = 0): void {
  const children: XNode[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) children.push(n);
  const structural = children.filter((n) => n.nodeType === ELEMENT_NODE || n.nodeType === COMMENT_NODE);
  if (!structural.length) return;

  for (const n of children) {
    if (n.nodeType === TEXT_NODE && !n.data.trim()) el.removeChild(n);
  }
  const inner = "\n" + "\t".repeat(level + 1);
  for (const child of structural) {
    el.insertBefore(doc.createTextNode(inner), child);
    if (child.nodeType === ELEMENT_NODE) indent(doc, child, level + 1);
  }
  el.appendChild(doc.createTextNode("\n" + "\t".repeat(level)));
}

export function serialize(el: XElement): string {
  return new XMLSerializer().serializeToString(el);
}

export interface XmlModification {
  action?: string;
  src?: string;
  selector?: string;
  attribute?: string;
  value?: string;
  xml?: string;
  new_parent_selector?: string;
  [key: string]: unknown;
}

function insertSnippet(doc: XDocument, xmlFile: string, mod: XmlModification, root: XElement, after: boolean): void {
  const label = after ? "insert_after" : "insert_before";
  const [target, parent] = findWithParentBySelector(root, mod.selector);
  if (target && parent && mod.xml) {
    try {
      const node = fromString(doc, mod.xml);
      parent.insertBefore(node, after ? target.nextSibling : target);
    } catch {
      log.writeWarning(`[XML ParseError] ${label}`);
    }
  } else if (!target) {
    log.writeWarning(`[${label}] target '${mod.selector}' not found in ${path.basename(xmlFile)}`);
  } else if (!parent) {
    log.writeWarning(`[${label}] target '${mod.selector}' has no parent (is root?) in ${path.basename(xmlFile)}`);
  }
}

export function applyModifications(xmlFile: string, modifications: XmlModification[]): void {
  if (!modifications?.length) return;
  if (!fs.existsSync(xmlFile)) {
    log.writeWarning(`[Missing XML] '${xmlFile}' not found; skipping modifications`);
    return;
  }
  let doc: XDocument;
  try {
    doc = parseXml(fs.readFileSync(xmlFile, "utf8"));
  } catch {
    log.writeWarning(`[XML ParseError] Could not parse ${xmlFile}`);
    return;
  }
  const root = doc.documentElement;
  const file = path.basename(xmlFile);

  for (const mod of modifications) {
    switch (mod.action) {
      case "add_script":
        ensureUniqueInclude(doc, root, "scripts", mod.src ?? "");
        break;
      case "add_style_include":
        ensureUniqueInclude(doc, root, "styles", mod.src ?? "");
        break;
      case "set_attribute": {
        const el = findBySelector(root, mod.selector);
        if (el && mod.attribute != null && mod.value != null) el.setAttribute(mod.attribute, String(mod.value));
        break;
      }
      case "add_child": {
        const parent = findBySelector(root, mod.selector);
        if (parent && mod.xml) {
          try {
            parent.appendChild(fromString(doc, mod.xml));
          } catch {
            log.writeWarning("[XML ParseError] add_child");
          }
        } else if (!parent) {
          log.writeWarning(`[add_child] target '${mod.selector}' not found in ${file}`);
        }
        break;
      }
      case "move_into": {
        const [el, oldParent] = findWithParentBySelector(root, mod.selector);
        const newParent = findBySelector(root, mod.new_parent_selector);
        if (el && newParent) {
          if (oldParent) oldParent.removeChild(el);
          newParent.appendChild(el);
        } else {
          if (!el) log.writeWarning(`[move_into] target '${mod.selector}' not found in ${file}`);
          if (!newParent) log.writeWarning(`[move_into] new_parent '${mod.new_parent_selector}' not found in ${file}`);
        }
        break;
      }
      case "insert_after":
        insertSnippet(doc, xmlFile, mod, root, true);
        break;
      case "insert_before":
        insertSnippet(doc, xmlFile, mod, root, false);
        break;
    }
  }

  indent(doc, root);
  fs.writeFileSync(xmlFile, serialize(root), "utf8");
}

/** Evaluates conditions and variable interpolation for rules defined in xml.json. */
export function processModXml(modXml: unknown, settings: Record<string, any>): Record<string, XmlModification[]> {
  const result: Record<string, XmlModification[]> = {};
  if (!isPlainObject(modXml)) return result;

  for (const [p, mods] of Object.entries(modXml)) {
    if (!p || !Array.isArray(mods)) continue;
    const cleanPath = interpolateVariables(String(p), settings);
    const processed: XmlModification[] = [];

    for (const mod of mods) {
      if (!isPlainObject(mod)) continue;
      const cond = mod.if ?? mod.condition;
      if (cond != null && !evaluateCondition(cond, settings)) continue;
      const clean: XmlModification = {};
      for (const [k, v] of Object.entries(mod)) {
        if (k === "if" || k === "condition") continue;
        clean[k] = typeof v === "string" ? interpolateVariables(v, settings) : v;
      }
      processed.push(clean);
    }
    if (processed.length || !mods.length) (result[cleanPath] ??= []).push(...processed);
  }
  return result;
}
