/**
 * admit.ts — THE admission boundary for artifacts. @layer shell.
 *
 * Every artifact in the system enters through `admit`: agent output (via seal), the verification
 * bundle, the MR record, CI and landing status. There is no other way to obtain a RecordedArtifact,
 * so "validated against its schema AND admissible against its inputs" is a property of the TYPE.
 * The way back OUT is also one function: `readArtifact` re-hashes bytes against the ledger's hash.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AbsPath } from "../core/ids.ts";
import { CATALOG } from "../core/contracts.ts";
import type { AdmitInputs, AnyRecorded, ArtifactKind, ArtifactRef, Body, LockSet, PinnedRoot } from "../core/contracts.ts";
import { canonicalJson, sha256 } from "../core/hash.ts";

/** Everything admit needs besides the raw bytes. The caller supplies git/file access as functions. */
export interface AdmitContext extends AdmitInputs {
  /**
   * Measure `roots` into lock sets at `head` (guard.hashLocked per repo). seal passes the real one;
   * callers without a worktree (verify, forge) pass `async () => []`. Throws/returns problems -> declared_file_missing.
   */
  readonly pin: (roots: readonly PinnedRoot[]) => Promise<readonly LockSet[]>;
}

export type Admission =
  | { readonly ok: true; readonly artifact: AnyRecorded }
  | { readonly ok: false; readonly problems: readonly string[] };

// ---------------------------------------------------------------- schema validation
// ponytail: a validator for the JSON Schema subset our schemas/*.v1.json use (type, enum, const, required,
// properties, additionalProperties: boolean, items, minItems, minLength, minimum, pattern). Upgrade: swap
// `validate` for ajv (compile once per kind) if a schema needs oneOf/$ref; the schema files stay as they are.

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly Json[];
  readonly const?: Json;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean;
  readonly items?: Schema;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly pattern?: string;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v);
const isType = (v: unknown, t: string): boolean => (t === "number" ? typeof v === "number" : typeOf(v) === t);

function validate(v: unknown, s: Schema, at: string, out: string[]): void {
  if (s.type !== undefined) {
    const types = typeof s.type === "string" ? [s.type] : s.type;
    if (!types.some((t) => isType(v, t))) return void out.push(`${at}: expected ${types.join("|")}, got ${typeOf(v)}`);
  }
  if (s.const !== undefined && canonicalJson(v) !== canonicalJson(s.const)) out.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum !== undefined && !s.enum.some((e) => canonicalJson(e) === canonicalJson(v))) out.push(`${at}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof v === "string") {
    if (s.minLength !== undefined && v.length < s.minLength) out.push(`${at}: must not be shorter than ${s.minLength}`);
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(v)) out.push(`${at}: must match ${s.pattern}`);
  }
  if (typeof v === "number" && s.minimum !== undefined && v < s.minimum) out.push(`${at}: must be >= ${s.minimum}`);
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at}: needs at least ${s.minItems} item(s)`);
    if (s.items !== undefined) v.forEach((x, i) => validate(x, s.items!, `${at}[${i}]`, out));
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of s.required ?? []) if (!Object.hasOwn(o, k)) out.push(`${at}.${k}: is required`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (Object.hasOwn(o, k)) validate(o[k], sub, `${at}.${k}`, out);
    if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!Object.hasOwn(s.properties ?? {}, k)) out.push(`${at}.${k}: is not allowed`);
  }
}

const schemas = new Map<ArtifactKind, Promise<Schema>>();
/** Loaded and parsed once per kind. */
function schemaFor(kind: ArtifactKind): Promise<Schema> {
  let s = schemas.get(kind);
  if (s === undefined) {
    s = readFile(join(import.meta.dirname, "..", "..", CATALOG[kind].schemaFile), "utf8").then((t) => JSON.parse(t) as Schema);
    schemas.set(kind, s);
  }
  return s;
}

// ---------------------------------------------------------------- admit

/** Every pinned root must come back as a non-empty set of files under it, else the declared file is missing. */
function unpinned(roots: readonly PinnedRoot[], sets: readonly LockSet[]): string[] {
  return roots
    .filter((r) => {
      const root = r.root.replace(/\/+$/, "");
      return !sets.some((s) => s.repo === r.repo && s.files.some((f) => f.path === root || f.path.startsWith(`${root}/`)));
    })
    .map((r) => `declared_file_missing: ${r.repo}:${r.root} has no files at head`);
}

/**
 * 1. parse `raw` JSON
 * 2. validate against schemas/<kind>.v1.json incl. the common envelope
 * 3. CATALOG[kind].admissible(body, ctx): cross-artifact truth. QE `pass` needs a current verification `pass` for
 *    the same head; every QE defect cites a failed check and existing evidence; the review lead's blockers exist in
 *    the fan-out findings; acceptance rejection-style checks carry a positive control and every check declares
 *    limitations. THE ONLY PLACE these rules run.
 * 4. outcome = outcomeOf(body); facts = factsOf(body); pinned = await ctx.pin(pinnedRoots(body)); hash = sha256(canonical JSON)
 * 5. write <runDir>/artifacts/<hash>.json via tmp+rename (content-addressed => idempotent)
 * 6. construct the RecordedArtifact (the single `as AnyRecorded` cast in the codebase besides ledger.decodeEvent)
 * Problems from 2 and 3 are returned together so one retry can fix both.
 *
 * The file is named by the hex digest (no `sha256:` prefix); `RecordedArtifact.path` is `artifacts/<hex>.json`.
 */
export async function admit(runDir: AbsPath, kind: ArtifactKind, raw: string, ctx: AdmitContext): Promise<Admission> {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { ok: false, problems: [`not valid JSON: ${(e as Error).message}`] };
  }
  const problems: string[] = [];
  validate(doc, await schemaFor(kind), "$", problems);

  const body = typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>).body : undefined;
  const def = CATALOG[kind];
  if (typeof body === "object" && body !== null && !Array.isArray(body)) problems.push(...def.admissible(body as Body, ctx));
  if (problems.length > 0) return { ok: false, problems };

  const b = body as Body;
  let pinned: readonly LockSet[] = [];
  const roots = def.pinnedRoots(b);
  if (roots.length > 0) {
    try {
      pinned = await ctx.pin(roots);
    } catch (e) {
      return { ok: false, problems: [`declared_file_missing: ${(e as Error).message}`] };
    }
    const missing = unpinned(roots, pinned);
    if (missing.length > 0) return { ok: false, problems: missing };
  }

  const canonical = canonicalJson(doc);
  const hash = sha256(canonical);
  const path = `artifacts/${hash.slice("sha256:".length)}.json`;
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  const tmp = join(runDir, `${path}.tmp-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, canonical);
  await rename(tmp, join(runDir, path));

  const artifact = { kind, hash, path, outcome: def.outcomeOf(b), facts: def.factsOf(b), pinned, head: ctx.head } as AnyRecorded;
  return { ok: true, artifact };
}

/**
 * The only way artifact bytes are read back (engine.readArtifact, publish, attempt prompts): read
 * `<runDir>/<ref.path>`, recompute sha256 of the canonical JSON, and throw unless it equals `ref.hash`.
 * Files under artifacts/ are agent-reachable; the ledger's hash is the authority.
 * Returns the canonical JSON (exactly what was hashed), not the file's raw bytes.
 */
export async function readArtifact(runDir: AbsPath, ref: ArtifactRef): Promise<string> {
  if (isAbsolute(ref.path) || ref.path.split("/").includes("..")) throw new Error(`artifact path escapes the run dir: ${ref.path}`);
  const text = await readFile(join(runDir, ref.path), "utf8");
  let canonical: string;
  try {
    canonical = canonicalJson(JSON.parse(text));
  } catch {
    throw new Error(`artifact ${ref.kind} ${ref.hash} is not valid JSON`);
  }
  if (sha256(canonical) !== ref.hash) throw new Error(`artifact ${ref.kind} ${ref.path} does not match its recorded hash (tampered?)`);
  return canonical;
}

// ---------------------------------------------------------------- views

function bullets(v: unknown, depth: number): string {
  const pad = "  ".repeat(depth);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x !== null ? `${pad}-\n${bullets(x, depth + 1)}` : `${pad}- ${String(x)}`)).join("\n");
  if (typeof v === "object" && v !== null) {
    return Object.entries(v).map(([k, x]) => (typeof x === "object" && x !== null ? `${pad}- **${k}**\n${bullets(x, depth + 1)}` : `${pad}- **${k}**: ${String(x)}`)).join("\n");
  }
  return `${pad}${String(v)}`;
}

/** Canonical JSON rendering for views: Markdown is derived from artifacts, never edited. Pure over bytes. */
export function renderMarkdown(kind: ArtifactKind, canonicalJsonText: string): string {
  const doc = JSON.parse(canonicalJsonText) as { ticket?: string; run?: string; attempt?: number; body?: Record<string, unknown> };
  const sections = Object.entries(doc.body ?? {}).map(([k, v]) => `## ${k}\n\n${bullets(v, 0)}\n`);
  return [`# ${kind}`, `${doc.ticket ?? ""} · ${doc.run ?? ""} · attempt ${doc.attempt ?? ""}`, ...sections].join("\n\n") + "\n";
}
