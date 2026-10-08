const root = new URL("../../", import.meta.url);
const importMap = Deno.env.get("DENO_IMPORT_MAP");
const output = await Deno.makeTempFile({ suffix: ".js" });
try {
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--config",
      new URL("deno.json", root).pathname,
      ...(importMap ? ["--import-map", importMap] : []),
      "--platform",
      "browser",
      "--minify",
      "--external",
      "/the8020/uui/shell/components/code-editor/editor.js",
      "--external",
      "/the8020/uui/shell/components/code-editor/vendor/library.js",
      "--output",
      output,
      new URL("frontend.ts", import.meta.url).pathname,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!build.success) throw new Error("Code browser build failed.");
  const publish = async (bytes: Uint8Array<ArrayBuffer>, extension: string) => {
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("").slice(0, 16);
    const name = `code-browser-${hash}.${extension}`;
    await Deno.writeFile(new URL(`public/${name}`, root), bytes);
    return name;
  };
  const assets = {
    module: await publish(await Deno.readFile(output), "js"),
    styles: [
      await publish(
        await Deno.readFile(new URL("frontend.css", import.meta.url)),
        "css",
      ),
    ],
  };
  await Deno.writeTextFile(
    new URL("assets.json", import.meta.url),
    JSON.stringify(assets, null, 2) + "\n",
  );
} finally {
  await Deno.remove(output);
}
