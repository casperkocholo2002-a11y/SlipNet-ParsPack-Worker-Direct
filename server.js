'use strict';

const http = require('http');
const { WebSocket, WebSocketServer, createWebSocketStream } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_RELAY_PATH = String(process.env.PUBLIC_RELAY_PATH || '/pd/62ad74fca82c63c4643acd61ce16d0348fc7c2e7c076b6e5').trim();
const WORKER_HOST = String(process.env.WORKER_HOST || 'ppw-3c19aa324d48.edgecache-628bbe41dc.workers.dev').trim();
const WORKER_PATH = String(process.env.WORKER_PATH || '/w/986b32e37335922c2faab7ce2153a8c9f9c6aff9de334f28').trim();
const MAX_WS = 1024 * 1024;

const ready = () => Boolean(
  PUBLIC_RELAY_PATH.startsWith('/') &&
  WORKER_HOST &&
  WORKER_PATH.startsWith('/')
);

const json = (res, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://slipnet.local');
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, ready() ? 200 : 503, {
      ok: ready(),
      service: 'slipnet-parspack-worker-direct',
      mode: 'parspack-worker-direct',
    });
  }
  return json(res, 404, { ok: false, error: 'not_found' });
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  clientTracking: false,
  maxPayload: MAX_WS,
});

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://slipnet.local'); }
  catch { return socket.destroy(); }

  if (!ready() || url.pathname !== PUBLIC_RELAY_PATH) return socket.destroy();

  const upstream = new WebSocket('wss://' + WORKER_HOST + WORKER_PATH, {
    perMessageDeflate: false,
    handshakeTimeout: 15000,
    maxPayload: MAX_WS,
  });

  let client, clientStream, upstreamStream;
  let closed = false;
  const closeAll = () => {
    if (closed) return;
    closed = true;
    try { clientStream && clientStream.destroy(); } catch {}
    try { upstreamStream && upstreamStream.destroy(); } catch {}
    try { client && client.terminate(); } catch {}
    try { upstream.terminate(); } catch {}
  };

  upstream.once('open', () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      client = ws;
      clientStream = createWebSocketStream(ws, { encoding: null, highWaterMark: 1024 * 1024 });
      upstreamStream = createWebSocketStream(upstream, { encoding: null, highWaterMark: 1024 * 1024 });
      clientStream.on('error', closeAll);
      upstreamStream.on('error', closeAll);
      clientStream.once('close', closeAll);
      upstreamStream.once('close', closeAll);
      clientStream.pipe(upstreamStream);
      upstreamStream.pipe(clientStream);
    });
  });

  upstream.once('error', () => {
    try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch {}
    closeAll();
  });
  socket.once('error', closeAll);
  socket.once('close', () => { if (!client) closeAll(); });
});

server.listen(PORT, '0.0.0.0', () => console.log('listening', PORT));
