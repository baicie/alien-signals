import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

const inputs = ["src/index.ts", "src/system.ts"];

export default defineConfig([
  // ESM bundle
  {
    input: inputs,
    output: {
      entryFileNames:'[name].mjs',
      format: "esm",
      dir: "esm",
	  sourcemap:'inline'
    },
    external: [/node_modules/],
  },
  // CJS bundle
  {
    input: inputs,
    output: {
      format: "cjs",
      dir: "cjs",
	  entryFileNames:'[name].cjs',
	  sourcemap:'inline'
    },
    external: [/node_modules/],
  },
  // Types
  {
    input: inputs,
    output: {
      dir: "types",
      format: "esm",
    },
    plugins: [
      dts({
		emitDtsOnly:true,
	  }),
    ],
  },
]);
