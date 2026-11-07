import type { ChildProcess } from 'child_process';
import { BridgeClient, type BridgeEvent } from './bridge-client.js';
import { AlertCollector, parsePlayerChat } from './alerts.js';
import { launchClient, prepareLaunch, type LaunchOptions, type LaunchPlan } from './launcher.js';
import type { InstanceLock } from './instance-lock.js';

/**
 * The client backend's connection: launches the modded game client, connects to its bridge, and keeps both alive.
 * Implements what ToolFactory needs from a connection (checkConnectionAndReconnect).
 */

type State = 'disconnected' | 'launching' | 'connected';

export interface ClientConnectionCallbacks {
  onLog: (level: string, message: string) => void;
  onChatMessage: (username: string, message: string) => void;
  /** this copy has the lock (at once, or once another copy let it go): the brain may start */
  onLock?: () => void;
}

export interface ClientConnectionDeps {
  prepare: (opts: LaunchOptions) => LaunchPlan;
  launch: (plan: LaunchPlan) => ChildProcess;
  bridge: BridgeClient;
  /** how long to keep trying to reach the bridge after launching */
  connectTimeoutMs: number;
  retryDelayMs: number;
  /** one copy of the server at a time drives the bot (none: no check) */
  lock?: InstanceLock;
}

export class ClientConnection {
  readonly bridge: BridgeClient;
  readonly alerts = new AlertCollector();
  private state: State = 'disconnected';
  private process: ChildProcess | null = null;
  private plan: LaunchPlan | null = null;
  private stopping = false;
  /** another copy of the server holds the lock: its pid (NaN when unknown) */
  private blockedBy: number | null = null;
  private locked = false;
  private readonly deps: ClientConnectionDeps;

  constructor(
    private readonly options: LaunchOptions,
    private readonly callbacks: ClientConnectionCallbacks,
    deps: Partial<ClientConnectionDeps> = {}
  ) {
    this.deps = {
      prepare: prepareLaunch,
      launch: launchClient,
      bridge: new BridgeClient(),
      connectTimeoutMs: 180_000,
      retryDelayMs: 1000,
      ...deps
    };
    this.bridge = this.deps.bridge;
    this.bridge.on('event', (e: BridgeEvent) => this.onEvent(e));
    this.bridge.on('close', () => {
      if (this.state === 'connected') {
        this.state = 'disconnected';
        this.callbacks.onLog('warn', 'Bridge connection to the game client closed');
      }
    });
  }

  getState(): State {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  /** Take the one-copy lock if there is one; false (and blockedBy set) when another copy holds it. */
  private takeLock(): boolean {
    if (!this.deps.lock || this.locked) return true;
    const owner = this.deps.lock.acquire();
    if (owner !== null) {
      if (this.blockedBy === null) this.callbacks.onLog('warn', `Another copy of this server (pid ${Number.isNaN(owner) ? '?' : owner}) is already running the bot: not launching a second game client`);
      this.blockedBy = owner;
      return false;
    }
    this.locked = true;
    this.blockedBy = null;
    this.callbacks.onLock?.();
    return true;
  }

  /** Launch the client and connect in the background. */
  start(): void {
    if (this.state !== 'disconnected') return;
    if (!this.takeLock()) return;
    this.state = 'launching';
    void this.launchAndConnect().catch(err => {
      this.state = 'disconnected';
      this.callbacks.onLog('error', `Client backend failed to start: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async launchAndConnect(): Promise<void> {
    if (!this.process || this.process.exitCode !== null) {
      this.plan = this.deps.prepare(this.options);
      this.process = this.deps.launch(this.plan);
      this.callbacks.onLog('info', `Launched the game client (pid ${this.process.pid}) as ${this.options.username} -> ${this.options.server}`);
      const proc = this.process;
      proc.on('exit', code => {
        if (this.process !== proc) return;
        this.process = null;
        this.state = 'disconnected';
        this.bridge.close();
        if (!this.stopping) this.callbacks.onLog('warn', `Game client exited (code ${code})`);
      });
    }
    const deadline = Date.now() + this.deps.connectTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline && !this.stopping) {
      if (!this.process) throw new Error('game client exited while starting (see client-stdout.log in the client folder)');
      try {
        const hello = await this.bridge.connect(this.options.bridgePort, this.plan!.token);
        this.state = 'connected';
        this.callbacks.onLog('info', `Bridge connected (${hello.bridge} protocol ${hello.protocol}, player ${hello.username})`);
        return;
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, this.deps.retryDelayMs));
      }
    }
    throw new Error(`could not reach the bridge: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /** ToolFactory's check before each tool: connected, or starting (say so), or start again. */
  async checkConnectionAndReconnect(): Promise<{ connected: boolean; message?: string }> {
    if (this.state === 'connected' && this.bridge.connected) return { connected: true };
    if (this.state === 'disconnected') this.start();
    if (this.blockedBy !== null) {
      return {
        connected: false,
        message: `Another copy of this MCP server${Number.isNaN(this.blockedBy) ? '' : ` (pid ${this.blockedBy})`} is already running the bot, ` +
          'probably from another Claude session. Only one may: a second game client would log in as the same player and get one of them kicked. ' +
          'Use the session that has it, or close that one and try again here.'
      };
    }
    return {
      connected: false,
      message: 'The game client is starting or reconnecting (this takes about a minute the first time). Try again shortly.'
    };
  }

  private onEvent(e: BridgeEvent): void {
    this.alerts.handle(e);
    if (e.type === 'chat' && typeof e.text === 'string') {
      const chat = parsePlayerChat(e.text);
      if (chat && chat.username !== this.options.username) this.callbacks.onChatMessage(chat.username, chat.message);
    }
  }

  cleanup(): void {
    this.stopping = true;
    if (this.locked) { this.deps.lock?.release(); this.locked = false; }
    this.bridge.close();
    this.process?.kill();
    this.process = null;
    this.state = 'disconnected';
  }
}
