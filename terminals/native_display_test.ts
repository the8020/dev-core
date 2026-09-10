import { assertEquals } from "@std/assert";
import { TerminalEngine } from "./engine.ts";
import { NativeTerminalDisplay } from "./native_display.ts";
import { NativeTerminalView } from "./native_view.ts";
import { captureTerminal } from "./state.ts";
import { TestTerminals } from "./test_support.ts";

const encoder = new TextEncoder();
function lines(engine: TerminalEngine, history = false): string[] {
  const b = engine.terminal.buffer.active;
  return Array.from(
    { length: history ? b.length : engine.terminal.rows },
    (_, y) =>
      b.getLine(y + (history ? 0 : b.baseY))?.translateToString(true) ?? "",
  );
}

Deno.test("native history accepts a full 256-KiB native read", async () => {
  const source = new TerminalEngine({ columns: 80, rows: 24 });
  const client = new TerminalEngine({ columns: 80, rows: 24 });
  const display = new NativeTerminalDisplay(source);
  try {
    await client.apply({
      sequence: 1,
      data: encoder.encode(display.initial()),
    });
    await source.apply({
      sequence: 1,
      data: encoder.encode("x".repeat(256 << 10)),
    });
    const update = encoder.encode(display.update());
    assertEquals(update.byteLength < 1 << 20, true);
    await client.apply({ sequence: 2, data: update });
    assertEquals(lines(client, true), lines(source, true));
    assertEquals(
      client.terminal.buffer.active.cursorX,
      source.terminal.buffer.active.cursorX,
    );
  } finally {
    display.close();
    await source.close();
    await client.close();
  }
});

Deno.test("new native shells restore startup text without filling unused rows", async () => {
  for (
    const startup of [
      "",
      "root@development:/workspace# ",
      "Welcome\r\nroot@development:/workspace# ",
    ]
  ) {
    const source = new TerminalEngine({ columns: 80, rows: 40 });
    const client = new TerminalEngine({ columns: 80, rows: 40 });
    let display: NativeTerminalDisplay | undefined;
    try {
      await source.apply({ sequence: 1, data: encoder.encode(startup) });
      display = new NativeTerminalDisplay(source);
      const initial = display.initial();
      assertEquals(
        initial.includes("\n"),
        false,
        "unused rows must not become newlines",
      );
      // deno-lint-ignore no-control-regex
      const cursorRows = [...initial.matchAll(/\x1b\[(\d+);\d+H/g)].map((
        match,
      ) => Number(match[1]));
      assertEquals(
        Math.max(...cursorRows),
        source.terminal.buffer.active.cursorY + 1,
      );
      await client.apply({ sequence: 1, data: encoder.encode(initial) });
      assertEquals(lines(client, true), lines(source, true));
      assertEquals(
        client.terminal.buffer.active.cursorX,
        source.terminal.buffer.active.cursorX,
      );
      for (
        const [index, text] of ["echo hello", "\r\nhello\r\nroot# "].entries()
      ) {
        await source.apply({ sequence: index + 2, data: encoder.encode(text) });
        await client.apply({
          sequence: index + 2,
          data: encoder.encode(display.update()),
        });
        assertEquals(lines(client, true), lines(source, true));
      }
    } finally {
      display?.close();
      await source.close();
      await client.close();
    }
  }
});

Deno.test("native startup clears stale cells without scrolling the client's viewport", async () => {
  const source = new TerminalEngine({ columns: 80, rows: 40 });
  const client = new TerminalEngine({ columns: 80, rows: 40 });
  const display = new NativeTerminalDisplay(source);
  const clears: number[] = [];
  const handler = client.terminal.parser.registerCsiHandler(
    { final: "J" },
    (params) => {
      clears.push(Number(params[0] ?? 0));
      return false;
    },
  );
  try {
    await client.apply({
      sequence: 1,
      data: encoder.encode("local output\r\n".repeat(45) + "SSH password: "),
    });
    const history = lines(client, true).slice(
      0,
      client.terminal.buffer.normal.baseY,
    );
    await source.apply({
      sequence: 1,
      data: encoder.encode("root@development:/workspace# "),
    });
    await client.apply({
      sequence: 2,
      data: encoder.encode(display.initial()),
    });
    // ED 2 scrolls the viewport into history in Warp; ED 0 at home erases in place.
    assertEquals(clears, [0]);
    assertEquals(lines(client), lines(source));
    assertEquals(
      lines(client, true).slice(0, client.terminal.buffer.normal.baseY),
      history,
    );
    assertEquals(client.terminal.buffer.normal.cursorY, 0);
    assertEquals(
      client.terminal.buffer.normal.cursorX,
      source.terminal.buffer.normal.cursorX,
    );
  } finally {
    handler.dispose();
    display.close();
    await source.close();
    await client.close();
  }
});

Deno.test("native display recovers history and continues partial parser state without answering queries", async () => {
  const source = new TerminalEngine({ columns: 40, rows: 8 });
  const client = new TerminalEngine({ columns: 40, rows: 8 });
  let display: NativeTerminalDisplay | undefined;
  let sequence = 0;
  const parse = (engine: TerminalEngine, data: string | Uint8Array) =>
    engine.apply({
      sequence: ++sequence,
      data: typeof data === "string" ? encoder.encode(data) : data,
    });
  try {
    await parse(
      source,
      Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join(""),
    );
    display = new NativeTerminalDisplay(source);
    assertEquals(await parse(client, display.initial()), undefined);
    assertEquals(lines(client, true), lines(source, true));
    // Every byte boundary can stop inside UTF-8, a query, saved cursor, CSI,
    // a charset switch, or an OSC color change. Only source may answer.
    const stream = encoder.encode(
      "\x1b[31mα😀\x1b[0m\x1b7\x1b[2;5Hsaved\x1b8!\x1b[6n\x1b]4;1;#123456\x1b\\\x1b(0lqqk\x1b(B\r\n",
    );
    for (const byte of stream) {
      await parse(source, new Uint8Array([byte]));
      assertEquals(await parse(client, display.update()), undefined);
      assertEquals(lines(client), lines(source));
    }
    for (
      const chunk of [
        "new\r\n".repeat(40),
        "\x1b[?1049h\x1b[Hhtop\x1b[3;1Hprocesses",
        "\x1b[2;6r\x1b[6;1Hregion\nnext",
        "\x1b[?1049l",
        "\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h",
      ]
    ) {
      await parse(source, chunk);
      assertEquals(await parse(client, display.update()), undefined);
      assertEquals(lines(client), lines(source));
      assertEquals(
        client.terminal.buffer.active.type,
        source.terminal.buffer.active.type,
      );
    }
    assertEquals(
      client.terminal.modes.applicationCursorKeysMode,
      source.terminal.modes.applicationCursorKeysMode,
    );
    assertEquals(
      client.terminal.modes.bracketedPasteMode,
      source.terminal.modes.bracketedPasteMode,
    );
    assertEquals(
      client.terminal.modes.mouseTrackingMode,
      source.terminal.modes.mouseTrackingMode,
    );
    assertEquals(lines(client, true), lines(source, true));
    await source.apply({
      sequence: ++sequence,
      size: { columns: 55, rows: 12 },
    });
    await client.apply({
      sequence: ++sequence,
      size: { columns: 55, rows: 12 },
    });
    assertEquals(await parse(client, display.update()), undefined);
    assertEquals(lines(client), lines(source));
  } finally {
    display?.close();
    await source.close();
    await client.close();
  }
});

Deno.test("native projection preserves RGB, styled Unicode and hyperlinks without replaying clipboard effects", async () => {
  const source = new TerminalEngine({ columns: 40, rows: 8 });
  const client = new TerminalEngine({ columns: 40, rows: 8 });
  let display: NativeTerminalDisplay | undefined;
  try {
    await source.apply({
      sequence: 1,
      data: encoder.encode(
        "\x1b[1;38;2;0;0;3mA\x1b[0;4:3;58:2::12:34:56m界\x1b[0m\x1b]8;;https://example.test/link\x1b\\linked\x1b]8;;\x1b\\\x1b]52;c;aGlzdG9yeQ==\x07\x1b[4;1Hbelow cursor\x1b[6;1H\x1b[44m\x1b[2K\x1b[0m\x1b[1;1H",
      ),
    });
    display = new NativeTerminalDisplay(source);
    assertEquals(
      await client.apply({
        sequence: 1,
        data: encoder.encode(display.initial()),
      }),
      undefined,
    );
    assertEquals(lines(client), lines(source));
    assertEquals(
      client.terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor(),
      3,
    );
    assertEquals(
      client.terminal.buffer.active.getLine(5)?.getCell(0)?.getBgColor(),
      0x3465a4,
      "blank rows with a background must still be restored",
    );
    const snapshot = captureTerminal(client.terminal);
    assertEquals(
      snapshot.links.some((entry: { data: { uri: string } }) =>
        entry.data.uri === "https://example.test/link"
      ),
      true,
    );
  } finally {
    display?.close();
    await source.close();
    await client.close();
  }
});

Deno.test("native views publish completed redraws and defer recovery across split DEC 2026 sequences", async () => {
  const source = new TerminalEngine({ columns: 80, rows: 24 });
  const client = new TerminalEngine({ columns: 80, rows: 24 });
  const writes: string[] = [];
  const native = new TestTerminals();
  let view: NativeTerminalView | undefined;
  let sequence = 0;
  const output = async (text: string) => {
    await source.apply({ sequence: ++sequence, data: encoder.encode(text) });
    view?.update();
  };
  try {
    await output("\x1b[?2026h\x1b[20;1HWorking\x1b[19;1H");
    view = new NativeTerminalView(
      new NativeTerminalDisplay(source),
      "processor",
      "view",
      {
        ...native.api,
        writeView: (_processor, _view, data) => {
          writes.push(new TextDecoder().decode(data));
          return Promise.resolve();
        },
      },
      new AbortController().signal,
      () => {},
    );
    assertEquals(
      writes,
      [],
      "initial recovery must wait for the composer cursor",
    );
    // History arriving before initial recovery must be restored exactly once.
    await output("\x1b[24;1H" + "history\r\n".repeat(30));
    await output("\x1b[24;3H\x1b[5 q\x1b[?2026l");
    await client.apply({ sequence: 1, data: encoder.encode(writes.join("")) });
    assertEquals(lines(client, true), lines(source, true));
    assertEquals(client.terminal.buffer.active.cursorX, 2);
    assertEquals(client.terminal.buffer.active.cursorY, 23);
    assertEquals(captureTerminal(client.terminal).decModes.cursorStyle, "bar");
    const before = writes.length;
    for (const byte of "\x1b[?2026h\x1b[19;1H\x1b[K") await output(byte);
    // The incomplete BSU prefix may produce harmless updates. Once recognized,
    // the real temporary cursor position must never reach the native client.
    const drawing = writes.length;
    await output("\x1b[?25h\x1b[?2026$p\x1b[6n");
    assertEquals(writes.length, drawing);
    for (const frame of writes.slice(before)) {
      await client.apply({ sequence: ++sequence, data: encoder.encode(frame) });
      assertEquals(client.terminal.buffer.active.cursorY, 23);
    }
    await output("\x1b[24;3H\x1b[?2026");
    assertEquals(writes.length, drawing);
    await output("l");
    assertEquals(writes.length, drawing + 1);
    for (const frame of writes) {
      assertEquals(frame.startsWith("\x1b[?2026h"), true);
      assertEquals(frame.endsWith("\x1b[?2026l"), true);
      assertEquals(frame.includes("\x1b[?2026$p"), false);
    }
    await client.apply({
      sequence: ++sequence,
      data: encoder.encode(writes.at(-1)!),
    });
    assertEquals(client.terminal.buffer.active.cursorY, 23);
    assertEquals(lines(client, true), lines(source, true));
  } finally {
    view?.close();
    await source.close();
    await client.close();
  }
});

Deno.test("native views commit adjacent frames before parsing the next partial frame", async () => {
  const stream = encoder.encode(
    "\x1b[?2026;2004h\x1b[2;1Hfirst\x1b[24;3H\x1b[?2026;2004l" +
      "\x1b[?2026h\x1b[2;1Hsecond\x1b[24;5H\x1b[?2026l" +
      "\x1b[?2026h\x1b[2;1Hunfinished\x1b[19;1H\x1b[6n\x1b[?2026$p",
  );
  // Transport chunking must not choose which application frames are displayed.
  for (
    const chunks of [
      [stream],
      [...stream].map((byte) => Uint8Array.of(byte)),
    ]
  ) {
    const source = new TerminalEngine({ columns: 80, rows: 24 });
    const client = new TerminalEngine({ columns: 80, rows: 24 });
    const writes: Uint8Array[] = [];
    const native = new TestTerminals();
    const view = new NativeTerminalView(
      new NativeTerminalDisplay(source),
      "processor",
      "view",
      {
        ...native.api,
        writeView: (_processor, _view, data) => {
          writes.push(data);
          return Promise.resolve();
        },
      },
      new AbortController().signal,
      () => {},
    );
    try {
      await client.apply({ sequence: 1, data: writes.shift()! });
      const replies = await source.applyBatch(
        chunks.map((data, index) => ({ sequence: index + 1, data })),
      );
      view.update();
      assertEquals(
        writes.length,
        2,
        "both completed frames reach the view immediately",
      );
      for (const [index, data] of writes.entries()) {
        await client.apply({ sequence: index + 2, data });
        assertEquals(lines(client)[1], ["first", "second"][index]);
        assertEquals(client.terminal.buffer.active.cursorY, 23);
        assertEquals(client.terminal.buffer.active.cursorX, [2, 4][index]);
        assertEquals(client.terminal.modes.bracketedPasteMode, false);
      }
      assertEquals(lines(source)[1], "unfinished");
      assertEquals(source.terminal.modes.synchronizedOutputMode, true);
      assertEquals(
        replies.map((reply) => reply ? new TextDecoder().decode(reply) : "")
          .join(""),
        "\x1b[19;1R\x1b[?2026;1$y",
        "queries continue exactly once inside the unfinished frame",
      );
      await source.apply({
        sequence: stream.length + 1,
        data: encoder.encode("\x1b[?2026l\x1b[1;1Hafter the frame"),
      });
      view.update();
      assertEquals(
        writes.length,
        4,
        "ordinary bytes after the end marker still publish",
      );
      for (const [index, data] of writes.slice(2).entries()) {
        await client.apply({ sequence: 4 + index, data });
      }
      assertEquals(lines(client), lines(source));
      view.update();
      assertEquals(
        writes.length,
        4,
        "unchanged projections do not send duplicate frames",
      );
      view.close();
      await source.apply({
        sequence: stream.length + 2,
        data: encoder.encode("\x1b[?2026hclosed\x1b[?2026l"),
      });
      assertEquals(
        writes.length,
        4,
        "closed views stop observing frame completions",
      );
    } finally {
      view.close();
      await source.close();
      await client.close();
    }
  }
});

Deno.test("native synchronized redraws have a deadline and flush on exit", async () => {
  const source = new TerminalEngine({ columns: 80, rows: 24 });
  const writes: string[] = [];
  const native = new TestTerminals();
  const view = new NativeTerminalView(
    new NativeTerminalDisplay(source),
    "processor",
    "view",
    {
      ...native.api,
      writeView: (_processor, _view, data) => {
        writes.push(new TextDecoder().decode(data));
        return Promise.resolve();
      },
    },
    new AbortController().signal,
    () => {},
  );
  try {
    await source.apply({
      sequence: 1,
      data: encoder.encode("\x1b[?2026hstalled"),
    });
    view.update();
    const before = writes.length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assertEquals(
      writes.length,
      before + 1,
      "a missing end marker cannot freeze the view",
    );
    await source.apply({
      sequence: 2,
      data: encoder.encode("ordinary output"),
    });
    view.update();
    assertEquals(
      writes.length,
      before + 2,
      "the deadline ends synchronization so subsequent output is immediate",
    );
    await source.apply({
      sequence: 3,
      data: encoder.encode("\x1b[?2026hfinal output"),
    });
    view.update();
    assertEquals(writes.length, before + 2, "a new frame still defers output");
    view.finish();
    assertEquals(writes.at(-1)!.includes("final output"), true);
  } finally {
    view.close();
    await source.close();
  }
});
