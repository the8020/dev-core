import { assertEquals } from "@std/assert";
import { TerminalEngine } from "./engine.ts";
import { NativeTerminalDisplay } from "./native_display.ts";
import { captureTerminal } from "./state.ts";

const encoder = new TextEncoder();
function lines(engine: TerminalEngine, history = false): string[] {
  const b = engine.terminal.buffer.active;
  return Array.from(
    { length: history ? b.length : engine.terminal.rows },
    (_, y) =>
      b.getLine(y + (history ? 0 : b.baseY))?.translateToString(true) ?? "",
  );
}

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
        "\x1b[1;38;2;0;0;3mA\x1b[0;4:3;58:2::12:34:56m界\x1b[0m\x1b]8;;https://example.test/link\x1b\\linked\x1b]8;;\x1b\\\x1b]52;c;aGlzdG9yeQ==\x07",
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
