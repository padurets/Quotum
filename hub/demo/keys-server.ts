import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AddressInfo} from 'node:net';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';

const app = Fastify({logger:false});
await app.register(staticFiles, {root:path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/demo')});
await app.listen({host:'127.0.0.1', port:Number(process.env.QUOTUM_PORT ?? 0)});
console.log(`Key storage demo: http://127.0.0.1:${(app.server.address() as AddressInfo).port}/`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void app.close());
