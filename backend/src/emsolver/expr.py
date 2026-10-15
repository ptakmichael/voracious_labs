"""Safe expression language for custom variables and metrics (EXPLORER_README §3).

Expressions are tokenized and parsed into a small AST by hand; nothing is ever passed to Python's
`eval`. Supported: numbers, names, + − * / ^ (or **), parentheses, sqrt abs log10 min max mean, and
the band functions max/min/mean(X, f1, f2), at(X, f), argmin(X, f1, f2) over a frequency-dependent
metric X. Units are tracked so unit-inconsistent expressions produce warnings.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable

SCALAR_FUNCS = {"sqrt", "abs", "log10", "min", "max", "mean"}
BAND_FUNCS = {"max", "min", "mean", "argmin", "at"}
FUNCS = SCALAR_FUNCS | BAND_FUNCS
CONSTANTS = {"pi": math.pi}


class ExprError(Exception):
    def __init__(self, msg: str, pos: int | None = None):
        super().__init__(msg)
        self.msg, self.pos = msg, pos


# ---------------------------------------------------------------- tokenizer + parser
_TOKEN = re.compile(r"\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^(),]))")


def tokenize(src: str) -> list[tuple[str, Any, int]]:
    out, i = [], 0
    src = src.replace("−", "-").replace("×", "*").replace("÷", "/")
    while i < len(src):
        if src[i:].strip() == "":
            break
        m = _TOKEN.match(src, i)
        if not m:
            j = i + len(src[i:]) - len(src[i:].lstrip())
            raise ExprError(f"unexpected character '{src[j]}'", j)
        num, name, op = m.groups()
        pos = m.start(m.lastindex)
        if num is not None:
            out.append(("num", float(num), pos))
        elif name is not None:
            out.append(("name", name, pos))
        else:
            out.append(("op", "^" if op == "**" else op, pos))
        i = m.end()
    out.append(("end", None, len(src)))
    return out


class _Parser:
    """Precedence climbing: + − < * / < unary − < ^ (right-assoc) < call/atom."""

    def __init__(self, src: str):
        self.toks = tokenize(src)
        self.i = 0

    def peek(self):
        return self.toks[self.i]

    def take(self, kind=None, val=None):
        t = self.toks[self.i]
        if (kind and t[0] != kind) or (val is not None and t[1] != val):
            want = val or kind
            got = "end of expression" if t[0] == "end" else f"'{t[1]}'"
            raise ExprError(f"expected {want}, got {got}", t[2])
        self.i += 1
        return t

    def parse(self):
        if self.peek()[0] == "end":
            raise ExprError("empty expression", 0)
        node = self.expr()
        t = self.peek()
        if t[0] != "end":
            raise ExprError(f"unexpected '{t[1]}'", t[2])
        return node

    def expr(self):
        node = self.term()
        while self.peek()[0] == "op" and self.peek()[1] in "+-":
            op = self.take()[1]
            node = ("bin", op, node, self.term())
        return node

    def term(self):
        node = self.unary()
        while self.peek()[0] == "op" and self.peek()[1] in "*/":
            op = self.take()[1]
            node = ("bin", op, node, self.unary())
        return node

    def unary(self):
        if self.peek()[0] == "op" and self.peek()[1] in "+-":
            op = self.take()[1]
            inner = self.unary()
            return ("neg", inner) if op == "-" else inner
        return self.power()

    def power(self):
        base = self.atom()
        if self.peek()[0] == "op" and self.peek()[1] == "^":
            self.take()
            return ("bin", "^", base, self.unary())
        return base

    def atom(self):
        t = self.peek()
        if t[0] == "num":
            self.take()
            return ("num", t[1])
        if t[0] == "name":
            self.take()
            if self.peek()[0] == "op" and self.peek()[1] == "(":
                if t[1] not in FUNCS:
                    raise ExprError(f"unknown function '{t[1]}' (available: {', '.join(sorted(FUNCS))})", t[2])
                self.take()
                args = [self.expr()]
                while self.peek()[0] == "op" and self.peek()[1] == ",":
                    self.take()
                    args.append(self.expr())
                self.take("op", ")")
                return ("call", t[1], args, t[2])
            return ("name", t[1], t[2])
        if t[0] == "op" and t[1] == "(":
            self.take()
            node = self.expr()
            self.take("op", ")")
            return node
        raise ExprError("expected a number, name or '('" if t[0] != "end" else "expression ends too early", t[2])


def parse(src: str):
    return _Parser(src).parse()


def names(node) -> set[str]:
    """Every identifier referenced (functions excluded)."""
    k = node[0]
    if k == "name":
        return {node[1]} - set(CONSTANTS)
    if k == "neg":
        return names(node[1])
    if k == "bin":
        return names(node[2]) | names(node[3])
    if k == "call":
        return set().union(*(names(a) for a in node[2]))
    return set()


# ---------------------------------------------------------------- units
# A unit is a dict {dimension: exponent}; None means "a bare number" that adopts the unit of
# whatever it is combined with (so "-10 - max(S11_dB, ...)" stays in dB).
Unit = dict[str, float] | None


def parse_unit(s: str | None) -> Unit:
    s = (s or "").strip()
    if s in ("", "1", "-"):
        return {}
    out: dict[str, float] = {}
    sign = 1
    for part in re.split(r"(\*|/)", s.replace(" ", "")):
        if part == "/":
            sign = -1
            continue
        if part in ("*", ""):
            continue
        base, _, exp = part.partition("^")
        out[base] = out.get(base, 0) + sign * (float(exp) if exp else 1)
    return {k: v for k, v in out.items() if v}


def fmt_unit(u: Unit) -> str:
    if not u:
        return ""
    num = [f"{k}^{v:g}" if v != 1 else k for k, v in sorted(u.items()) if v > 0]
    den = [f"{k}^{-v:g}" if v != -1 else k for k, v in sorted(u.items()) if v < 0]
    s = "·".join(num) or "1"
    return s + ("/" + "·".join(den) if den else "")


def _mul(a: Unit, b: Unit, sign=1) -> Unit:
    if a is None and b is None:
        return None
    out = dict(a or {})
    for k, v in (b or {}).items():
        out[k] = out.get(k, 0) + sign * v
    return {k: v for k, v in out.items() if abs(v) > 1e-12}


# ---------------------------------------------------------------- analysis
@dataclass
class Context:
    """What an expression may reference. `scalars` maps names to units; `series` are frequency-dependent
    metrics (only usable inside band functions); `band_ok` is False for input-variable expressions."""
    scalars: dict[str, Unit]
    series: dict[str, Unit] = field(default_factory=dict)
    band_ok: bool = False


@dataclass
class Analysis:
    ast: Any = None
    unit: Unit = None
    deps: set[str] = field(default_factory=set)
    errors: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _is_band_call(node, ctx: Context) -> bool:
    return (node[0] == "call" and node[1] in BAND_FUNCS and node[2] and node[2][0][0] == "name"
            and node[2][0][1] in ctx.series)


def analyze(src: str, ctx: Context) -> Analysis:
    a = Analysis()
    try:
        a.ast = parse(src)
    except ExprError as e:
        a.errors.append({"msg": e.msg, "pos": e.pos})
        return a

    def err(msg, pos=None):
        a.errors.append({"msg": msg, "pos": pos})
        return None

    def same(u1: Unit, u2: Unit, what: str) -> Unit:
        if u1 is None:
            return u2
        if u2 is None:
            return u1
        if u1 != u2:
            a.warnings.append(f"unit mismatch in {what}: {fmt_unit(u1) or 'dimensionless'} vs "
                              f"{fmt_unit(u2) or 'dimensionless'}")
        return u1

    def walk(n) -> Unit:
        k = n[0]
        if k == "num":
            return None
        if k == "name":
            nm = n[1]
            if nm in CONSTANTS:
                return None
            if nm in ctx.scalars:
                a.deps.add(nm)
                return ctx.scalars[nm]
            if nm in ctx.series:
                return err(f"'{nm}' depends on frequency; use it inside max/min/mean({nm}, f1, f2), "
                           f"at({nm}, f) or argmin({nm}, f1, f2)", n[2])
            return err(f"unknown name '{nm}'", n[2])
        if k == "neg":
            return walk(n[1])
        if k == "bin":
            op, ua, ub = n[1], walk(n[2]), walk(n[3])
            if op in "+-":
                return same(ua, ub, f"'{op}'")
            if op == "*":
                return _mul(ua, ub)
            if op == "/":
                return _mul(ua, ub, -1)
            # power: exponent must be a plain number to keep units meaningful
            if ub:
                a.warnings.append("exponent should be dimensionless")
            if ua and n[3][0] == "num":
                return {kk: v * n[3][1] for kk, v in ua.items()}
            if ua:
                a.warnings.append("power of a quantity with units needs a numeric exponent")
            return ua
        if k == "call":
            fn, args, pos = n[1], n[2], n[3]
            if _is_band_call(n, ctx):
                if not ctx.band_ok:
                    return err(f"band functions are only available in metric expressions", pos)
                want = 2 if fn == "at" else 3
                if len(args) != want:
                    return err(f"{fn}(X, {'f' if fn == 'at' else 'f1, f2'}) takes {want} arguments", pos)
                for fa in args[1:]:
                    if names(fa):
                        err(f"frequency arguments of {fn}() must be numbers in GHz", pos)
                a.deps.add(args[0][1])
                return {"GHz": 1} if fn == "argmin" else ctx.series[args[0][1]]
            if fn in ("argmin", "at"):
                return err(f"{fn}() needs a frequency-dependent metric as its first argument "
                           f"({', '.join(sorted(ctx.series)) or 'none available here'})", pos)
            us = [walk(x) for x in args]
            if fn in ("sqrt", "abs", "log10"):
                if len(args) != 1:
                    return err(f"{fn}() takes one argument", pos)
                if fn == "sqrt":
                    return {kk: v / 2 for kk, v in us[0].items()} if us[0] else us[0]
                if fn == "log10" and us[0]:
                    a.warnings.append("log10 of a quantity with units")
                    return {}
                return us[0]
            if not args:
                return err(f"{fn}() needs at least one argument", pos)
            u = us[0]
            for x in us[1:]:
                u = same(u, x, f"{fn}()")
            return u
        return err("bad expression")

    a.unit = walk(a.ast)
    return a


# ---------------------------------------------------------------- evaluation
@dataclass
class Env:
    """Values for evaluation. `band(fn, name, f1, f2)` evaluates a band function on a frequency series and
    returns (value, active_frequency); the active points are recorded so callers can detect non-smooth jumps."""
    scalars: Callable[[str], float]
    band: Callable[[str, str, float, float | None], tuple[float, float | None]] | None = None
    series: set[str] = field(default_factory=set)
    active: list = field(default_factory=list)


def evaluate(node, env: Env) -> float:
    k = node[0]
    if k == "num":
        return node[1]
    if k == "name":
        return CONSTANTS[node[1]] if node[1] in CONSTANTS else env.scalars(node[1])
    if k == "neg":
        return -evaluate(node[1], env)
    if k == "bin":
        op, x, y = node[1], evaluate(node[2], env), evaluate(node[3], env)
        if op == "+":
            return x + y
        if op == "-":
            return x - y
        if op == "*":
            return x * y
        if op == "/":
            if y == 0:
                raise ExprError("division by zero")
            return x / y
        try:
            r = x ** y
        except (OverflowError, ZeroDivisionError):
            raise ExprError("power out of range")
        if isinstance(r, complex):
            raise ExprError("negative number to a fractional power")
        return r
    if k == "call":
        fn, args = node[1], node[2]
        if env.band and args and args[0][0] == "name" and fn in BAND_FUNCS and args[0][1] in env.series:
            f1 = evaluate(args[1], env)
            f2 = evaluate(args[2], env) if len(args) > 2 else None
            v, act = env.band(fn, args[0][1], f1, f2)
            env.active.append((fn, args[0][1], act))
            return v
        vals = [evaluate(x, env) for x in args]
        if fn == "sqrt":
            if vals[0] < 0:
                raise ExprError("sqrt of a negative number")
            return math.sqrt(vals[0])
        if fn == "abs":
            return abs(vals[0])
        if fn == "log10":
            if vals[0] <= 0:
                raise ExprError("log10 of a non-positive number")
            return math.log10(vals[0])
        if fn == "min":
            return min(vals)
        if fn == "max":
            return max(vals)
        if fn == "mean":
            return sum(vals) / len(vals)
    raise ExprError(f"cannot evaluate {node[0]}")


# ---------------------------------------------------------------- dependency graph
def find_cycle(graph: dict[str, set[str]]) -> list[str] | None:
    """Return one cycle (as a list of names) in a name → dependencies graph, or None."""
    state: dict[str, int] = {}
    stack: list[str] = []

    def dfs(n: str) -> list[str] | None:
        state[n] = 1
        stack.append(n)
        for d in graph.get(n, ()):
            if d not in graph:
                continue
            if state.get(d) == 1:
                return stack[stack.index(d):] + [d]
            if not state.get(d):
                c = dfs(d)
                if c:
                    return c
        stack.pop()
        state[n] = 2
        return None

    for n in graph:
        if not state.get(n):
            c = dfs(n)
            if c:
                return c
    return None
