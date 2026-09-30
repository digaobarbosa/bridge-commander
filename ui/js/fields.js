// fields — the one set of rules for a plugin's form and config fields.
// A command's `form` and a plugin's `config` are both `{ <name>: field }` with
//   field = { type: string|text|number|boolean|enum, title?, description?,
//             default?, enum?: [..], required?: bool, placeholder? }
// The modal validates with this before it posts; the server validates with
// this same file before it runs anything. Pure and DOM-free.

/** The defaults a form opens with: each field's `default`, overlaid by `given` values it declares. */
export function defaultsFor(fields, given) {
  const out = {};
  for (const [k, f] of Object.entries(fields || {})) if (f.default !== undefined) out[k] = f.default;
  if (given && typeof given === 'object') {
    for (const [k, v] of Object.entries(given)) if (fields && k in fields && v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function typeOf(f) { return f.enum ? 'enum' : (f.type || 'string'); }

/**
 * Coerce and check raw values (strings from a form, or JSON) against fields.
 * -> {values} or {error, field}. Unknown keys are dropped; a missing optional
 * field takes its default or stays absent.
 */
export function validateValues(fields, raw) {
  const values = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [name, f] of Object.entries(fields || {})) {
    let v = src[name];
    const label = f.title || name;
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty) {
      if (f.default !== undefined) { values[name] = f.default; continue; }
      if (f.required) return { error: label + ' is required', field: name };
      continue;
    }
    switch (typeOf(f)) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        if (!Number.isFinite(n)) return { error: label + ' must be a number', field: name };
        v = n;
        break;
      }
      case 'boolean':
        if (typeof v !== 'boolean') {
          const s = String(v).toLowerCase();
          if (['true', 'on', '1', 'yes'].includes(s)) v = true;
          else if (['false', 'off', '0', 'no'].includes(s)) v = false;
          else return { error: label + ' must be true or false', field: name };
        }
        break;
      case 'enum':
        if (!f.enum.map(String).includes(String(v))) return { error: label + ' must be one of ' + f.enum.join(', '), field: name };
        v = f.enum.find((e) => String(e) === String(v));
        break;
      default:
        v = String(v);
        if (typeOf(f) === 'string' && v.includes('\n')) return { error: label + ' must be one line', field: name };
    }
    values[name] = v;
  }
  return { values };
}
