'use strict';

/* ════════════════════════════════════════════════════════════════════
   8ras Time Tracker — v2.1.0
   Adobe Photoshop UXP panel plugin. Classic script (NO ES modules).

   All UXP API calls verified against the official reference
   (github.com/AdobeDocs/uxp-photoshop → persistent-file-storage):
     localFs.getFolder()                    → folder picker
     localFs.createPersistentToken(entry)   → string token (persist me)
     localFs.getEntryForPersistentToken(str)→ entry restored later
     folder.getEntry(name)                  → existing File|Folder
     folder.createFile(name)                → new File
     file.read()                            → string (utf8 default)
     file.write(data[, {append}])           → replaces unless append
   ══════════════════════════════════════════════════════════════════ */
console.log('[8ras v2.3.0] main.js loaded');

var NAME = '8ras time tracker';
var VERSION = '2.3.0';
var TOKEN_KEY = 'eighras-tracker-token';   // persistent-token key in storage.local
var TOKEN_FILE = '.tracker-token.json';    // human-readable marker inside the data folder
var METRICS_FILE = 'metrics.json';
var CHECKPOINT_MS = 60 * 1000;

var state = {
  stage: 'boot',            // boot | setup | ready | fatal
  error: '',
  current: { project: '—', file: '—' },
  isTracking: false,
  liveSeconds: 0,
  weekTotal: 0,
  weekProjects: [],
  thresholdMin: 2,
  folderPath: '',
  showDash: false,
  showSettings: false,
  showLogs: false
};

var sessions = {};          // "project|file" -> session record
var currentKey = null;
var metrics = null;         // in-memory cache of metrics.json
var folder = null;          // UXP Folder entry (user's data folder)
var uxpMod = null;
var ps = null;
var localFs = null;
var activityHandle = null;
var docHandle = null;
var timerId = null;
var lastTickAt = Date.now();
var histLast = null;           // last seen historyStates.length → activity probe
var lastPersistAt = Date.now();
var booted = false;
var busy = false;

/* ── logging (mirrored to UDT console + optional on-screen log) ── */
var logs = [];
function log(msg) {
  var line = new Date().toISOString().slice(11, 19) + '  ' + msg;
  try { console.log('[8ras] ' + line); } catch (e) {}
  logs.push(line);
  if (logs.length > 250) logs.shift();
  if (booted && state.showLogs) render();
}
function logErr(msg) {
  var line = new Date().toISOString().slice(11, 19) + '  ERROR  ' + msg;
  try { console.error('[8ras] ' + line); } catch (e) {}
  logs.push(line);
  if (logs.length > 250) logs.shift();
  if (booted && state.showLogs) render();
}

/* ── capture the Adobe modules (top level, synchronously) ── */
try {
  ps = require('photoshop');
  log('module photoshop: OK');
} catch (e) {
  logErr('require("photoshop") failed: ' + e.message);
}
try {
  uxpMod = require('uxp');
  localFs = uxpMod && uxpMod.storage ? uxpMod.storage.localFileSystem : null;
  if (localFs) log('module uxp + localFileSystem: OK');
  else logErr('uxp.storage.localFileSystem is undefined in this build');
} catch (e) {
  logErr('require("uxp") failed: ' + e.message);
}

/* ── tiny DOM helper ── */
function $(id) { return document.getElementById(id); }

/* ── utilities ── */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid() {
  var n = Math.random() * 4294967295;
  return 'm' + Date.now().toString(36) + '-' + n.toString(36) +
         Math.floor(Math.random() * 4294967295).toString(36);
}
/* durations with explicit units: "2h 05m 09s" / "4m 12s" / "38s" */
function fmtUnits(totalSec) {
  totalSec = Math.max(0, Math.floor(totalSec));
  var h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  function p(x) { return (x < 10 ? '0' : '') + x; }
  if (h > 0) return h + 'h ' + p(m) + 'm ' + p(s) + 's';
  if (m > 0) return m + 'm ' + p(s) + 's';
  return s + 's';
}
function folderLabel(f) {
  return (f && f.nativePath) || (f && f.path) || String(f || '');
}

/* ── key-value persistence ──
   This PS build exposes uxp.storage.localFileSystem but NOT uxp.storage.local,
   so the panel's own web localStorage is the primary store, with a fallback.
   All calls are try/catched: worst case we just re-ask for the folder. */
async function kvGet(key) {
  try { var v = window.localStorage.getItem(key); if (v != null) return v; } catch (e) {}
  try { if (uxpMod && uxpMod.storage && uxpMod.storage.local) return await uxpMod.storage.local.getItem(key); } catch (e) {}
  return null;
}
async function kvSet(key, value) {
  try { window.localStorage.setItem(key, String(value)); return true; }
  catch (e) { log('web localStorage unavailable (' + e.message + ')'); }
  try { if (uxpMod && uxpMod.storage && uxpMod.storage.local) { await uxpMod.storage.local.setItem(key, String(value)); return true; } } catch (e) {}
  logErr('could not persist kv "' + key + '" anywhere');
  return false;
}
async function kvDel(key) {
  try { window.localStorage.removeItem(key); } catch (e) {}
  try { if (uxpMod && uxpMod.storage && uxpMod.storage.local) await uxpMod.storage.local.removeItem(key); } catch (e) {}
}

/* ═══════════════ file I/O — real PS UXP persistent-file API ═══════════════ */

/* Read a text file from the data folder; null if it doesn't exist. */
async function readTextFile(fdir, name) {
  var f;
  try { f = await fdir.getEntry(name); } catch (e) { return null; }
  if (!f || !f.isFile) return null;
  try { return await f.read(); } catch (e) { return null; }
}

/* Write (replace) a text file in the data folder. Creates it if needed. */
async function writeTextFile(fdir, name, text) {
  var f;
  try {
    f = await fdir.getEntry(name);
    if (f && !f.isFile) { try { await f.delete(); } catch (e) {} f = null; }
  } catch (e) { f = null; }
  if (!f) {
    try { f = await fdir.createFile(name); }
    catch (e) { logErr('cannot create ' + name + ': ' + e.message); return false; }
  }
  try { await f.write(text); return true; }
  catch (e) { logErr('write ' + name + ' failed: ' + e.message); return false; }
}

/* ═══════════════════════════════ metrics model ═════════════════════════════ */

function emptyMetrics() {
  return {
    version: 1,
    created: new Date().toISOString(),
    projects: {},
    totals: { days: {}, projects: {} }
  };
}

function docName(doc) {
  return (doc && (doc.name || (doc.path ? doc.path.split('/').pop().split('\\').pop() : ''))) || 'Unknown';
}
function docPath(doc) {
  return (doc && doc.path) ? String(doc.path) : '';
}
function projectOf(p) {
  if (!p) return 'Unsaved Documents';
  var parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return 'Unsaved Documents';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }
/* LOCAL date key (YYYY-MM-DD). Using UTC (toISOString) shifts a whole day for users
   off UTC — in Madrid a Tuesday session landed on the "We" row. */
function localISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayISO() { return localISO(new Date()); }

function findRow(projects, proj, file) {
  if (!projects[proj]) projects[proj] = { files: {}, totalSeconds: 0 };
  if (!projects[proj].files[file]) {
    projects[proj].files[file] = { filePath: '', totalSeconds: 0, sessions: [] };
  }
  return projects[proj].files[file];
}

/* Push a finished (or checkpointed) slice of a session into the cache. */
function commitSession(key, finalize) {
  var s = sessions[key];
  if (!s || s.seconds <= 0) { if (finalize) delete sessions[key]; return; }
  if (!metrics || typeof metrics.projects !== 'object' || !metrics.projects) metrics = emptyMetrics();
  var row = findRow(metrics.projects, s.project, s.file);
  if (s.path && (!row.filePath || row.filePath.indexOf(s.path) === 0) && s.path !== '/-') row.filePath = s.path;
  var nowIso = new Date().toISOString();
  row.sessions.push({
    id: uid(),
    date: todayISO(),
    startTime: new Date(s.startTime).toISOString(),
    endTime: nowIso,
    seconds: Math.round(s.seconds),
    project: s.project,
    file: s.file,
    filePath: row.filePath,
    isActive: false
  });
  row.totalSeconds += Math.round(s.seconds);
  metrics.projects[s.project].totalSeconds += Math.round(s.seconds);
  var t = todayISO();
  if (!metrics.totals.days[t]) metrics.totals.days[t] = { totalSeconds: 0, byProject: {} };
  metrics.totals.days[t].totalSeconds += Math.round(s.seconds);
  if (!metrics.totals.days[t].byProject[s.project]) metrics.totals.days[t].byProject[s.project] = 0;
  metrics.totals.days[t].byProject[s.project] += Math.round(s.seconds);
  if (!metrics.totals.projects[s.project]) metrics.totals.projects[s.project] = 0;
  metrics.totals.projects[s.project] += Math.round(s.seconds);
  if (finalize) {
    delete sessions[key];
    if (key === currentKey) currentKey = null;
  } else {
    s.seconds = 0;
    s.startTime = Date.now();
    s.lastEvent = Date.now();
  }
}

async function persistNow() {
  if (!folder || !metrics) return false;
  if (persistNow.busy) return false;
  persistNow.busy = true;
  try {
    await writeTextFile(folder, METRICS_FILE, JSON.stringify(metrics, null, 1));
    lastPersistAt = Date.now();
    return true;
  } catch (e) {
    logErr('persist failed: ' + (e && e.message ? e.message : e));
    return false;
  } finally {
    persistNow.busy = false;
  }
}

/* ═══════════════════════════════ tracking engine ══════════════════════════ */

var ACTIVITY_ACTIONS = [
  'brush', 'pencil', 'eraser', 'fill', 'gradient', 'typeTool',
  'layerNew', 'layerDelete', 'layerDuplicate', 'mergeLayer',
  'adjustBrightnessContrast', 'adjustHueSaturation', 'adjustCurves', 'adjustLevels',
  'undo', 'redo', 'move', 'transform', 'rotate', 'scale',
  'select', 'marquee', 'lasso', 'wand', 'crop', 'paste', 'copy',
  'documentSave', 'zoomIn', 'zoomOut'
];
var DOC_EVENTS = ['documentOpen', 'documentSave', 'documentActivate', 'documentIndexChange', 'documentClose'];

function liveSessionSeconds() {
  var total = 0;
  for (var k in sessions) total += sessions[k].seconds;
  return total;
}

function touchDoc() {
  var nowMs = Date.now();
  try {
    if (!ps || !ps.app || !ps.app.activeDocument) return;
    var doc = ps.app.activeDocument;
    var file = docName(doc);
    var p = projectOf(docPath(doc));
    if (currentKey && sessions[currentKey] && (sessions[currentKey].file !== file || sessions[currentKey].project !== p)) {
      commitSession(currentKey, true);
      void persistNow();
    }
    var key = p + '|' + file;
    if (!sessions[key]) {
      sessions[key] = {
        project: p, file: file, path: docPath(doc) || '/-',
        startTime: nowMs, lastEvent: nowMs, seconds: 0, active: true
      };
    } else {
      sessions[key].active = true;
      sessions[key].lastEvent = nowMs;
    }
    currentKey = key;
    state.current = { project: p, file: file };
    state.isTracking = true;
    refreshLive();
    if (booted && state.stage === 'ready' && !renderBlocked()) render();
  } catch (e) {
    logErr('touchDoc: ' + (e && e.message ? e.message : e));
  }
}

function tick() {
  try {
    var nowMs = Date.now();

    /* activity probe: the history stack grows with EVERY undoable step — including
       strokes of the tool you're already using — so this resumes tracking after an
       idle pause without needing a doc/tool switch */
    try {
      var actDoc = ps && ps.app ? ps.app.activeDocument : null;
      if (actDoc && actDoc.historyStates) {
        var hn = actDoc.historyStates.length;
        if (typeof histLast === 'number' && hn > histLast) touchDoc();
        histLast = hn;
      } else {
        histLast = null;
      }
    } catch (e) { histLast = null; }

    var dt = Math.max(0, (nowMs - lastTickAt) / 1000);
    lastTickAt = nowMs;
    var idleFor = state.thresholdMin * 60 * 1000;
    var committed = false;

    for (var k in sessions) {
      var s = sessions[k];
      if (nowMs - s.lastEvent > idleFor) {
        if (s.active) {
          s.active = false;
          commitSession(k, true);
          committed = true;
          log('idle timeout → session committed (' + s.project + '/' + s.file + ')');
        }
      } else if (s.active) {
        s.seconds += dt;            // count time only while activity is recent
      }
    }
    if (committed) void persistNow();

    state.liveSeconds = liveSessionSeconds();
    state.isTracking = !!(currentKey && sessions[currentKey] && sessions[currentKey].active);

    if (nowMs - lastPersistAt >= CHECKPOINT_MS && Object.keys(sessions).length > 0) {
      var anyTime = false;
      for (var k2 in sessions) { if (sessions[k2].seconds > 0) { anyTime = true; break; } }
      if (anyTime) {
        for (var k3 in sessions) commitSession(k3, false);
        void persistNow();
        log('checkpoint saved');
      }
    }
    if (booted && state.stage === 'ready' && !renderBlocked()) render();
  } catch (e) {
    logErr('tick: ' + (e && e.message ? e.message : e));
  }
}

/* Fold every open session into metrics and hit disk. Used on hide/close. */
function flushActive() {
  if (!Object.keys(sessions).length) return;
  for (var k in sessions) commitSession(k, true);
  void persistNow();
}

function stopTracking() {
  if (timerId != null) { clearInterval(timerId); timerId = null; }
  if (ps && ps.action && activityHandle != null) { try { ps.action.removeNotificationListener(activityHandle); } catch (e) {} }
  if (ps && ps.action && docHandle != null) { try { ps.action.removeNotificationListener(docHandle); } catch (e) {} }
  activityHandle = null;
  docHandle = null;
}

function startTracking() {
  stopTracking();
  if (!ps || !ps.action) { logErr('ps.action unavailable — cannot listen for activity'); return; }
  try {
    activityHandle = ps.action.addNotificationListener(ACTIVITY_ACTIONS, function () { touchDoc(); });
    docHandle = ps.action.addNotificationListener(DOC_EVENTS, function () { touchDoc(); });
    log('notification listeners registered');
  } catch (e) {
    logErr('addNotificationListener failed: ' + (e && e.message ? e.message : e));
  }
  timerId = setInterval(tick, 1000);
  state.isTracking = true;
  log('tracking started (idle threshold ' + state.thresholdMin + ' min, checkpoint every ' + CHECKPOINT_MS / 1000 + ' s)');
}

function refreshLive() {
  state.liveSeconds = liveSessionSeconds();
}

/* ═══════════════════════════════ weekly dashboard ══════════════════════════ */

function weekRows() {
  var days = [];
  var byProj = {};
  var start = new Date();
  var dow = start.getDay();                    // 0=Sun … 6=Sat
  var sinceMonday = dow === 0 ? 6 : dow - 1;    // week starts Monday
  start.setDate(start.getDate() - sinceMonday);
  start.setHours(0, 0, 0, 0);
  for (var i = 0; i < 7; i++) {
    var d = new Date(start.getTime() + i * 86400000);
    var iso = localISO(d);
    var day = { label: ['Mo','Tu','We','Th','Fr','Sa','Su'][i], iso: iso, sec: 0, today: iso === todayISO() };
    if (metrics && metrics.totals && metrics.totals.days[iso]) {
      day.sec = metrics.totals.days[iso].totalSeconds || 0;
      var bp = metrics.totals.days[iso].byProject || {};
      for (var pj in bp) byProj[pj] = (byProj[pj] || 0) + bp[pj];
    }
    days.push(day);
  }
  var nowMs = Date.now();
  for (var k in sessions) {
    var s = sessions[k];
    var d = new Date(s.startTime);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() >= start.getTime()) {
      var iso = localISO(d);
      for (var j = 0; j < days.length; j++) {
        if (days[j].iso === iso) { days[j].sec += s.seconds; break; }
      }
      byProj[s.project] = (byProj[s.project] || 0) + s.seconds;
    }
  }
  state.weekTotal = 0;
  days.forEach(function (d) { state.weekTotal += d.sec; });
  var list = [];
  for (var p in byProj) list.push({ project: p, sec: byProj[p] });
  list.sort(function (a, b) { return b.sec - a.sec; });
  state.weekProjects = list.slice(0, 8);
  return days;
}

/* ═══════════════════════════════════ UI render ═════════════════════════════ */

function logHtml() {
  if (!logs.length) return '<div class="logbox">no log entries yet</div>';
  var recent = logs.slice(-60);
  return '<div class="logbox">' + recent.map(function (l) { return esc(l); }).join('<br>') + '</div>';
}

function render() {
  var el = $('app');
  if (!el) return;
  var html = '';

  if (state.stage === 'boot') {
    html = '<div class="setup"><div class="logo">&#9201;</div><h1>' + NAME + ' <span class="vtag">v' + VERSION + '</span></h1><p>Initializing&hellip;</p>' +
           (state.showLogs || logs.length ? logHtml() : '') + '</div>';
  } else if (state.stage === 'fatal') {
    html = '<div class="setup"><div class="logo">!</div><h1>' + NAME + ' — startup error</h1><p>' + esc(state.error) + '</p>' +
           (state.showLogs || logs.length ? logHtml() : '') +
           '<button class="btn wide" data-action="restart">Retry</button></div>';
  } else if (state.stage === 'setup') {
    html = '<div class="setup"><div class="logo">&#9201;</div><h1>' + NAME + ' <span class="vtag">v' + VERSION + '</span></h1>' +
           '<p>Pick the folder where your tracking data will live.<br>One file: ' + esc(METRICS_FILE) + '</p>' +
           '<button class="btn wide primary" data-action="configure">Select folder&hellip;</button>' +
           (logs.length ? logHtml() : '') + '</div>';
  } else {
    var days = weekRows();

    html += '<div class="card header"><div class="row"><span class="brand">' + NAME + '<span class="vtag"> v' + VERSION + '</span></span></div></div>';

    html += '<div class="card timer ' + (state.isTracking ? 'on' : 'off') + '">' +
            '<div class="time">' + fmtUnits(state.liveSeconds) + '</div>' +
            '<div class="doc">' + esc(state.current.project) + ' / <b>' + esc(state.current.file) + '</b></div>' +
            '<div class="status">' + (state.isTracking ? '&#9679; tracking' : 'idle&nbsp;<span style="opacity:.6">(pause after ' + state.thresholdMin + ' min)</span>') + '</div>' +
            '</div>';

    html += '<div class="tabs"><button class="tab ' + (state.showDash ? 'on' : '') + '" data-action="dash">This week</button>' +
            '<button class="tab ' + (state.showSettings ? 'on' : '') + '" data-action="settings">Settings</button></div>';

    if (state.showSettings) {
      html += '<div class="card settings">' +
              '<label>Idle pause after (minutes)</label>' +
              '<input type="number" min="1" max="180" step="1" value="' + state.thresholdMin + '" id="threshold" data-change="setThreshold">' +
              '<div class="btnrow">' +
              '<button class="btn" data-action="exportCsv">Export CSV</button>' +
              '<button class="btn primary" data-action="configure">Change folder&hellip;</button>' +
              '</div>' +
              '<div class="btnrow">' +
              '<button class="btn" data-action="toggleLog">' + (state.showLogs ? 'Hide log' : 'Show log') + '</button>' +
              '<button class="btn danger" data-action="resetConfig">Reset config</button>' +
              '</div>' +
              '<div class="hint">data folder: ' + esc(state.folderPath || '?') + '</div>' +
              '<div class="hint">CSV marks the in-flight session with <code>active=true</code>.</div>' +
              (state.showLogs ? logHtml() : '') +
              '</div>';
    } else if (state.showDash) {
      html += '<div class="card week"><h3>This week — ' + fmtUnits(state.weekTotal) + '</h3>';
      if (!state.weekProjects.length && state.weekTotal === 0) {
        html += '<p class="dim">No tracked time this week yet.</p>';
      } else {
        html += '<div class="weekrows">';
        days.forEach(function (d) {
          var pct = Math.min(100, Math.round((d.sec / 86400) * 100));
          html += '<div class="barrow' + (d.today ? ' today' : '') + '" title="' + d.iso + '"><span class="wd">' + d.label + '</span>' +
                  '<div class="bartrack"><div class="barfill" style="width:' + pct + '%"></div></div>' +
                  '<span class="wsec' + (d.sec < 1 ? ' zero' : '') + '">' + (d.sec >= 1 ? fmtUnits(d.sec) : '&mdash;') + '</span></div>';
        });
        html += '</div><div class="hint" style="margin-top:2px">bars scale to a full day (24h)</div>';
        if (state.weekProjects.length) {
          html += '<div class="projlist">';
          state.weekProjects.forEach(function (p) {
            var share = state.weekTotal > 0 ? Math.round((p.sec / state.weekTotal) * 100) : 0;
            html += '<div class="proj-row"><span class="dot"></span><span class="pname" title="' + esc(p.project) + '">' + esc(p.project) + '</span>' +
                    '<span class="ptime">' + fmtUnits(p.sec) + '</span><span class="pshare">' + share + '%</span></div>';
          });
          html += '</div>';
        }
      }
      html += '<div class="verbar">v' + VERSION + '</div></div>';
    } else {
      html += '<div class="card week"><p class="dim">Time tracks automatically while you work in Photoshop.<br>Open <b>This week</b> for the dashboard, <b>Settings</b> for options.</p>' +
              '<div class="verbar">v' + VERSION + ' &middot; ready</div></div>';
    }
  }
  el.innerHTML = html;
  wire(el);
}

/* UXP forbids inline onclick handlers in innerHTML-injected markup: bind via addEventListener */
function wire(el) {
  try {
    var i, nodes;
    nodes = el.querySelectorAll('[data-action]');
    for (i = 0; i < nodes.length; i++) {
      (function (a) {
        nodes[i].addEventListener('click', function () { window.__action(a); });
      })(nodes[i].getAttribute('data-action'));
    }
    nodes = el.querySelectorAll('[data-change]');
    for (i = 0; i < nodes.length; i++) {
      (function (a) {
        nodes[i].addEventListener('change', function () { window.__action(a); });
      })(nodes[i].getAttribute('data-change'));
    }
  } catch (e) {
    logErr('wire: ' + (e && e.message ? e.message : e));
  }
}

/* don't repaint while the user is typing in an input (tick renders every second) */
function renderBlocked() {
  try {
    var ae = document.activeElement;
    return !!(ae && ae.tagName && ae.tagName === 'INPUT');
  } catch (e) { return false; }
}

/* ═══════════════════════════════ actions & wiring ══════════════════════════ */

async function configure() {
  if (busy) return;
  if (!localFs) { logErr('configure: localFileSystem unavailable'); return; }
  busy = true;
  try {
    log('opening folder picker…');
    var f = await localFs.getFolder();
    if (!f) { log('folder selection: cancelled'); render(); return; }
    folder = f;
    state.folderPath = folderLabel(f);

    /* restore previous settings (threshold) before overwriting the token file */
    var prevRaw = await readTextFile(f, TOKEN_FILE);
    if (prevRaw) {
      try {
        var prev = JSON.parse(prevRaw);
        if (Number(prev.thresholdMinutes) >= 1 && Number(prev.thresholdMinutes) <= 180) state.thresholdMin = Number(prev.thresholdMinutes);
      } catch (e) {}
    }

    var token;
    try {
      token = await localFs.createPersistentToken(f);
      await kvSet(TOKEN_KEY, token);
    } catch (e) {
      log('persistent token unavailable (' + e.message + ') — will ask again on restart');
    }
    var tokenMeta = {
      app: '8ras-time-tracker',
      version: VERSION,
      folderPath: state.folderPath,
      persistentToken: token || null,
      thresholdMinutes: state.thresholdMin,
      createdAt: new Date().toISOString()
    };
    await writeTextFile(f, TOKEN_FILE, JSON.stringify(tokenMeta, null, 1));
    metrics = null;
    var raw = await readTextFile(f, METRICS_FILE);
    if (raw) {
      try {
        metrics = JSON.parse(raw);
        if (!metrics.projects) metrics = emptyMetrics();
        log('restored existing ' + METRICS_FILE);
      } catch (e) { log('existing ' + METRICS_FILE + ' unreadable — starting fresh'); metrics = emptyMetrics(); }
    }
    if (!metrics) metrics = emptyMetrics();
    state.stage = 'ready';
    startTracking();
    log('folder ready: ' + state.folderPath);
  } catch (e) {
    logErr('configure failed: ' + (e && e.message ? e.message : e));
  } finally {
    busy = false;
    render();
  }
}

async function exportCsv() {
  try {
    var rows = [['date', 'project', 'file', 'session_start', 'session_end', 'seconds', 'active']];
    if (metrics && metrics.projects) {
      for (var p in metrics.projects) {
        var files = metrics.projects[p].files || {};
        for (var f in files) {
          (files[f].sessions || []).forEach(function (s) {
            rows.push([s.date, p, f, (s.startTime || '').slice(11, 19), (s.endTime || '').slice(11, 19), s.seconds, s.isActive ? 'true' : 'false']);
          });
        }
      }
    }
    var nowMs = Date.now();
    for (var k in sessions) {
      var s = sessions[k];
      rows.push([todayISO(), s.project, s.file, new Date(s.startTime).toISOString().slice(11, 19), new Date(nowMs).toISOString().slice(11, 19), Math.round(s.seconds), 'true']);
    }
    if (rows.length <= 1) { alert('Nothing to export yet.'); return; }
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        c = String(c == null ? '' : c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\r\n');
    if (!folder) { alert('No data folder configured.'); return; }
    var stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    var ok = await writeTextFile(folder, '8ras-tracker-' + stamp + '.csv', '\uFEFF' + csv);
    if (ok) log('CSV exported (' + (rows.length - 1) + ' rows)');
  } catch (e) {
    logErr('CSV export failed: ' + (e && e.message ? e.message : e));
  }
}

function resetConfig() {
  if (!confirm('Reset configuration? Your metrics.json stays on disk; the plugin will ask for the folder again.')) return;
  void kvDel(TOKEN_KEY);
  stopTracking();
  folder = null;
  metrics = null;
  for (var k in sessions) delete sessions[k];
  currentKey = null;
  state.stage = 'setup';
  state.isTracking = false;
  state.liveSeconds = 0;
  render();
}

function restartApp() {
  try { flushActive(); } catch (e) {}
  stopTracking();
  for (var k in sessions) delete sessions[k];
  currentKey = null;
  metrics = null;
  folder = null;
  state.stage = 'boot';
  state.error = '';
  state.isTracking = false;
  state.liveSeconds = 0;
  render();
  init();
}

async function init() {
  try {
    if (!localFs) throw new Error('localFileSystem API not available in this UXP build');

    /* 1) try to restore the user's folder from its persistent token */
    var token = null;
    try { token = await kvGet(TOKEN_KEY); } catch (e) {}
    if (token) {
      try {
        var entry = await localFs.getEntryForPersistentToken(token);
        if (!entry) throw new Error('token resolved to nothing');
        folder = entry;
        state.folderPath = folderLabel(entry);
        var metaRaw = await readTextFile(folder, TOKEN_FILE);
        if (metaRaw) {
          try {
            var meta = JSON.parse(metaRaw);
            if (Number(meta.thresholdMinutes) >= 1) state.thresholdMin = Number(meta.thresholdMinutes);
          } catch (e) {}
        }
        var raw = await readTextFile(folder, METRICS_FILE);
        if (raw) {
          try { metrics = JSON.parse(raw); if (!metrics.projects) metrics = emptyMetrics(); log('restored metrics from disk'); }
          catch (e) { log('stored metrics.json unreadable — starting fresh'); metrics = null; }
        }
        if (!metrics) metrics = emptyMetrics();
        state.stage = 'ready';
        startTracking();
        log('restored folder from token: ' + state.folderPath);
        render();
        return;
      } catch (e) {
        log('stored token invalid (' + (e && e.message ? e.message : e) + ') — will ask for folder again');
        await kvDel(TOKEN_KEY);
        folder = null;
      }
    }

    state.stage = 'setup';
    render();
  } catch (e) {
    state.stage = 'fatal';
    state.error = 'Initialization failed: ' + (e && e.message ? e.message : e);
    logErr(state.error);
    render();
  }
}

/* ── panel-visible action bridge (onclick handlers) ── */
window.__action = function (name, arg) {
  if (name === 'toggleLog') { state.showLogs = !state.showLogs; render(); }
  else if (name === 'dash') { state.showDash = true; state.showSettings = false; render(); }
  else if (name === 'settings') { state.showSettings = true; state.showDash = false; render(); }
  else if (name === 'configure') { void configure(); }
  else if (name === 'exportCsv') { void exportCsv(); }
  else if (name === 'resetConfig') { resetConfig(); }
  else if (name === 'restart') { restartApp(); }
  else if (name === 'setThreshold') {
    var inp = $('threshold');
    if (!inp) return;
    var v = parseInt(inp.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 180) v = 180;
    state.thresholdMin = v;
    if (folder) {
      readTextFile(folder, TOKEN_FILE).then(function (raw) {
        var meta = { app: '8ras-time-tracker', version: VERSION, folderPath: state.folderPath, thresholdMinutes: v, updatedAt: new Date().toISOString() };
        return writeTextFile(folder, TOKEN_FILE, JSON.stringify(meta, null, 1));
      }).catch(function () {});
      log('idle threshold set to ' + v + ' min');
    }
    render();
  }
};

/* ── global error traps → surface anything silent in the panel ── */
window.onerror = function (msg, src, line, col, err) {
  logErr('window.onerror: ' + msg + (src ? ' @ ' + src + ':' + line + ':' + col : '') +
         (err && err.stack ? '\n' + err.stack : ''));
  if (state.stage === 'boot') {
    state.stage = 'fatal';
    state.error = 'Script error: ' + msg;
    render();
  }
  return false;
};
window.addEventListener('unhandledrejection', function (ev) {
  var m = (ev.reason && ev.reason.message) ? ev.reason.message : String(ev.reason);
  logErr('unhandled rejection: ' + m);
  if (state.stage === 'boot') {
    state.stage = 'fatal';
    state.error = 'Unhandled promise rejection: ' + m;
    render();
  }
});
try { document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') { try { flushActive(); } catch (e) {} }
}); } catch (e) {}
try { window.addEventListener('beforeunload', function () { try { flushActive(); } catch (e) {} }); } catch (e) {}

/* ── debug hooks (used by test/smoke.cjs and for in-panel poking) ── */
window.__debug = {
  sessions: function () { return sessions; },
  state: function () { return state; },
  logs: function () { return logs.slice(); },
  metrics: function () { return metrics; },
  action: function (n, a) { return window.__action(n, a); },
  touchDoc: touchDoc,
  tick: tick,
  flushActive: flushActive,
  todayISO: todayISO,
  localISO: localISO
};

/* ── boot ── */
booted = true;
render();
init();
