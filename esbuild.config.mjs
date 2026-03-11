import esbuild from "esbuild";

const args = process.argv.slice(2);
const watch = args.includes("--watch");

const config = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  external: ["obsidian"],
  sourcemap: watch,
  minify: !watch,
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log("Watching...");
} else {
  await esbuild.build(config);
}
