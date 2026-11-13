import { request } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * Resolves with a connection that sends no request, like a browser's speculative preconnect, once the
 * server has accepted it: a request answered on a later connection means the earlier one was accepted.
 */
export async function preconnect(base: string): Promise<Socket> {
  const { hostname, port } = new URL(base);
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = connect(Number(port), hostname, () => resolve(opened)).on("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    request(base, { path: "/", agent: false, headers: { Connection: "close" } }, (response) => {
      response.resume().on("end", resolve);
    }).on("error", reject).end();
  });
  return socket;
}

/** Rejects if `promise` is still pending after `ms`, so a hang fails fast rather than at the test timeout. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
