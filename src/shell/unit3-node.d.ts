interface PromiseConstructor {
  withResolvers<T>(): { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (e: unknown) => void };
}
// Minimal ambient types for the Node built-ins that git.ts, guard.ts, admit.ts and their tests use, so `tsc`
// needs no @types/node (typescript is the only dev dependency). Only the surface used is declared.
interface ImportMeta {
  readonly dirname: string;
}
declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(data: string, encoding?: string): Buffer;
    static concat(parts: readonly Uint8Array[]): Buffer;
    toString(encoding?: string, start?: number, end?: number): string;
    subarray(start?: number, end?: number): Buffer;
    indexOf(value: number | string, from?: number): number;
  }
}
declare module "node:process" {
  export const env: Record<string, string | undefined>;
}
declare module "node:child_process" {
  interface Readable {
    on(event: "data", cb: (chunk: Uint8Array) => void): void;
  }
  interface Writable {
    on(event: "error", cb: (e: Error) => void): void;
    end(data?: string): void;
  }
  export interface ChildProcess {
    readonly stdout: Readable;
    readonly stderr: Readable;
    readonly stdin: Writable;
    on(event: "error", cb: (e: Error) => void): void;
    on(event: "close", cb: (code: number | null) => void): void;
  }
  export function spawn(
    cmd: string, args: readonly string[],
    opts: { cwd?: string; env?: Record<string, string | undefined>; stdio?: readonly string[] },
  ): ChildProcess;
  export function spawnSync(
    cmd: string, args: readonly string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined>; encoding?: string },
  ): { status: number | null; stdout: string; stderr: string };
}
declare module "node:crypto" {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomBytes(n: number): { toString(encoding: "hex"): string };
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:path" {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(p: string): boolean;
}
declare module "node:fs" {
  export function existsSync(p: string): boolean;
  export function statSync(p: string): { isFile(): boolean; size: number };
}
declare module "node:fs/promises" {
  import type { Buffer } from "node:buffer";
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function readFile(p: string): Promise<Buffer>;
  export function readFile(p: string, encoding: "utf8"): Promise<string>;
  export function writeFile(p: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void>;
  export function readdir(p: string, opts: { withFileTypes: true }): Promise<Dirent[]>;
  export function lstat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  export function readlink(p: string): Promise<string>;
  export function mkdir(p: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function realpath(p: string): Promise<string>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function symlink(target: string, p: string): Promise<void>;
}
