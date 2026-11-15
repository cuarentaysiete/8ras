/* 8RAS Time Tracker — Pure Vanilla JS for Adobe Photoshop UXP */

// ─── Configuration ────────────────────────────────────────────────
var STORAGE_PATH = '/Users/Shared/8ras-data'; // Edit this before loading in PS
var IDLE_TIMEOUT = 60; // seconds of inactivity before pause
var SUPPORTED_ACTIONS = [
  'brush', 'penTool', 'move', 'typeCreateOrChange',
  'setNewHue', 'freeTransform', 'pathComponentOperation', 'adjustment'
];

// ─── State ────────────────────────────────────────────────────────
var metricsFile = STORAGE_PATH + '/metrics.json';
var tokenFile = STORAGE_PATH + '/token.txt';
var sessionFile = STORAGE_PATH + '/session.json';
var currentView = 'setup'; // setup | timer | dashboard | settings
var settings = { idleTimeout: IDLE_TIMEOUT };
var clickHandlers = {};
var rootEl = null;
var idleTimer = null;
var timerInterval = null;
var sessionStartTime = null;
var isActive = false;
var lastActionTime = null;

// ─── File System Helpers (UXP Storage API) ────────────────────────
var _uxpAvailable = false;
var _resolvedFolder = null;

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

async function setupStorageFolder() {
  try {
    var fileSystem = await getFileSystem();
    _resolvedFolder = await resolvePath(fileSystem, STORAGE_PATH);
    try {
      await _resolvedFolder.getFile(metricsFile);
    } catch (e) {
      var f = await _resolvedFolder.createFile(metricsFile);
      await f.write(JSON.stringify({ entries: [] }), { format: 'text' });
    }
    _uxpAvailable = true;
    return true;
  } catch (e) {
    console.warn('Storage setup failed (may be UDT):', e.message);
    return false;
  }
}

function readMetrics() {
  if (!_uxpAvailable || !_resolvedFolder) {
    return Promise.resolve({ entries: [] });
  }
  return _resolvedFolder.getFile(metricsFile).then(function(file) {
    return file.read({ format: 'text' }).then(function(content) {
      return JSON.parse(content);
    });
  }).catch(function() {
    return { entries: [] };
  });
}

function writeMetrics(metrics) {
  if (!_uxpAvailable || !_resolvedFolder) return Promise.resolve();
  return _resolvedFolder.createFile ? _resolvedFolder.createFile(metricsFile).then(function(file) {
    return file.write(JSON.stringify(metrics, null, 2), { format: 'text' });
  }).catch(function() { return Promise.resolve(); }) : Promise.resolve();
}

function saveToken(token) {
  if (!_uxpAvailable || !_resolvedFolder) return Promise.resolve();
  return _resolvedFolder.createFile ? _resolvedFolder.createFile(tokenFile).then(function(file) {
    return file.write(token, { format: 'text' });
  }).catch(function() { return Promise.resolve(); }) : Promise.resolve();
}

function restoreToken() {
  if (!_uxpAvailable || !_resolvedFolder) return Promise.resolve(null);
  return _resolvedFolder.getFile(tokenFile).then(function(file) {
    return file.read({ format: 'text' }).then(function(content) {
      return content.trim();
    });
  }).catch(function() {
    return Promise.resolve(null);
  });
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
  if (!_uxpAvailable || !_resolvedFolder) return Promise.resolve();
  var data = JSON.stringify({
    active: isActive,
    startTime: sessionStartTime,
    elapsed: seconds || 0,
    lastAction: lastActionTime
  });
  return _resolvedFolder.createFile ? _resolvedFolder.createFile(sessionFile).then(function(file) {
    return file.write(data, { format: 'text' });
  }).catch(function() { return Promise.resolve(); }) : Promise.resolve();
}

async function restoreSession() {
  if (!_uxpAvailable || !_resolvedFolder) return Promise.resolve(false);
  return _resolvedFolder.getFile(sessionFile).then(function(file) {
    return file.read({ format: 'text' }).then(function(content) {
      var data = JSON.parse(content);
      isActive = data.active;
      sessionStartTime = data.startTime;
      lastActionTime = data.lastAction;
      return true;
    });
  }).catch(function() {
    return Promise.resolve(false);
  });
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
  if (!sessionStartTime) sessionStartTime = Date.now();
  resetIdleTimer();
  persistSessionData(getElapsed());
}

function pauseTracking() {
  if (!isActive) return;
  var duration = getElapsed();
  if (duration > 0) {
    addToMetrics(lastActionTime, duration);
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

  var folderBtn = createButton('Select Folder', 'selectFolderBtn');
  btnContainer.appendChild(folderBtn);

  var startBtn = createButton('Start Tracking', 'startBtn');
  btnContainer.appendChild(startBtn);

  rootEl.appendChild(btnContainer);

  registerClick('selectFolderBtn', function() {
    setupStorageFolder().then(function(ok) {
      document.getElementById('statusText').textContent =
        ok ? 'Storage ready!' : 'Storage setup failed.';
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
function init() {
  try {
    rootEl = document.body;
    if (!rootEl) return;
    rootEl.addEventListener('click', dispatchClick.bind(rootEl));

    // Apply Catppuccin Mocha theme styles
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

    // Fire-and-forget storage (never blocks UI)
    setupStorageFolder().then(function(ok) {
      console.log('[8RAS] Storage initialized:', ok);
    }).catch(function(e) {
      console.warn('[8RAS] Storage unavailable (UDT mode):', e.message);
    });

    render('setup');
  } catch (e) {
    console.error('[8RAS] CRITICAL ERROR in init():', e.message);
    if (rootEl) {
      rootEl.innerHTML = '<p style="color:#f38;">Error: ' + e.message + '</p>';
    }
  }
}

// Boot
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
