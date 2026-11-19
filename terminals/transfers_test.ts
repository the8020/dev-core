import { DevelopmentError } from "../i18n/errors.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { receiveFile } from "./transfer_files.ts";
import {
  filename,
  folder,
  header,
  shellPaths,
  TransferReader,
} from "./transfer_protocol.ts";

Deno.test("file streams preserve binary bytes across split headers and trailing completion", async () => {
  const binary = new Uint8Array(65537).map((_, index) => index % 256);
  const wire = new Uint8Array([
    ...header({ size: binary.length }),
    ...binary,
    ...header({ complete: true }),
  ]);
  const reader = new TransferReader((async function* () {
    for (let offset = 0; offset < wire.length; offset += 73) {
      yield wire.subarray(offset, offset + 73);
    }
  })());
  assertEquals(await reader.header(), { size: binary.length });
  const received = [];
  for await (const chunk of reader.bytes(binary.length)) {
    received.push(...chunk);
  }
  assertEquals(new Uint8Array(received), binary);
  assertEquals(await reader.header(), { complete: true });
  await assertRejects(() => reader.header(), Error, "ended");
});

Deno.test("uploads publish complete files with collision naming and clean up failures", async () => {
  const root = await Deno.makeTempDir();
  const source = async function* () {
    yield new Uint8Array([0, 255, 13, 10, 27]);
  };
  try {
    await Deno.writeTextFile(`${root}/photo.png`, "original");
    await Deno.symlink(`${root}/photo.png`, `${root}/photo (1).png`);
    const path = await receiveFile(root, "photo.png", source());
    assertEquals(path, `${root}/photo (2).png`);
    assertEquals(await Deno.readTextFile(`${root}/photo.png`), "original");
    assertEquals(
      await Deno.readFile(path),
      new Uint8Array([0, 255, 13, 10, 27]),
    );
    await assertRejects(
      () =>
        receiveFile(
          root,
          "unfinished",
          (async function* () {
            yield new Uint8Array([1]);
            throw new Error("cancelled");
          })(),
        ),
      Error,
      "cancelled",
    );
    const rows = await Array.fromAsync(Deno.readDir(root));
    assertEquals(rows.map((row) => row.name).sort(), [
      "photo (1).png",
      "photo (2).png",
      "photo.png",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("transfer names reject traversal and quote paths without shell execution", () => {
  for (const name of ["../a", "a/b", "a\\b", ".", "..", "a\ncommand", ""]) {
    assertThrows(() => filename(name));
  }
  assertThrows(() => folder("relative"));
  assertEquals(folder("/root/uploads/"), "/root/uploads");
  assertEquals(
    shellPaths(["/root/uploads/a'b $(id).png", "/root/uploads/b"]),
    "'/root/uploads/a'\\''b $(id).png' '/root/uploads/b'",
  );
});

Deno.test("standalone transfer errors preserve their presentation key", async () => {
  const key = "errors.invalid_filename";
  const reader = new TransferReader((async function* () {
    yield header({ error: "Invalid filename", textKey: key });
  })());
  const error = await assertRejects(
    () => reader.header(),
    DevelopmentError,
    "Invalid filename",
  );
  assertEquals(error.textKey, key);
});
