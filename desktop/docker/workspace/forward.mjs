// Keeps the workspace container alive and forwards 0.0.0.0:15173 to the Vite dev server on
// localhost:5173. Vite listens on localhost only (::1 or 127.0.0.1, depending on how localhost
// resolves), so a port published by Docker could not reach it otherwise. SupportDesk itself
// stays unchanged.
import { connect, createServer } from 'node:net';

const LISTEN_PORT = 15173;
const TARGET_PORT = Number(process.env.BUGDETECTIVE_CLIENT_PORT ?? 5173);
const TARGET_HOSTS = ['::1', '127.0.0.1'];

/** Connects to the first loopback address that accepts the connection. */
function connectUpstream(hosts, done) {
  const [host, ...rest] = hosts;
  const socket = connect({ host, port: TARGET_PORT });
  socket.once('connect', () => done(socket));
  socket.once('error', () => {
    socket.destroy();
    if (rest.length > 0) {
      connectUpstream(rest, done);
    } else {
      done(null);
    }
  });
}

const server = createServer((client) => {
  client.pause();
  client.on('error', () => client.destroy());
  connectUpstream(TARGET_HOSTS, (upstream) => {
    if (!upstream || client.destroyed) {
      upstream?.destroy();
      client.destroy();
      return;
    }
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    client.on('close', close);
    upstream.on('close', close);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`Forwarding 0.0.0.0:${LISTEN_PORT} to localhost:${TARGET_PORT}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
