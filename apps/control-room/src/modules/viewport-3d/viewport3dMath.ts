export type Tuple3 = [number, number, number];

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function sameTuple3(left: Tuple3, right: Tuple3): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function nearTuple3(left: Tuple3, right: Tuple3, epsilon: number): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - right[index]) <= epsilon)
  );
}
