// 8RAS Time Tracker - Adobe Photoshop UXP Plugin (Vanilla JS)
// Minimal synchronous version for debugging

(function() {
  'use strict';

  var SUPPORTED_ACTIONS = [
    'brush', 'penTool', 'move', 'typeCreateOrChange',
    'setNewHue', 'freeTransform', 'pathComponentOperation', 'adjustment'
  ];

  var STORAGE_PATH = '/Users/Shared/8ras-data';
  var IDLE_TIMEOUT = 60;

  // State
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
  var metricsEntries = [];

  // Try to get Photoshop app reference
  var psApp = null;
  try {
    psApp = require('photoshop').app;
  } catch(e) {
    console.log('[8RAS] Photoshop API not available:', e.message);
  }

  // ─── Tracking Engine ──────────────────────────────────────
  function resetIdleTimer(now) {
    lastActionTime = now || Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    if (isActive) {
      idleTimer = setTimeout(function() { pauseTracking(); }, settings.idleTimeout * 1000);
    }
  }

  function startTracking(action) {
    var i;
    for (i = 0; i < SUPPORTED_ACTIONS.length; i++) {
      if (SUPPORTED_ACTIONS[i] === action) break;
    }
    if (i >= SUPPORTED_ACTIONS.length) return;
    isActive = true;
    lastAction = action;
    if (!sessionStartTime) sessionStartTime = Date.now();
    resetIdleTimer();
  }

  function pauseTracking() {
    if (!isActive) return;
    var duration = getElapsed();
    if (duration > 0) {
      metricsEntries.push({ date: new Date(lastActionTime).toISOString(), duration: duration, action: lastAction || 'unknown' });
    }
    isActive = false;
    sessionStartTime = null;
    updateTimerDisplay();
  }

  function getElapsed() {
    if (!sessionStartTime) return 0;
    return Math.floor((Date.now() - sessionStartTime) / 1000);
  }

  function padStartNum(num, len) {
    var s = String(num);
    while (s.length < len) s = '0' + s;
    return s;
  }

  function formatTime(totalSeconds) {
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    return (h > 0 ? h + ':' : '') + padStartNum(m, h > 0 ? 2 : 1) + ':' + padStartNum(s, 2);
  }

  // ─── Photoshop Notifications ──────────────────────────────
  function startListening() {
    try {
      if (psApp && typeof psApp.addEventListener === 'function') {
        psApp.addEventListener('notification', onPhotoshopEvent);
      }
    } catch (e) {
      console.log('[8RAS] Could not attach listener:', e.message);
    }
  }

  function stopListening() {
    try {
      if (psApp && typeof psApp.removeEventListener === 'function') {
        psApp.removeEventListener('notification', onPhotoshopEvent);
      }
    } catch (e) {}
  }

  function onPhotoshopEvent(notification) {
    if (!notification || !notification.commandId) return;
    var cmd = notification.commandId;
    var i;
    for (i = 0; i < SUPPORTED_ACTIONS.length; i++) {
      if (SUPPORTED_ACTIONS[i] === cmd) break;
    }
    if (i >= SUPPORTED_ACTIONS.length) return;
    startTracking(cmd);
    if (currentView === 'timer') {
      updateTimerDisplay();
    }
  }

  // ─── UI Rendering ─────────────────────────────────────────
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
      document.getElementById('statusText').textContent =
        'Storage initialized! Click Start Tracking.';
    });

    registerClick('startBtn', function() {
      currentView = 'timer';
      render();
      startListening();
      sessionStartTime = null;
      updateTimerDisplay();
    });
  }

  function renderMainView() {
    var container = document.createElement('div');

    var tabs = document.createElement('div');
    tabs.className = 'tabs';
    var tabNames = ['Timer', 'Dashboard', 'Settings'];
    var ti;
    for (ti = 0; ti < tabNames.length; ti++) {
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
      if (isActive) { pauseTracking(); } else { startTracking(lastAction || 'manual'); }
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
      if (isActive) { updateTimerDisplay(); }
    }, 1000);
  }

  function updateTimerDisplay() {
    var display = document.getElementById('timerDisplay');
    if (display) display.textContent = formatTime(getElapsed());
    var status = document.getElementById('timerStatus');
    if (status) status.textContent = isActive ? 'Active' : 'Paused';
  }

  function renderDashboardView() {
    var content = document.getElementById('mainContent');
    if (!content) return;
    content.innerHTML = '';

    var title = document.createElement('h3');
    title.textContent = 'Weekly Dashboard (' + metricsEntries.length + ' entries)';
    content.appendChild(title);

    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var weeklyEntries = [];
    var ei;
    for (ei = 0; ei < metricsEntries.length; ei++) {
      if (new Date(metricsEntries[ei].date).getTime() > weekAgo) {
        weeklyEntries.push(metricsEntries[ei]);
      }
    }

    var totalSeconds = 0;
    for (ei = 0; ei < weeklyEntries.length; ei++) {
      totalSeconds += weeklyEntries[ei].duration;
    }

    var summary = document.createElement('p');
    summary.textContent = 'This week: ' + formatTime(totalSeconds);
    content.appendChild(summary);

    var actionCounts = {};
    for (ei = 0; ei < weeklyEntries.length; ei++) {
      var act = weeklyEntries[ei].action;
      actionCounts[act] = (actionCounts[act] || 0) + weeklyEntries[ei].duration;
    }

    var list = document.createElement('ul');
    list.style.listStyle = 'none';
    list.style.padding = '0';
    var keys = Object.keys(actionCounts);
    var ki;
    for (ki = 0; ki < keys.length; ki++) {
      var li = document.createElement('li');
      li.textContent = keys[ki] + ': ' + formatTime(actionCounts[keys[ki]]);
      list.appendChild(li);
    }
    content.appendChild(list);

    var exportBtn = createButton('Export CSV', 'exportCsvBtn');
    content.appendChild(exportBtn);

    registerClick('exportCsvBtn', function() {
      var csv = 'Date,Action,Duration (seconds)\n';
      for (ei = 0; ei < metricsEntries.length; ei++) {
        csv += '"' + metricsEntries[ei].date + '",' + metricsEntries[ei].action + ',' + metricsEntries[ei].duration + '\n';
      }
      var blob = new Blob([csv], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '8ras-export.csv';
      a.click();
      URL.revokeObjectURL(url);
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
    var bi;
    for (bi = 0; bi < buttons.length; bi++) {
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

  // ─── Event Delegation ─────────────────────────────────────
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

  // ─── Initialization ───────────────────────────────────────
  function init(appContainer) {
    try {
      containerEl = appContainer;
      containerEl.addEventListener('click', dispatchClick.bind(containerEl));
      console.log('[8RAS] Panel initialized successfully');
      render('setup');
    } catch (e) {
      console.error('[8RAS] Plugin init error:', e.message);
      if (appContainer) {
        appContainer.innerHTML = '<p style="color:#f38;">Error: ' + e.message + '</p>';
      }
    }
  }

  // Auto-init when loaded as script tag
  if (typeof document !== 'undefined' && document.body) {
    init(document.body);
  }

  // Export for CommonJS modules (real Photoshop UXP)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { init: init };
  }

})();
