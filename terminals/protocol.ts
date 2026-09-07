export const TERMINAL_PROTOCOL = "the8020.terminal.v1";
export const TERMINAL_SERVICE = "/the8020/dev-core/terminals";
export const VIEW_WINDOW_BYTES = 262_144;
export const VIEW_QUEUE_BYTES = 1_048_576;
export const VIEW_QUEUE_FRAMES = 512;

export interface TerminalItem {
  id: string;
  name: string;
  route: string;
}

export function outputFrame(
  sequence: number,
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(8 + data.byteLength);
  new DataView(frame.buffer).setBigUint64(0, BigInt(sequence));
  frame.set(data, 8);
  return frame;
}

export function outputSequence(frame: Uint8Array): number {
  if (frame.byteLength < 9) {
    throw new TypeError("Invalid terminal output frame");
  }
  const sequence = Number(
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(
      0,
    ),
  );
  if (!Number.isSafeInteger(sequence)) {
    throw new TypeError("Invalid terminal sequence");
  }
  return sequence;
}
