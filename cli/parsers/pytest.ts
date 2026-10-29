// Parser for pytest. It maps `@pytest.mark.ac("<AC id>", ...)` markers to per-test results.
//
// Suite `command` to configure in ark.yml:
//
//   pytest -o junit_family=xunit1 --junitxml={report}
//
// Stock pytest does not write marker arguments into its reports. Add this to the suite's
// `conftest.py` so every `ac` marker argument becomes a `<property name="ac">` on the test case
// (`junit_family=xunit1` keeps properties on test cases; xunit2 drops them):
//
//   def pytest_configure(config):
//       config.addinivalue_line("markers", "ac(*ids): acceptance criteria this test proves")
//
//   def pytest_runtest_setup(item):
//       for marker in item.iter_markers("ac"):
//           for criterion in marker.args:
//               item.user_properties.append(("ac", criterion))
//
// Test cases without an AC property get `criteria: []`. A skipped or xfailed test is "skipped".
import { ArkError } from "../errors";
import type { Parser, TestResult } from "./index";

const criterionPattern = /\b[A-Z][A-Z0-9]+-\d+-AC\d+\b/;

const entities: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => entities[name]);
}

export const parsePytest: Parser = ({ report }) => {
  if (!report.includes("<testcase")) {
    throw new ArkError("pytest report has no test cases: check the suite command writes JUnit XML to {report}");
  }
  const results: TestResult[] = [];
  for (const match of report.matchAll(/<testcase\s([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1];
    const body = match[2] ?? "";
    const className = attributes.match(/\bclassname="([^"]*)"/)?.[1] ?? "";
    const testName = attributes.match(/\bname="([^"]*)"/)?.[1] ?? "";
    const criteria = new Set<string>();
    for (const property of body.matchAll(/<property\s+name="ac"\s+value="([^"]*)"/g)) {
      const criterion = unescapeXml(property[1]).match(criterionPattern)?.[0];
      if (criterion) criteria.add(criterion);
    }
    const status = /<(failure|error)[\s>]/.test(body) ? "failed" : /<skipped[\s/>]/.test(body) ? "skipped" : "passed";
    results.push({
      name: unescapeXml(className ? `${className}::${testName}` : testName),
      criteria: [...criteria].sort(),
      status,
    });
  }
  return results;
};
