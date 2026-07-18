const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'clocks.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2'
};

// ---------- NTP (real UDP time-server queries, not an HTTP wrapper) ----------

// A spread of well-known, independently-operated NTP servers.
const NTP_SERVERS = [
  { name: 'Google', host: 'time.google.com' },
  { name: 'Cloudflare', host: 'time.cloudflare.com' },
  { name: 'Microsoft', host: 'time.windows.com' },
  { name: 'Apple', host: 'time.apple.com' },
  { name: 'NIST', host: 'time.nist.gov' },
  { name: 'NTP Pool', host: 'pool.ntp.org' }
];

const NTP_EPOCH_OFFSET = 2208988800000; // ms between 1900-01-01 and 1970-01-01
const NTP_TIMEOUT_MS = 3000;

function queryNtp(host) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch (e) { /* noop */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), NTP_TIMEOUT_MS);

    socket.once('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });

    socket.once('message', (msg) => {
      clearTimeout(timer);
      const t4 = Date.now(); // client receive time

      if (msg.length < 48) return finish({ ok: false, error: 'short packet' });

      const readTimestamp = (offset) => {
        const seconds = msg.readUInt32BE(offset);
        const fraction = msg.readUInt32BE(offset + 4);
        return seconds * 1000 + (fraction * 1000) / 4294967296 - NTP_EPOCH_OFFSET;
      };

      const t1 = readTimestamp(24); // originate (echoed client send time)
      const t2 = readTimestamp(32); // server receive time
      const t3 = readTimestamp(40); // server transmit time

      const roundTripMs = (t4 - t1) - (t3 - t2);
      const offsetMs = ((t2 - t1) + (t3 - t4)) / 2;

      finish({ ok: true, offsetMs: Math.round(offsetMs), rttMs: Math.max(0, Math.round(roundTripMs)) });
    });

    try {
      const packet = Buffer.alloc(48);
      packet[0] = 0x1B; // LI=0, VN=3, Mode=3 (client)
      const t1 = Date.now();
      // Stamp our own send time into the "transmit timestamp" field, servers
      // echo this back as the "originate timestamp" in their reply.
      const seconds = Math.floor(t1 / 1000) + NTP_EPOCH_OFFSET / 1000;
      const fraction = Math.round(((t1 % 1000) / 1000) * 4294967296);
      packet.writeUInt32BE(Math.floor(seconds), 40);
      packet.writeUInt32BE(fraction, 44);
      socket.send(packet, 0, packet.length, 123, host);
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    }
  });
}

let syncCache = null; // { syncedAt, offsetMs, sources }
const SYNC_CACHE_MS = 60 * 1000;

async function getSync(forceRefresh) {
  if (!forceRefresh && syncCache && (Date.now() - syncCache.syncedAt) < SYNC_CACHE_MS) {
    return syncCache;
  }

  const results = await Promise.all(
    NTP_SERVERS.map(async (s) => {
      const r = await queryNtp(s.host);
      return { name: s.name, host: s.host, ...r };
    })
  );

  const good = results.filter(r => r.ok);
  let offsetMs = 0;
  let consensus = false;

  if (good.length > 0) {
    const offsets = good.map(r => r.offsetMs).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    offsetMs = offsets.length % 2 ? offsets[mid] : Math.round((offsets[mid - 1] + offsets[mid]) / 2);
    consensus = true;
  }

  syncCache = {
    syncedAt: Date.now(),
    ok: consensus,
    offsetMs,
    respondedCount: good.length,
    totalCount: NTP_SERVERS.length,
    sources: results
  };
  return syncCache;
}

// ---------- Storage helpers ----------

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const defaults = {
      clocks: [
        { id: crypto.randomUUID(), timeZone: 'America/New_York', label: 'New York', order: 0 },
        { id: crypto.randomUUID(), timeZone: 'Europe/London', label: 'London', order: 1 },
        { id: crypto.randomUUID(), timeZone: 'Asia/Dhaka', label: 'Dhaka', order: 2 },
        { id: crypto.randomUUID(), timeZone: 'Asia/Tokyo', label: 'Tokyo', order: 3 }
      ]
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaults, null, 2));
  }
}

function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.clocks)) parsed.clocks = [];
    return parsed;
  } catch (e) {
    fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak-' + Date.now());
    return { clocks: [] };
  }
}

function writeData(data) {
  ensureDataFile();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Small helpers ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

let cachedZones = null;
function getTimeZones() {
  if (cachedZones) return cachedZones;
  let zones;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch (e) {
    zones = ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
  }
  cachedZones = zones.map((tz) => {
    let offsetLabel = '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
      const off = parts.find(p => p.type === 'timeZoneName');
      offsetLabel = off ? off.value : '';
    } catch (e) { /* noop */ }
    return { timeZone: tz, offset: offsetLabel };
  });
  return cachedZones;
}

// ---------- Request handler ----------

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }

    const parts = pathname.split('/').filter(Boolean);

    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/time' && req.method === 'GET') {
      const force = parsed.searchParams.get('refresh') === '1';
      const sync = await getSync(force);
      return sendJson(res, 200, {
        ok: sync.ok,
        now: new Date(Date.now() + sync.offsetMs).toISOString(),
        offsetMs: sync.offsetMs,
        syncedAt: sync.syncedAt,
        respondedCount: sync.respondedCount,
        totalCount: sync.totalCount,
        sources: sync.sources
      });
    }

    if (pathname === '/api/timezones' && req.method === 'GET') {
      return sendJson(res, 200, getTimeZones());
    }

    if (pathname === '/api/export' && req.method === 'GET') {
      const data = readData();
      const body = JSON.stringify(data, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="world-clock-backup.json"',
        'Content-Length': Buffer.byteLength(body)
      });
      return res.end(body);
    }

    if (pathname === '/api/import' && req.method === 'POST') {
      const incoming = await readBody(req);
      if (!incoming || !Array.isArray(incoming.clocks)) {
        return sendJson(res, 400, { error: 'Invalid backup file' });
      }
      const data = readData();
      const existingIds = new Set(data.clocks.map(c => c.id));
      let added = 0;
      for (const c of incoming.clocks) {
        if (!c.id || !existingIds.has(c.id)) {
          data.clocks.push({ ...c, id: c.id || crypto.randomUUID() });
          added++;
        }
      }
      writeData(data);
      return sendJson(res, 200, { added, total: data.clocks.length });
    }

    if (pathname === '/api/clocks' && req.method === 'GET') {
      const data = readData();
      const sorted = [...data.clocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return sendJson(res, 200, sorted);
    }

    if (pathname === '/api/clocks' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.timeZone) return sendJson(res, 400, { error: 'timeZone is required' });
      const data = readData();
      const clock = {
        id: crypto.randomUUID(),
        timeZone: body.timeZone,
        label: body.label || body.timeZone.split('/').pop().replace(/_/g, ' '),
        order: data.clocks.length
      };
      data.clocks.push(clock);
      writeData(data);
      return sendJson(res, 201, clock);
    }

    if (pathname === '/api/clocks/bulk' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.timeZones)) return sendJson(res, 400, { error: 'timeZones array required' });
      const data = readData();
      const existing = new Set(data.clocks.map(c => c.timeZone));
      const added = [];
      for (const timeZone of body.timeZones) {
        if (!timeZone || existing.has(timeZone)) continue;
        const clock = {
          id: crypto.randomUUID(),
          timeZone,
          label: timeZone.split('/').pop().replace(/_/g, ' '),
          order: data.clocks.length
        };
        data.clocks.push(clock);
        existing.add(timeZone);
        added.push(clock);
      }
      writeData(data);
      return sendJson(res, 200, { added, total: data.clocks.length });
    }

    if (pathname === '/api/clocks/all' && req.method === 'DELETE') {
      const data = readData();
      const removed = data.clocks;
      data.clocks = [];
      writeData(data);
      return sendJson(res, 200, { removed: removed.length });
    }

    if (pathname === '/api/clocks/reorder' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.order)) return sendJson(res, 400, { error: 'order array required' });
      const data = readData();
      const byId = new Map(data.clocks.map(c => [c.id, c]));
      body.order.forEach((id, idx) => {
        const c = byId.get(id);
        if (c) c.order = idx;
      });
      writeData(data);
      return sendJson(res, 200, { ok: true });
    }

    if (parts[0] === 'api' && parts[1] === 'clocks' && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      const data = readData();
      const idx = data.clocks.findIndex(c => c.id === id);

      if (req.method === 'PUT') {
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        const body = await readBody(req);
        data.clocks[idx] = {
          ...data.clocks[idx],
          label: body.label ?? data.clocks[idx].label,
          timeZone: body.timeZone ?? data.clocks[idx].timeZone
        };
        writeData(data);
        return sendJson(res, 200, data.clocks[idx]);
      }

      if (req.method === 'DELETE') {
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        const [removed] = data.clocks.splice(idx, 1);
        writeData(data);
        return sendJson(res, 200, removed);
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 400, { error: err.message || 'Bad request' });
  }
});

server.listen(PORT, () => {
  console.log(`World Clock running at http://localhost:${PORT}`);
  console.log(`Data stored at ${DATA_FILE}`);
});
