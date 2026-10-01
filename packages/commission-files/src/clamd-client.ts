import { connect, type Socket } from "node:net";

export class ClamdUnavailableError extends Error {
  constructor(readonly reason: "connect" | "timeout" | "protocol" | "closed" | "size_limit") {
    super(`clamd unavailable: ${reason}`); this.name = "ClamdUnavailableError";
  }
}
export type ClamdVerdict = Readonly<{ kind: "clean" }> | Readonly<{ kind: "found"; reason: "malware" | "encrypted_archive" | "limits_exceeded"; signature: string }>;
export type ClamdVersion = Readonly<{ engine: string; signatureVersion: number; signatureDate: Date }>;
export type ClamdClient = Readonly<{ scan(source: AsyncIterable<Uint8Array>): Promise<ClamdVerdict>; version(): Promise<ClamdVersion> }>;

const CHUNK_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 4096;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function parseClamdScanReply(reply: string): ClamdVerdict {
  if (reply === "stream: OK") return { kind: "clean" };
  const found = /^stream: (\S{1,200}) FOUND$/u.exec(reply);
  if (found) {
    const signature = found[1]!.replace(/[^A-Za-z0-9._:-]/gu, "_");
    const reason = signature.startsWith("Heuristics.Encrypted.") ? "encrypted_archive" : signature.startsWith("Heuristics.Limits.Exceeded") ? "limits_exceeded" : "malware";
    return { kind: "found", reason, signature };
  }
  if (/^INSTREAM size limit exceeded\.? ERROR$/u.test(reply)) throw new ClamdUnavailableError("size_limit");
  throw new ClamdUnavailableError("protocol");
}

/** The official image runs with TZ=UTC, so the database date is read as UTC. */
export function parseClamdVersion(reply: string): ClamdVersion {
  const match = /^ClamAV ([0-9][0-9A-Za-z.-]{0,31})\/([0-9]{1,9})\/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/u.exec(reply);
  if (!match) throw new ClamdUnavailableError("protocol");
  const [, engine, version, month, day, hour, minute, second, year] = match;
  const signatureDate = new Date(Date.UTC(Number(year), MONTHS.indexOf(month as typeof MONTHS[number]), Number(day), Number(hour), Number(minute), Number(second)));
  if (!Number.isFinite(signatureDate.getTime())) throw new ClamdUnavailableError("protocol");
  return { engine: engine!, signatureVersion: Number(version), signatureDate };
}

function write(socket: Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(new ClamdUnavailableError("closed")); return; }
    const onClose = () => reject(new ClamdUnavailableError("closed"));
    socket.once("close", onClose);
    const flushed = socket.write(data, (error) => { if (error) { socket.off("close", onClose); reject(new ClamdUnavailableError("closed")); } });
    const done = () => { socket.off("close", onClose); resolve(); };
    if (flushed) done(); else socket.once("drain", done);
  });
}

export function createClamdClient(options: Readonly<{ host: string; port: number; timeoutMs: number }>): ClamdClient {
  if (typeof options.host !== "string" || !options.host || !Number.isInteger(options.port) || options.port < 1 || options.port > 65_535 ||
    !Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 900_000) throw new Error("Invalid clamd client options");

  function exchange(send: (socket: Socket) => Promise<void>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const socket = connect({ host: options.host, port: options.port });
      const chunks: Buffer[] = []; let size = 0; let settled = false; let connected = false;
      const finish = (error: ClamdUnavailableError | null, reply?: string) => {
        if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(reply!);
      };
      const timer = setTimeout(() => finish(new ClamdUnavailableError("timeout")), options.timeoutMs);
      // `socket.connecting` can already be false by the time `error` fires (observed on this
      // Node/Windows combination even for a genuinely refused connection), so track the
      // transition explicitly instead of trusting that flag.
      socket.on("error", () => finish(new ClamdUnavailableError(connected ? "closed" : "connect")));
      socket.on("close", () => finish(new ClamdUnavailableError("closed")));
      socket.on("data", (data: Buffer) => {
        size += data.byteLength;
        if (size > MAX_REPLY_BYTES) { finish(new ClamdUnavailableError("protocol")); return; }
        chunks.push(data);
        const all = Buffer.concat(chunks); const end = all.indexOf(0);
        if (end >= 0) finish(null, all.subarray(0, end).toString("utf8"));
      });
      socket.once("connect", () => {
        connected = true;
        socket.setNoDelay(true);
        send(socket).catch((error: unknown) => finish(error instanceof ClamdUnavailableError ? error : new ClamdUnavailableError("closed")));
      });
    });
  }

  return {
    async scan(source) {
      const reply = await exchange(async (socket) => {
        await write(socket, Buffer.from("zINSTREAM\0", "latin1"));
        for await (const chunk of source) {
          for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) {
            const part = chunk.subarray(offset, offset + CHUNK_BYTES);
            const header = Buffer.alloc(4); header.writeUInt32BE(part.byteLength);
            await write(socket, header); await write(socket, part);
          }
        }
        await write(socket, Buffer.alloc(4));
      });
      return parseClamdScanReply(reply);
    },
    async version() {
      return parseClamdVersion(await exchange((socket) => write(socket, Buffer.from("zVERSION\0", "latin1"))));
    },
  };
}
