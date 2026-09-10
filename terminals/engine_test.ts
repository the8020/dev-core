import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { TerminalEngine } from "./engine.ts";
import {
  installTerminalView,
  restoreTerminal,
  validateSnapshot,
} from "./state.ts";

const encode = (data: string) => new TextEncoder().encode(data);

Deno.test("terminal engine snapshots precede later queued output and continue partial Unicode", async () => {
  const first = new TerminalEngine({ columns: 20, rows: 6 });
  const second = new TerminalEngine({ columns: 20, rows: 6 });
  try {
    const before = first.apply({
      sequence: 1,
      data: new Uint8Array([0x41, 0xf0, 0x9f]),
    });
    const snapshot = first.capture();
    const after = first.apply({
      sequence: 2,
      data: new Uint8Array([0x98, 0x80]),
    });
    await before;
    restoreTerminal(second.terminal, await snapshot);
    await second.apply({ sequence: 2, data: new Uint8Array([0x98, 0x80]) });
    await after;
    assertEquals(await second.capture(), await first.capture());
    assertEquals(
      first.terminal.buffer.active.getLine(0)?.translateToString(true),
      "A😀",
    );
  } finally {
    await first.close();
    await second.close();
  }
});

Deno.test("canonical terminal answers detached queries and view parsing cannot duplicate replies", async () => {
  const owner = new TerminalEngine({ columns: 80, rows: 24 });
  const view = new TerminalEngine({ columns: 80, rows: 24 });
  try {
    installTerminalView(view.terminal);
    const snapshot = await owner.capture();
    restoreTerminal(view.terminal, snapshot);
    const event = { sequence: 1, data: encode("\x1b[6n\x1b]11;?\x07") };
    const reply = await owner.apply(event);
    assertEquals(
      new TextDecoder().decode(reply),
      "\x1b[1;1R\x1b]11;rgb:0d0d/1111/1717\x1b\\",
    );
    assertEquals(await view.apply(event), undefined);
    assertEquals(await view.capture(), await owner.capture());
  } finally {
    await owner.close();
    await view.close();
  }
});

Deno.test("batched native reads preserve byte, query, resize and snapshot ordering", async () => {
  const serial = new TerminalEngine({ columns: 20, rows: 6 });
  const batched = new TerminalEngine({ columns: 20, rows: 6 });
  const events = [
    { sequence: 1, data: new Uint8Array([0x41, 0xf0, 0x9f]) },
    { sequence: 2, data: new Uint8Array([0x98, 0x80, 0x1b, 0x5b]) },
    { sequence: 3, data: encode("6n\x1b7\x1b[2;5r\x1b[?1049hother") },
    { sequence: 4, size: { columns: 30, rows: 8 } },
    { sequence: 5, data: encode("\x1b[6n\x1b[?1049l\x1b8\x1b]11;?\x07") },
    { sequence: 6, data: encode("\r\nfinal") },
  ];
  try {
    const expected = [];
    for (const event of events) expected.push(await serial.apply(event));
    const pending = batched.applyBatch(events);
    const snapshot = batched.capture();
    const later = batched.apply({ sequence: 7, data: encode("later") });
    void later.catch(() => {});
    assertEquals(await pending, expected);
    assertEquals(await snapshot, await serial.capture());
    await later;
    await serial.apply({ sequence: 7, data: encode("later") });
    assertEquals(await batched.capture(), await serial.capture());
  } finally {
    await serial.close();
    await batched.close();
  }
});

Deno.test("snapshots continue synchronized redraws, queries and application cursor styles", async () => {
  const owner = new TerminalEngine({ columns: 80, rows: 24 });
  const view = new TerminalEngine({ columns: 80, rows: 24 });
  try {
    installTerminalView(view.terminal);
    await owner.apply({
      sequence: 1,
      data: encode("\x1b[?2026h\x1b[19;1H\x1b[5 q"),
    });
    const snapshot = await owner.capture();
    restoreTerminal(view.terminal, snapshot);
    assertEquals(view.terminal.modes.synchronizedOutputMode, true);
    assertEquals(await view.capture(), snapshot);
    const query = { sequence: 2, data: encode("\x1b[?2026$p\x1b[6n") };
    assertEquals(
      new TextDecoder().decode(await owner.apply(query)),
      "\x1b[?2026;1$y\x1b[19;1R",
    );
    assertEquals(await view.apply(query), undefined);
    const end = { sequence: 3, data: encode("\x1b[24;3H\x1b[?2026l") };
    await owner.apply(end);
    await view.apply(end);
    assertEquals(view.terminal.modes.synchronizedOutputMode, false);
    assertEquals(await view.capture(), await owner.capture());
    await owner.apply({ sequence: 4, data: encode("\x1b[0 q") });
    assertEquals((await owner.capture()).decModes.cursorStyle, undefined);
  } finally {
    await owner.close();
    await view.close();
  }
});

Deno.test("terminal state rejects hostile object keys and impossible allocation shapes", async () => {
  const owner = new TerminalEngine({ columns: 80, rows: 24 });
  try {
    const original = await owner.capture();
    for (
      const change of [
        { ...original, cols: 501 },
        { ...original, rows: 0 },
        { ...original, scrollback: 100_000 },
        { ...original, version: "unqualified-engine" },
        {
          ...original,
          normal: {
            ...original.normal,
            geometry: JSON.parse('{"__proto__":{}}'),
          },
        },
        { ...original, palette: { colors: [], defaults: [] } },
      ]
    ) assertThrows(() => validateSnapshot(change), Error);
    validateSnapshot(original);
  } finally {
    await owner.close();
  }
});

Deno.test("closing the engine drains an admitted write and rejects future work", async () => {
  const owner = new TerminalEngine({ columns: 80, rows: 24 });
  const admitted = owner.apply({ sequence: 1, data: encode("output") });
  // Enter the queued write before close; its xterm callback must still finish.
  await Promise.resolve();
  await owner.close();
  await admitted;
  await assertRejects(() => owner.capture(), Error, "closed");
});
