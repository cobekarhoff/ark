/**
 * Child process of attempt.test.ts: an executor ("ark") running one scripted attempt, to be SIGKILLed mid-run.
 * argv: <config.json> with { runsRoot, env, req }. Prints the outcome as one JSON line if it ever gets that far.
 */
import { readFileSync } from "node:fs";
import process from "node:process";
import type { AbsPath } from "../core/ids.ts";
import type { EffectRequest } from "../core/effects.ts";
import { scriptedExecutor } from "./attempt-fixture.ts";

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { runsRoot: AbsPath; env: Record<string, string>; req: EffectRequest };
console.log(JSON.stringify(await scriptedExecutor(cfg.runsRoot, cfg.env).run(cfg.req, "first")));
