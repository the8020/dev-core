import type { TerminalEngine } from "./engine.ts";
import { MAX_SNAPSHOT_BYTES, nativeDisplaySource } from "./state.ts";

const encoder = new TextEncoder();
const prepare = "\x1b[?25l\x1b[?6l\x1b[?7l\x1b[4l\x1b[r\x1b(B\x0f";
const beginUpdate = "\x1b[?2026h";
const endUpdate = "\x1b[?2026l";
export const nativeDisplayCleanup = endUpdate +
  "\x1b[0m\x1b[?1049l\x1b[?25h\x1b[?7h\x1b[?1l\x1b>\x1b[?2004l\x1b[?1004l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[0 q\r\n";
const maximumDelta = 1 << 20;

/** Query-free VT projection of the canonical engine, with native scrollback. */
export class NativeTerminalDisplay {
  readonly #source;
  readonly #unobserve;
  #rows: string[] = [];
  #history: string[] = [];
  #historyBytes = 0;
  #alternate = false;
  #columns = 0;
  #height = 0;
  #overflow = false;
  #cursorModes = "";

  constructor(readonly engine: TerminalEngine) {
    this.#source = nativeDisplaySource(engine.terminal);
    this.#unobserve = this.#source.observeHistory((row) => {
      this.#historyBytes += encoder.encode(row).byteLength;
      if (this.#historyBytes > maximumDelta) this.#overflow = true;
      else this.#history.push(row);
    });
  }

  initial(): string {
    // Recovery includes rows committed while waiting for a synchronized redraw.
    this.#history = [];
    this.#historyBytes = 0;
    this.#overflow = false;
    const t = this.engine.terminal, normal = t.buffer.normal;
    let result = beginUpdate + prepare + "\x1b[?1049l\x1b[H\x1b[2J";
    if (normal.baseY > 0 || t.buffer.active.type === "alternate") {
      for (let index = 0; index < normal.baseY + t.rows; index++) {
        if (index) result += "\r\n";
        result += this.#source.line(normal, index);
        if (result.length * 3 > MAX_SNAPSHOT_BYTES) {
          throw new Error("Native terminal recovery exceeds its byte limit");
        }
      }
    } else {
      // The cleared screen already contains unused rows. Do not scroll a fresh
      // shell through a screenful of blank lines or move below its last content.
      this.#columns = t.cols;
      this.#height = t.rows;
      for (let y = t.rows - 1; y > normal.cursorY; y--) {
        const line = normal.getLine(y);
        let blank = true;
        for (let x = 0; x < t.cols && blank; x++) {
          const cell = line?.getCell(x);
          blank = !cell || (!cell.getChars() && cell.isAttributeDefault());
        }
        if (!blank) break;
        this.#rows[y] = this.#source.line(normal, y);
      }
    }
    result += this.#update(false) + endUpdate;
    if (result.length * 3 > MAX_SNAPSHOT_BYTES) {
      throw new Error("Native terminal recovery exceeds its byte limit");
    }
    return result;
  }

  update(force = false): string {
    const update = this.#update(force);
    return update ? beginUpdate + update + endUpdate : "";
  }

  #update(force: boolean): string {
    if (this.#overflow) throw new Error("Native terminal view fell behind");
    const t = this.engine.terminal, active = t.buffer.active;
    const alternate = active.type === "alternate";
    let result = prepare;
    if (this.#history.length) {
      if (this.#alternate) {
        result += "\x1b[?1049l";
        this.#alternate = false;
      }
      for (const row of this.#history) {
        // Paint the row leaving the canonical viewport, then scroll it into
        // the client's normal history. CUP/EL alone would lose that history.
        result += `\x1b[H${row}\x1b[${t.rows};1H\n`;
      }
      this.#history = [];
      this.#historyBytes = 0;
      force = true;
    }
    if (alternate !== this.#alternate) {
      result += alternate ? "\x1b[?1049h" : "\x1b[?1049l";
      this.#alternate = alternate;
      force = true;
    }
    if (this.#columns !== t.cols || this.#height !== t.rows) {
      this.#columns = t.cols;
      this.#height = t.rows;
      force = true;
    }
    const rows: string[] = [];
    for (let y = 0; y < t.rows; y++) {
      const row = this.#source.line(active, active.baseY + y);
      rows.push(row);
      if (force || row !== this.#rows[y]) result += `\x1b[${y + 1};1H${row}`;
    }
    this.#rows = rows;
    const cursorModes =
      `\x1b[${active.cursorY + 1};${Math.min(t.cols, active.cursorX + 1)}H` +
      this.#source.modes();
    // A frame completion and the surrounding native batch can publish the same
    // state. Send nothing until cells, history, geometry, cursor or modes change.
    if (result === prepare && cursorModes === this.#cursorModes) return "";
    this.#cursorModes = cursorModes;
    return result + cursorModes;
  }

  close(): void {
    this.#unobserve();
  }
}
