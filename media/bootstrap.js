/* VSCode Wallpaper Engine - injected workbench bootstrap (fixed build) */
(function () {
  'use strict';

  var scriptEl = document.currentScript;
  var PORT = 23333;
  var INJECTED_PORT = 23333;
  try {
    var src = scriptEl && scriptEl.src ? scriptEl.src : '';
    var m = /[?&]port=(\d+)/.exec(src);
    if (m) { PORT = parseInt(m[1], 10) || 23333; INJECTED_PORT = PORT; }
  } catch (e) {}
  var BASE = 'http://127.0.0.1:' + PORT;

  // 同一个 VS Code 安装里的多个窗口会各起一个本地服务，注入文件里的端口
  // 可能已经被另一个窗口改写。这里用 renderer 的 logsPath 作为窗口指纹，
  // 只连接属于自己的那个扩展实例，避免显示到别的窗口的壁纸。
  function currentWindowKey() {
    try {
      var cfg = window.vscode && window.vscode.context && window.vscode.context.configuration
        ? window.vscode.context.configuration() : null;
      var raw = String((cfg && cfg.logsPath) || '').replace(/\\/g, '/');
      var parts = raw.split('/').filter(Boolean);
      var ts = parts.length ? parts[parts.length - 1] : '';
      var win = cfg && cfg.windowId !== undefined && cfg.windowId !== null ? cfg.windowId : '';
      return (ts + '#' + win).toLowerCase();
    } catch (e) { return ''; }
  }
  var WINDOW_KEY = currentWindowKey();

  function probePort(port) {
    var q = WINDOW_KEY ? '?window=' + encodeURIComponent(WINDOW_KEY) : '';
    return fetch('http://127.0.0.1:' + port + '/ping' + q, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return null;
        return r.text().then(function (text) {
          var info = null;
          try { info = JSON.parse(text); } catch (e) {}
          if (!info) info = { ok: true, legacy: true, window: false };
          info.port = port;
          return info;
        });
      })
      .catch(function () { return null; });
  }

  function resolveServerPort() {
    var candidates = [];
    function add(p) { p = Number(p); if (p >= 1 && p <= 65535 && candidates.indexOf(p) < 0) candidates.push(p); }
    add(PORT);
    for (var p = 23333; p <= 23370; p++) add(p);
    return Promise.all(candidates.map(function (port) {
      return probePort(port).then(function (info) { return info ? { port: port, info: info } : null; });
    })).then(function (list) {
      var alive = list.filter(Boolean);
      if (!alive.length) return false;
      var own = alive.filter(function (x) { return x.info && x.info.window === true; })[0];
      var preferred = alive.filter(function (x) { return x.port === INJECTED_PORT; })[0];
      var pick = own || preferred || alive[0];
      PORT = pick.port;
      BASE = 'http://127.0.0.1:' + PORT;
      return true;
    });
  }

  var reconnecting = false;
  function reconnectServer(reason) {
    if (reconnecting) return;
    reconnecting = true;
    log('reconnecting server', reason || '');
    resolveServerPort().then(function (ok) {
      reconnecting = false;
      if (!ok) { setTimeout(function () { reconnectServer('retry'); }, 2000); return; }
      state.connected = false;
      refresh(true);
      connectEvents();
    }).catch(function () { reconnecting = false; });
  }

  var state = { meta: null, mediaEl: null, videoEl: null, root: null, media: null, lastWallpaperId: null, lastCustomJs: '', scene: null, sceneTimer: null, sceneRetry: null, sceneFailures: 0, lastSizeReport: 0, resizeTimer: null };
  var STYLE_BASE_ID = 'vswe-base-style';
  var STYLE_THEME_ID = 'vswe-theme-style';
  var STYLE_CUSTOM_ID = 'vswe-custom-style';

  function log() {
    try { console.log.apply(console, ['[VSWE]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
  }

  function clamp(v, min, max) { v = Number(v); if (!isFinite(v)) return min; return Math.max(min, Math.min(max, v)); }

  function parseHex(hex, fallback) {
    var h = String(hex || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(h)) return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    if (/^#[0-9a-f]{3}$/i.test(h)) return [parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), parseInt(h[3] + h[3], 16)];
    return fallback;
  }

  function themeIsLight() {
    var body = document.body;
    if (!body) return false;
    if (body.classList.contains('vs-light') || body.classList.contains('hc-light')) return true;
    if (body.classList.contains('vs-dark') || body.classList.contains('hc-black')) return false;
    var bg = getComputedStyle(document.body).backgroundColor || '';
    var mm = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
    if (mm) {
      var lum = 0.299 * Number(mm[1]) + 0.587 * Number(mm[2]) + 0.114 * Number(mm[3]);
      return lum > 140;
    }
    return false;
  }

  function baseColor(settings) {
    var custom = parseHex(settings.transparencyBaseColor, null);
    if (custom) return custom;
    return themeIsLight() ? [255, 255, 255] : [0, 0, 0];
  }

  function buildThemeCss(meta) {
    var s = meta.settings || {};
    var rules = s.transparencyRules || {};
    var base = baseColor(s);
    var enabled = s.transparencyEnabled !== false;
    function A(key) { return enabled ? clamp(rules[key] === undefined ? 0 : rules[key], 0, 1) : 1; }
    function C(key) { var a = A(key); return 'rgba(' + base[0] + ',' + base[1] + ',' + base[2] + ',' + a + ')'; }

    var editor = A('editor.background');
    var tabs = A('editorGroupHeader.tabsBackground');
    var side = A('sideBar.background');
    var panel = A('panel.background');
    var term = A('terminal.background');
    var act = A('activityBar.background');
    var title = A('titleBar.activeBackground');
    var status = A('statusBar.background');
    var empty = A('editorGroup.emptyBackground');

    var lines = [];
    lines.push('html, body { background: transparent !important; }');
    lines.push('.monaco-workbench { background: transparent !important; position: relative; z-index: 1; }');
    lines.push('.monaco-workbench {');
    lines.push('  --vscode-editor-background: ' + C('editor.background') + ' !important;');
    lines.push('  --vscode-editorGroup-background: ' + C('editor.background') + ' !important;');
    lines.push('  --vscode-editorPane-background: ' + C('editor.background') + ' !important;');
    lines.push('  --vscode-editorGroup-emptyBackground: ' + C('editorGroup.emptyBackground') + ' !important;');
    lines.push('  --vscode-editorGroupHeader-tabsBackground: ' + C('editorGroupHeader.tabsBackground') + ' !important;');
    lines.push('  --vscode-tab-activeBackground: ' + C('editorGroupHeader.tabsBackground') + ' !important;');
    lines.push('  --vscode-tab-inactiveBackground: ' + C('editorGroupHeader.tabsBackground') + ' !important;');
    lines.push('  --vscode-tab-unfocusedActiveBackground: ' + C('editorGroupHeader.tabsBackground') + ' !important;');
    lines.push('  --vscode-tab-unfocusedInactiveBackground: ' + C('editorGroupHeader.tabsBackground') + ' !important;');
    lines.push('  --vscode-sideBar-background: ' + C('sideBar.background') + ' !important;');
    lines.push('  --vscode-panel-background: ' + C('panel.background') + ' !important;');
    lines.push('  --vscode-terminal-background: ' + C('terminal.background') + ' !important;');
    lines.push('  --vscode-activityBar-background: ' + C('activityBar.background') + ' !important;');
    lines.push('  --vscode-titleBar-activeBackground: ' + C('titleBar.activeBackground') + ' !important;');
    lines.push('  --vscode-titleBar-inactiveBackground: ' + C('titleBar.activeBackground') + ' !important;');
    lines.push('  --vscode-statusBar-background: ' + C('statusBar.background') + ' !important;');
    lines.push('  --vscode-statusBar-noFolderBackground: ' + C('statusBar.background') + ' !important;');
    lines.push('  --vscode-statusBar-debuggingBackground: ' + C('statusBar.background') + ' !important;');
    lines.push('  --vscode-modernUI-shellBackground: ' + C('editor.background') + ' !important;');
    lines.push('  --modern-ui-shell-background: ' + C('editor.background') + ' !important;');
    lines.push('  --vscode-modernUI-inactiveShellBackground: ' + C('editor.background') + ' !important;');
    lines.push('}');
    lines.push('.monaco-workbench .part.titlebar, .monaco-workbench .part.titlebar > .titlebar-container { background-color: ' + C('titleBar.activeBackground') + ' !important; }');
    lines.push('.monaco-workbench .part.statusbar { background-color: ' + C('statusBar.background') + ' !important; }');
    lines.push('.monaco-workbench .part.activitybar { background-color: ' + C('activityBar.background') + ' !important; }');
    lines.push('.monaco-workbench .part.editor > .content, .monaco-workbench .editor-container, .monaco-workbench .editor-group-container { background-color: ' + C('editor.background') + ' !important; }');
    lines.push('.monaco-workbench .part.sidebar > .content, .monaco-workbench .part.panel > .content { background-color: transparent !important; }');
    if (editor === 0 && side === 0 && panel === 0) {
      lines.push('.monaco-grid-view { background-color: transparent !important; }');
    }
    return lines.join('\n');
  }

  function ensureStyle(id) {
    var el = document.getElementById(id);
    if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
    return el;
  }

  function applySettings(meta) {
    if (!meta) return;
    state.meta = meta;
    var s = meta.settings || {};
    ensureStyle(STYLE_THEME_ID).textContent = buildThemeCss(meta);
    if (state.root) state.root.style.setProperty('--vswe-opacity', String(clamp(s.backgroundOpacity, 0, 1)));
    ensureStyle(STYLE_CUSTOM_ID).textContent = s.customCss || '';
    if (state.videoEl && s.pauseOnBlur) {
      if (document.hidden || !document.hasFocus()) { try { state.videoEl.pause(); } catch (e) {} }
      else { try { state.videoEl.play().catch(function () {}); } catch (e) {} }
    }
  }

  function clearMedia() {
    stopSceneFrames();
    if (state.sceneRetry) { clearTimeout(state.sceneRetry); state.sceneRetry = null; }
    if (state.mediaEl && state.mediaEl.parentNode) state.mediaEl.parentNode.removeChild(state.mediaEl);
    state.mediaEl = null;
    state.videoEl = null;
    if (state.media) { while (state.media.firstChild) state.media.removeChild(state.media.firstChild); }
  }

  function stopSceneFrames() {
    if (state.scene) state.scene.stopped = true;
    state.scene = null;
    if (state.sceneTimer) { clearTimeout(state.sceneTimer); state.sceneTimer = null; }
  }

  function scenePaused() {
    // 场景是持续渲染的实时画面：只有窗口真正隐藏/最小化时才暂停。
    // VS Code 失去焦点时仍然继续播放，避免点了别的窗口后壁纸卡住。
    return document.hidden;
  }

  function reportSceneSize(force) {
    var now = Date.now();
    if (!force && now - state.lastSizeReport < 15000) return;
    state.lastSizeReport = now;
    var dpr = window.devicePixelRatio || 1;
    var q = '?w=' + Math.round(window.innerWidth) + '&h=' + Math.round(window.innerHeight) + '&dpr=' + dpr;
    fetch(BASE + '/api/scene-size' + q, { cache: 'no-store' }).catch(function () {});
  }

  function startSceneFrames(container, meta) {
    stopSceneFrames();
    var scene = (meta && meta.scene) || {};
    var fps = Math.max(5, Math.min(60, Number(scene.fps) || 24));
    var interval = 1000 / fps;
    var token = { stopped: false, frames: 0 };
    state.scene = token;
    state.sceneFailures = 0;

    var front = document.createElement('img');
    var back = document.createElement('img');
    [front, back].forEach(function (img) {
      img.className = 'vswe-scene-frame';
      img.style.position = 'absolute';
      img.style.top = '0';
      img.style.left = '0';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      img.style.opacity = '0';
      img.style.transition = 'none';
      container.appendChild(img);
    });
    if (meta && meta.wallpaper && meta.wallpaper.preview) {
      front.src = BASE + '/preview';
      front.style.opacity = '1';
    }
    var visible = front;
    var hidden = back;

    function schedule(ms) {
      if (token.stopped) return;
      if (state.sceneTimer) clearTimeout(state.sceneTimer);
      state.sceneTimer = setTimeout(tick, ms);
    }

    function tick() {
      if (token.stopped) return;
      if (scenePaused()) { schedule(450); return; }
      var started = Date.now();
      hidden.onload = function () {
        if (token.stopped) return;
        hidden.style.opacity = '1';
        visible.style.opacity = '0';
        var tmp = visible;
        visible = hidden;
        hidden = tmp;
        token.frames++;
        state.sceneFailures = 0;
        schedule(Math.max(0, interval - (Date.now() - started)));
      };
      hidden.onerror = function () {
        if (token.stopped) return;
        state.sceneFailures = (state.sceneFailures || 0) + 1;
        if (state.sceneFailures === 10) reconnectServer('scene frame failed');
        schedule(350);
      };
      hidden.src = BASE + '/scene/frame?t=' + Date.now() + '-' + token.frames;
    }
    tick();
    reportSceneSize(true);
  }

  function renderWallpaper(meta) {
    var w = meta.wallpaper;
    clearMedia();
    if (!w || w.kind === 'none') return;
    var el = null;
    if (w.kind === 'video') {
      el = document.createElement('video');
      el.src = BASE + '/media';
      el.autoplay = true;
      el.loop = true;
      el.muted = true;
      el.defaultMuted = true;
      el.playsInline = true;
      el.setAttribute('muted', '');
      el.setAttribute('playsinline', '');
      el.disablePictureInPicture = true;
      state.videoEl = el;
      el.addEventListener('error', function () { log('video error', el.error && el.error.code); });
      var p = el.play();
      if (p && p.catch) p.catch(function (e) { log('autoplay blocked', e && e.name); el.muted = true; el.play().catch(function () {}); });
    } else if (w.kind === 'web') {
      el = document.createElement('iframe');
      el.src = BASE + '/';
      el.setAttribute('allow', 'autoplay; fullscreen');
      el.setAttribute('scrolling', 'no');
    } else if (w.kind === 'scene') {
      el = document.createElement('div');
      el.className = 'vswe-media-el vswe-scene';
      el.style.position = 'relative';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.overflow = 'hidden';
      state.mediaEl = el;
      state.media.appendChild(el);
      var sc = meta.scene || {};
      if (sc.active) {
        startSceneFrames(el, meta);
        log('rendered scene', w.title || w.id);
      } else {
        var pv = document.createElement('img');
        pv.className = 'vswe-media-el vswe-scene-preview';
        pv.style.position = 'absolute';
        pv.style.top = '0';
        pv.style.left = '0';
        pv.style.width = '100%';
        pv.style.height = '100%';
        pv.style.objectFit = 'cover';
        pv.src = BASE + '/preview';
        el.appendChild(pv);
        log('scene not active yet, retrying', sc.error || '');
        state.sceneRetry = setTimeout(function () {
          state.sceneRetry = null;
          if (state.mediaEl === el) refresh(true);
        }, 2500);
      }
      return;
    } else if (w.kind === 'image') {
      el = document.createElement('img');
      el.src = BASE + '/media';
      var isGif = /\.gif($|\?)/i.test(w.preview || w.entry || '');
      if (meta.settings && meta.settings.staticKenBurns && !isGif) el.className = 'vswe-kenburns';
    }
    if (!el) return;
    el.className = (el.className ? el.className + ' ' : '') + 'vswe-media-el';
    state.mediaEl = el;
    state.media.appendChild(el);
    log('rendered', w.kind, w.title || w.id);
  }

  function runCustomJs(meta) {
    var code = (meta.settings && meta.settings.customJs) || '';
    if (!code || code === state.lastCustomJs) return;
    state.lastCustomJs = code;
    try {
      var s = document.createElement('script');
      s.textContent = code;
      document.body.appendChild(s);
      s.parentNode.removeChild(s);
    } catch (e) { log('custom js failed', e && e.message); }
  }

  function refresh(force) {
    fetch(BASE + '/meta', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (meta) {
        var prevId = state.lastWallpaperId;
        var prevSceneActive = !!(state.meta && state.meta.scene && state.meta.scene.active);
        var id = meta.wallpaper ? meta.wallpaper.id + ':' + meta.wallpaper.kind : 'none';
        state.lastWallpaperId = id;
        applySettings(meta);
        var sceneBecameActive = !!(meta.scene && meta.scene.active && !prevSceneActive);
        if (force || id !== prevId || !state.mediaEl || sceneBecameActive) renderWallpaper(meta);
        runCustomJs(meta);
      })
      .catch(function () {});
  }

  function connectEvents() {
    try {
      var es = new EventSource(BASE + '/events');
      es.onmessage = function (ev) {
        var data = null;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (!data) return;
        if (data.meta) {
          var id = data.meta.wallpaper ? data.meta.wallpaper.id + ':' + data.meta.wallpaper.kind : 'none';
          var changed = id !== state.lastWallpaperId;
          var prevSceneActive = !!(state.meta && state.meta.scene && state.meta.scene.active);
          state.lastWallpaperId = id;
          applySettings(data.meta);
          var sceneBecameActive = !!(data.meta.scene && data.meta.scene.active && !prevSceneActive);
          if (changed || sceneBecameActive) renderWallpaper(data.meta);
          runCustomJs(data.meta);
        } else if (data.type === 'scene' && state.meta) {
          var wasActive = !!(state.meta.scene && state.meta.scene.active);
          state.meta.scene = data.scene;
          if (data.scene && data.scene.active && !wasActive) renderWallpaper(state.meta);
        }
      };
      es.onerror = function () {
        try { es.close(); } catch (e) {}
        setTimeout(function () { reconnectServer('events'); }, 1800);
      };
    } catch (e) { setTimeout(connectEvents, 3000); }
  }

  function buildDom() {
    if (document.getElementById('vswe-root')) return;
    var style = ensureStyle(STYLE_BASE_ID);
    style.textContent = [
      '#vswe-root{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:0;pointer-events:none;overflow:hidden;background:transparent;--vswe-opacity:1}',
      '#vswe-root .vswe-media{position:absolute;top:0;left:0;width:100%;height:100%;opacity:var(--vswe-opacity);transition:opacity .25s ease;background:transparent}',
      '#vswe-root .vswe-media-el{width:100%;height:100%;object-fit:cover;display:block;border:0;background:transparent}',
      '#vswe-root>div>iframe{pointer-events:none;border:0}',
      '#vswe-root .vswe-kenburns{animation:vswe-kenburns 80s ease-in-out infinite alternate;transform-origin:center center;will-change:transform}',
      '@keyframes vswe-kenburns{from{transform:scale(1.02) translate3d(0,0,0)}to{transform:scale(1.13) translate3d(-1.5%,-1.2%,0)}}'
    ].join('\n');

    var root = document.createElement('div');
    root.id = 'vswe-root';
    var media = document.createElement('div');
    media.className = 'vswe-media';
    root.appendChild(media);
    state.root = root;
    state.media = media;
    var body = document.body || document.documentElement;
    body.insertBefore(root, body.firstChild);
  }

  function boot() {
    resolveServerPort().then(function (ok) {
      if (!ok) { setTimeout(boot, 1500); return; }
      refresh(true);
      if (!state.connected) {
        state.connected = true;
        connectEvents();
        setInterval(function () {
          var q = WINDOW_KEY ? '?window=' + encodeURIComponent(WINDOW_KEY) : '';
          fetch(BASE + '/ping' + q).catch(function () { return null; });
        }, 5000);
      }
    }).catch(function () { setTimeout(boot, 1500); });
  }

  function start() {
    buildDom();
    boot();
    window.addEventListener('resize', function () {
      if (state.resizeTimer) clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(function () { reportSceneSize(); }, 1500);
    });
    document.addEventListener('visibilitychange', function () {
      var s = state.meta && state.meta.settings;
      if (!s || !s.pauseOnBlur || !state.videoEl) return;
      if (document.hidden) { try { state.videoEl.pause(); } catch (e) {} }
      else { try { state.videoEl.play().catch(function () {}); } catch (e) {} }
    });
    window.addEventListener('blur', function () {
      var s = state.meta && state.meta.settings;
      if (s && s.pauseOnBlur && state.videoEl) { try { state.videoEl.pause(); } catch (e) {} }
    });
    window.addEventListener('focus', function () {
      var s = state.meta && state.meta.settings;
      if (s && s.pauseOnBlur && state.videoEl) { try { state.videoEl.play().catch(function () {}); } catch (e) {} }
    });
  }

  var waited = 0;
  var timer = setInterval(function () {
    waited += 100;
    if (document.querySelector('.monaco-workbench') || waited > 20000) {
      clearInterval(timer);
      try { start(); } catch (e) { log('start failed', e && e.message); }
      
    }
  }, 100);
})();
