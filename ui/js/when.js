// when — the JSON predicates that decide where a contribution shows up.
// The board evaluates them over a small frozen context (card.*, project.*,
// worker.*, harness); plugins never run code to answer "is this visible?".
// Pure and DOM-free: the server imports this same file to re-check a command's
// `when` before it runs one, so the two sides can never disagree.
//
// A predicate is an object. Each key is either
//   a dotted path  ('card.column', 'card.attributes.prs[0].url') → a field test, or
//   a combinator   $all: [p…] (and) · $any: [p…] (or) · $not: p
// All keys of one object must hold (implicit and).
//
// A field test is a plain value (equality; when the field is a list: it
// contains the value) or an object of operators:
//   $eq $ne $in $nin $exists $gt $gte $lt $lte $regex $contains
// An unknown operator throws at COMPILE time, so a typo fails when the
// manifest loads, not silently on every render.

const FIELD_OPS = new Set(['$eq', '$ne', '$in', '$nin', '$exists', '$gt', '$gte', '$lt', '$lte', '$regex', '$contains']);

/** The value at a dotted path, `undefined` when any step is missing. */
export function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) cur = cur[m[1]];
    for (const idx of m[2].match(/\d+/g) || []) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[Number(idx)];
    }
  }
  return cur;
}

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function eq(actual, expected) {
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((a) => eq(a, expected));
  if (isObj(expected) || Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  return actual === expected;
}

function present(v) {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObj(v)) return Object.keys(v).length > 0;
  return true;
}

function compileField(path, test) {
  if (!isObj(test) || !Object.keys(test).some((k) => k.startsWith('$'))) {
    return (ctx) => eq(getPath(ctx, path), test);
  }
  const checks = Object.entries(test).map(([op, arg]) => {
    if (!FIELD_OPS.has(op)) throw new Error('when: unknown operator "' + op + '" on "' + path + '"');
    switch (op) {
      case '$eq': return (v) => eq(v, arg);
      case '$ne': return (v) => !eq(v, arg);
      case '$in':
        if (!Array.isArray(arg)) throw new Error('when: $in on "' + path + '" needs a list');
        return (v) => arg.some((a) => eq(v, a));
      case '$nin':
        if (!Array.isArray(arg)) throw new Error('when: $nin on "' + path + '" needs a list');
        return (v) => !arg.some((a) => eq(v, a));
      // "exists" means carries something: an empty list or string is nothing,
      // the same rule the playbook `requires` check uses.
      case '$exists': return (v) => present(v) === !!arg;
      case '$gt': return (v) => typeof v === typeof arg && v > arg;
      case '$gte': return (v) => typeof v === typeof arg && v >= arg;
      case '$lt': return (v) => typeof v === typeof arg && v < arg;
      case '$lte': return (v) => typeof v === typeof arg && v <= arg;
      case '$regex': {
        const re = new RegExp(String(arg));
        return (v) => typeof v === 'string' && re.test(v);
      }
      case '$contains':
        return (v) => (Array.isArray(v) ? v.some((a) => eq(a, arg)) : typeof v === 'string' && v.includes(String(arg)));
      default: return () => false;
    }
  });
  return (ctx) => {
    const v = getPath(ctx, path);
    return checks.every((c) => c(v));
  };
}

/** Compile a predicate once into (ctx) => boolean. `undefined`/`null` = always true. Throws on a malformed predicate. */
export function compileWhen(pred) {
  if (pred === undefined || pred === null) return () => true;
  if (!isObj(pred)) throw new Error('when: a predicate must be an object');
  const parts = Object.entries(pred).map(([key, val]) => {
    if (key === '$all' || key === '$any') {
      if (!Array.isArray(val)) throw new Error('when: ' + key + ' needs a list of predicates');
      const subs = val.map(compileWhen);
      return key === '$all' ? (ctx) => subs.every((s) => s(ctx)) : (ctx) => subs.some((s) => s(ctx));
    }
    if (key === '$not') {
      const sub = compileWhen(val);
      return (ctx) => !sub(ctx);
    }
    if (key.startsWith('$')) throw new Error('when: unknown combinator "' + key + '"');
    return compileField(key, val);
  });
  return (ctx) => parts.every((p) => p(ctx));
}

// Compiled predicates are cached by their JSON: manifests are loaded once, and
// the same `when` is asked about every card on every render.
const cache = new Map();

/** Does ctx satisfy pred? Compiles (and caches) on first use. */
export function matches(pred, ctx) {
  if (pred === undefined || pred === null) return true;
  const key = JSON.stringify(pred);
  let fn = cache.get(key);
  if (!fn) {
    fn = compileWhen(pred);
    if (cache.size > 500) cache.clear();
    cache.set(key, fn);
  }
  return fn(ctx);
}
