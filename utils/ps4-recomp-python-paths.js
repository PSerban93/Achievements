"use strict";

// Recognize a small vocabulary of path/config expressions in Python bytecode.
// Values are data, not executable functions. Unknown operations stay unresolved.
const U = Symbol("unresolved"), ENV = { kind: "environment" };
const expr = (op, fields = {}) => ({ op, ...fields });
const isExpr = (v) => v && typeof v === "object" && typeof v.op === "string";
function truth(value) { return value === U || isExpr(value) ? U : Array.isArray(value) ? value.length > 0 : !!value; }
function conditional(condition, yes, no) {
  if (yes === U || no === U) return U;
  return expr("if", { condition, yes, no });
}
function instructions(code) {
  const result = []; let extension = 0;
  for (let at = 0; at < code.bytes.length; at += 2) {
    const op = code.bytes[at], arg = extension + code.bytes[at + 1];
    extension = op === 144 ? arg * 256 : 0;
    if (op !== 0 && op !== 144) result.push({ at, op, arg });
  }
  return result;
}
function analyze(bundle, executable, diagnostic = () => {}) {
  const modules = new Map(), reads = [], primaryReads = [], commands = [], aliases = [];
  let steps = 0, forks = 0;
  const external = (name) => ({ kind: "external", name });
  const functions = (code) => code.constants.filter((v) => v?.kind === "code");
  const imports = (code) => instructions(code).filter((i) => i.op === 108).map((i) => code.names[i.arg]).filter(Boolean);
  const startupValue = (value) => {
    if (value?.op === "env") return process.env[value.key] || value.fallback;
    if (value?.op === "if") { const test = startupValue(value.condition); return test === U ? U : startupValue(test ? value.yes : value.no); }
    return isExpr(value) ? U : value;
  };
  const wellKnown = /^(?:os|sys|json|pathlib|subprocess|datetime|time|re|struct|typing|collections)(?:\.|$)/;
  function module(name, code) {
    if (modules.has(name)) return modules.get(name);
    if (modules.size >= 24) return U;
    code ||= bundle.module(name);
    if (!code || code.kind !== "code") return external(name);
    const value = { kind: "module", name, code, globals: new Map() }; modules.set(name, value);
    for (const fn of functions(code)) value.globals.set(fn.name, { kind: "function", code: fn, module: value });
    run(code, value, [], 0, true);
    return value;
  }
  function attribute(value, name) {
    if (value === U || !name) return U;
    if (value?.kind === "external") {
      const full = value.name + "." + name;
      if (full === "os.environ") return ENV;
      if (full === "os.name") return "nt";
      if (full === "sys.executable") return expr("executable");
      if (full === "sys.frozen") return true;
      return external(full);
    }
    if (value?.kind === "module") return value.globals.get(name) ?? U;
    if (isExpr(value) && name === "parent") return expr("parent", { value });
    return { kind: "method", value, name };
  }
  function call(target, args, kwargs, depth) {
    if (target === U || args.some((arg) => arg === U)) return U;
    if (target?.kind === "function") {
      const value = run(target.code, target.module, args, depth + 1);
      diagnostic({ call: target.code.name, unresolved: value === U });
      return value;
    }
    if (target?.kind === "method") {
      const { value, name } = target;
      if (value === ENV && name === "get" && typeof args[0] === "string") return expr("env", { key: args[0], fallback: args[1] });
      if (name === "get" && typeof args[0] === "string") {
        if (value instanceof Map) return value.has(args[0]) ? value.get(args[0]) : args[1];
        if (isExpr(value)) return expr("get", { value, key: args[0], fallback: args[1] });
      }
      if (["resolve", "expanduser", "strip"].includes(name) && (typeof value === "string" || isExpr(value))) return expr(name, { value });
      if (name === "read_text" && isExpr(value)) return { kind: "text", path: value };
      if (name === "symlink_to" && isExpr(value) && isExpr(args[0])) { aliases.push(value); return undefined; }
      if (name === "update" && value instanceof Map && value.has("game_dir") && args[0]?.op === "json") primaryReads.push(args[0].value);
      if (["mkdir", "unlink", "insert", "update"].includes(name)) return undefined; // Records only; no filesystem effects.
      if (["is_file", "exists", "is_symlink"].includes(name) && isExpr(value)) return expr("exists", { value, type: name });
      if (name === "glob") return [];
      if (name === "open" && isExpr(value)) return { kind: "file", path: value };
      return U;
    }
    if (target?.kind !== "external") return U;
    const name = target.name;
    if (name === "Path" || name === "pathlib.Path") return args[0] === undefined ? U : expr("path", { value: args[0] });
    if (name === "Path.home" || name === "pathlib.Path.home") return expr("home");
    if (name === "bool") return truth(args[0]);
    if (name === "str") return isExpr(args[0]) ? expr("str", { value: args[0] }) : args[0] && typeof args[0] === "object" ? U : String(args[0] ?? "");
    if (name === "int") return typeof args[0] === "number" || typeof args[0] === "boolean" ? Number(args[0]) : U;
    if (name === "getattr") return args[0]?.name === "sys" && args[1] === "frozen" ? true : args[2];
    if (name === "dict") return args[0] instanceof Map ? new Map(args[0]) : new Map();
    if (name === "isinstance") return args[0]?.op === "json" ? true : U;
    if (name === "sorted") return Array.isArray(args[0]) ? [...args[0]] : U;
    if (name === "json.loads" && args[0]?.kind === "text") {
      reads.push(args[0].path); return expr("json", { value: args[0].path });
    }
    if (name === "open" && isExpr(args[0])) return { kind: "file", path: args[0] };
    if (name === "subprocess.Popen") { commands.push({ args: args[0], stdout: kwargs.stdout }); return U; }
    if (/^datetime\./.test(name)) return expr("dynamic");
    return U;
  }
  function run(code, owner, args, depth, top = false) {
    if (depth > 12 || steps > 60000) return U;
    const ops = instructions(code), indices = new Map(ops.map((i, index) => [i.at, index]));
    const globals = owner.globals, locals = new Map();
    for (let i = 0; i < code.argc + code.kwonly; i++) locals.set(code.locals[i], args[i]);
    function execute(state) {
      const { stack, locals: local } = state; let keywords = [];
      const pop = () => stack.length ? stack.pop() : U;
      while (state.pc < ops.length && ++steps <= 60000) {
        const { op, arg, at } = ops[state.pc++];
        const name = code.names[arg], jump = (target) => indices.get(target) ?? ops.length;
        if (op === 151 || op === 9) continue;
        if (op === 100) stack.push(code.constants[arg]);
        else if (op === 101 || op === 116) {
          const key = code.names[op === 116 ? Math.floor(arg / 2) : arg];
          stack.push(key === "__file__" ? expr("executable") : globals.has(key) ? globals.get(key) : external(key));
        } else if (op === 124 || op === 127) stack.push(local.has(code.locals[arg]) ? local.get(code.locals[arg]) : U);
        else if (op === 125) local.set(code.locals[arg], pop());
        else if (op === 90 || op === 97) { const v = pop(); if (top && v !== U) globals.set(name, v); }
        else if (op === 106) stack.push(attribute(pop(), code.names[Math.floor(arg / 2)]));
        else if (op === 108) { pop(); pop(); stack.push(wellKnown.test(name) ? external(name) : { kind: "import", name }); }
        else if (op === 109) {
          let v = stack[stack.length - 1]; if (v?.kind === "import") v = module(v.name);
          stack.push(attribute(v, name));
        } else if (op === 1) pop();
        else if (op === 2) { /* Call protocol sentinel is not needed for data values. */ }
        else if (op === 120) stack.push(stack.length >= arg ? stack[stack.length - arg] : U);
        else if (op === 99) { const end = stack.length - 1, other = stack.length - arg; [stack[end], stack[other]] = [stack[other], stack[end]]; }
        else if (op === 102 || op === 103 || op === 104) stack.push(stack.splice(Math.max(0, stack.length - arg), arg));
        else if (op === 105) {
          const items = stack.splice(Math.max(0, stack.length - arg * 2), arg * 2), map = new Map();
          for (let i = 0; i < items.length; i += 2) map.set(items[i], items[i + 1]); stack.push(map);
        } else if (op === 156) {
          const keys = pop(), values = stack.splice(Math.max(0, stack.length - arg), arg);
          stack.push(Array.isArray(keys) ? new Map(keys.map((k, i) => [k, values[i]])) : U);
        } else if (op === 132) {
          const fn = pop(); for (const bit of [8, 4, 2, 1]) if (arg & bit) pop();
          stack.push(fn?.kind === "code" ? { kind: "function", code: fn, module: owner } : U);
        } else if (op === 172) keywords = code.constants[arg] || [];
        else if (op === 142) {
          const kw = arg & 1 ? pop() : new Map(), values = pop(), target = pop();
          stack.push(call(target, Array.isArray(values) ? values : [], kw instanceof Map ? Object.fromEntries(kw) : {}, depth));
        } else if (op === 164 || op === 165) {
          const other = pop(), target = stack[stack.length - arg];
          if (target instanceof Map && other instanceof Map) for (const [k, v] of other) target.set(k, v);
        } else if (op === 147) {
          const value = pop(), key = pop(), target = stack[stack.length - arg];
          if (target instanceof Map) target.set(key, value);
        } else if (op === 145 || op === 162 || op === 163) {
          const value = pop(), target = stack[stack.length - arg];
          if (Array.isArray(target)) { if (op === 145) target.push(value); else if (Array.isArray(value)) target.push(...value); }
        } else if (op === 171) {
          const values = stack.splice(Math.max(0, stack.length - arg), arg), target = pop(), kwargs = Object.create(null);
          keywords.forEach((k, i) => { kwargs[k] = values[values.length - keywords.length + i]; });
          if (target?.kind === "import") stack.push(U);
          else stack.push(call(target, values.slice(0, values.length - keywords.length), kwargs, depth));
          keywords = [];
        } else if (op === 122) {
          const right = pop(), left = pop();
          stack.push(arg === 11 && left !== U && right !== U ? expr("join", { left, right }) : U);
        } else if (op === 26) {
          const stop = pop(), start = pop(), value = pop();
          stack.push(Array.isArray(value) ? value.slice(typeof start === "number" ? start : 0, typeof stop === "number" ? stop : undefined) : U);
        } else if (op === 25) {
          const key = pop(), value = pop();
          stack.push(value === ENV && typeof key === "string" ? expr("env", { key }) : value instanceof Map ? value.get(key) :
            isExpr(value) && typeof key === "string" ? expr("get", { value, key }) : U);
        } else if (op === 12) { const t = truth(pop()); stack.push(t === U ? U : !t); }
        else if (op === 107 || op === 117) { const b = pop(), a = pop(); stack.push(a === U || b === U || isExpr(a) || isExpr(b) ? U : op === 117 ? (arg ? a !== b : a === b) : arg >> 4 === 2 ? a === b : U); }
        else if (op === 68) { const values = pop(); stack.push(Array.isArray(values) ? { kind: "iterator", values, index: 0 } : U); }
        else if (op === 93) {
          const iterator = pop();
          if (iterator?.kind !== "iterator") return U;
          if (iterator.index >= iterator.values.length) { state.pc = jump(at + 4 + arg * 2); }
          else { stack.push({ ...iterator, index: iterator.index + 1 }, iterator.values[iterator.index]); }
        } else if (op === 4) { /* FOR_ITER already removed the exhausted iterator. */ }
        else if (op === 110 || op === 140 || op === 134) state.pc = jump(at + 2 + (op === 110 ? arg : -arg) * 2);
        else if ([114, 115, 128, 129].includes(op)) {
          const value = pop();
          let test = op === 128 || op === 129 ? value === undefined : truth(top ? startupValue(value) : value);
          if (op === 128) test = !test;
          if (op === 114 && test !== U) test = !test;
          const target = jump(at + 2 + arg * 2);
          if (test === U) {
            if (++forks > 80 || top) return U;
            const branched = execute({ pc: target, stack: [...stack], locals: new Map(local) });
            const continued = execute({ pc: state.pc, stack: [...stack], locals: new Map(local) });
            return value === U ? U : op === 114 ? conditional(value, continued, branched) : conditional(value, branched, continued);
          }
          if (test) state.pc = target;
        } else if (op === 155) { if (arg & 4) pop(); const value = pop(); stack.push(value === U ? expr("dynamic") : value); }
        else if (op === 157) stack.push(expr("format", { values: stack.splice(Math.max(0, stack.length - arg), arg) }));
        else if (op === 53) { const value = pop(); stack.push(U, value); }
        else if (op === 83) return pop();
        else if (op === 121) return code.constants[arg];
        else { diagnostic({ function: code.name, unsupported: op, at }); return U; }
        // Resolve an import only when accessed, never import a GUI/stdlib tree.
        if (op === 106 && stack[stack.length - 1]?.kind === "method" && stack[stack.length - 1].value?.kind === "import") {
          const method = stack.pop(); stack.push(attribute(module(method.value.name), method.name));
        }
        if (stack.length > 2048) return U;
      }
      return U;
    }
    return execute({ pc: 0, stack: [], locals });
  }
  // Only modules imported by an entry point can own this launcher's settings.
  const queue = bundle.scripts.map((item) => module(item.name, item.code)), inspected = new Set();
  while (queue.length && inspected.size < 24) {
    const item = queue.shift(); if (item?.kind !== "module" || inspected.has(item.name)) continue;
    inspected.add(item.name);
    for (const name of imports(item.code)) {
      if (wellKnown.test(name) || !bundle.names.includes(name)) continue;
      const code = modules.get(name)?.code || bundle.module(name);
      if (!code) continue;
      // Read only application modules with launcher/runtime declarations, not
      // bundled GUI frameworks and unrelated standard-library modules.
      const strings = code.constants.filter((v) => typeof v === "string");
      const relevant = strings.some((s) => /boot-linked\.bin|--app0|settings\.json|launcher\.json/.test(s)) ||
        functions(code).some((fn) => fn.constants.some((s) => typeof s === "string" && /^(?:--app0|settings\.json|launcher\.json)$/.test(s)));
      if (relevant) queue.push(module(name, code));
    }
    for (const fn of functions(item.code)) {
      if (fn.names.includes("loads") && fn.names.includes("read_text")) run(fn, item, [], 0);
      if (fn.names.includes("Popen") && fn.constants.includes("--app0")) run(fn, item, [expr("settings"), 0], 0);
    }
  }
  const validCommands = commands.filter((command) => Array.isArray(command.args) && command.args.includes("--app0"));
  diagnostic({ modules: [...modules.keys()], steps, forks, reads: reads.length, primaryReads: primaryReads.length, commands: commands.length });
  if (!validCommands.length || steps > 60000 || forks > 80 || validCommands.some(({ args }) => !args.includes("--user") || !isExpr(args[args.indexOf("--user") + 1]))) return null;
  const users = validCommands.map(({ args }) => args[args.indexOf("--user") + 1]).filter((v) => v !== U && isExpr(v));
  const userPointers = new Set();
  const findPointers = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 48) return;
    if (node.op === "json") userPointers.add(JSON.stringify(node.value));
    for (const value of Object.values(node)) findPointers(value, depth + 1);
  };
  users.forEach((node) => findPointers(node));
  const primary = new Set(primaryReads.map((v) => JSON.stringify(v)));
  const settings = (primary.size ? primaryReads : reads).filter((v) => isExpr(v) && (!userPointers.has(JSON.stringify(v)) || primary.has(JSON.stringify(v))));
  const logs = [...aliases, ...validCommands.flatMap((command) => command.stdout?.kind === "file" ? [command.stdout.path] : [])].filter((v) => isExpr(v));
  // Undefined/unresolved values cannot escape into the production resolver.
  const clean = (value, depth = 0) => {
    if (depth > 48 || value === U || typeof value === "symbol") throw new Error("Unresolved compiled launcher expression");
    if (value === undefined || value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
    if (!isExpr(value)) throw new Error("Unsupported compiled launcher value");
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, depth + 1)]));
  };
  const unique = (items) => [...new Map(items.flatMap((v) => { try { const item = clean(v); return [[JSON.stringify(item), item]]; } catch { return []; } })).values()];
  const result = { executable, settings: unique(settings), users: unique(users), logs: unique(logs), runtime: unique(validCommands.map((c) => c.args[0])) };
  return result.settings.length && result.users.length && result.logs.length ? result : null;
}
module.exports = { analyze, instructions };
