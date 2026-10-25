import { connect } from "cloudflare:sockets";

const uuidString = (bytes) => {
  const h = [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
  return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
};

const concat = (a,b) => {
  const out = new Uint8Array(a.length+b.length);
  out.set(a,0); out.set(b,a.length); return out;
};

const allowedSet = (env) => new Set(
  String(env.VLESS_UUIDS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean)
);

function blockedLiteral(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
}

function looksLikeIpLiteral(host) {
  return /^[0-9.]+$/.test(host) || host.includes(":");
}

function parseVless(buf) {
  if (buf.length < 19) return null;
  const version = buf[0];
  const uuid = uuidString(buf.slice(1,17)).toLowerCase();
  const addonLen = buf[17];
  let i = 18 + addonLen;
  if (buf.length < i + 4) return null;
  const cmd = buf[i++];
  const port = (buf[i++] << 8) | buf[i++];
  const atyp = buf[i++];
  let host = "";

  if (atyp === 1) {
    if (buf.length < i + 4) return null;
    host = Array.from(buf.slice(i,i+4)).join(".");
    i += 4;
  } else if (atyp === 2) {
    if (buf.length < i + 1) return null;
    const n = buf[i++];
    if (buf.length < i + n) return null;
    host = new TextDecoder().decode(buf.slice(i,i+n));
    i += n;
  } else if (atyp === 3) {
    if (buf.length < i + 16) return null;
    const parts = [];
    for (let p=0;p<16;p+=2) parts.push(((buf[i+p]<<8)|buf[i+p+1]).toString(16));
    host = parts.join(":");
    i += 16;
  } else {
    throw new Error("unsupported address type");
  }
  return {version,uuid,cmd,port,host,offset:i};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const publicPath = String(env.PUBLIC_PATH || "");

    if (url.pathname === "/health") return new Response("ok", {status:200});
    if (!publicPath || url.pathname !== publicPath) return new Response("not found",{status:404});
    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("upgrade required",{status:426});
    }

    const allowed = allowedSet(env);
    if (!allowed.size) return new Response("unconfigured",{status:503});

    const pair = new WebSocketPair();
    const [client,server] = Object.values(pair);
    server.accept({allowHalfOpen:true});
    server.binaryType = "arraybuffer";

    let handshake = new Uint8Array(0);
    let socket = null;
    let writer = null;
    let fallbackWs = null;
    let mode = "handshake";
    let queuedFrames = [];
    let chain = Promise.resolve();
    let closed = false;

    const closeAll = () => {
      if (closed) return;
      closed = true;
      try { writer && writer.close(); } catch {}
      try { socket && socket.close(); } catch {}
      try { fallbackWs && fallbackWs.close(1000,""); } catch {}
      try { server.close(1000,""); } catch {}
    };

    const flushQueuedDirect = async () => {
      for (const frame of queuedFrames) await writer.write(frame);
      queuedFrames = [];
    };

    const flushQueuedFallback = () => {
      for (const frame of queuedFrames) fallbackWs.send(frame);
      queuedFrames = [];
    };

    const openFallback = async (fullHandshake) => {
      const host = String(env.FALLBACK_ORIGIN_HOST || "");
      const path = String(env.FALLBACK_ORIGIN_PATH || "");
      const auth = String(env.FALLBACK_ORIGIN_AUTH || "");

      if (!host || !path || !auth) throw new Error("fallback unconfigured");
      if (looksLikeIpLiteral(host)) throw new Error("fallback host must be a domain, not an IP");
      if (!path.startsWith("/")) throw new Error("bad fallback path");

      const headers = new Headers();
      headers.set("Upgrade", "websocket");
      headers.set("X-SlipNet-Origin-Auth", auth);

      const response = await fetch("https://" + host + path, {
        method: "GET",
        headers,
        redirect: "manual"
      });

      if (!response.webSocket) throw new Error("fallback websocket rejected");

      fallbackWs = response.webSocket;
      fallbackWs.binaryType = "arraybuffer";
      fallbackWs.accept({allowHalfOpen:true});

      fallbackWs.addEventListener("message", (event) => {
        if (typeof event.data === "string") return closeAll();
        if (server.readyState === WebSocket.OPEN) server.send(event.data);
      });
      fallbackWs.addEventListener("close", closeAll);
      fallbackWs.addEventListener("error", closeAll);

      mode = "fallback";
      fallbackWs.send(fullHandshake);
      flushQueuedFallback();
    };

    const openDirectOrFallback = async (parsed, initial, fullHandshake) => {
      if (!allowed.has(parsed.uuid)) throw new Error("unauthorized");
      if (parsed.cmd !== 1) throw new Error("tcp only");
      if (!parsed.host || parsed.port < 1 || parsed.port > 65535) throw new Error("bad target");
      if (blockedLiteral(parsed.host)) throw new Error("private target blocked");

      try {
        socket = connect(
          {hostname:parsed.host,port:parsed.port},
          {secureTransport:"off",allowHalfOpen:true}
        );
        await socket.opened;
        writer = socket.writable.getWriter();
        mode = "direct";

        server.send(Uint8Array.of(parsed.version,0));
        if (initial.length) await writer.write(initial);
        await flushQueuedDirect();

        const reader = socket.readable.getReader();
        (async () => {
          try {
            while (true) {
              const {value,done} = await reader.read();
              if (done) break;
              if (value && value.byteLength && server.readyState === WebSocket.OPEN) server.send(value);
            }
          } finally {
            closeAll();
          }
        })();
      } catch {
        try { socket && socket.close(); } catch {}
        socket = null;
        writer = null;
        await openFallback(fullHandshake);
      }
    };

    server.addEventListener("message", (event) => {
      if (typeof event.data === "string") return closeAll();
      const data = new Uint8Array(event.data);

      if (mode === "handshake") {
        handshake = concat(handshake,data);
        if (handshake.length > 8192) return closeAll();

        let parsed;
        try { parsed = parseVless(handshake); } catch { return closeAll(); }
        if (!parsed) return;

        const fullHandshake = handshake;
        const initial = handshake.slice(parsed.offset);
        handshake = new Uint8Array(0);
        mode = "opening";

        chain = chain
          .then(() => openDirectOrFallback(parsed,initial,fullHandshake))
          .catch(closeAll);
        return;
      }

      if (mode === "opening") {
        queuedFrames.push(data);
        return;
      }

      if (mode === "direct") {
        chain = chain.then(() => writer.write(data)).catch(closeAll);
        return;
      }

      if (mode === "fallback") {
        try { fallbackWs.send(data); } catch { closeAll(); }
      }
    });

    server.addEventListener("close",closeAll);
    server.addEventListener("error",closeAll);

    return new Response(null,{status:101,webSocket:client});
  }
};
