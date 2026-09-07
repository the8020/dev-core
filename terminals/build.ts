// Build products belong to this package's explicit browser publication directory.
const root = new URL("../", import.meta.url);
const published = new URL("public/", root);
const manifestPath = new URL("assets.json", import.meta.url);
const temporary = await Deno.makeTempDir({ prefix: "the8020-terminal-build-" });
try {
  const output = `${temporary}/terminal.js`;
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--config",
      new URL("deno.json", root).pathname,
      "--platform",
      "browser",
      "--minify",
      "--output",
      output,
      new URL("frontend/console.ts", import.meta.url).pathname,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error("Terminal browser build failed");
  const previous = await Deno.readTextFile(manifestPath).then((value) =>
    JSON.parse(value) as { module: string; styles: string[] }
  ).catch((error) => {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  });
  await Deno.mkdir(published, { recursive: true });
  const write = async (
    body: Uint8Array<ArrayBuffer>,
    extension: string,
  ): Promise<string> => {
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("").slice(0, 16);
    const name = `development-terminal-${hash}.${extension}`;
    await Deno.writeFile(new URL(name, published), body);
    return name;
  };
  const assets = {
    module: await write(await Deno.readFile(output), "js"),
    styles: [
      await write(
        await Deno.readFile(new URL("frontend/console.css", import.meta.url)),
        "css",
      ),
    ],
  };
  await Deno.writeTextFile(
    manifestPath,
    JSON.stringify(assets, null, 2) + "\n",
  );
  for (const name of previous ? [previous.module, ...previous.styles] : []) {
    if (name === assets.module || assets.styles.includes(name)) continue;
    if (!/^development-terminal-[a-f0-9]{16}\.(js|css)$/.test(name)) continue;
    await Deno.remove(new URL(name, published)).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
} finally {
  await Deno.remove(temporary, { recursive: true });
}
