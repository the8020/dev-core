import { assertAlmostEquals, assertEquals } from "@std/assert";
import type { Browser } from "./browser_scenarios.ts";
import { TerminalEngine } from "./engine.ts";

/** Pixel checks supplement buffer/DOM geometry: font ink can leave empty rows. */
export async function verifyTerminalRendering(
  page: Browser,
  output: (data: string) => Promise<void>,
): Promise<void> {
  const original = await page.evaluate(`(() => {
    const {fontFamily, fontSize, cursorBlink} = globalThis.__terminalForTest.options;
    return {fontFamily, fontSize, cursorBlink};
  })()`);
  const paint = () =>
    page.evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  const blocks = Array.from(
    { length: 32 },
    (_, i) => String.fromCharCode(0x2580 + i),
  ).join("");
  try {
    for (const deviceScaleFactor of [1, 1.25, 2]) {
      for (const fontFamily of ["monospace", "serif"]) {
        await page.evaluate(
          `Object.assign(globalThis.__terminalForTest.options, {
          fontFamily: ${
            JSON.stringify(fontFamily)
          }, fontSize: 13, cursorBlink: false
        })`,
        );
        // Resize the host after changing fonts so its ordinary Fit path runs.
        await page.command("Emulation.setDeviceMetricsOverride", {
          width: fontFamily === "monospace" ? 1280 : 1200,
          height: 900,
          deviceScaleFactor,
          mobile: false,
        });
        await waitForTerminalSize(page);
        const size = await page.evaluate<{ columns: number; rows: number }>(
          "({columns: globalThis.__terminalForTest.cols, rows: globalThis.__terminalForTest.rows})",
        );
        const data = "\x1b[?2026h\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l" +
          "\x1b[0;38;2;255;255;255;48;2;0;0;0m" +
          ["████", "████", "████", blocks].join("\r\n") +
          "\r\n\x1b[38;2;255;0;0;48;2;0;0;255m▀\x1b[7m▀\x1b[27m" +
          "\r\n\x1b[0mA██▀B\r\n\x1b[48;2;17;25;39m" +
          ["👋", "👍"].map((emoji) => emoji + " ".repeat(size.columns - 2))
            .join("\r\n") +
          "\x1b[?2026l";
        const engine = new TerminalEngine(size);
        try {
          await engine.apply({
            sequence: 1,
            data: new TextEncoder().encode(data),
          });
          const snapshot = await engine.capture();
          await output(data);
          for (const restored of [false, true]) {
            if (restored) {
              await page.evaluate(
                `globalThis.__restoreTerminalForTest(${
                  JSON.stringify(snapshot)
                })`,
              );
            }
            await paint();
            const label =
              `${fontFamily}, DPR ${deviceScaleFactor}, restored ${restored}`;
            assertEquals(
              await page.evaluate(`(() => {
                const terminal = globalThis.__terminalForTest;
                return [6, 7].map(y => {
                  const line = terminal.buffer.active.getLine(y);
                  return [line.getCell(0).getWidth(), line.getCell(1).getWidth(), line.getCell(terminal.cols - 1).getBgColor()];
                });
              })()`),
              [[2, 0, 0x111927], [2, 0, 0x111927]],
              `emoji widths and final background cells: ${label}`,
            );
            const geometry = await page.evaluate(`(() => {
              const terminal = globalThis.__terminalForTest;
              const rows = [...terminal.element.querySelector('.xterm-rows').children].slice(0, 8);
              return {cell: rows[0].getBoundingClientRect().width / terminal.cols,
                rows: rows.map(row => row.getBoundingClientRect().toJSON()), cols: terminal.cols};
            })()`);
            const screenshot = await page.command<{ data: string }>(
              "Page.captureScreenshot",
              { format: "png" },
            );
            await Deno.writeFile(
              "/tmp/8020-terminal-blocks-browser.png",
              Uint8Array.from(atob(screenshot.data), (c) => c.charCodeAt(0)),
            );
            const pixels = await page.evaluate<{
              gaps: number[];
              coverage: number[];
              coverageTolerance: number;
              quadrants: number[][];
              colors: number[][];
              finalCells: number[][];
            }>(`(async () => {
              const image = new Image();
              image.src = 'data:image/png;base64,${screenshot.data}';
              await image.decode();
              const canvas = document.createElement('canvas');
              canvas.width = image.width; canvas.height = image.height;
              const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
              const {cell, rows, cols} = ${
              JSON.stringify(geometry)
            }, dpr = devicePixelRatio;
              const pixel = (x, y) => [...ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data].slice(0, 3);
              const sample = (row, col, x, y) => pixel(rows[row].left + (col + x) * cell, rows[row].top + y * rows[row].height);
              const gaps = [];
              for (let y = Math.ceil(rows[0].top * dpr); y < Math.floor(rows[2].bottom * dpr); y++) {
                const boundary = rows.slice(1, 3).some(row => Math.abs(row.top * dpr - (y + .5)) < 1);
                const minimum = boundary && dpr % 1 ? 64 : 255;
                if (pixel(rows[0].left + cell / 2, (y + .5) / dpr).some(c => c < minimum)) gaps.push(y);
              }
              const coverage = Array.from({length: 32}, (_, col) => {
                let light = 0, count = 0;
                const left = (rows[3].left + col * cell) * dpr, right = left + cell * dpr;
                const top = rows[3].top * dpr, bottom = rows[3].bottom * dpr;
                for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
                  for (let x = Math.floor(left); x < Math.ceil(right); x++) {
                    const area = (Math.min(x + 1, right) - Math.max(x, left)) * (Math.min(y + 1, bottom) - Math.max(y, top));
                    light += ctx.getImageData(x, y, 1, 1).data[0] / 255 * area; count += area;
                  }
                }
                return light / count;
              });
              const quadrants = [0,4,12,16,22,23,24,25,26,27,28,29,30,31].map(col =>
                [[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y]) => sample(3, col, x, y)[0] > 128 ? 1 : 0));
              return {gaps, coverage, coverageTolerance: 2 / (cell * dpr), quadrants,
                colors: [sample(4,0,.5,.25), sample(4,0,.5,.75), sample(4,1,.5,.25), sample(4,1,.5,.75)],
                finalCells: [sample(6,cols-1,.5,.5), sample(7,cols-1,.5,.5)]};
            })()`);
            assertEquals(
              pixels.gaps,
              [],
              `full-block pixel coverage: ${label}`,
            );
            const coverage = [
              4,
              1,
              2,
              3,
              4,
              5,
              6,
              7,
              8,
              7,
              6,
              5,
              4,
              3,
              2,
              1,
              4,
              2,
              4,
              6,
              1,
              1,
              2,
              2,
              2,
              6,
              4,
              6,
              6,
              2,
              4,
              6,
            ];
            // Shape edges and tile boundaries can each antialias one device pixel.
            for (const [index, expected] of coverage.entries()) {
              assertAlmostEquals(
                pixels.coverage[index]!,
                expected / 8,
                pixels.coverageTolerance,
                `${blocks[index]} ink coverage: ${label}`,
              );
            }
            assertEquals(pixels.quadrants, [
              [1, 1, 0, 0],
              [0, 0, 1, 1],
              [1, 0, 1, 0],
              [0, 1, 0, 1],
              [0, 0, 1, 0],
              [0, 0, 0, 1],
              [1, 0, 0, 0],
              [1, 0, 1, 1],
              [1, 0, 0, 1],
              [1, 1, 1, 0],
              [1, 1, 0, 1],
              [0, 1, 0, 0],
              [0, 1, 1, 0],
              [0, 1, 1, 1],
            ], `half/quadrant shapes: ${label}`);
            assertEquals(pixels.colors, [
              [255, 0, 0],
              [0, 0, 255],
              [0, 0, 255],
              [255, 0, 0],
            ], `foreground, background and inverse colors: ${label}`);
            assertEquals(
              pixels.finalCells,
              [[17, 25, 39], [17, 25, 39]],
              label,
            );
          }
        } finally {
          await engine.close();
        }
      }
    }
    assertEquals(
      await page.evaluate(`(() => {
      const terminal = globalThis.__terminalForTest;
      terminal.select(0, 5, 5);
      const clipboardData = new DataTransfer();
      terminal.element.dispatchEvent(new ClipboardEvent('copy', {clipboardData, bubbles:true, cancelable:true}));
      const text = terminal.element.querySelector('.xterm-rows').children[5].textContent.trimEnd();
      terminal.clearSelection();
      return [text, clipboardData.getData('text/plain')];
    })()`),
      ["A██▀B", "A██▀B"],
      "retained text and copying",
    );
    assertEquals(
      await page.evaluate(`(async () => {
      const terminal = globalThis.__terminalForTest;
      terminal.select(0, 4, 2);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const selected = [...terminal.element.querySelector('.xterm-rows').children[4].children].slice(0, 2).map(span => getComputedStyle(span));
      const visible = terminal.getSelection() === '▀▀' &&
        selected[0].backgroundColor === selected[1].backgroundColor &&
        selected[0].backgroundColor !== 'rgb(0, 0, 255)' &&
        selected.every(style => style.backgroundImage !== 'none');
      terminal.clearSelection();
      return visible;
    })()`),
      true,
      "selection styling",
    );
    await paint();
    await page.evaluate("globalThis.__terminalForTest.focus()");
    for (const [code, style] of [[2, "block"], [4, "underline"], [6, "bar"]]) {
      await output(`\x1b[0m\x1b[?25h\x1b[6;2H\x1b[${code} q`);
      await paint();
      assertEquals(
        await page.evaluate(`(() => {
        const cursor = document.querySelector('.xterm-cursor');
        const css = getComputedStyle(cursor);
        return cursor.textContent === '█' && cursor.classList.contains('xterm-cursor-${style}') &&
          css.backgroundImage !== 'none' && ("${style}" !== 'bar' || css.boxShadow !== 'none') &&
          ("${style}" !== 'underline' || css.borderBottomStyle === 'solid');
      })()`),
        true,
        `${style} cursor retains geometry and xterm styling`,
      );
    }
  } finally {
    await page.evaluate(
      `Object.assign(globalThis.__terminalForTest.options, ${
        JSON.stringify(original)
      })`,
    );
    await page.command("Emulation.clearDeviceMetricsOverride");
    await output("\x1b[0m\x1b[0 q\x1b[?25h\x1b[?1049l");
  }
}

/** Wait for debounced PTY geometry and the silent-resize presentation fallback. */
export async function waitForTerminalSize(page: Browser): Promise<void> {
  assertEquals(
    await page.evaluate(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const terminal = globalThis.__terminalForTest;
    const deadline = performance.now() + 5000;
    do {
      const size = globalThis.__terminalFitForTest.proposeDimensions();
      if (terminal.cols === size.cols && terminal.rows === size.rows &&
          Math.abs(parseFloat(getComputedStyle(terminal.element.querySelector('.xterm-screen')).width) -
            terminal._core._renderService.dimensions.css.canvas.width) < 0.5) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < deadline);
    return false;
  })()`),
    true,
    "terminal geometry settles after viewport resize",
  );
}
