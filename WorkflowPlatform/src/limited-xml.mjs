const MAX_XML_BYTES = 8 * 1024 * 1024;
const NAME_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_";
const NAME_BODY = `${NAME_START}0123456789-`;
const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });

function isWhitespace(character) { return character === " " || character === "\t" || character === "\r" || character === "\n"; }

function decodeText(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "&") { result += value[index]; continue; }
    const end = value.indexOf(";", index + 1);
    if (end < 0) throw new Error("LIMITED_XML_ENTITY_UNCLOSED");
    const name = value.slice(index + 1, end);
    if (!Object.hasOwn(ENTITIES, name)) throw new Error(`LIMITED_XML_ENTITY_FORBIDDEN: ${name}`);
    result += ENTITIES[name];
    index = end;
  }
  return result;
}

export function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function parseLimitedXml(input) {
  let source = String(input ?? "");
  if (Buffer.byteLength(source, "utf8") > MAX_XML_BYTES) throw new Error("LIMITED_XML_TOO_LARGE");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let cursor = 0;
  const stack = [];
  let root = null;

  function skipWhitespace() { while (cursor < source.length && isWhitespace(source[cursor])) cursor += 1; }
  function readName() {
    if (!NAME_START.includes(source[cursor] ?? "")) throw new Error(`LIMITED_XML_NAME_INVALID_AT_${cursor}`);
    const start = cursor;
    cursor += 1;
    while (cursor < source.length && NAME_BODY.includes(source[cursor])) cursor += 1;
    return source.slice(start, cursor);
  }
  function appendText(text) {
    if (!text) return;
    if (!stack.length) {
      if (text.split("").some(character => !isWhitespace(character))) throw new Error("LIMITED_XML_TEXT_OUTSIDE_ROOT");
      return;
    }
    stack.at(-1).text += decodeText(text);
  }

  while (cursor < source.length) {
    const opening = source.indexOf("<", cursor);
    if (opening < 0) { appendText(source.slice(cursor)); cursor = source.length; break; }
    appendText(source.slice(cursor, opening));
    cursor = opening + 1;
    const marker = source[cursor];
    if (marker === "!" || marker === "?") throw new Error("LIMITED_XML_DECLARATION_FORBIDDEN");
    if (marker === "/") {
      cursor += 1;
      const name = readName();
      skipWhitespace();
      if (source[cursor] !== ">") throw new Error("LIMITED_XML_CLOSE_INVALID");
      cursor += 1;
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`LIMITED_XML_CLOSE_MISMATCH: ${name}`);
      continue;
    }

    const name = readName();
    const node = { name, attributes: {}, children: [], text: "" };
    while (cursor < source.length) {
      skipWhitespace();
      if (source.startsWith("/>", cursor)) {
        cursor += 2;
        if (stack.length) stack.at(-1).children.push(node);
        else if (root) throw new Error("LIMITED_XML_MULTIPLE_ROOTS");
        else root = node;
        break;
      }
      if (source[cursor] === ">") {
        cursor += 1;
        if (stack.length) stack.at(-1).children.push(node);
        else if (root) throw new Error("LIMITED_XML_MULTIPLE_ROOTS");
        else root = node;
        stack.push(node);
        break;
      }
      const attribute = readName();
      if (Object.hasOwn(node.attributes, attribute)) throw new Error(`LIMITED_XML_DUPLICATE_ATTRIBUTE: ${attribute}`);
      skipWhitespace();
      if (source[cursor] !== "=") throw new Error("LIMITED_XML_ATTRIBUTE_EQUALS_REQUIRED");
      cursor += 1;
      skipWhitespace();
      if (source[cursor] !== '"') throw new Error("LIMITED_XML_DOUBLE_QUOTE_REQUIRED");
      cursor += 1;
      const end = source.indexOf('"', cursor);
      if (end < 0) throw new Error("LIMITED_XML_ATTRIBUTE_UNCLOSED");
      node.attributes[attribute] = decodeText(source.slice(cursor, end));
      cursor = end + 1;
    }
  }
  if (stack.length) throw new Error(`LIMITED_XML_UNCLOSED_TAG: ${stack.at(-1).name}`);
  if (!root) throw new Error("LIMITED_XML_ROOT_REQUIRED");
  return root;
}

export function exactChildren(node, names) {
  const actual = node.children.map(child => child.name);
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) throw new Error(`LIMITED_XML_CHILDREN_INVALID: ${node.name}`);
  return node.children;
}

export function exactAttributes(node, names) {
  const actual = Object.keys(node.attributes).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error(`LIMITED_XML_ATTRIBUTES_INVALID: ${node.name}`);
  return node.attributes;
}
