/*
 * Interpreter of the time bytecode fullmag_time_expr.v1 for host code (C, C++,
 * CUDA host side).
 *
 * Contract: docs/specs/mask-function-v1.md, section 4. The Rust interpreter
 * fullmag_expr::eval_time_program implements the same opcode table; the
 * runner checks that FULLMAG_TIME_EXPRESSION_VERSION equals
 * fullmag_expr::TIME_PROGRAM_VERSION at build time and compares both
 * interpreters on every uploaded program. A malformed program evaluates to NaN.
 */
#ifndef FULLMAG_TIME_EXPRESSION_H
#define FULLMAG_TIME_EXPRESSION_H

#include <math.h>
#include <stdint.h>

#define FULLMAG_TIME_EXPRESSION_VERSION 1
#define FULLMAG_TIME_EXPRESSION_MAX_STACK 64
#define FULLMAG_TIME_EXPRESSION_MAX_WORDS 65536

enum {
    FULLMAG_TIME_OP_RETURN = 0,
    FULLMAG_TIME_OP_PUSH = 1,
    FULLMAG_TIME_OP_LOAD_T = 2,
    FULLMAG_TIME_OP_ADD = 3,
    FULLMAG_TIME_OP_SUB = 4,
    FULLMAG_TIME_OP_MUL = 5,
    FULLMAG_TIME_OP_DIV = 6,
    FULLMAG_TIME_OP_POW = 7,
    FULLMAG_TIME_OP_NEG = 8,
    FULLMAG_TIME_OP_SIN = 9,
    FULLMAG_TIME_OP_COS = 10,
    FULLMAG_TIME_OP_TAN = 11,
    FULLMAG_TIME_OP_ASIN = 12,
    FULLMAG_TIME_OP_ACOS = 13,
    FULLMAG_TIME_OP_ATAN = 14,
    FULLMAG_TIME_OP_ATAN2 = 15,
    FULLMAG_TIME_OP_SINH = 16,
    FULLMAG_TIME_OP_COSH = 17,
    FULLMAG_TIME_OP_TANH = 18,
    FULLMAG_TIME_OP_EXP = 19,
    FULLMAG_TIME_OP_LOG = 20,
    FULLMAG_TIME_OP_SQRT = 21,
    FULLMAG_TIME_OP_ABS = 22,
    FULLMAG_TIME_OP_MIN = 23,
    FULLMAG_TIME_OP_MAX = 24
};

/* Opcode of one word, or -1 when the word is not an opcode. */
static inline int fullmag_time_expression_opcode(double word)
{
    if (!(word >= 0.0 && word <= (double)FULLMAG_TIME_OP_MAX) || word != floor(word)) {
        return -1;
    }
    return (int)word;
}

/* Value of the program at time t_s; NaN when the program is malformed. */
static inline double fullmag_time_expression_eval(
    const double *code, uint64_t len, double t_s)
{
    double stack[FULLMAG_TIME_EXPRESSION_MAX_STACK];
    uint64_t depth = 0;
    uint64_t cursor = 0;
    if (code == 0) {
        return NAN;
    }
    while (cursor < len) {
        const int opcode = fullmag_time_expression_opcode(code[cursor]);
        cursor += 1;
        if (opcode < 0) {
            return NAN;
        }
        switch (opcode) {
        case FULLMAG_TIME_OP_RETURN:
            return depth == 1 && cursor == len ? stack[0] : NAN;
        case FULLMAG_TIME_OP_PUSH:
        case FULLMAG_TIME_OP_LOAD_T:
            if (depth == FULLMAG_TIME_EXPRESSION_MAX_STACK) {
                return NAN;
            }
            if (opcode == FULLMAG_TIME_OP_PUSH) {
                if (cursor == len) {
                    return NAN;
                }
                stack[depth] = code[cursor];
                cursor += 1;
            } else {
                stack[depth] = t_s;
            }
            depth += 1;
            break;
        case FULLMAG_TIME_OP_ADD:
        case FULLMAG_TIME_OP_SUB:
        case FULLMAG_TIME_OP_MUL:
        case FULLMAG_TIME_OP_DIV:
        case FULLMAG_TIME_OP_POW:
        case FULLMAG_TIME_OP_ATAN2:
        case FULLMAG_TIME_OP_MIN:
        case FULLMAG_TIME_OP_MAX: {
            double left;
            double right;
            double result;
            if (depth < 2) {
                return NAN;
            }
            right = stack[depth - 1];
            left = stack[depth - 2];
            depth -= 1;
            switch (opcode) {
            case FULLMAG_TIME_OP_ADD: result = left + right; break;
            case FULLMAG_TIME_OP_SUB: result = left - right; break;
            case FULLMAG_TIME_OP_MUL: result = left * right; break;
            case FULLMAG_TIME_OP_DIV: result = left / right; break;
            case FULLMAG_TIME_OP_POW: result = pow(left, right); break;
            case FULLMAG_TIME_OP_ATAN2: result = atan2(left, right); break;
            case FULLMAG_TIME_OP_MIN: result = fmin(left, right); break;
            default: result = fmax(left, right); break;
            }
            stack[depth - 1] = result;
            break;
        }
        default: {
            double value;
            if (depth < 1) {
                return NAN;
            }
            value = stack[depth - 1];
            switch (opcode) {
            case FULLMAG_TIME_OP_NEG: value = -value; break;
            case FULLMAG_TIME_OP_SIN: value = sin(value); break;
            case FULLMAG_TIME_OP_COS: value = cos(value); break;
            case FULLMAG_TIME_OP_TAN: value = tan(value); break;
            case FULLMAG_TIME_OP_ASIN: value = asin(value); break;
            case FULLMAG_TIME_OP_ACOS: value = acos(value); break;
            case FULLMAG_TIME_OP_ATAN: value = atan(value); break;
            case FULLMAG_TIME_OP_SINH: value = sinh(value); break;
            case FULLMAG_TIME_OP_COSH: value = cosh(value); break;
            case FULLMAG_TIME_OP_TANH: value = tanh(value); break;
            case FULLMAG_TIME_OP_EXP: value = exp(value); break;
            case FULLMAG_TIME_OP_LOG: value = log(value); break;
            case FULLMAG_TIME_OP_SQRT: value = sqrt(value); break;
            default: value = fabs(value); break;
            }
            stack[depth - 1] = value;
            break;
        }
        }
    }
    return NAN;
}

/* Structure of a program: 1 when it is well formed and reads t, 0 when it is
 * well formed and constant, -1 when it is malformed (unknown opcode, missing
 * operand, stack underflow or overflow, no final RETURN, trailing words, too
 * many words). */
static inline int fullmag_time_expression_reads_t(const double *code, uint64_t len)
{
    uint64_t depth = 0;
    uint64_t cursor = 0;
    int reads_t = 0;
    if (code == 0 || len == 0 || len > FULLMAG_TIME_EXPRESSION_MAX_WORDS) {
        return -1;
    }
    while (cursor < len) {
        const int opcode = fullmag_time_expression_opcode(code[cursor]);
        cursor += 1;
        if (opcode < 0) {
            return -1;
        }
        if (opcode == FULLMAG_TIME_OP_RETURN) {
            return depth == 1 && cursor == len ? reads_t : -1;
        }
        if (opcode == FULLMAG_TIME_OP_PUSH || opcode == FULLMAG_TIME_OP_LOAD_T) {
            if (depth == FULLMAG_TIME_EXPRESSION_MAX_STACK) {
                return -1;
            }
            if (opcode == FULLMAG_TIME_OP_PUSH) {
                if (cursor == len) {
                    return -1;
                }
                cursor += 1;
            } else {
                reads_t = 1;
            }
            depth += 1;
        } else if (opcode == FULLMAG_TIME_OP_ADD || opcode == FULLMAG_TIME_OP_SUB ||
                   opcode == FULLMAG_TIME_OP_MUL || opcode == FULLMAG_TIME_OP_DIV ||
                   opcode == FULLMAG_TIME_OP_POW || opcode == FULLMAG_TIME_OP_ATAN2 ||
                   opcode == FULLMAG_TIME_OP_MIN || opcode == FULLMAG_TIME_OP_MAX) {
            if (depth < 2) {
                return -1;
            }
            depth -= 1;
        } else if (depth < 1) {
            return -1;
        }
    }
    return -1;
}

#endif /* FULLMAG_TIME_EXPRESSION_H */
