import net from 'net';
import { EventEmitter } from 'events';

/**
 * JSON-RPC 2.0 over newline-delimited JSON on loopback TCP, talking to the bridge mod in the game client
 * (client-mod/src/claudebridge/BridgeServer.java). The first request must be `hello` with the launch token.
 * Emits 'event' (params of the bridge's "event" notifications) and 'close'.
 */

export interface BridgeEvent { type: string; [key: string]: unknown }

export class BridgeError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'BridgeError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HelloResult { bridge: string; protocol: number; username: string }

export class BridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** Connect and authenticate. Rejects if nothing listens or the token is refused. */
  async connect(port: number, token: string, host = '127.0.0.1'): Promise<HelloResult> {
    this.close();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(port, host);
      s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
      s.once('error', reject);
    });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', () => { /* 'close' follows */ });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.failAll(new BridgeError('bridge connection closed'));
      this.emit('close');
    });
    return this.request<HelloResult>('hello', { token }, { timeoutMs: 10_000 });
  }

  /** Call a bridge method. Long processes (goto, mine, build) need a timeout longer than their own. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}, { timeoutMs = 30_000 } = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new BridgeError('bridge not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`bridge call ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  close(): void {
    const s = this.socket;
    this.socket = null;
    s?.destroy();
    this.failAll(new BridgeError('bridge connection closed'));
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let msg: { id?: number | null; method?: string; params?: BridgeEvent; result?: unknown; error?: { code?: number; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === 'event' && msg.params) {
      this.emit('event', msg.params);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new BridgeError(msg.error.message ?? 'bridge error', msg.error.code));
    else p.resolve(msg.result);
  }
}
