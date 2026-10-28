import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { readdirSync } from "node:fs";

const directory = `${import.meta.dir}/../schemas`;
const names = readdirSync(directory)
  .filter((file) => file.endsWith(".schema.json"))
  .map((file) => file.replace(".schema.json", ""));
const load = (path: string) => Bun.file(`${directory}/${path}`).json();

describe("ARK-102-AC3", () => {
  test("every planned schema exists", () => {
    expect(names.sort()).toEqual(
      ["ac", "implementer", "ledger-event", "reviewer", "state", "ticket", "ticket-frontmatter", "validator"],
    );
  });

  for (const name of names) {
    const validate = async () => new Ajv2020().compile(await load(`${name}.schema.json`));

    test(`${name}: valid example validates`, async () => {
      const check = await validate();
      expect(check(await load(`examples/${name}.json`)), JSON.stringify(check.errors)).toBe(true);
    });

    test(`${name}: invalid example fails`, async () => {
      const check = await validate();
      expect(check(await load(`examples/invalid/${name}.json`))).toBe(false);
    });
  }
});
