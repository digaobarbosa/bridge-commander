// form — a command's `form` or a plugin's `config` fields as one labelled
// control each, and the raw values back out. Validation is not here: the
// caller passes readForm's output to fields.validateValues, the same rules the
// server applies before it runs anything.
//
// field = { type: string|text|number|boolean|enum, title?, description?,
//           default?, enum?: [..], required?: bool, placeholder? }
// formHtml is a pure string builder (every value escaped); readForm reads a
// root element's controls.
import { esc } from './util.js';

function typeOf(f) { return f.enum ? 'enum' : (f.type || 'string'); }
// A field name is plugin data: keep only id-safe characters for the element id.
function idFor(prefix, name) { return (prefix || 'bcf') + '-' + String(name).replace(/[^A-Za-z0-9_-]/g, '_'); }

function controlHtml(name, f, value, id) {
  const common = ' id="' + esc(id) + '" name="' + esc(name) + '" data-bc-field="' + esc(name) + '"' +
    (f.required ? ' required' : '') +
    (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '');
  const has = value !== undefined && value !== null;
  switch (typeOf(f)) {
    case 'text':
      return '<textarea' + common + ' rows="4">' + (has ? esc(value) : '') + '</textarea>';
    case 'number':
      return '<input type="number" step="any"' + common + (has ? ' value="' + esc(value) + '"' : '') + '>';
    case 'boolean':
      return '<input type="checkbox"' + common + (value === true || value === 'true' ? ' checked' : '') + '>';
    case 'enum':
      return '<select' + common + '>' +
        (f.required ? '' : '<option value=""' + (has ? '' : ' selected') + '>—</option>') +
        f.enum.map((o) => '<option value="' + esc(o) + '"' + (has && String(o) === String(value) ? ' selected' : '') + '>' + esc(o) + '</option>').join('') +
        '</select>';
    default:
      return '<input type="text"' + common + (has ? ' value="' + esc(value) + '"' : '') + '>';
  }
}

/**
 * Markup for `fields` filled with `values` (a field's `default` when a value is
 * absent). `idPrefix` keeps ids unique when two forms are on screen.
 */
export function formHtml(fields, values, { idPrefix } = {}) {
  const vals = values || {};
  const rows = Object.entries(fields || {}).map(([name, f]) => {
    const id = idFor(idPrefix, name);
    const v = vals[name] !== undefined ? vals[name] : f.default;
    const type = typeOf(f);
    const label = '<label for="' + esc(id) + '">' + esc(f.title || name) + (f.required ? ' <span class="bc-req" title="required">*</span>' : '') + '</label>';
    const desc = f.description ? '<small class="bc-desc">' + esc(f.description) + '</small>' : '';
    return '<div class="bc-field bc-field-' + type + '">' + label + controlHtml(name, f, v, id) + desc + '</div>';
  });
  return '<div class="bc-form">' + rows.join('') + '</div>';
}

/**
 * The raw values of `root`'s controls for the declared fields: a checkbox reads
 * as a boolean, everything else as its string. Undeclared controls are ignored.
 */
export function readForm(root, fields) {
  const out = {};
  const decl = fields || {};
  for (const el of root.querySelectorAll('[data-bc-field]')) {
    const name = el.getAttribute('data-bc-field');
    if (!Object.prototype.hasOwnProperty.call(decl, name)) continue;
    out[name] = typeOf(decl[name]) === 'boolean' ? !!el.checked : el.value;
  }
  return out;
}
