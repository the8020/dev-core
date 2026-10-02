import { frame, Frames } from "./language.ts";

Deno.test("language framing survives fragmented Unicode and rejects oversized responses", () => {
  const values = [{ id: 1, result: "café 👋" }, { id: 2, result: null }];
  const input = new Uint8Array(values.flatMap((value) => [...frame(value)]));
  for (const size of [1, 3, input.length]) {
    const parser = new Frames();
    const output: unknown[] = [];
    for (let i = 0; i < input.length; i += size) {
      output.push(...parser.push(input.subarray(i, i + size)));
    }
    if (JSON.stringify(output) !== JSON.stringify(values)) {
      throw new Error("Corrupted LSP response");
    }
  }
  let rejected = false;
  try {
    new Frames().push(
      new TextEncoder().encode("Content-Length: 999999999\r\n\r\n"),
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Unbounded response accepted");
});
