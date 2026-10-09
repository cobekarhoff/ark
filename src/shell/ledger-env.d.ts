// Ambient types for the Node modules the ledger and its tests use, so `tsc` needs no @types/node
// (the only dev dependency is typescript). Only the members actually called are declared.
declare module "node:sqlite" {
  type Param = null | number | bigint | string;
  export class StatementSync {
    run(...params: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: Param[]): Record<string, unknown> | undefined;
    all(...params: Param[]): Record<string, unknown>[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
declare module "node:process" {
  const process: {
    readonly pid: number;
    readonly execPath: string;
    readonly argv: readonly string[];
    kill(pid: number, signal: string): true;
  };
  export default process;
}
declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
  export function readdirSync(path: string): string[];
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:child_process" {
  export function spawnSync(
    cmd: string, args: readonly string[],
    opts?: { encoding?: "utf8" },
  ): { status: number | null; signal: string | null; stdout: string; stderr: string };
}
interface ImportMeta { readonly dirname: string }
