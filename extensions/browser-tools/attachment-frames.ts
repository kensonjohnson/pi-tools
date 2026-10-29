import { Transform, type TransformCallback } from "node:stream";

/** Enforces a per-WebSocket-message byte limit without buffering frame bodies. */
export class AttachmentFrameLimit extends Transform {
  private header = Buffer.alloc(14);
  private have = 0;
  private need = 2;
  private remaining = 0;
  private messageBytes = 0;
  private fragmented = false;
  private readonly masked: boolean;
  private readonly limit: number;
  constructor(masked: boolean, limit: number) {
    super();
    this.masked = masked;
    this.limit = limit;
  }
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.remaining) {
          const size = Math.min(this.remaining, chunk.length - offset);
          this.remaining -= size;
          offset += size;
          continue;
        }
        const count = Math.min(this.need - this.have, chunk.length - offset);
        chunk.copy(this.header, this.have, offset, offset + count);
        this.have += count;
        offset += count;
        if (this.have < this.need) continue;
        if (this.need === 2) {
          const length = this.header[1] & 127;
          this.need =
            2 +
            (length === 126 ? 2 : length === 127 ? 8 : 0) +
            (this.header[1] & 128 ? 4 : 0);
          if (this.have < this.need) continue;
        }
        const first = this.header[0];
        const opcode = first & 15;
        const fin = !!(first & 128);
        if (first & 112 || !!(this.header[1] & 128) !== this.masked)
          throw new Error("Unsupported WebSocket frame");
        const code = this.header[1] & 127;
        const length =
          code < 126
            ? BigInt(code)
            : code === 126
              ? BigInt(this.header.readUInt16BE(2))
              : this.header.readBigUInt64BE(2);
        if (length > BigInt(this.limit))
          throw new Error("Attachment WebSocket message exceeds limit");
        const size = Number(length);
        if (opcode >= 8) {
          if (!fin || size > 125 || ![8, 9, 10].includes(opcode))
            throw new Error("Invalid WebSocket control frame");
        } else {
          if (opcode === 0) {
            if (!this.fragmented)
              throw new Error("Invalid WebSocket continuation");
          } else if (opcode === 1 || opcode === 2) {
            if (this.fragmented)
              throw new Error("Invalid WebSocket fragmentation");
            this.messageBytes = 0;
          } else throw new Error("Invalid WebSocket opcode");
          this.messageBytes += size;
          if (this.messageBytes > this.limit)
            throw new Error("Attachment WebSocket message exceeds limit");
          this.fragmented = !fin;
          if (fin) this.messageBytes = 0;
        }
        this.remaining = size;
        this.have = 0;
        this.need = 2;
      }
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }
}
