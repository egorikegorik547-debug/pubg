// Сигнальный сервер для игры «Королевская битва».
// Без зависимостей: только Node.js 16+.  Запуск:  node server.js
// Он лишь передаёт между игроками SDP-коды (офер/ответ). Сама игра идёт напрямую (WebRTC).
const http = require('http');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const MAX_GUESTS = 3, ROOM_TTL = 30 * 60 * 1000, HOLD = 20000;
const rooms = new Map();
const hits = new Map();

const rid = () => crypto.randomBytes(8).toString('hex');
const newId = () => { for (let i = 0; i < 200; i++) { const id = String(1000 + Math.floor(Math.random() * 9000)); if (!rooms.has(id)) return id } return null };
const q = () => ({ msgs: [], waiters: [] });
function push(queue, m) { queue.msgs.push(m); flush(queue) }
function flush(queue) {
  queue.waiters = queue.waiters.filter(w => {
    if (queue.msgs.length > w.since) { clearTimeout(w.timer); send(w.res, 200, { msgs: queue.msgs.slice(w.since), next: queue.msgs.length }); return false }
    return true;
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise(r => { let s = ''; req.on('data', d => { s += d; if (s.length > 65536) req.destroy() }); req.on('end', () => { try { r(JSON.parse(s || '{}')) } catch (e) { r({}) } }); req.on('error', () => r({})) });
}
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length > 20;
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const u = new URL(req.url, 'http://x'), p = u.pathname.split('/').filter(Boolean);
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  try {
    if (!p.length) return send(res, 200, { ok: true, rooms: rooms.size });
    if (p[0] === 'ice' && req.method === 'GET') {
      let ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }];
      try { if (process.env.ICE_SERVERS) ice = JSON.parse(process.env.ICE_SERVERS) } catch (e) {}
      return send(res, 200, { ice });
    }
    if (p[0] !== 'room') return send(res, 404, { error: 'not found' });
    if (p.length === 1 && req.method === 'POST') {
      if (limited(ip)) return send(res, 429, { error: 'Слишком много запросов, подожди минуту' });
      if (rooms.size >= 2000) return send(res, 503, { error: 'Сервер переполнен' });
      const id = newId(); if (!id) return send(res, 503, { error: 'Нет свободных ID' });
      rooms.set(id, { token: rid(), host: q(), guests: new Map(), last: Date.now() });
      return send(res, 200, { id, token: rooms.get(id).token });
    }
    const room = rooms.get(p[1]);
    if (!room) return send(res, 404, { error: 'Комната не найдена' });
    room.last = Date.now();
    const act = p[2];
    if (!act && req.method === 'DELETE') {
      if (u.searchParams.get('token') !== room.token) return send(res, 403, { error: 'forbidden' });
      room.host.waiters.forEach(w => { clearTimeout(w.timer); send(w.res, 410, { error: 'closed' }) });
      room.guests.forEach(g => g.waiters.forEach(w => { clearTimeout(w.timer); send(w.res, 410, { error: 'closed' }) }));
      rooms.delete(p[1]); return send(res, 200, { ok: true });
    }
    if (act === 'join' && req.method === 'POST') {
      const b = await body(req);
      if (room.closed || room.guests.size >= MAX_GUESTS) return send(res, 409, { error: 'Комната заполнена' });
      const pid = rid(); room.guests.set(pid, q());
      push(room.host, { t: 'join', pid, name: String(b.name || 'Игрок').slice(0, 12) });
      return send(res, 200, { pid });
    }
    if (act === 'offer' && req.method === 'POST') {
      const b = await body(req), g = room.guests.get(b.pid);
      if (b.token !== room.token) return send(res, 403, { error: 'forbidden' });
      if (!g || !b.sdp) return send(res, 400, { error: 'bad request' });
      push(g, { t: 'offer', sdp: b.sdp }); return send(res, 200, { ok: true });
    }
    if (act === 'answer' && req.method === 'POST') {
      const b = await body(req);
      if (!room.guests.has(b.pid) || !b.sdp) return send(res, 400, { error: 'bad request' });
      push(room.host, { t: 'answer', pid: b.pid, sdp: b.sdp }); return send(res, 200, { ok: true });
    }
    if (act === 'poll' && req.method === 'GET') {
      const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
      let queue;
      if (u.searchParams.get('role') === 'host') { if (u.searchParams.get('token') !== room.token) return send(res, 403, { error: 'forbidden' }); queue = room.host }
      else queue = room.guests.get(u.searchParams.get('pid'));
      if (!queue) return send(res, 404, { error: 'Игрок не найден' });
      if (queue.msgs.length > since) return send(res, 200, { msgs: queue.msgs.slice(since), next: queue.msgs.length });
      const w = { res, since, timer: setTimeout(() => { queue.waiters = queue.waiters.filter(x => x !== w); send(res, 200, { msgs: [], next: since }) }, HOLD) };
      queue.waiters.push(w); req.on('close', () => { clearTimeout(w.timer); queue.waiters = queue.waiters.filter(x => x !== w) });
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: 'server error' }) }
}).listen(PORT, () => console.log('Сигнальный сервер запущен на порту ' + PORT));

setInterval(() => { const now = Date.now(); for (const [id, r] of rooms) if (now - r.last > ROOM_TTL) rooms.delete(id); hits.clear() }, 60000);
