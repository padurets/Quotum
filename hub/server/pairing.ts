import {config} from './config.js';
import {newSecret, newUserCode, normalizeUserCode} from './domain/auth.js';
import {Invalid, parseAgent, parseMachine} from './domain/ingest.js';
import type {Device, DeviceCode, Directory, Machine} from './store/directory.js';

export type CodeRequest = {deviceCode: string; userCode: string; expiresIn: number; interval: number};

/** Answers while an agent waits, as in OAuth 2.0 device authorization (RFC 8628). */
export type Waiting = 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token';

export type Connected = {token: string; device: Device; board: {id: string; name: string}};

/**
 * Connecting a machine with a one-time code: the agent asks for a code, a signed-in
 * person enters it and picks a board, the agent receives its own device token.
 */
export class Pairing {
  constructor(private readonly directory: Directory) {}

  /** Starts a request for an agent; null if the machine description is unusable. */
  start(body: unknown, now = Date.now()): CodeRequest | null {
    const input = (body ?? {}) as {machine?: unknown; agent?: unknown};
    let machine: Machine & {agent: string};
    try {
      machine = {...parseMachine(input.machine), agent: parseAgent(input.agent)};
    } catch (error) {
      if (error instanceof Invalid) return null;
      throw error;
    }
    const deviceCode = newSecret('qt_c');
    for (let attempt = 0; ; attempt++) {
      const userCode = newUserCode();
      try {
        this.directory.createCode(deviceCode, userCode, machine, now, config.auth.codeTtlMs);
        return {deviceCode, userCode, expiresIn: config.auth.codeTtlMs / 1000, interval: config.auth.codeIntervalS};
      } catch (error) {
        if (attempt >= 4) throw error; // a user code collision is astronomically rare; retry a few times
      }
    }
  }

  /** The agent asks whether its code was approved. */
  poll(deviceCode: unknown, now = Date.now()): Connected | Waiting {
    const request = typeof deviceCode === 'string' ? this.directory.codeBySecret(deviceCode) : null;
    if (!request || request.status === 'used' || (request.status === 'pending' && request.expiresAt <= now)) return 'expired_token';
    if (request.status === 'denied') return 'access_denied';
    const tooSoon = request.polledAt !== null && now - request.polledAt < (config.auth.codeIntervalS - 1) * 1000;
    this.directory.polled(request.id, now);
    if (request.status === 'pending') return tooSoon ? 'slow_down' : 'authorization_pending';

    if (!this.directory.useCode(request.id)) return 'expired_token';
    const user = this.directory.user(request.userId!)!;
    const board = this.directory.board(request.boardId!)!;
    const token = newSecret('qt_d');
    const {agent, ...machine} = request.machine;
    const device = this.directory.saveDevice(
      {boardId: board.id, machine, agent, owner: user.name, ownerUserId: user.id, tokenId: null, secret: token},
      now,
    );
    return {token, device, board: {id: board.id, name: board.name}};
  }

  /** A pending request as the approving person sees it. */
  pending(userCode: unknown, now = Date.now()): DeviceCode | null {
    const normalized = typeof userCode === 'string' ? normalizeUserCode(userCode) : null;
    const request = normalized ? this.directory.codeByUserCode(normalized) : null;
    return request && request.status === 'pending' && request.expiresAt > now ? request : null;
  }

  /** Approves (to a board the person is a member of) or denies a pending request. */
  decide(userCode: unknown, approve: boolean, userId: string, boardId: string | null, now = Date.now()): boolean {
    const request = this.pending(userCode, now);
    if (!request) return false;
    if (approve && (!boardId || !this.directory.membership(boardId, userId))) return false;
    return this.directory.decide(request.userCode, approve, userId, approve ? boardId : null, now);
  }
}
