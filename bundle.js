/* 8RAS Time Tracker — Pure Vanilla JS for Adobe Photoshop UXP */

// ─── Configuration ────────────────────────────────────────────────
var STORAGE_PATH = '/Users/Shared/8ras-data'; // Edit this before loading in PS
var IDLE_TIMEOUT = 60; // seconds of inactivity before pause
var SUPPORTED_ACTIONS = [
  'brush', 'penTool', 'move', 'typeCreateOrChange',
  'setNewHue', 'freeTransform', 'pathComponentOperation', 'adjustment'
];

// ─── State ────────────────────────────────────────────────────────
var metricsFile = 'metrics.json';
var tokenFile = 'token.txt';
var sessionFile = 'session.json';
var currentView = 'setup'; // setup | timer | dashboard | settings
var settings = { idleTimeout: IDLE_TIMEOUT };
var clickHandlers = {};
var rootEl = null;
var idleTimer = null;
var timerInterval = null;
var sessionStartTime = null;
var isActive = false;
var lastActionTime = null;
var lastAction = null;
var resolvedFolder = null; // cached folder reference

// ─── UXP File System Helpers ──────────────────────────────────────
async function getFileSystem() {
  var uxp = require('uxp');
  var session = uxp.storage.session;
  return await session.requestFileSystem();
}

async function resolvePath(fileSystem, path) {
  var parts = path.split('/').filter(function(p) { return p.length > 0; });
  var current = fileSystem.root;
  for (var i = 0; i < parts.length; i++) {
    try {
      current = await current.getFolder(parts[i]);
    } catch (e) {
      current = await current.createFolder(parts[i]);
    }
  }
  return current;
}

async function resolveFilePath(fileSystem, filename) {
  try {
    return await resolvedFolder.getFile(filename);
  } catch (e) {
    return await resolvedFolder.createFile(filename);
  }
}

async function setupStorageFolder() {
  try {
    var fileSystem = await getFileSystem();
    resolvedFolder = await resolvePath(fileSystem, STORAGE_PATH);
    // Ensure metrics file exists
    try {
      await resolvedFolder.getFile(metricsFile);
    } catch (e) {
      var f = await resolvedFolder.createFile(metricsFile);
      await f.write(JSON.stringify({ entries: [] }), { format: 'text' });
    }
    return true;
  } catch (e) {
    console.error('Storage setup failed:', e.message);
    return false;
  }
}

async function readMetrics() {
  try {
    if (!resolvedFolder) return { entries: [] };
    var file = await resolvedFolder.getFile(metricsFile);
    var content = await file.read({ format: 'text' });
    return JSON.parse(content);
  } catch (e) {
    return { entries: [] };
  }
}

async function writeMetrics(metrics) {
  try {
    if (!resolvedFolder) return;
    var file = await resolveFilePath(resolvedFolder, metricsFile);
    await file.write(JSON.stringify(metrics, null, 2), { format: 'text' });
  } catch (e) {
    console.error('Write metrics failed:', e.message);
  }
}

async function saveToken(token) {
  try {
    if (!resolvedFolder) return;
    var file = await resolveFilePath(resolvedFolder, tokenFile);
    await file.write(token, { format: 'text' });
  } catch (e) {
    console.error('Save token failed:', e.message);
  }
}

async function restoreToken() {
  try {
    if (!resolvedFolder) return null;
    var file = await resolvedFolder.getFile(tokenFile);
    var content = await file.read({ format: 'text' });
    return content.trim();
  } catch (e) {
    return null;
  }
}

async function exportToCSV() {
  var metrics = await readMetrics();
  var csv = 'Date,Action,Duration (seconds)\n';
  metrics.entries.forEach(function(entry) {
    csv += '"' + entry.date + '",' + entry.action + ',' + entry.duration + '\n';
  });
  return csv;
}

// ─── Session Persistence ──────────────────────────────────────────
async function persistSessionData(seconds) {
  try {
    if (!resolvedFolder) return;
    var data = JSON.stringify({
      active: isActive,
      startTime: sessionStartTime,
      elapsed: seconds || 0,
      lastAction: lastAction
    });
    var file = await resolveFilePath(resolvedFolder, sessionFile);
    await file.write(data, { format: 'text' });
  } catch (e) {
    console.error('Persist session failed:', e.message);
  }
}

async function restoreSession() {
  try {
    if (!resolvedFolder) return false;
    var file = await resolvedFolder.getFile(sessionFile);
    var content = await file.read({ format: 'text' });
    var data = JSON.parse(content);
    isActive = data.active;
    sessionStartTime = data.startTime;
    lastActionTime = data.lastAction;
    lastAction = data.lastAction;
    return true;
  } catch (e) {
    return false;
  }
}

// ─── Tracking Engine ──────────────────────────────────────────────
function resetIdleTimer(now) {
  lastActionTime = now || Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  if (isActive) {
    idleTimer = setTimeout(function() {
      pauseTracking();
    }, settings.idleTimeout * 1000);
  }
}

function startTracking(action) {
  if (!SUPPORTED_ACTIONS.includes(action)) return;
  isActive = true;
  lastAction = action;
  if (!sessionStartTime) sessionStartTime = Date.now();
  resetIdleTimer();
  persistSessionData(getElapsed());
}

function pauseTracking() {
  if (!isActive) return;
  var duration = getElapsed();
  if (duration > 0) {
    addToMetrics(lastActionTime, duration, lastAction || 'unknown');
  }
  isActive = false;
  sessionStartTime = null;
  persistSessionData(0);
  updateTimerDisplay();
}

function getElapsed() {
  if (!sessionStartTime) return 0;
  return Math.floor((Date.now() - sessionStartTime) / 1000);
}

function formatTime(totalSeconds) {
  var h = Math.floor(totalSeconds / 3600);
  var m = Math.floor((totalSeconds % 3600) / 60);
  var s = totalSeconds % 60;
  return (h > 0 ? h + ':' : '') +
    String(m).padStart(h > 0 ? 2 : 1, '0') + ':' +
    String(s).padStart(2, '0');
}

function addToMetrics(date, duration, action) {
  readMetrics().then(function(metrics) {
    metrics.entries.push({
      date: new Date(date).toISOString(),
      duration: duration,
      action: action || 'unknown'
    });
    writeMetrics(metrics);
  });
}

// ─── Photoshop Notifications ──────────────────────────────────────
function startListening() {
  try {
    var app = require('photoshop').app;
    if (app && app.addEventListener) {
      app.addEventListener('notification', onPhotoshopEvent);
    }
  } catch (e) {
    console.warn('Could not attach Photoshop listener:', e.message);
  }
}

function stopListening() {
  try {
    var app = require('photoshop').app;
    if (app && app.removeEventListener) {
      app.removeEventListener('notification', onPhotoshopEvent);
    }
  } catch (e) {
    console.warn('Could not detach Photoshop listener:', e.message);
  }
}

function onPhotoshopEvent(notification) {
  if (!notification || !notification.commandId) return;
  var cmd = notification.commandId;
  if (SUPPORTED_ACTIONS.includes(cmd)) {
    startTracking(cmd);
    if (currentView === 'timer') {
      updateTimerDisplay();
    }
  }
}

// ─── UI Rendering ─────────────────────────────────────────────────
function render(view) {
  currentView = view || currentView;
  if (!rootEl) return;
  rootEl.innerHTML = '';
  switch (currentView) {
    case 'setup': renderSetupView(); break;
    case 'timer': renderMainView(); break;
    case 'dashboard': renderDashboardView(); break;
    case 'settings': renderSettingsView(); break;
  }
  registerNavigation();
}

function renderSetupView() {
  var header = document.createElement('div');
  header.innerHTML = '<h2>Setup</h2>';
  rootEl.appendChild(header);

  var status = document.createElement('p');
  status.id = 'statusText';
  status.textContent = 'Configure storage and start tracking.';
  rootEl.appendChild(status);

  var btnContainer = document.createElement('div');
  btnContainer.style.marginTop = '20px';

  var initBtn = createButton('Initialize Storage', 'initStorageBtn');
  btnContainer.appendChild(initBtn);

  var startBtn = createButton('Start Tracking', 'startBtn');
  btnContainer.appendChild(startBtn);

  rootEl.appendChild(btnContainer);

  registerClick('initStorageBtn', function() {
    setupStorageFolder().then(function(ok) {
      document.getElementById('statusText').textContent =
        ok ? 'Storage ready! Click Start Tracking.' : 'Storage setup failed: ' + (window._lastError || '');
      window._lastError = '';
    }).catch(function(e) {
      document.getElementById('statusText').textContent = 'Storage setup failed: ' + e.message;
      window._lastError = e.message;
    });
  });

  registerClick('startBtn', function() {
    currentView = 'timer';
    render();
    startListening();
    restoreSession().then(function(restored) {
      if (restored && isActive) {
        sessionStartTime = Date.now() - (getElapsed() * 1000);
        updateTimerDisplay();
      } else {
        sessionStartTime = null;
        updateTimerDisplay();
      }
    });
  });
}

function renderMainView() {
  var container = document.createElement('div');

  // Tabs
  var tabs = document.createElement('div');
  tabs.className = 'tabs';
  ['Timer', 'Dashboard', 'Settings'].forEach(function(tab) {
    var btn = document.createElement('button');
    btn.textContent = tab;
    btn.dataset.view = tab.toLowerCase();
    tabs.appendChild(btn);
  });
  container.appendChild(tabs);

  // Content area
  var content = document.createElement('div');
  content.id = 'mainContent';
  container.appendChild(content);

  rootEl.appendChild(container);
  renderTimerContent();
}

function renderTimerContent() {
  var content = document.getElementById('mainContent');
  if (!content) return;
  content.innerHTML = '';

  var elapsed = getElapsed();
  var timerDisplay = document.createElement('div');
  timerDisplay.id = 'timerDisplay';
  timerDisplay.style.fontSize = '48px';
  timerDisplay.style.textAlign = 'center';
  timerDisplay.style.padding = '30px 0';
  timerDisplay.textContent = formatTime(elapsed);
  content.appendChild(timerDisplay);

  var statusInfo = document.createElement('p');
  statusInfo.id = 'timerStatus';
  statusInfo.textContent = isActive ? 'Active' : 'Paused';
  content.appendChild(statusInfo);

  var controls = document.createElement('div');
  controls.style.marginTop = '20px';

  var pauseBtn = createButton(isActive ? 'Pause' : 'Resume', 'pauseBtn');
  controls.appendChild(pauseBtn);

  var stopBtn = createButton('Stop & Save', 'stopBtn');
  controls.appendChild(stopBtn);

  content.appendChild(controls);

  registerClick('pauseBtn', function() {
    if (isActive) {
      pauseTracking();
    } else {
      startTracking(lastAction || 'manual');
    }
    updateTimerDisplay();
  });

  registerClick('stopBtn', function() {
    pauseTracking();
    stopListening();
    currentView = 'setup';
    render();
  });

  // Start interval update
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(function() {
    if (isActive) {
      updateTimerDisplay();
      persistSessionData(getElapsed());
    }
  }, 1000);
}

function updateTimerDisplay() {
  var display = document.getElementById('timerDisplay');
  if (display) {
    display.textContent = formatTime(getElapsed());
  }
  var status = document.getElementById('timerStatus');
  if (status) {
    status.textContent = isActive ? 'Active' : 'Paused';
  }
}

function renderDashboardView() {
  var content = document.getElementById('mainContent');
  if (!content) return;
  content.innerHTML = '';

  var title = document.createElement('h3');
  title.textContent = 'Weekly Dashboard';
  content.appendChild(title);

  readMetrics().then(function(metrics) {
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var weeklyEntries = metrics.entries.filter(function(e) {
      return new Date(e.date).getTime() > weekAgo;
    });

    var totalSeconds = weeklyEntries.reduce(function(sum, e) {
      return sum + e.duration;
    }, 0);

    var summary = document.createElement('p');
    summary.textContent = 'This week: ' + formatTime(totalSeconds);
    content.appendChild(summary);

    // Per-action breakdown
    var actionCounts = {};
    weeklyEntries.forEach(function(e) {
      actionCounts[e.action] = (actionCounts[e.action] || 0) + e.duration;
    });

    var list = document.createElement('ul');
    list.style.listStyle = 'none';
    list.style.padding = '0';
    Object.keys(actionCounts).forEach(function(action) {
      var li = document.createElement('li');
      li.textContent = action + ': ' + formatTime(actionCounts[action]);
      list.appendChild(li);
    });
    content.appendChild(list);

    // Export button
    var exportBtn = createButton('Export CSV', 'exportCsvBtn');
    content.appendChild(exportBtn);

    registerClick('exportCsvBtn', function() {
      exportToCSV().then(function(csv) {
        var blob = new Blob([csv], { type: 'text/csv' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = '8ras-export.csv';
        a.click();
        URL.revokeObjectURL(url);
      });
    });
  });
}

function renderSettingsView() {
  var content = document.getElementById('mainContent');
  if (!content) return;
  content.innerHTML = '';

  var title = document.createElement('h3');
  title.textContent = 'Settings';
  content.appendChild(title);

  var form = document.createElement('form');

  var label = document.createElement('label');
  label.textContent = 'Idle timeout (seconds):';
  form.appendChild(label);

  var input = document.createElement('input');
  input.type = 'number';
  input.id = 'timeoutInput';
  input.value = settings.idleTimeout;
  input.min = '10';
  input.max = '3600';
  form.appendChild(input);

  var saveBtn = createButton('Save Settings', 'saveSettingsBtn');
  form.appendChild(saveBtn);

  content.appendChild(form);

  registerClick('saveSettingsBtn', function() {
    var val = parseInt(input.value, 10);
    if (val >= 10 && val <= 3600) {
      settings.idleTimeout = val;
      alert('Settings saved!');
    } else {
      alert('Please enter a value between 10 and 3600.');
    }
  });
}

function registerNavigation() {
  var tabs = rootEl.querySelector('.tabs');
  if (!tabs) return;
  var buttons = tabs.querySelectorAll('button[data-view]');
  buttons.forEach(function(btn) {
    registerClick(btn.dataset.view + 'Tab', function() {
      currentView = btn.dataset.view;
      if (timerInterval) clearInterval(timerInterval);
      timerInterval = null;
      render();
    });
  });
}

// ─── Event Delegation ─────────────────────────────────────────────
function createButton(text, id) {
  var btn = document.createElement('button');
  btn.textContent = text;
  btn.id = id;
  btn.style.display = 'block';
  btn.style.width = '100%';
  btn.style.marginBottom = '10px';
  btn.style.padding = '10px';
  btn.style.border = 'none';
  btn.style.borderRadius = '6px';
  btn.style.cursor = 'pointer';
  btn.style.background = '#89b4fa';
  btn.style.color = '#1e1e2e';
  btn.style.fontWeight = 'bold';
  return btn;
}

function registerClick(id, handler) {
  clickHandlers[id] = handler;
}

function dispatchClick(event) {
  var target = event.target;
  while (target && target !== rootEl) {
    if (clickHandlers[target.id]) {
      clickHandlers[target.id](event);
      return;
    }
    target = target.parentNode;
  }
}

// ─── Initialization ───────────────────────────────────────────────
async function init() {
  rootEl = document.body;
  rootEl.addEventListener('click', dispatchClick.bind(rootEl));

  // Catppuccin Mocha theme styles
  var style = document.createElement('style');
  style.textContent =
    'body{font-family:sans-serif;background:#1e1e2e;color:#cdd6f4;padding:16px;margin:0}' +
    'button:hover{opacity:0.85}' +
    'button:active{transform:scale(0.98)}' +
    '.tabs{display:flex;gap:4px;margin-bottom:16px}' +
    '.tabs button{flex:1;padding:8px;border:none;border-radius:4px;' +
    'background:#45475a;color:#cdd6f4;cursor:pointer;font-size:13px}' +
    '.tabs button:hover{background:#585b70}' +
    'ul{padding-left:0}' +
    'li{padding:4px 0;border-bottom:1px solid #45475a}';
  document.head.appendChild(style);

  await setupStorageFolder();
  render('setup');
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
