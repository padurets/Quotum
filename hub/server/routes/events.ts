import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {Guards} from '../api.js';
import {polled, sse, type ByeReason, type Events, type Frame} from '../events.js';
import type {Directory} from '../store/directory.js';
import {CSP, sameSite, sessionSecret} from '../session.js';

/**
 * `GET /api/events` (spec/dashboard-v1.md): a board's events for its reader, as a
 * text/event-stream, or with `mode=poll` as long polls for proxies that hold streams back.
 * A stream or a poll is refused before anything starts: without a session, from a page
 * that is not the hub's, for a board that is not the reader's, or with no room left.
 */
export function eventRoutes(app: FastifyInstance, directory: Directory, events: Events, guards: Guards, local = false) {
  /** Only the hub's own page asks for events: it sets `Quotum-Stream`, which no frame, link or no-cors request can. */
  const ownPage = (request: FastifyRequest) => {
    const {origin, 'sec-fetch-site': site, 'quotum-stream': stream} = request.headers;
    return stream === '1' && (!origin || sameSite(origin, request)) && (!site || site === 'same-origin');
  };

  app.get<{Querystring: {board?: string; mode?: string; lease?: string; desktop?: string}}>('/api/events', {exposeHeadRoute: false}, async (request, reply) => {
    const user = guards.user(request, reply);
    if (!user) return reply;
    if (!ownPage(request)) return reply.code(403).send({error: 'forbidden_origin'});
    const desktop = request.query.desktop;
    if (desktop !== undefined && (desktop !== '1' || !local || request.query.mode === 'poll')) return reply.code(400).send({error: 'invalid_request'});
    const boards = directory.boards(user.id);
    const board = request.query.board ? boards.find(b => b.id === request.query.board) : boards[0];
    if (!board) return reply.code(404).send({error: 'board_not_found'});
    const reader = {user: user.id, secret: sessionSecret(request)!, board: board.id, desktop: desktop === '1'};

    if (request.query.mode === 'poll') {
      const answer = await events.poll(reader, request.query.lease);
      if (answer === 'limit') return reply.code(429).send({error: 'too_many_streams'});
      if (answer === null) return reply.code(404).send({error: 'board_not_found'});
      if (answer.frames.some(f => f.type === 'bye' && f.data.includes('"restart"'))) reply.header('Connection', 'close');
      return reply.type('application/json').send(`{"lease":${JSON.stringify(answer.lease)},"now":${answer.now},"events":${polled(answer.frames)}}`);
    }
    return stream(reply, events, reader);
  });
}

/** Opens a stream: the reader and the snapshot come first, so a failure there is a plain error answer. */
function stream(reply: FastifyReply, events: Events, reader: {user: string; secret: string; board: string; desktop?: boolean}) {
  const {raw} = reply;
  const drop = () => raw.socket?.destroy();
  const opened = events.open({
    ...reader,
    kind: 'stream',
    send(frames: Frame[]) {
      if (!raw.destroyed && !raw.writableEnded) raw.write(sse(frames));
    },
    backlog: () => raw.writableLength,
    end(reason: ByeReason) {
      if (raw.destroyed || raw.writableEnded) return;
      raw.end(sse([{type: 'bye', data: JSON.stringify({reason})}]));
      // The stream is over: its connection goes with it, at once if the other side reads no more.
      const late = setTimeout(drop, 250);
      late.unref();
      raw.once('finish', () => {
        clearTimeout(late);
        drop();
      });
    },
  });
  if (opened === 'limit') return reply.code(429).send({error: 'too_many_streams'});
  if (opened === null) return reply.code(404).send({error: 'board_not_found'});

  reply.hijack();
  raw.on('close', opened.close);
  raw.on('error', () => {
    opened.close();
    drop();
  });
  try {
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
      Connection: 'close',
    });
    raw.write(sse(opened.frames));
  } catch (error) {
    console.error(JSON.stringify({event: 'error', url: '/api/events', message: String((error as Error).message)}));
    opened.close();
    drop();
  }
}
