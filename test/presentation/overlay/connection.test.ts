import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectOverlay } from "../../../src/presentation/overlay/connection";

class FakeSocket {
  static peers: FakeSocket[] = [];
  static failConstruction = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  close = vi.fn(() => this.onclose?.());

  constructor(readonly url: string) {
    if (FakeSocket.failConstruction) throw new Error("Socket unavailable");
    FakeSocket.peers.push(this);
  }
}

function peer(index: number): FakeSocket {
  const value = FakeSocket.peers[index];
  if (!value) throw new Error(`Missing fake peer ${index}`);
  return value;
}

describe("reconnecting overlay subscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.peers = [];
    FakeSocket.failConstruction = false;
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to the root loopback socket and ignores malformed messages", () => {
    const receive = vi.fn();
    const stop = connectOverlay(8123, receive, vi.fn());
    expect(peer(0).url).toBe("ws://127.0.0.1:8123/");
    peer(0).onmessage?.({ data: "{" });
    peer(0).onmessage?.({ data: '{"mode":"unknown"}' });
    expect(receive).not.toHaveBeenCalled();
    peer(0).onmessage?.({ data: '{"mode":"off","replay":false}' });
    peer(0).onmessage?.({ data: '{"mode":"off","replay":true}' });
    expect(receive.mock.calls).toEqual([
      [{ mode: "off", replay: false }, true],
      [{ mode: "off", replay: true }, false],
    ]);
    stop();
  });

  it("deduplicates error/close retries, backs off, and resets on a successful open", () => {
    const receive = vi.fn();
    const offline = vi.fn();
    const stop = connectOverlay(7777, receive, offline);
    peer(0).onerror?.();
    peer(0).onclose?.();
    expect(offline).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(FakeSocket.peers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.peers).toHaveLength(2);
    peer(1).onclose?.();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.peers).toHaveLength(2);
    vi.advanceTimersByTime(1);
    peer(2).onopen?.();
    peer(2).onmessage?.({
      data: '{"mode":"vibe","replay":true,"status":"live","intensity":"calm","beatWave":[],"breathWave":[]}',
    });
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "vibe" }),
      true,
    );
    // Events from obsolete sockets cannot overwrite the new snapshot.
    peer(0).onmessage?.({ data: '{"mode":"off","replay":false}' });
    expect(receive).toHaveBeenCalledTimes(1);
    peer(2).onclose?.();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.peers).toHaveLength(4);
    stop();
  });

  it("retries construction failures and cancels scheduled work when stopped", () => {
    FakeSocket.failConstruction = true;
    const offline = vi.fn();
    const stop = connectOverlay(7777, vi.fn(), offline);
    expect(offline).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(500);
    expect(offline).toHaveBeenCalledTimes(2);
    FakeSocket.failConstruction = false;
    stop();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.peers).toHaveLength(0);
  });

  it("stops an active subscription without triggering another reconnect", () => {
    const offline = vi.fn();
    const stop = connectOverlay(7777, vi.fn(), offline);
    stop();
    stop();
    vi.advanceTimersByTime(10_000);
    expect(peer(0).close).toHaveBeenCalledOnce();
    expect(offline).not.toHaveBeenCalled();
    expect(FakeSocket.peers).toHaveLength(1);
  });
});
