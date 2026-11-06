// Parser for pytest. It maps `@pytest.mark.ac("<AC id>", ...)` markers (old AC ids) and
// `@pytest.mark.case("<KEY>-T<n>", ...)` markers (test case ids) to per-test results.
//
// Suite `command` to configure in ark.yml:
//
//   pytest -o junit_family=xunit1 --junitxml={report}
//
// Stock pytest does not write marker arguments into its reports. Add this to the suite's
// `conftest.py` so every `ac` marker argument becomes a `<property name="ac">` and every `case` marker
// argument a `<property name="case">` on the test case
// (`junit_family=xunit1` keeps properties on test cases; xunit2 drops them):
//
//   def pytest_configure(config):
//       config.addinivalue_line("markers", "ac(*ids): acceptance criteria this test proves")
//       config.addinivalue_line("markers", "case(*ids): test case ids this test implements")
//
//   def pytest_runtest_setup(item):
//       for marker in item.iter_markers("ac"):
//           for criterion in marker.args:
//               item.user_properties.append(("ac", criterion))
//       for marker in item.iter_markers("case"):
//           for case_id in marker.args:
//               item.user_properties.append(("case", case_id))
//
// Tests without an `ac` property get `criteria: []`, and without a `case` property `cases: []`. A skipped or xfailed test is "skipped".
import { ArkError } from "../errors";
import { caseIdsIn } from "./case";
import type { Parser, TestResult } from "./index";

const criterionPattern = /\b[A-Z][A-Z0-9]+-\d+-AC\d+\b/;

const entities: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => entities[name]);
}

export const parsePytest: Parser = ({ report }) => {
  if (!report.includes("<testcase")) {
    throw new ArkError(
      "pytest report has no test cases: check the suite command writes JUnit XML to {report}",
    );
  }
  const results: TestResult[] = [];
  for (const match of report.matchAll(/<testcase\s([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1];
    const body = match[2] ?? "";
    const className = attributes.match(/\bclassname="([^"]*)"/)?.[1] ?? "";
    const testName = attributes.match(/\bname="([^"]*)"/)?.[1] ?? "";
    const criteria = new Set<string>();
    const cases = new Set<string>();
    for (const property of body.matchAll(/<property\s+name="ac"\s+value="([^"]*)"/g)) {
      const criterion = unescapeXml(property[1]).match(criterionPattern)?.[0];
      if (criterion) criteria.add(criterion);
    }
    for (const property of body.matchAll(/<property\s+name="case"\s+value="([^"]*)"/g))
      for (const id of caseIdsIn(unescapeXml(property[1]))) cases.add(id);
    const status = /<(failure|error)[\s>]/.test(body)
      ? "failed"
      : /<skipped[\s/>]/.test(body)
        ? "skipped"
        : "passed";
    results.push({
      name: unescapeXml(className ? `${className}::${testName}` : testName),
      criteria: [...criteria].sort(),
      cases: [...cases].sort(),
      status,
    });
  }
  return results;
};
