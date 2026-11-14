/* 8RAS Time Tracker — Adobe Photoshop UXP Plugin (Vanilla JS) */

// ─── Configuration ────────────────────────────────────────────────
var STORAGE_PATH = '/Users/Shared/8ras-data'; // Edit before loading in PS
var IDLE_TIMEOUT = 60; // seconds of inactivity before pause
var SUPPORTED_ACTIONS = [
  'brush', 'penTool', 'move', 'typeCreateOrChange',
  'setNewHue', 'freeTransform', 'pathComponentOperation', 'adjustment'
];

// ─── State ────────────────────────────────────────────────────────
var metricsFile = 'metrics.json';
var tokenFile = 'token.txt';
var sessionFile = 'session.json';
var currentView = 'setup';
var settings = { idleTimeout: IDLE_TIMEOUT };
var clickHandlers = {};
var containerEl = null;
var idleTimer = null;
var timerInterval = null;
var sessionStartTime = null;
var isActive = false;
var lastActionTime = null;
var lastAction = null;
var resolvedFolder = null;
var _uxpAvailable = false;
var psApp = null;

// Try to get Photoshop app reference (may fail in UDT)
try { psApp = require('photoshop').app; } catch(e) { psApp = null; }

// ─── UXP File System Helpers ──────────────────────────────────────
// All file operations wrapped in try/catch — never throw to caller

function padStart(str, len, ch) {
  str = String(str);
  while (str.length < len) str = ch + str;
  return str;
}

function padStartNum(num, len) {
  return padStart(String(num), len, '0');
}

function arrayIncludes(arr, val) {
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] === val) return true;
  }
  return false;
}

function getFileSystem() {
  var uxp = require('uxp');
  var session = uxp.storage.session;
  return session.requestFileSystem();
}

function resolvePath(fileSystem, path) {
  var parts = path.split('/');
  var filtered = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length > 0) filtered.push(parts[i]);
  }
  var current = fileSystem.root;
  for (var i = 0; i < filtered.length; i++) {
    (function(idx) {
      current.getFolder(filtered[idx]).then(function(folder) {
        current = folder;
      }).catch(function() {
        current.createFolder(filtered[idx]).then(function(folder) {
          current = folder;
        });
      });
    })(i);
  }
  // Return a promise-based result
  return new Promise(function(resolve, reject) {
    (function recurse(idx, callback) {
      if (idx >= filtered.length) {
        callback(null, current);
        return;
      }
      current.getFolder(filtered[idx]).then(function(folder) {
        current = folder;
        recurse(idx + 1, callback);
      }).catch(function() {
        current.createFolder(filtered[idx]).then(function(folder) {
          current = folder;
          recurse(idx + 1, callback);
        });
      });
    })(0, function(err, folder) {
      if (err) reject(err);
      else resolve(folder);
    });
  });
}

function resolveFilePath(filename) {
  return resolvedFolder.getFile(filename).catch(function() {
    return resolvedFolder.createFile(filename);
  });
}

function setupStorageFolder() {
  return getFileSystem().then(function(fileSystem) {
    return resolvePath(fileSystem, STORAGE_PATH).then(function(folder) {
      resolvedFolder = folder;
      return folder.getFile(metricsFile).catch(function() {
        return folder.createFile(metricsFile).then(function(f) {
          return f.write(JSON.stringify({ entries: [] }), { format: 'text' });
        });
      }).then(function() {
        _uxpAvailable = true;
        return true;
      });
    });
  }).catch(function(e) {
    console.warn('Storage setup failed:', e.message);
    return false;
  });
}

function trySetupStorageSilently() {
  getFileSystem().then(function(fileSystem) {
    return resolvePath(fileSystem, STORAGE_PATH).then(function(folder) {
      resolvedFolder = folder;
      return folder.getFile(metricsFile).catch(function() {
        return folder.createFile(metricsFile).then(function(f) {
          return f.write(JSON.stringify({ entries: [] }), { format: 'text' });
        });
      }).then(function() {
        _uxpAvailable = true;
      });
    }).catch(function() {});
  }).catch(function() {});
}

function readMetrics() {
  if (!_uxpAvailable || !resolvedFolder) {
    return Promise.resolve({ entries: [] });
  }
  return resolvedFolder.getFile(metricsFile).then(function(file) {
    return file.read({ format: 'text' });
  }).then(function(content) {
    return JSON.parse(content);
  }).catch(function() {
    return { entries: [] };
  });
}

function writeMetrics(metrics) {
  if (!_uxpAvailable || !resolvedFolder) return Promise.resolve();
  return resolveFilePath(metricsFile).then(function(file) {
    return file.write(JSON.stringify(metrics, null, 2), { format: 'text' });
  }).catch(function() {
    return Promise.resolve();
  });
}

function saveToken(token) {
  if (!_uxpAvailable || !resolvedFolder) return Promise.resolve();
  return resolveFilePath(tokenFile).then(function(file) {
    return file.write(token, { format: 'text' });
  }).catch(function() {
    return Promise.resolve();
  });
}

function restoreToken() {
  if (!_uxpAvailable || !resolvedFolder) return Promise.resolve(null);
  return resolvedFolder.getFile(tokenFile).then(function(file) {
    return file.read({ format: 'text' });
  }).then(function(content) {
    return content.trim();
  }).catch(function() {
    return Promise.resolve(null);
  });
}

function exportToCSV() {
  return readMetrics().then(function(metrics) {
    var csv = 'Date,Action,Duration (seconds)\n';
    for (var i = 0; i < metrics.entries.length; i++) {
      csv += '"' + metrics.entries[i].date + '",' + metrics.entries[i].action + ',' + metrics.entries[i].duration + '\n';
    }
    return csv;
  });
}

// ─── Session Persistence ──────────────────────────────────────────
function persistSessionData(seconds) {
  if (!_uxpAvailable || !resolvedFolder) return Promise.resolve();
  var data = JSON.stringify({
    active: isActive,
    startTime: sessionStartTime,
    elapsed: seconds || 0,
    lastAction: lastAction
  });
  return resolveFilePath(sessionFile).then(function(file) {
    return file.write(data, { format: 'text' });
  }).catch(function() {
    return Promise.resolve();
  });
}

function restoreSession() {
  if (!_uxpAvailable || !resolvedFolder) return Promise.resolve(false);
  return resolvedFolder.getSession ? Promise.resolve(false) : Promise.resolve(false);
  return resolvedFolder.getFile(sessionFile).then(function(file) {
    return file.read({ format: 'text' });
  }).then(function(content) {
    var data = JSON.parse(content);
    isActive = data.active;
    sessionStartTime = data.startTime;
    lastActionTime = data.lastAction;
    lastAction = data.lastAction;
    return true;
  }).catch(function() {
    return false;
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
  if (!arrayIncludes(SUPPORTED_ACTIONS, action)) return;
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
  return (h > 0 ? h + ':' : '') + padStartNum(m, h > 0 ? 2 : 1) + ':' + padStartNum(s, 2);
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
    if (psApp && typeof psApp.addEventListener === 'function') {
      psApp.addEventListener('notification', onPhotoshopEvent);
    }
  } catch (e) {
    // Silently fail
  }
}

function stopListening() {
  try {
    if (psApp && typeof psApp.removeEventListener === 'function') {
      psApp.removeEventListener('notification', onPhotoshopEvent);
    }
  } catch (e) {
    // Silently fail
  }
}

function onPhotoshopEvent(notification) {
  if (!notification || !notification.commandId) return;
  var cmd = notification.commandId;
  if (arrayIncludes(SUPPORTED_ACTIONS, cmd)) {
    startTracking(cmd);
    if (currentView === 'timer') {
      updateTimerDisplay();
    }
  }
}

// ─── UI Rendering ─────────────────────────────────────────────────
var CSS_STYLES =
  'body{font-family:sans-serif;background:#1e1e2e;color:#cdd6f4;padding:16px;margin:0}' +
  'button:hover{opacity:0.85}' +
  'button:active{transform:scale(0.98)}' +
  '.tabs{display:flex;gap:4px;margin-bottom:16px}' +
  '.tabs button{flex:1;padding:8px;border:none;border-radius:4px;' +
  'background:#45475a;color:#cdd6f4;cursor:pointer;font-size:13px}' +
  '.tabs button:hover{background:#585b70}' +
  'ul{padding-left:0}' +
  'li{padding:4px 0;border-bottom:1px solid #45475a}';

function render(view) {
  currentView = view || currentView;
  if (!containerEl) return;
  containerEl.innerHTML = '';
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
  containerEl.appendChild(header);

  var status = document.createElement('p');
  status.id = 'statusText';
  status.textContent = 'Configure storage and start tracking.';
  containerEl.appendChild(status);

  var btnContainer = document.createElement('div');
  btnContainer.style.marginTop = '20px';

  var initBtn = createButton('Initialize Storage', 'initStorageBtn');
  btnContainer.appendChild(initBtn);

  var startBtn = createButton('Start Tracking', 'startBtn');
  btnContainer.appendChild(startBtn);

  containerEl.appendChild(btnContainer);

  registerClick('initStorageBtn', function() {
    setupStorageFolder().then(function(ok) {
      document.getElementById('statusText').textContent =
        ok ? 'Storage ready! Click Start Tracking.' : 'Storage setup failed.';
    }).catch(function(e) {
      document.getElementById('statusText').textContent = 'Storage error: ' + e.message;
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

  var tabs = document.createElement('div');
  tabs.className = 'tabs';
  var tabNames = ['Timer', 'Dashboard', 'Settings'];
  for (var ti = 0; ti < tabNames.length; ti++) {
    (function(tabName) {
      var btn = document.createElement('button');
      btn.textContent = tabName;
      btn.dataset.view = tabName.toLowerCase();
      tabs.appendChild(btn);
    })(tabNames[ti]);
  }
  container.appendChild(tabs);

  var content = document.createElement('div');
  content.id = 'mainContent';
  container.appendChild(content);

  containerEl.appendChild(container);
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
    var weeklyEntries = [];
    for (var i = 0; i < metrics.entries.length; i++) {
      if (new Date(metrics.entries[i].date).getTime() > weekAgo) {
        weeklyEntries.push(metrics.entries[i]);
      }
    }

    var totalSeconds = 0;
    for (var i = 0; i < weeklyEntries.length; i++) {
      totalSeconds += weeklyEntries[i].duration;
    }

    var summary = document.createElement('p');
    summary.textContent = 'This week: ' + formatTime(totalSeconds);
    content.appendChild(summary);

    var actionCounts = {};
    for (var i = 0; i < weeklyEntries.length; i++) {
      var act = weeklyEntries[i].action;
      actionCounts[act] = (actionCounts[act] || 0) + weeklyEntries[i].duration;
    }

    var list = document.createElement('ul');
    list.style.listStyle = 'none';
    list.style.padding = '0';
    var keys = Object.keys(actionCounts);
    for (var ki = 0; ki < keys.length; ki++) {
      var li = document.createElement('li');
      li.textContent = keys[ki] + ': ' + formatTime(actionCounts[keys[ki]]);
      list.appendChild(li);
    }
    content.appendChild(list);

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
  var tabs = containerEl.querySelector('.tabs');
  if (!tabs) return;
  var buttons = tabs.querySelectorAll('button[data-view]');
  for (var bi = 0; bi < buttons.length; bi++) {
    (function(btn) {
      registerClick(btn.dataset.view + 'Tab', function() {
        currentView = btn.dataset.view;
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = null;
        render();
      });
    })(buttons[bi]);
  }
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
  while (target && target !== containerEl) {
    if (clickHandlers[target.id]) {
      clickHandlers[target.id](event);
      return;
    }
    target = target.parentNode;
  }
}

// ─── Initialization ───────────────────────────────────────────────
function init(appContainer) {
  try {
    containerEl = appContainer;
    containerEl.addEventListener('click', dispatchClick.bind(containerEl));

    var styleTag = document.createElement('style');
    styleTag.textContent = CSS_STYLES;
    document.head.appendChild(styleTag);

    trySetupStorageSilently();

    render('setup');
  } catch (e) {
    console.error('Plugin init error:', e.message);
    if (appContainer) {
      appContainer.innerHTML = '<p style="color:#f38;">Error: ' + e.message + '</p>';
    }
  }
}

// Auto-init when loaded as script tag (for UDT testing)
if (typeof document !== 'undefined' && document.body) {
  init(document.body);
}

// Export for CommonJS modules (real Photoshop UXP)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { init: init };
}
