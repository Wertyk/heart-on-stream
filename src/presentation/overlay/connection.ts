import type { OverlayState } from "../../domain/privacy/index";
import { parseOverlayMessage } from "./message";
import { reconnectDelay } from "./options";

/** Receive-only connection; firstSnapshot lets playback reset after an app restart. */
export function connectOverlay(
  port: number,
  onSnapshot: (state: OverlayState, firstSnapshot: boolean) => void,
  onDisconnect: () => void,
): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  function retry(): void {
    if (stopped || timer !== undefined) return;
    onDisconnect();
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, reconnectDelay(attempt++));
  }

  function connect(): void {
    if (stopped) return;
    let peer: WebSocket;
    try {
      peer = new WebSocket(`ws://127.0.0.1:${port}/`);
    } catch {
      retry();
      return;
    }
    socket = peer;
    let firstSnapshot = true;
    const failed = (): void => {
      if (socket !== peer) return;
      socket = null;
      peer.close();
      retry();
    };
    peer.onopen = () => {
      if (socket === peer) attempt = 0;
    };
    peer.onmessage = (event: MessageEvent<unknown>) => {
      if (socket !== peer) return;
      const state = parseOverlayMessage(event.data);
      if (!state) return;
      onSnapshot(state, firstSnapshot);
      firstSnapshot = false;
    };
    peer.onclose = failed;
    peer.onerror = failed;
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    const peer = socket;
    socket = null;
    peer?.close();
  };
}
