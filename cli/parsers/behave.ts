// Parser for behave. It maps feature and scenario tags that carry an AC id to per-scenario results.
//
// Suite `command` to configure in ark.yml:
//
//   behave --format json -o {report}
//
// Tag a scenario (or a whole feature, which tags every scenario in it) with the AC id, as
// `@CLARA-12-AC1` or `@ac:CLARA-12-AC1`. Scenarios without an AC id tag get `criteria: []`.
// A scenario outline row counts as one scenario and inherits the tags of the outline and its
// examples table. Scenario status "passed" maps to passed, "skipped" and "untested" to skipped,
// and everything else (failed, undefined) to failed.
import { ArkError } from "../errors";
import type { Parser, TestResult } from "./index";

type BehaveElement = { type: string; name: string; tags?: string[]; status?: string };
type BehaveFeature = { name: string; tags?: string[]; elements?: BehaveElement[] };

const criterionPattern = /\b[A-Z][A-Z0-9]+-\d+-AC\d+\b/g;

function statusOf(behaveStatus: string | undefined): TestResult["status"] {
  if (behaveStatus === "passed") return "passed";
  return behaveStatus === "skipped" || behaveStatus === "untested" ? "skipped" : "failed";
}

export const parseBehave: Parser = ({ report }) => {
  if (!report.trim()) {
    throw new ArkError("behave report is empty: check the suite command writes JSON to {report}");
  }
  const features: BehaveFeature[] = JSON.parse(report);
  const results: TestResult[] = [];
  for (const feature of features) {
    for (const element of feature.elements ?? []) {
      if (element.type !== "scenario") continue;
      const tags = [...(feature.tags ?? []), ...(element.tags ?? [])].join(" ");
      results.push({
        name: `${feature.name}: ${element.name.trim()}`,
        criteria: [...new Set(tags.match(criterionPattern) ?? [])].sort(),
        status: statusOf(element.status),
      });
    }
  }
  return results;
};
