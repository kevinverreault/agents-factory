// The egress proxy of an L2 task's container (ADR 0007). It runs in a
// container of its own, the only one on the task container's internal
// network that also has a route out, so it is the task container's only way
// out. It forwards a request (an HTTPS `CONNECT`, or a plain HTTP one) only
// to a host on its allowlist, and refuses any other with a 403, appending
// the host to its denial log. Both files are read and written afresh for
// every request, so the Docker adapter changes the allowlist, and starts a
// new log, at each prepare, without restarting it.
//
// Node runs this file as it is, in the sandbox image: it imports nothing
// but Node's own modules, and its types are erasable.
//
//   node egress-proxy.ts <allowlist file> <denial log> <port>
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';

const [allowlist, denials, port] = process.argv.slice(2) as [string, string, string];

// The host a URL names, as the allowlist names hosts: lower case, an IPv6
// address without its brackets, and no trailing dot.
function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

// Whether the host may be reached: only as the allowlist names it, one per
// line. A missing allowlist allows nothing.
function allowed(host: string): boolean {
  try {
    return readFileSync(allowlist, 'utf8').split('\n').map((line) => line.trim().toLowerCase()).includes(host);
  } catch {
    return false;
  }
}

// Logs the denied host, and says why, for the client that asked.
function deny(host: string): string {
  appendFileSync(denials, `${host}\n`);
  return `The factory’s egress proxy denies ${host}: it isn’t allowed for this task.\n`;
}

const server = createServer((incoming, outgoing) => {
  // A plain HTTP request names its whole URL.
  let url: URL;
  try {
    url = new URL(incoming.url ?? '');
  } catch {
    outgoing.writeHead(400).end('The factory’s egress proxy forwards only requests that name their whole URL.\n');
    return;
  }
  if (url.protocol !== 'http:') {
    outgoing.writeHead(400).end('The factory’s egress proxy forwards only plain HTTP requests, and HTTPS through CONNECT.\n');
    return;
  }
  const host = hostOf(url);
  if (!allowed(host)) {
    outgoing.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(deny(host));
    return;
  }
  const headers: IncomingHttpHeaders = { ...incoming.headers };
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  const upstream = request({ host, port: url.port || 80, method: incoming.method, path: `${url.pathname}${url.search}`, headers }, (answer) => {
    outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(outgoing);
  });
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
});

server.on('connect', (incoming, socket, head) => {
  // `host:port`, an IPv6 host in brackets.
  let authority: URL;
  try {
    authority = new URL(`http://${incoming.url ?? ''}`);
  } catch {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const host = hostOf(authority);
  socket.on('error', () => socket.destroy());
  if (!allowed(host)) {
    socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n${deny(host)}`);
    return;
  }
  let tunnelled = false;
  const upstream = connect(Number(authority.port) || 443, host, () => {
    tunnelled = true;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  // Once tunnelled, the socket carries the client's own bytes: it is only dropped.
  upstream.on('error', () => (tunnelled ? socket.destroy() : socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')));
  socket.on('close', () => upstream.destroy());
});

server.listen(Number(port));
