/**
 * Tiny expression language for custom metrics and parameters. No eval: tokenise, parse to a tree, walk it.
 * Numbers, names, + − × ÷ ^, parentheses and a few functions. Band functions take a curve name first:
 * max(S11_dB, 2.40, 2.48), min(...), mean(...), at(S11_dB, 2.44).
 */

export type Node =
  | { t: 'num'; v: number }
  | { t: 'id'; name: string; pos: number }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[]; pos: number }

export class ExprError extends Error {
  pos: number
  constructor(msg: string, pos: number) { super(msg); this.pos = pos }
}

const FNS = ['sqrt', 'abs', 'log10', 'min', 'max', 'mean', 'at']
const BAND = ['min', 'max', 'mean', 'at']

export function parse(src: string): Node {
  const toks: { k: string; v: string; pos: number }[] = []
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_]\w*)|(\*\*|[-+*/^(),×÷]))/gy
  let m: RegExpExecArray | null
  let i = 0
  while (i < src.length) {
    re.lastIndex = i
    m = re.exec(src)
    if (!m || m[0].length === 0) {
      if (/^\s*$/.test(src.slice(i))) break
      throw new ExprError(`Didn't understand "${src.slice(i).trim()[0]}"`, i)
    }
    const pos = i + m[0].length - m[0].trimStart().length
    if (m[1]) toks.push({ k: 'num', v: m[1], pos })
    else if (m[2]) toks.push({ k: 'id', v: m[2], pos })
    else toks.push({ k: 'op', v: m[3] === '**' ? '^' : m[3] === '×' ? '*' : m[3] === '÷' ? '/' : m[3], pos })
    i = re.lastIndex
  }
  let p = 0
  const peek = () => toks[p]
  const take = (v?: string) => {
    const t = toks[p]
    if (!t) throw new ExprError(v ? `Expected "${v}" at the end` : 'Expression ends too early', src.length)
    if (v && t.v !== v) throw new ExprError(`Expected "${v}"`, t.pos)
    p++
    return t
  }
  const prim = (): Node => {
    const t = take()
    if (t.k === 'num') return { t: 'num', v: parseFloat(t.v) }
    if (t.k === 'id') {
      if (peek()?.v === '(') {
        if (!FNS.includes(t.v)) throw new ExprError(`Unknown function ${t.v}()`, t.pos)
        take('(')
        const args: Node[] = []
        if (peek()?.v !== ')') { args.push(add()); while (peek()?.v === ',') { take(','); args.push(add()) } }
        take(')')
        return { t: 'call', fn: t.v, args, pos: t.pos }
      }
      return { t: 'id', name: t.v, pos: t.pos }
    }
    if (t.v === '(') { const e = add(); take(')'); return e }
    if (t.v === '-') return { t: 'neg', a: pow() }
    if (t.v === '+') return pow()
    throw new ExprError(`Unexpected "${t.v}"`, t.pos)
  }
  const pow = (): Node => { const a = prim(); if (peek()?.v === '^') { take(); return { t: 'bin', op: '^', a, b: pow() } } return a }
  const mul = (): Node => { let a = pow(); while (peek() && (peek().v === '*' || peek().v === '/')) { const op = take().v; a = { t: 'bin', op, a, b: pow() } } return a }
  const add = (): Node => { let a = mul(); while (peek() && (peek().v === '+' || peek().v === '-')) { const op = take().v; a = { t: 'bin', op, a, b: mul() } } return a }
  if (!toks.length) throw new ExprError('Empty expression', 0)
  const e = add()
  if (p < toks.length) throw new ExprError(`Unexpected "${toks[p].v}"`, toks[p].pos)
  return e
}

export interface Env {
  scalars: Record<string, number>
  curves?: Record<string, (f: number) => number>
}

/** Every name the expression uses (not function names). */
export function names(n: Node, out = new Set<string>()): Set<string> {
  if (n.t === 'id') out.add(n.name)
  else if (n.t === 'neg') names(n.a, out)
  else if (n.t === 'bin') { names(n.a, out); names(n.b, out) }
  else if (n.t === 'call') n.args.forEach((a) => names(a, out))
  return out
}

/** Check names and argument shapes against what's available, without evaluating. */
export function check(n: Node, scalars: string[], curves: string[]) {
  const walk = (n: Node, curveOk = false): void => {
    if (n.t === 'id') {
      if (curves.includes(n.name)) { if (!curveOk) throw new ExprError(`${n.name} is a curve; use it inside max/min/mean(${n.name}, f1, f2) or at(${n.name}, f)`, n.pos); return }
      if (!scalars.includes(n.name)) throw new ExprError(`Unknown name ${n.name}`, n.pos)
    } else if (n.t === 'neg') walk(n.a)
    else if (n.t === 'bin') { walk(n.a); walk(n.b) }
    else if (n.t === 'call') {
      const first = n.args[0]
      const band = BAND.includes(n.fn) && first?.t === 'id' && curves.includes(first.name)
      if (n.fn === 'at' && !band) throw new ExprError('at() needs a curve first, like at(S11_dB, 2.44)', n.pos)
      if (band) {
        const want = n.fn === 'at' ? 2 : 3
        if (n.args.length !== want) throw new ExprError(`${n.fn}(curve, ${n.fn === 'at' ? 'f' : 'f1, f2'}) takes ${want} arguments`, n.pos)
        n.args.slice(1).forEach((a) => walk(a))
      } else {
        if (['sqrt', 'abs', 'log10'].includes(n.fn) && n.args.length !== 1) throw new ExprError(`${n.fn}() takes one argument`, n.pos)
        if (!n.args.length) throw new ExprError(`${n.fn}() needs an argument`, n.pos)
        n.args.forEach((a) => walk(a))
      }
    }
  }
  walk(n)
}

export function evaluate(n: Node, env: Env): number {
  switch (n.t) {
    case 'num': return n.v
    case 'id': return env.scalars[n.name] ?? NaN
    case 'neg': return -evaluate(n.a, env)
    case 'bin': {
      const a = evaluate(n.a, env), b = evaluate(n.b, env)
      return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : n.op === '/' ? a / b : a ** b
    }
    case 'call': {
      const first = n.args[0]
      const curve = first?.t === 'id' ? env.curves?.[first.name] : undefined
      if (curve) {
        if (n.fn === 'at') return curve(evaluate(n.args[1], env))
        const f1 = evaluate(n.args[1], env), f2 = evaluate(n.args[2], env)
        const lo = Math.min(f1, f2), hi = Math.max(f1, f2), k = Math.max(2, Math.round((hi - lo) / 0.002))
        const ys = Array.from({ length: k + 1 }, (_, i) => curve(lo + ((hi - lo) * i) / k))
        return n.fn === 'max' ? Math.max(...ys) : n.fn === 'min' ? Math.min(...ys) : ys.reduce((a, b) => a + b, 0) / ys.length
      }
      const xs = n.args.map((a) => evaluate(a, env))
      switch (n.fn) {
        case 'sqrt': return Math.sqrt(xs[0])
        case 'abs': return Math.abs(xs[0])
        case 'log10': return Math.log10(xs[0])
        case 'min': return Math.min(...xs)
        case 'max': return Math.max(...xs)
        default: return xs.reduce((a, b) => a + b, 0) / xs.length
      }
    }
  }
}
