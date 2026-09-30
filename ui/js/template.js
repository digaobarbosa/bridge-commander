// template — `${path}` in plugin data (a badge's text, a link command's url),
// filled from the frozen card context. The same getPath the `when` predicates
// read, so a path that works in one works in the other. Pure and DOM-free.
//
// Shell templates are NOT expanded here: `run.exec` never leaves the server,
// which quotes every substitution (server/commands.js).
import { getPath } from './when.js';

const VAR = /\$\{([^}]+)\}/g;

/**
 * Fill every ${path} from ctx. -> {text, missing[]}: a path that resolves to
 * nothing (undefined, null, '') is listed in `missing` and left empty.
 * Objects and lists are never stringified into the text.
 */
export function expandTemplate(tpl, ctx) {
  const missing = [];
  const text = String(tpl == null ? '' : tpl).replace(VAR, (_, p) => {
    const path = p.trim();
    const v = getPath(ctx, path);
    if (v === undefined || v === null || v === '' || typeof v === 'object') { missing.push(path); return ''; }
    return String(v);
  });
  return { text, missing };
}

/**
 * A link command's url for this card, or null. Every path must resolve (a
 * half-filled url opens the wrong page) and the result must be http(s): a
 * plugin cannot hand the board a javascript: or file: link.
 */
export function expandUrl(tpl, ctx) {
  const { text, missing } = expandTemplate(tpl, ctx);
  if (missing.length) return null;
  const url = text.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  try { return new URL(url).href; } catch (e) { return null; }
}
