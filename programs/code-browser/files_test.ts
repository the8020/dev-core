import {
  matchesExcerpt,
  readSource,
  searchSources,
  sourcePath,
  sourceText,
  sourceURI,
} from "./files.ts";

Deno.test("code browser reads bounded package text and rejects unsafe paths", async () => {
  const root = await Deno.makeTempDir();
  const assert = (value: unknown) => {
    if (!value) throw new Error("Assertion failed");
  };
  try {
    await Deno.mkdir(`${root}/folder`);
    await Deno.mkdir(`${root}/.git`);
    await Deno.mkdir(`${root}/.meta`);
    await Deno.writeTextFile(`${root}/file.ts`, "const café = 1;\n");
    await Deno.writeFile(`${root}/binary`, new Uint8Array([0, 1, 2]));
    await Deno.writeTextFile(`${root}/large`, "x".repeat(128 * 1024 + 1));
    await Deno.symlink("/tmp", `${root}/escape`);
    const listing = await readSource(root, "");
    assert(listing.entries?.[0]?.name === "folder");
    assert(
      !listing.entries?.some((entry) =>
        [".git", ".meta", "escape"].includes(entry.name)
      ),
    );
    assert((await readSource(root, "file.ts")).content === "const café = 1;\n");
    assert((await readSource(root, "folder")).entries?.length === 0);
    assert((await readSource(root, "binary")).notice?.includes("binary"));
    assert((await readSource(root, "large")).notice?.includes("128 KiB"));
    assert(sourceText("one\r\ncafé 👋\r\nthree") === "one\ncafé 👋\nthree");
    assert(
      matchesExcerpt("one\r\ncafé 👋\r\nthree", {
        firstLine: 2,
        text: "café 👋\nthree",
      }),
    );
    assert(
      !matchesExcerpt("one\nchanged\nthree", {
        firstLine: 2,
        text: "café 👋\nthree",
      }),
    );
    assert(!matchesExcerpt("one\ntwo", { firstLine: 4, text: "two" }));
    const found = await searchSources(root, "café", true);
    assert(found.rows.length === 1 && found.rows[0]?.path === "file.ts");
    assert(found.rows[0]?.line === 1 && found.rows[0]?.column === 7);
    assert((await searchSources(root, "file", false)).rows.length === 1);
    await Deno.writeTextFile(
      `${root}/unicode.ts`,
      "first\rconst İ = 1; const café = 2;\r",
    );
    const unicode = (await searchSources(root, "CAFÉ", true)).rows.find((row) =>
      row.path === "unicode.ts"
    );
    assert(unicode?.line === 2 && unicode.column === 20);
    for (const path of ["the8020/demo/a #%.ts", "@runtime/kernel/mod.ts"]) {
      assert(sourcePath(sourceURI(path)) === path);
    }
    for (
      const uri of [
        "file:///etc/passwd",
        "https://example.com/source.ts",
        "file://other/workspace/packages/code.ts",
      ]
    ) {
      let rejected = false;
      try {
        sourcePath(uri);
      } catch {
        rejected = true;
      }
      assert(rejected);
    }
    for (
      const path of [
        "../outside",
        "/etc/passwd",
        "folder/../file.ts",
        ".git/config",
        ".meta",
        "escape",
        "escape/file",
        "folder//file",
        "folder\\file",
        "bad\0name",
      ]
    ) {
      let rejected = false;
      try {
        await readSource(root, path);
      } catch {
        rejected = true;
      }
      assert(rejected);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
