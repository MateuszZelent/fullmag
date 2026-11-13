#!/usr/bin/env python3
"""Independent oracle for the time bytecode `fullmag_time_expr.v1`.

This script is a second implementation of the grammar, constant folding and
opcode table of `docs/specs/mask-function-v1.md`, written without looking at
the Rust code paths. It writes `time_program_golden.json`, which the Rust tests
must reproduce: opcodes exactly, literals and sample values to 4 ulp (libm of
the two machines may differ in the last bit).

Usage: python3 generate_time_program_golden.py > time_program_golden.json
"""

from __future__ import annotations

import json
import math
import re
import sys

OPCODES = {
    "RETURN": 0, "PUSH": 1, "LOAD_T": 2, "ADD": 3, "SUB": 4, "MUL": 5, "DIV": 6, "POW": 7,
    "NEG": 8, "sin": 9, "cos": 10, "tan": 11, "asin": 12, "acos": 13, "atan": 14, "atan2": 15,
    "sinh": 16, "cosh": 17, "tanh": 18, "exp": 19, "log": 20, "sqrt": 21, "abs": 22,
    "min": 23, "max": 24,
}
BINARY = {"+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "^": "POW"}
FUNC1 = {
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "asin": math.asin, "acos": math.acos,
    "atan": math.atan, "sinh": math.sinh, "cosh": math.cosh, "tanh": math.tanh, "exp": math.exp,
    "log": math.log, "sqrt": math.sqrt, "abs": abs,
}
FUNC2 = {"atan2": math.atan2, "min": min, "max": max}
TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(.))")


def tokenize(text):
    tokens = []
    for number, name, symbol in TOKEN.findall(text):
        if number:
            tokens.append(("num", float(number)))
        elif name:
            tokens.append(("name", name))
        elif symbol.strip():
            tokens.append(("sym", symbol))
    tokens.append(("end", None))
    return tokens


class Parser:
    """Trees are tuples: ("num", v) | ("t",) | ("neg", a) | ("bin", op, a, b) | ("call", f, args)."""

    def __init__(self, text, names):
        self.tokens = tokenize(text)
        self.index = 0
        self.names = names

    def peek(self):
        return self.tokens[self.index]

    def take(self):
        token = self.tokens[self.index]
        self.index += 1
        return token

    def expression(self):
        left = self.term()
        while self.peek() in (("sym", "+"), ("sym", "-")):
            op = self.take()[1]
            left = ("bin", op, left, self.term())
        return left

    def term(self):
        left = self.unary()
        while self.peek() in (("sym", "*"), ("sym", "/")):
            op = self.take()[1]
            left = ("bin", op, left, self.unary())
        return left

    def unary(self):
        if self.peek() == ("sym", "-"):
            self.take()
            return ("neg", self.unary())
        if self.peek() == ("sym", "+"):
            self.take()
            return self.unary()
        return self.power()

    def power(self):
        base = self.atom()
        if self.peek() == ("sym", "^"):
            self.take()
            return ("bin", "^", base, self.unary())
        return base

    def atom(self):
        kind, value = self.take()
        if kind == "num":
            return ("num", value)
        if (kind, value) == ("sym", "("):
            inner = self.expression()
            assert self.take() == ("sym", ")")
            return inner
        assert kind == "name", (kind, value)
        if self.peek() == ("sym", "("):
            self.take()
            arguments = [self.expression()]
            while self.peek() == ("sym", ","):
                self.take()
                arguments.append(self.expression())
            assert self.take() == ("sym", ")")
            return ("call", value, arguments)
        if value == "t":
            return ("t",)
        if value == "pi":
            return ("num", math.pi)
        return self.names[value]


def depends_on_t(tree):
    if tree[0] == "t":
        return True
    if tree[0] == "num":
        return False
    if tree[0] == "neg":
        return depends_on_t(tree[1])
    if tree[0] == "bin":
        return depends_on_t(tree[2]) or depends_on_t(tree[3])
    return any(depends_on_t(argument) for argument in tree[2])


def evaluate(tree, t):
    kind = tree[0]
    if kind == "num":
        return tree[1]
    if kind == "t":
        return t
    if kind == "neg":
        return -evaluate(tree[1], t)
    if kind == "bin":
        a, b = evaluate(tree[2], t), evaluate(tree[3], t)
        op = tree[1]
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return a / b
        return math.pow(a, b)
    arguments = [evaluate(argument, t) for argument in tree[2]]
    if tree[1] in FUNC1:
        return FUNC1[tree[1]](*arguments)
    return FUNC2[tree[1]](*arguments)


def emit(tree, code):
    if not depends_on_t(tree):
        code += [OPCODES["PUSH"], evaluate(tree, 0.0)]
        return
    kind = tree[0]
    if kind == "t":
        code.append(OPCODES["LOAD_T"])
    elif kind == "neg":
        emit(tree[1], code)
        code.append(OPCODES["NEG"])
    elif kind == "bin":
        emit(tree[2], code)
        emit(tree[3], code)
        code.append(OPCODES[BINARY[tree[1]]])
    else:
        for argument in tree[2]:
            emit(argument, code)
        code.append(OPCODES[tree[1]])


CASES = [
    ("sine", {"f": 3.6e9}, [], "sin(2*pi*f*t)"),
    ("delayed_sine", {"frequency": 3.6e9, "t0": 2e-9}, [], "sin(2 * pi * frequency * (t - t0))"),
    ("gaussian_pulse", {"f": 5e9, "t0": 1e-9, "s": 2e-10}, [("u", "(t - t0)/s")], "exp(-u^2)*sin(2*pi*f*t)"),
    ("atan2", {}, [], "atan2(t, 1e-9)"),
    ("min", {}, [], "min(t, 1e-9)"),
    ("max", {}, [], "max(-t, t)"),
    ("abs", {}, [], "abs(t - 1e-9)"),
    ("sqrt", {}, [], "sqrt(t)"),
    ("log", {}, [], "log(t + 1e-12)"),
    ("tanh_ramp", {"tau": 1e-9}, [], "tanh(t/tau)"),
    ("hyperbolic", {"tau": 1e-9}, [], "cosh(t/tau) + sinh(t/tau)"),
    ("inverse_trig", {}, [], "asin(t/1e-7) + acos(t/1e-7) + atan(t) + tan(t)"),
    ("constant", {"a": 2.0}, [("b", "a*3")], "b + 1"),
    ("power_and_division", {"w": 2e10}, [("c", "cos(w*t)")], "c^2/(1 + .5e0*c)"),
]
TIMES = [0.0, 1e-12, 2.5e-9, 1.7e-8]


def main():
    golden = []
    for name, parameters, locals_, output in CASES:
        names = {key: ("num", float(value)) for key, value in parameters.items()}
        for local_name, text in locals_:
            names[local_name] = Parser(text, names).expression()
        tree = Parser(output, names).expression()
        code = []
        emit(tree, code)
        code.append(OPCODES["RETURN"])
        golden.append({
            "name": name,
            "parameters": [[key, float(value)] for key, value in parameters.items()],
            "locals": [[local_name, text] for local_name, text in locals_],
            "output": output,
            "code": [float(word) for word in code],
            "samples": [[t, evaluate(tree, t)] for t in TIMES],
        })
    json.dump(golden, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
