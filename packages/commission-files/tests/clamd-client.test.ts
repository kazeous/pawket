import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { ClamdUnavailableError, createClamdClient, parseClamdScanReply, parseClamdVersion } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))); });

async function fakeClamd(handle: (socket: Socket, received: () => Buffer) => void): Promise<number> {
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (data) => chunks.push(data));
    handle(socket, () => Buffer.concat(chunks));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
function replyAfterStream(reply: string) {
  return (socket: Socket, received: () => Buffer) => socket.on("data", () => {
    const all = received();
    if (all.byteLength >= 14 && all.subarray(all.byteLength - 4).equals(Buffer.alloc(4))) socket.end(`${reply}\0`);
  });
}
async function* source(...parts: string[]) { for (const part of parts) yield new TextEncoder().encode(part); }

describe("clamd client", () => {
  test("bounds a silent VERSION and cancels its socket explicitly", async () => {
    const port = await fakeClamd(() => undefined);
    await expect(createClamdClient({ host: "127.0.0.1", port, timeoutMs: 100 }).version()).rejects.toMatchObject({ reason: "timeout" });
    const abort = new AbortController();
    const pending = createClamdClient({ host: "127.0.0.1", port, timeoutMs: 300_000 }).version(abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ reason: "closed" });
    await expect(createClamdClient({ host: "127.0.0.1", port, timeoutMs: 300_000 }).version(abort.signal)).rejects.toMatchObject({ reason: "closed" });
  });
  test("frames INSTREAM chunks and reports a clean stream", async () => {
    let framed: Buffer | undefined;
    const port = await fakeClamd((socket, received) => socket.on("data", () => {
      const all = received();
      if (all.byteLength >= 14 && all.subarray(all.byteLength - 4).equals(Buffer.alloc(4))) { framed = all; socket.end("stream: OK\0"); }
    }));
    await expect(createClamdClient({ host: "127.0.0.1", port, timeoutMs: 2_000 }).scan(source("abc", "de"))).resolves.toEqual({ kind: "clean" });
    expect(framed!.subarray(0, 10).toString("latin1")).toBe("zINSTREAM\0");
    expect(framed!.readUInt32BE(10)).toBe(3);
    expect(framed!.subarray(14, 17).toString()).toBe("abc");
    expect(framed!.readUInt32BE(17)).toBe(2);
  });
  test.each([
    ["stream: Eicar-Signature FOUND", { kind: "found", reason: "malware", signature: "Eicar-Signature" }],
    ["stream: Heuristics.Encrypted.Zip FOUND", { kind: "found", reason: "encrypted_archive", signature: "Heuristics.Encrypted.Zip" }],
    ["stream: Heuristics.Limits.Exceeded.MaxRecursion FOUND", { kind: "found", reason: "limits_exceeded", signature: "Heuristics.Limits.Exceeded.MaxRecursion" }],
    ["stream: Win.Test/Odd(Name) FOUND", { kind: "found", reason: "malware", signature: "Win.Test_Odd_Name_" }],
  ])("maps %j", async (reply, verdict) => {
    const port = await fakeClamd(replyAfterStream(reply));
    await expect(createClamdClient({ host: "127.0.0.1", port, timeoutMs: 2_000 }).scan(source("x"))).resolves.toEqual(verdict);
  });
  test.each([
    ["an unrecognised reply", (socket: Socket) => socket.on("data", () => socket.end("hello\0")), "protocol"],
    ["a size-limit error", (socket: Socket) => socket.on("data", () => socket.end("INSTREAM size limit exceeded. ERROR\0")), "size_limit"],
    ["a close without reply", (socket: Socket) => socket.on("data", () => socket.destroy()), "closed"],
    ["silence", () => undefined, "timeout"],
  ] as const)("treats %s as unavailable", async (_label, handle, reason) => {
    const port = await fakeClamd(handle);
    const error = await createClamdClient({ host: "127.0.0.1", port, timeoutMs: 300 }).scan(source("x")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClamdUnavailableError);
    expect(error).toMatchObject({ reason });
  });
  test("treats a refused connection as unavailable", async () => {
    const port = await fakeClamd(() => undefined);
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(createClamdClient({ host: "127.0.0.1", port, timeoutMs: 1_000 }).version()).rejects.toMatchObject({ reason: "connect" });
  });
  test("parses VERSION as UTC and refuses malformed versions", () => {
    expect(parseClamdVersion("ClamAV 1.4.3/27780/Tue Sep 30 09:23:45 2026")).toEqual({ engine: "1.4.3", signatureVersion: 27780, signatureDate: new Date("2026-09-30T09:23:45Z") });
    expect(parseClamdVersion("ClamAV 1.4.3/27780/Wed Oct  1 07:00:00 2026").signatureDate.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    for (const bad of ["ClamAV 1.4.3", "hello", "ClamAV 1.4.3/x/Tue Sep 30 09:23:45 2026"]) expect(() => parseClamdVersion(bad)).toThrow(ClamdUnavailableError);
  });
  test("parses replies without trusting unknown shapes", () => {
    expect(parseClamdScanReply("stream: OK")).toEqual({ kind: "clean" });
    expect(() => parseClamdScanReply("stream: OK extra")).toThrow(ClamdUnavailableError);
    expect(() => parseClamdScanReply("stream:  FOUND")).toThrow(ClamdUnavailableError);
  });
});
