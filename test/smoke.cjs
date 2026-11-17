#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────
   Headless smoke test — 8ras Time Tracker v2.x
   Simulates the real PS UXP persistent-file API (verified against
   AdobeDocs/uxp-photoshop): getFolder / createPersistentToken /
   getEntryForPersistentToken / getEntry / createFile / read / write.
   Usage: node test/smoke.cjs
   ───────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!/<script\s+src="main\.js"><\/script>/.test(html)) {
  console.error('FAIL: index.html must load main.js via <script src="main.js">');
  process.exit(1);
}
const code = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

/* ── Shared mocks (persist across simulated "panel reloads") ── */
let activityCbs = [];
const psMock = {
  app: { activeDocument: { name: 'poster.psd', path: '/Projects/Nike_Campaign/poster.psd', historyStates: { length: 5 } } },
  action: {
    addNotificationListener(names, cb) { activityCbs.push(cb); return activityCbs.length; },
    removeNotificationListener() {}
  }
};

const TRACKER_PATH = '/Users/tester/Documents/TrackerData';
const folderData = {};

function fileObj(n) {
  return {
    name: n,
    isFile: true,
    isFolder: false,
    read: async () => {
      if (!Object.prototype.hasOwnProperty.call(folderData, n)) throw new Error('ENOENT: ' + n);
      return folderData[n];
    },
    write: async (d, opts) => {
      const s = String(d);
      folderData[n] = (opts && opts.append) ? (folderData[n] + s) : s;
      return s.length;
    },
    delete: async () => { delete folderData[n]; }
  };
}

const trackerFolder = {
  name: 'TrackerData',
  nativePath: TRACKER_PATH,
  isFolder: true,
  getEntry(n) {
    if (!Object.prototype.hasOwnProperty.call(folderData, n)) throw new Error('no such entry: ' + n);
    return Promise.resolve(fileObj(n));
  },
  createFile(n) { folderData[n] = ''; return Promise.resolve(fileObj(n)); }
};

const store = {}; // uxp.storage.local backing store
const uxpMock = {
  storage: {
    local: {
      getItem: async (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: async (k, v) => { store[k] = String(v); },
      removeItem: async (k) => { delete store[k]; }
    },
    localFileSystem: {
      getFolder: async () => trackerFolder,
      createPersistentToken: async (entry) => 'PTOKEN|' + (entry.nativePath || entry.path || String(entry)),
      getEntryForPersistentToken: async (t) => {
        if (typeof t !== 'string' || !t.startsWith('PTOKEN|')) throw new Error('Reference Error: token is not defined');
        return trackerFolder;
      }
    }
  }
};

const appEl = {
  _html: '',
  set innerHTML(v) { this._html = v; },
  get innerHTML() { return this._html; },
  querySelectorAll: () => [],
  querySelector: () => null
};
const inputEl = { value: '' };

function buildSandbox() {
  const sandbox = {
    console,
    Blob,
    alert: () => {},
    confirm: () => true,
    document: {
      getElementById: (id) => (id === 'app' ? appEl : inputEl),
      activeElement: null,
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    /* web localStorage = primary KV store in UXP panels (persists across "restarts") */
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    require(name) {
      if (name === 'photoshop') return psMock;
      if (name === 'uxp') return uxpMock;
      throw new Error('unexpected require: ' + name);
    }
  };
  sandbox.window = sandbox;
  sandbox.location = { reload: () => { sandbox.__reloaded = true; } };
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  return sandbox;
}

const fireActivity = () => activityCbs[activityCbs.length - 1]({});
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

console.log('\n== 8ras Time Tracker — smoke test ==\n');

(async () => {
  /* ── Scenario 1: fresh install ── */
  console.log('[1] Fresh install (no saved config)');
  const sb = buildSandbox();
  try {
    vm.runInContext(code, sb, { filename: 'plugin-main.js', timeout: 5000 });
  } catch (e) {
    console.error('FAIL: main.js threw at load time:\n' + e.stack);
    process.exit(1);
  }
  await settle();
  const dbg = sb.__debug;
  assert(!!dbg, '__debug hook exposed');
  assert(appEl.innerHTML.includes('v2.3.0'), 'version banner visible in UI');
  assert(appEl.innerHTML.includes('8ras time tracker'), 'official name shown');
  assert(dbg.state().stage === 'setup', 'initial stage is "setup"');
  assert(appEl.innerHTML.includes('Select folder'), 'setup screen rendered');
  assert(!/onclick\s*=/.test(appEl.innerHTML), 'no inline onclick attrs (UXP refuses them)');
  assert(appEl.innerHTML.includes('data-action="configure"'), 'buttons wired via data-action');
  assert(appEl.innerHTML.indexOf('assets/logo') === -1, 'plain text branding — no logo images');
  assert(dbg.logs().some(l => l.includes('module photoshop: OK')), 'log: photoshop module loaded');
  assert(dbg.logs().some(l => l.includes('localFileSystem: OK')), 'log: uxp + localFileSystem loaded');

  /* ── Scenario 2: user selects a folder ── */
  console.log('\n[2] User selects data folder');
  sb.__action('configure');
  await settle(80);
  assert(dbg.state().stage === 'ready', 'stage is "ready" after configure');
  assert(dbg.state().folderPath === TRACKER_PATH, 'state holds folder nativePath');
  assert(typeof store['eighras-tracker-token'] === 'string' && store['eighras-tracker-token'].startsWith('PTOKEN|'),
         'persistent token stored in panel localStorage');
  const tokenMeta = JSON.parse(folderData['.tracker-token.json']);
  assert(tokenMeta.folderPath === TRACKER_PATH, 'token file stores folderPath');
  assert(tokenMeta.persistentToken === store['eighras-tracker-token'], 'token file matches stored token');
  assert(activityCbs.length >= 2, 'two notification listeners registered');
  assert(!/onclick\s*=/.test(appEl.innerHTML), 'ready UI free of inline handlers');
  assert(appEl.innerHTML.includes('8ras time tracker'), 'header uses official name');
  assert(!appEl.innerHTML.includes('weekrows') && appEl.innerHTML.includes('for the dashboard'),
         'default view: timer only, bars hidden until "This week" is pressed');
  sb.__action('dash');
  assert(appEl.innerHTML.includes('No tracked time this week yet.'), '"This week" tab reveals the weekly view (empty)');
  sb.__action('settings');
  assert(appEl.innerHTML.includes('Change folder') && appEl.innerHTML.includes('data-action="toggleLog"') && appEl.innerHTML.includes('Reset config'),
         'settings holds Change folder / Show log / Reset buttons');
  sb.__action('dash');

  /* ── Scenario 3: activity on the active document ── */
  console.log('\n[3] Activity on active document');
  fireActivity();
  await settle();
  let st = dbg.state();
  assert(st.current.file === 'poster.psd', 'tracks active file name');
  assert(st.current.project === 'Nike_Campaign', 'groups by parent folder');
  assert(st.isTracking === true, 'status shows tracking');
  assert(Object.keys(dbg.sessions()).length === 1, 'one live session open');

  /* ── Scenario 4: idle timeout ends the session ── */
  console.log('\n[4] Idle timeout (simulated 3 min of no events)');
  const key = Object.keys(dbg.sessions())[0];
  dbg.sessions()[key].seconds += 120;                    // pretend 2 min of work
  dbg.sessions()[key].lastEvent = new Date(Date.now() - 3 * 60 * 1000);
  dbg.tick();
  await settle(80);
  assert(Object.keys(dbg.sessions()).length === 0, 'idle session ended and committed');
  assert(!!folderData['metrics.json'], 'metrics.json written');
  const met = JSON.parse(folderData['metrics.json']);
  const pm = met.projects.Nike_Campaign && met.projects.Nike_Campaign.files && met.projects.Nike_Campaign.files['poster.psd'];
  assert(!!pm && pm.sessions.length === 1, 'session row inside metrics.json');
  assert(pm && pm.sessions[0].seconds >= 120, 'captured ~2 minutes (got ' + (pm && pm.sessions[0].seconds) + ')');
  assert(pm && pm.sessions[0].project === 'Nike_Campaign' && pm.sessions[0].file === 'poster.psd', 'row has project+file');
  st = dbg.state();
  assert(st.weekTotal >= 120, 'weekly summary counts committed time');
  assert(st.weekProjects.some(p => p.project === 'Nike_Campaign'), 'weekly breakdown lists the project');
  assert(appEl.innerHTML.includes('weekrows') && appEl.innerHTML.includes('barrow'), 'weekly day-rows rendered with data');
  assert((appEl.innerHTML.match(/class="wd"/g) || []).length === 7, 'exactly seven day rows');
  const wds = appEl.innerHTML.split('class="wd">').slice(1).map(x => x.slice(0, 2));
  assert(JSON.stringify(wds) === JSON.stringify(['Mo','Tu','We','Th','Fr','Sa','Su']),
         'week rows labelled Mo…Su starting Monday');

  /* date keys must be LOCAL calendar dates. v2.2.x bug: toISOString() (UTC) shifted the
     day in non-UTC timezones — Madrid's Tuesday session landed on the "We" row. */
  const nowL = new Date();
  const p2 = n => (n < 10 ? '0' : '') + n;
  const expectLocal = nowL.getFullYear() + '-' + p2(nowL.getMonth() + 1) + '-' + p2(nowL.getDate());
  assert(dbg.todayISO() === expectLocal, 'todayISO is the LOCAL calendar date');
  assert(dbg.localISO(nowL) === expectLocal, 'localISO formats local date');
  /* and committed time must actually land on today's row, whatever the timezone */
  const tdays = dbg.metrics().totals.days;
  assert(!!tdays[expectLocal] && tdays[expectLocal].totalSeconds >= 120,
         'committed time lands on the TODAY local date key (no UTC shift)');
  assert(appEl.innerHTML.includes('This week') && appEl.innerHTML.includes('2m 00s'), 'durations show explicit units (2m 00s)');
  assert(appEl.innerHTML.includes('bars scale to a full day'), '24h bar scale is noted');

  /* idle → user keeps working with the SAME tool: history stack grows → tracking must resume
     without any doc/tool switch (the reported v2.2.0 gap) */
  psMock.app.activeDocument.historyStates.length += 6;    // e.g. several brush strokes
  dbg.tick();
  await settle(50);
  assert(Object.keys(dbg.sessions()).length === 1, 'activity probe reopened a session after idle');
  assert(dbg.state().isTracking, 'tracking resumed without doc/tool change');
  assert(appEl.innerHTML.includes('tracking'), 'status shows tracking again');

  /* ── Scenario 5: document switching ── */
  console.log('\n[5] Document switching');
  const preNik = met.projects.Nike_Campaign.totalSeconds;
  psMock.app.activeDocument = { name: 'poster.psd', path: '/Projects/Nike_Campaign/poster.psd' };
  fireActivity();                        // poster.psd becomes active again
  await settle();
  const k5 = Object.keys(dbg.sessions())[0];
  dbg.sessions()[k5].seconds += 120;     // pretend 2 min of work on poster
  dbg.sessions()[k5].lastEvent = new Date();
  psMock.app.activeDocument = { name: 'logo.psd', path: '/Projects/Brand_Refresh/logo.psd' };
  fireActivity();                        // switch tabs to logo.psd
  await settle(80);
  st = dbg.state();
  assert(st.current.file === 'logo.psd', 'switched to new document');
  assert(st.current.project === 'Brand_Refresh', 'new project detected');
  const met2 = JSON.parse(folderData['metrics.json']);
  const nikDelta = met2.projects.Nike_Campaign.totalSeconds - preNik;
  assert(nikDelta >= 120, 'switching instantly commits the previous doc (delta ' + nikDelta + 's)');
  const kLogo = Object.keys(dbg.sessions()).find(k => k.indexOf('Brand_Refresh') === 0);
  assert(!!kLogo, 'new doc starts its own live session');

  /* ── Scenario 6: unsaved document ── */
  console.log('\n[6] Unsaved document');
  psMock.app.activeDocument = { name: 'Untitled-3', path: '' };
  fireActivity();
  await settle();
  st = dbg.state();
  assert(st.current.project === 'Unsaved Documents', 'unsaved doc → "Unsaved Documents" project');
  assert(st.current.file === 'Untitled-3', 'unsaved doc keeps its name');

  /* ── Scenario 7: CSV export ── */
  console.log('\n[7] CSV export');
  sb.__action('exportCsv');
  await settle(80);
  const csvName = Object.keys(folderData).find(n => n.endsWith('.csv'));
  assert(!!csvName, 'CSV file created (' + (csvName || 'none') + ')');
  if (csvName) {
    const csv = folderData[csvName].replace(/^\uFEFF/, '');
    const lines = csv.split('\r\n');
    assert(lines[0] === 'date,project,file,session_start,session_end,seconds,active', 'CSV header correct');
    assert(csv.includes('Nike_Campaign') && csv.includes('poster.psd'), 'CSV contains committed session');
    assert(csv.includes(',true'), 'CSV marks live sessions as active');
  }

  /* ── Scenario 8: threshold persistence + full panel restart ── */
  console.log('\n[8] Threshold change + restart (config restore)');
  inputEl.value = '5';
  sb.__action('setThreshold');
  await settle(80);
  const token2 = JSON.parse(folderData['.tracker-token.json']);
  assert(token2.thresholdMinutes === 5, 'threshold saved into token file');

  // Simulate closing and reopening the panel: brand-new context, same disk + storage.
  activityCbs = [];
  psMock.app.activeDocument = { name: 'poster.psd', path: '/Projects/Nike_Campaign/poster.psd' };
  const sb2 = buildSandbox();
  vm.runInContext(code, sb2, { filename: 'plugin-reload.js', timeout: 5000 });
  await settle();
  const dbg2 = sb2.__debug;
  assert(dbg2.state().stage === 'ready', 'config restored after restart → stage ready');
  assert(dbg2.state().folderPath === TRACKER_PATH, 'restored folder path');
  assert(dbg2.state().thresholdMin === 5, 'restored threshold (5 min)');
  assert(!!dbg2.metrics() && !!dbg2.metrics().projects.Nike_Campaign, 'restored metrics cache from disk');
  assert(activityCbs.length >= 2, 'listeners re-registered on boot');
  assert(dbg2.logs().some(l => l.includes('restored folder from token')), 'log confirms token restore');

  // Live timer still works after restore
  fireActivity();
  await settle();
  assert(dbg2.state().current.file === 'poster.psd', 'tracking resumes after restart');

  /* ── Result ── */
  /* ── Scenario 9: reconfigure the data folder from settings ── */
  console.log('\n[9] Change folder from settings (data preserved)');
  dbg2.action('settings');
  dbg2.action('configure');
  await settle(150);
  assert(dbg2.state().stage === 'ready', 'still ready after Change folder…');
  assert(dbg2.state().folderPath === TRACKER_PATH, 'same folder re-selected');
  const tot9 = Object.values(dbg2.metrics().totals.days || {}).reduce((a, d) => a + d.totalSeconds, 0);
  assert(tot9 >= 120, 'committed time survived folder re-selection (' + tot9 + 's)');
  assert(dbg2.logs().some(l => l.includes('restored existing')), 'existing metrics.json re-read from the folder');
  psMock.app.activeDocument.name = 'poster_b.psd';
  fireActivity();
  await settle();
  assert(dbg2.state().current.file === 'poster_b.psd', 'tracking continues after folder change');

  console.log('\n== result: ' + passed + ' passed, ' + failed + ' failed ==\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL: test harness crashed:\n' + e.stack);
  process.exit(1);
});
