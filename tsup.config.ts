import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // ws is a Node-only optional peer dep; exclude it from the bundle so
  // browser builds remain dependency-free and the dist stays tree-shakeable.
  external: ["ws"],
});
