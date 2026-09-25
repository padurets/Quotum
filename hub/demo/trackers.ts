import {createServer, type Server} from 'node:http';
import type {AddressInfo, Socket} from 'node:net';
import type {Answer, Scene} from './model.js';

/**
 * Stands in for the two community reset trackers, so the demo reaches nothing outside:
 * every scene answers at `/<scene>/codex` and `/<scene>/claude` as Codex Resets and Claude
 * Resets do, or fails the way they can. The hub is pointed at one scene with
 * QUOTUM_RESETS_CODEX_URL and QUOTUM_RESETS_CLAUDE_URL.
 */
export class Trackers {
  /** How many times the hub asked. */
  asked = 0;
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly base: string,
  ) {
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(scenes: Scene[], start: number): Promise<Trackers> {
    const at = (t: number) => new Date(start + t).toISOString();
    let trackers: Trackers | undefined;
    const server = createServer((request, response) => {
      const [, scene, tracker] = request.url?.split('?')[0].split('/') ?? [];
      const found = scenes.find(s => s.id === scene);
      if (!found || (tracker !== 'codex' && tracker !== 'claude')) return void response.writeHead(404).end();
      trackers!.asked++;
      answer(found[tracker](at), request.socket, response);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    trackers = new Trackers(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return trackers;
  }

  /** Where the hub reads the trackers for a scene. */
  urls(scene: string) {
    return {codex: `${this.base}/${scene}/codex`, claude: `${this.base}/${scene}/claude`};
  }

  /** Closes the server and whatever is still waiting on it (a tracker that never answers). */
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

function answer(how: Answer, socket: Socket, response: import('node:http').ServerResponse) {
  switch (how) {
    case 'timeout':
      // Never answers: the hub gives up after its timeout.
      return;
    case 'network':
      return void socket.destroy();
    case 'challenge':
      // Cloudflare's bot check, as it stops a server.
      return void response.writeHead(403, {'content-type': 'text/html', 'cf-mitigated': 'challenge'}).end('<html>Just a moment…</html>');
    case 'format':
      return void response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({unexpected: true}));
  }
  if ('status' in how) return void response.writeHead(how.status, {'content-type': 'text/plain'}).end('unavailable');
  response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(how.json));
}
