const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PEER_TTL_MS = 12000;
const EVENT_TTL_MS = 15000;
const WORLD_TTL_MS = 5000;

const peers = new Map();
const worlds = new Map();
let events = [];

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function prune() {
  const now = Date.now();
  for (const [id, peer] of peers.entries()) {
    if (!peer || now - (peer.updatedAt || 0) > PEER_TTL_MS) peers.delete(id);
  }
  for (const [id, world] of worlds.entries()) {
    if (!world || now - (world.at || 0) > WORLD_TTL_MS) worlds.delete(id);
  }
  events = events.filter(event => event && now - (event.at || 0) <= EVENT_TTL_MS).slice(-120);
}

function sendJson(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type'
  });
  res.end(body);
}

function readBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (error) {
      callback(error);
    }
  });
}

function sanitizePeer(peer) {
  if (!peer || typeof peer !== 'object' || typeof peer.id !== 'string') return null;
  return {
    id: peer.id.slice(0, 80),
    nick: String(peer.nick || 'Player').slice(0, 20),
    active: !!peer.active,
    mode: peer.mode === 'SANDBOX' ? 'SANDBOX' : (peer.mode === 'OLD_WAVE_MAZE' ? 'OLD_WAVE_MAZE' : 'NORMAL'),
    hostId: String(peer.hostId || peer.id).slice(0, 80),
    squadId: String(peer.squadId || '').slice(0, 80),
    squadReady: !!peer.squadReady,
    squadStartAt: Number(peer.squadStartAt) || 0,
    joinedAt: Number(peer.joinedAt) || Date.now(),
    x: Number(peer.x) || 0,
    y: Number(peer.y) || 0,
    range: Number(peer.range) || 1,
    hp: Number(peer.hp) || 0,
    maxHp: Number(peer.maxHp) || 0,
    petals: Array.isArray(peer.petals)
      ? peer.petals.slice(0, 10).map(item => ({
          type: String(item.type || 'Basic').slice(0, 40),
          rarityIndex: Number(item.rarityIndex) || 0
        }))
      : [],
    updatedAt: Date.now()
  };
}

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.senderId !== 'string') return null;
  const type = ['tp', 'loot', 'squadStart'].includes(event.type) ? event.type : '';
  if (!type) return null;
  return {
    id: String(event.id || `${event.senderId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 140),
    senderId: event.senderId.slice(0, 80),
    hostId: String(event.hostId || event.senderId).slice(0, 80),
    type,
    payload: event.payload || {},
    at: Date.now()
  };
}

function sanitizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizePlainObject(value, maxKeys = 80) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  Object.keys(value).slice(0, maxKeys).forEach(key => {
    const item = value[key];
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) out[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) out[key] = sanitizePlainObject(item, 30);
    else if (Array.isArray(item)) out[key] = item.slice(0, 40).map(v => (
      v && typeof v === 'object' ? sanitizePlainObject(v, 30) : v
    ));
  });
  return out;
}

function sanitizeWorld(body) {
  if (!body || typeof body !== 'object') return null;
  const squadId = String(body.squadId || body.hostId || '').slice(0, 80);
  if (!squadId) return null;
  return {
    squadId,
    leaderId: String(body.leaderId || '').slice(0, 80),
    hostId: String(body.hostId || squadId).slice(0, 80),
    at: Date.now(),
    wave: sanitizeNumber(body.wave, 1),
    gameSpeed: Math.max(1, Math.min(5, sanitizeNumber(body.gameSpeed, 1))),
    currentActiveWaveNumber: sanitizeNumber(body.currentActiveWaveNumber, 0),
    currentActiveWaveType: String(body.currentActiveWaveType || '').slice(0, 60),
    isWaveSpawning: !!body.isWaveSpawning,
    waveTimer: sanitizeNumber(body.waveTimer, 0),
    mobsToSpawn: sanitizeNumber(body.mobsToSpawn, 0),
    mobsSpawned: sanitizeNumber(body.mobsSpawned, 0),
    currentWaveConfig: sanitizePlainObject(body.currentWaveConfig, 80),
    lastMainWaveType: body.lastMainWaveType ? String(body.lastMainWaveType).slice(0, 60) : null,
    sameMainWaveTypeStreak: sanitizeNumber(body.sameMainWaveTypeStreak, 0),
    currentLootMultiplier: sanitizeNumber(body.currentLootMultiplier, 1),
    isLootWave: !!body.isLootWave,
    enemies: Array.isArray(body.enemies) ? body.enemies.slice(0, 350).map(enemy => sanitizePlainObject(enemy, 60)).filter(Boolean) : [],
    projectiles: Array.isArray(body.projectiles) ? body.projectiles.slice(0, 250).map(projectile => sanitizePlainObject(projectile, 45)).filter(Boolean) : [],
    webZones: Array.isArray(body.webZones) ? body.webZones.slice(0, 80).map(zone => sanitizePlainObject(zone, 35)).filter(Boolean) : []
  };
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch (error) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const resolved = path.resolve(ROOT, `.${urlPath}`);
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      if (urlPath.startsWith('/img/')) {
        const fallback = path.resolve(ROOT, path.basename(urlPath));
        if (fallback.startsWith(ROOT)) {
          fs.readFile(fallback, (fallbackError, fallbackData) => {
            if (!fallbackError) {
              res.writeHead(200, { 'Content-Type': contentTypes[path.extname(fallback).toLowerCase()] || 'application/octet-stream' });
              res.end(fallbackData);
              return;
            }
            res.writeHead(404);
            res.end('Not found');
          });
          return;
        }
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(resolved).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  if (req.url.startsWith('/mp/state')) {
    prune();
    sendJson(res, { now: Date.now(), peers: Object.fromEntries(peers), events, worlds: Object.fromEntries(worlds) });
    return;
  }

  if (req.url.startsWith('/healthz')) {
    prune();
    sendJson(res, {
      ok: true,
      peers: peers.size,
      events: events.length,
      uptime: Math.round(process.uptime())
    });
    return;
  }

  if (req.url.startsWith('/mp/world') && req.method === 'POST') {
    readBody(req, (error, body) => {
      if (error) {
        res.writeHead(400);
        res.end('Bad JSON');
        return;
      }
      const world = sanitizeWorld(body);
      if (world) worlds.set(world.squadId, world);
      prune();
      sendJson(res, { ok: true });
    });
    return;
  }

  if (req.url.startsWith('/mp/presence') && req.method === 'POST') {
    readBody(req, (error, body) => {
      if (error) {
        res.writeHead(400);
        res.end('Bad JSON');
        return;
      }
      const peer = sanitizePeer(body);
      if (peer) peers.set(peer.id, peer);
      prune();
      sendJson(res, { ok: true });
    });
    return;
  }

  if (req.url.startsWith('/mp/event') && req.method === 'POST') {
    readBody(req, (error, body) => {
      if (error) {
        res.writeHead(400);
        res.end('Bad JSON');
        return;
      }
      const event = sanitizeEvent(body);
      if (event) events.push(event);
      prune();
      sendJson(res, { ok: true });
    });
    return;
  }

  if (req.url.startsWith('/mp/leave') && req.method === 'POST') {
    readBody(req, (error, body) => {
      if (!error && body && typeof body.id === 'string') peers.delete(body.id);
      prune();
      sendJson(res, { ok: true });
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FlowerWave multiplayer: http://localhost:${PORT}`);
});
