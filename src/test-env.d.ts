// Minimal ambient types for the two Node modules the tests use, so `tsc` needs no @types/node
// (the only dev dependency is typescript). Core never sees this file: tsconfig.core.json lists its files explicitly.
declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | object): void;
  };
  export default assert;
}
