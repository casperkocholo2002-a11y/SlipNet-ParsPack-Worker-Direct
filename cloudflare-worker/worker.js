export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const publicPath = String(env.PUBLIC_PATH || "");
    const originHost = String(env.FIXED_ORIGIN_HOST || "");
    const originPath = String(env.FIXED_ORIGIN_PATH || "");
    const originAuth = String(env.ORIGIN_AUTH || "");

    if (url.pathname === "/health") {
      return new Response("ok", {
        status: 200,
        headers: {"cache-control":"no-store"}
      });
    }

    if (!publicPath || !originHost || !originPath || !originAuth) {
      return new Response("unconfigured", {status:503});
    }

    if (url.pathname !== publicPath) {
      return new Response("not found", {status:404});
    }

    if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("upgrade required", {status:426});
    }

    const upstream = new URL("https://" + originHost);
    upstream.port = "443";
    upstream.pathname = originPath;

    const headers = new Headers(request.headers);
    headers.delete("cf-connecting-ip");
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
    headers.delete("forwarded");
    headers.set("X-SlipNet-Origin-Auth", originAuth);

    return fetch(new Request(upstream.toString(), {
      method: "GET",
      headers,
      redirect: "manual"
    }));
  }
};
