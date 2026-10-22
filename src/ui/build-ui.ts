const out = await Bun.build({
  entrypoints: [new URL("./main.ts", import.meta.url).pathname],
  target: "browser",
  format: "esm",
  minify: true,
});

if (!out.success) {
  console.error("UI build failed:");
  for (const log of out.logs) console.error(String(log));
  process.exit(1);
}

const code = await out.outputs[0]!.text();
const dest = new URL("./main.bundle.js", import.meta.url).pathname;
await Bun.write(dest, code);
console.log(`ui bundle: ${(Buffer.byteLength(code) / 1024).toFixed(0)} KiB -> ${dest}`);
