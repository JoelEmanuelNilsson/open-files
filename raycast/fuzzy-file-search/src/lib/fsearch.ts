import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const FSEARCH_BINARY = path.join(os.homedir(), ".local", "bin", "fsearch");
export const FSEARCH_SOCKET = path.join(os.homedir(), "Library", "Application Support", "FSearch", "fsearch.sock");

/** One indexed entry; `mtime` is unix seconds. */
export type FsearchHit = {
  readonly kind: "file" | "dir" | "link";
  readonly path: string;
  readonly score: number;
  readonly mtime: number;
};

/** The ways a search ends: merged hits, best score first, or an expected failure the UI can show. */
export type FsearchOutcome =
  | { readonly kind: "hits"; readonly hits: ReadonlyArray<FsearchHit> }
  | { readonly kind: "binary-missing" }
  | { readonly kind: "indexing" }
  | { readonly kind: "error"; readonly message: string };

type Response = { ok: true; hits: FsearchHit[] } | { ok: false; error: string };

const INDEXING_ERROR = /^indexing/;
const HIT_KINDS: ReadonlySet<unknown> = new Set(["file", "dir", "link"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parseHit(value: unknown): FsearchHit | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, path: hitPath, score, mtime } = value;
  if (!HIT_KINDS.has(kind) || typeof hitPath !== "string" || typeof score !== "number" || typeof mtime !== "number") {
    return undefined;
  }
  // SAFETY: HIT_KINDS.has(kind) proved kind is one of the three literals.
  return { kind: kind as FsearchHit["kind"], path: hitPath, score, mtime };
}

function parseResponseLine(line: string): { id: number; response: Response } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.id !== "number") return undefined;
  if (value.ok === true && Array.isArray(value.hits)) {
    return { id: value.id, response: { ok: true, hits: value.hits.flatMap((hit) => parseHit(hit) ?? []) } };
  }
  const error = typeof value.error === "string" ? value.error : "malformed response";
  return { id: value.id, response: { ok: false, error } };
}

function exchange(queries: ReadonlyArray<string>, limit: number): Promise<Response[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(FSEARCH_SOCKET);
    const responses = new Map<number, Response>();
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(queries.map((q, id) => `${JSON.stringify({ id, q, limit })}\n`).join(""));
    });
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseResponseLine(line);
        if (parsed) responses.set(parsed.id, parsed.response);
      }
      const ordered = queries.flatMap((_, id) => responses.get(id) ?? []);
      if (ordered.length === queries.length) {
        socket.end();
        resolve(ordered);
      }
    });
    socket.on("close", () => reject(new Error("fsearch closed the connection before answering")));
  });
}

/** Merges the hits of several queries: one hit per path (the highest score), best score first, at most `limit` kept. */
export function mergeFsearchHits(results: ReadonlyArray<ReadonlyArray<FsearchHit>>, limit: number): FsearchHit[] {
  const byPath = new Map<string, FsearchHit>();
  for (const hit of results.flat()) {
    const known = byPath.get(hit.path);
    if (!known || hit.score > known.score) byPath.set(hit.path, hit);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(FSEARCH_BINARY, args, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const isConnectFailure = (error: unknown) =>
  isRecord(error) && (error.code === "ENOENT" || error.code === "ECONNREFUSED");

/** Runs every query on one connection to the fsearch daemon, starting the daemon once if it is down. */
export async function searchFsearch(queries: ReadonlyArray<string>, limit: number): Promise<FsearchOutcome> {
  if (queries.length === 0) return { kind: "hits", hits: [] };
  try {
    let responses: Response[];
    try {
      responses = await exchange(queries, limit);
    } catch (error) {
      if (!isConnectFailure(error)) throw error;
      if (!fs.existsSync(FSEARCH_BINARY)) return { kind: "binary-missing" };
      await run(["status"]);
      responses = await exchange(queries, limit);
    }
    const results: FsearchHit[][] = [];
    for (const response of responses) {
      if (!response.ok) {
        return INDEXING_ERROR.test(response.error) ? { kind: "indexing" } : { kind: "error", message: response.error };
      }
      results.push(response.hits);
    }
    return { kind: "hits", hits: mergeFsearchHits(results, limit) };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether the daemon can read protected folders; undefined when the binary or its status is unavailable. */
export async function hasFullDiskAccess(): Promise<boolean | undefined> {
  if (!fs.existsSync(FSEARCH_BINARY)) return undefined;
  try {
    const status: unknown = JSON.parse(await run(["status"]));
    return isRecord(status) && typeof status.full_disk_access === "boolean" ? status.full_disk_access : undefined;
  } catch {
    return undefined;
  }
}
