/**
 * Thin WS client wrapper — typed send/receive using the voice protocol.
 */

import { WebSocket } from "ws";
import type { ClientFrame, ServerFrame } from "../types.js";

export type FrameRouter = {
  onFrame: (frame: ServerFrame) => void;
  /** Called when the next binary message arrives (expected after tts.chunk). */
  onBinary: (buf: Buffer) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
};

export function connect(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

export function sendFrame(ws: WebSocket, frame: ClientFrame): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

/**
 * Attach a typed message router to an open WebSocket.
 * Tracks binary expectation: a tts.chunk JSON frame means the next message is binary audio.
 */
export function attachRouter(ws: WebSocket, router: FrameRouter): void {
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      router.onBinary(data as Buffer);
      return;
    }
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data.toString()) as ServerFrame;
    } catch {
      return;
    }
    router.onFrame(frame);
  });

  ws.on("close", (code, reason) => router.onClose(code, reason.toString()));
  ws.on("error", router.onError);
}

/** Derive an http(s) base URL from a ws(s) gateway URL. */
export function wsToHttp(gatewayWsUrl: string): string {
  return gatewayWsUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
}
