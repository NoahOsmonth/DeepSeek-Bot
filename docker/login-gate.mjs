// Sits in front of dsh web and keeps the plain root URL usable. dsh's browser
// gate hands out its signed cookie only in exchange for the launch token in
// `?token=`, and that cookie is bound to one authority, so a fresh browser at
// http://host:port/ gets "dsh web authentication required" until someone opens
// the URL from the log. Here a root request the gate refuses is exchanged
// upstream and answered with the page plus the cookie, so the first visit to
// the plain URL signs the browser in without a redirect.
import http from 'node:http'
import net from 'node:net'
import { readFileSync, statSync } from 'node:fs'

const UPSTREAM = {
  host: '127.0.0.1',
  port: Number(process.env.DSH_GATE_UPSTREAM_PORT ?? 3081),
}
const LISTEN = {
  host: process.env.DSH_GATE_HOST ?? '0.0.0.0',
  port: Number(process.env.DSH_GATE_PORT ?? 3080),
}
const URL_FILE = process.env.DSH_GATE_URL_FILE ?? '/run/dsh-login-url'
const TOKEN_PATTERN = /[?&]token=([A-Za-z0-9_-]+)/u

const agent = new http.Agent({ keepAlive: true })

let token
let tokenMtime = -1

// The entrypoint writes dsh's startup line, token included, once dsh is up.
// Reading it per request keeps this process independent of startup order.
function launchToken() {
  let mtimeMs
  try {
    mtimeMs = statSync(URL_FILE).mtimeMs
  } catch {
    return undefined
  }
  if (mtimeMs !== tokenMtime) {
    tokenMtime = mtimeMs
    try {
      token = TOKEN_PATTERN.exec(readFileSync(URL_FILE, 'utf8'))?.[1]
    } catch {
      token = undefined
    }
  }
  return token
}

function forwardedHeaders(headers) {
  const forwarded = { ...headers }
  // The browser's authority is what dsh's trust fence checks, so Host stays.
  delete forwarded.connection
  delete forwarded['proxy-connection']
  return forwarded
}

function request({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const upstream = http.request(
      { host: UPSTREAM.host, port: UPSTREAM.port, method, path, headers: forwardedHeaders(headers), agent },
      resolve,
    )
    upstream.on('error', reject)
    if (body === undefined) upstream.end()
    else body.pipe(upstream)
  })
}

function relay(upstreamResponse, res) {
  res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
  upstreamResponse.pipe(res)
}

async function signIn(req, res) {
  const refused = await request({ method: 'GET', path: req.url, headers: req.headers })
  if (refused.statusCode !== 401) {
    relay(refused, res)
    return
  }
  const current = launchToken()
  if (current === undefined) {
    relay(refused, res)
    return
  }
  refused.resume()
  const signed = new URL(req.url ?? '/', 'http://gate.invalid')
  signed.searchParams.set('token', current)
  const exchange = await request({ method: 'GET', path: signed.pathname + signed.search, headers: req.headers })
  const minted = exchange.headers['set-cookie']
  if (minted === undefined) {
    // dsh changed the exchange; show its answer rather than guessing.
    relay(exchange, res)
    return
  }
  exchange.resume()
  const cookie = minted.map((entry) => entry.split(';')[0]).join('; ')
  const page = await request({
    method: 'GET',
    path: '/',
    headers: { ...req.headers, cookie: req.headers.cookie ? `${req.headers.cookie}; ${cookie}` : cookie },
  })
  res.writeHead(page.statusCode ?? 502, { ...page.headers, 'set-cookie': minted, 'cache-control': 'no-store' })
  page.pipe(res)
}

function handle(req, res) {
  const failed = (error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`login gate: dsh web is not reachable (${error.message})\n`)
  }
  const url = new URL(req.url ?? '/', 'http://gate.invalid')
  const root = req.method === 'GET' && url.pathname === '/' && !url.searchParams.has('token')
  if (!root) {
    request({ method: req.method, path: req.url, headers: req.headers, body: req }).then(
      (upstreamResponse) => relay(upstreamResponse, res),
      failed,
    )
    return
  }
  signIn(req, res).catch(failed)
}

const server = http.createServer(handle)

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(UPSTREAM.port, UPSTREAM.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(LISTEN.port, LISTEN.host, () => {
  console.log(`login gate: ${LISTEN.host}:${LISTEN.port} -> ${UPSTREAM.host}:${UPSTREAM.port}`)
})
