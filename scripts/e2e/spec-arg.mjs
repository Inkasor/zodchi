// The spec argument of a helper command (core/scripts/gate.mjs), as the workflows type it into a runner's prompt: "b64:" and the base64
// of the spec's UTF-8 JSON text, one single-quoted shell word. The scenarios that read the spec out of a prompt, or make a command of their
// own, use these: a plain JSON argument (the older form, which the helper still accepts) is decoded the same way.

/** The text of a single-quoted shell word as the shell reads it: each '\'' stands for one apostrophe. */
export const unquote = (word) => word.replace(/'\\''/g, "'");

/** The spec an argument carries: "b64:<base64>" or plain JSON (already unquoted). Throws when it is neither. */
export function decodeSpec(arg) {
  if (arg.startsWith("b64:")) return JSON.parse(Buffer.from(arg.slice(4), "base64").toString("utf8"));
  return JSON.parse(arg);
}

/** The argument the workflows send for a spec. */
export const encodeSpec = (spec) => `b64:${Buffer.from(JSON.stringify(spec), "utf8").toString("base64")}`;

/** Every ` <command> '<argument>'` of a prompt, as { command, arg, spec } (arg is the unquoted word, spec the decoded argument). */
export function commandsIn(prompt, command = "[a-z-]+") {
  const session = / -- "\$\(pwd -W 2>\/dev\/null \|\| pwd\)" /.source;
  const re = new RegExp(`${session}(${command}) '((?:[^']|'\\\\'')*)'(?=\\n|$)`, "gm");
  return [...prompt.matchAll(re)].map((m) => ({ command: m[1], arg: unquote(m[2]), spec: decodeSpec(unquote(m[2])) }));
}

/** The decoded spec of the first ` <command> '<argument>'` of a prompt, or null when the prompt has no such command. */
export const specIn = (prompt, command) => (commandsIn(prompt, command)[0] || { spec: null }).spec;

/**
 * The prompt with every `'b64:<base64>'` argument written out as the single-quoted plain JSON the workflows sent before (an apostrophe as
 * '\''), so that a scenario can read the fields of a spec as text of the prompt. Only for reading: the runner of a scenario gets the real prompt.
 */
export const plainPrompt = (prompt) => prompt.replace(/ '(b64:[A-Za-z0-9+/=]*)'(?=\n|$)/gm, (_, arg) => ` '${JSON.stringify(decodeSpec(arg)).replace(/'/g, "'\\''")}'`);

const stringsOf = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(stringsOf) : []);

/**
 * Every text a `b64:<base64>` token anywhere in a prompt hides: the decoded text, and each string of the decoded JSON as it is (without the
 * JSON escapes of quotes and backslashes). For an assertion that a value is NOT in a prompt: the raw prompt alone cannot show it any more.
 */
export function hiddenTexts(prompt) {
  const out = [];
  for (const m of String(prompt).matchAll(/b64:([A-Za-z0-9+/=]+)/g)) {
    const text = Buffer.from(m[1], "base64").toString("utf8");
    out.push(text);
    try { out.push(...stringsOf(JSON.parse(text))); } catch { /* not JSON: the decoded text above is all there is */ }
  }
  return out;
}

/** The prompt itself and everything its encoded arguments hide, as the texts an absence assertion has to search. */
export const seenIn = (prompt) => [String(prompt), ...hiddenTexts(prompt)];
