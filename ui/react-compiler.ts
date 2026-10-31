import { transformAsync } from "@babel/core";
import type { BunPlugin } from "bun";

/** Runs the React Compiler over every .tsx file the HTML import bundles. */
const plugin: BunPlugin = {
  name: "react-compiler",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const result = await transformAsync(source, {
        filename: path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["jsx", "typescript"] },
        plugins: [["babel-plugin-react-compiler", {}]],
      });
      return { contents: result?.code ?? source, loader: "tsx" };
    });
  },
};

export default plugin;
