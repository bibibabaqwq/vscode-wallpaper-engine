(function () {
  const vscode = acquireVsCodeApi();
  const RULES = [
    ['editor.background', '代码编辑区'],
    ['editorGroup.emptyBackground', '空白编辑区'],
    ['editorGroupHeader.tabsBackground', '标签栏'],
    ['sideBar.background', '侧边栏'],
    ['panel.background', '底部面板'],
    ['terminal.background', '终端'],
    ['activityBar.background', '活动栏'],
    ['titleBar.activeBackground', '标题栏'],
    ['statusBar.background', '状态栏']
  ];
  const PRESETS = {
    clear: { 'editor.background': 0, 'editorGroup.emptyBackground': 0, 'editorGroupHeader.tabsBackground': 0, 'sideBar.background': 0, 'panel.background': 0, 'terminal.background': 0, 'activityBar.background': 0, 'titleBar.activeBackground': 0, 'statusBar.background': 0 },
    soft: { 'editor.background': 0.18, 'editorGroup.emptyBackground': 0.18, 'editorGroupHeader.tabsBackground': 0.32, 'sideBar.background': 0.38, 'panel.background': 0.38, 'terminal.background': 0.5, 'activityBar.background': 0.38, 'titleBar.activeBackground': 0.45, 'statusBar.background': 0.45 },
    solid: { 'editor.background': 1, 'editorGroup.emptyBackground': 1, 'editorGroupHeader.tabsBackground': 1, 'sideBar.background': 1, 'panel.background': 1, 'terminal.background': 1, 'activityBar.background': 1, 'titleBar.activeBackground': 1, 'statusBar.background': 1 }
  };

  let applying = false;
  let state = null;
  let sendTimer = null;
  let pending = {};

  const $ = (id) => document.getElementById(id);

  let sceneSig = '';
  let sceneSendTimer = null;
  let scenePending = {};

  function sceneSend(values, delay) {
    Object.assign(scenePending, values);
    if (sceneSendTimer) clearTimeout(sceneSendTimer);
    sceneSendTimer = setTimeout(() => {
      const body = scenePending;
      scenePending = {};
      vscode.postMessage({ type: 'sceneProps', values: body });
    }, delay === undefined ? 420 : delay);
  }

  function sceneStatusText(sc) {
    if (!sc) return '—';
    if (sc.error) return '启动失败';
    if (sc.starting) return '正在启动…';
    if (sc.ready) return '实时渲染中 · ' + sc.fps + ' FPS';
    if (sc.active) return '等待画面…';
    if (!sc.enabled) return '已关闭';
    return '未运行';
  }

  function buildSceneControls(props) {
    const box = $('sceneProps');
    box.textContent = '';
    for (const p of props) {
      if (p.type === 'text') {
        if (!p.label) continue;
        const note = document.createElement('p');
        note.className = 'sceneNote';
        note.textContent = p.label;
        box.appendChild(note);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'rule sceneRule';
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = p.label || '场景属性';
      lbl.title = p.label || '';
      const wrap = document.createElement('div');
      wrap.className = 'sceneControl';
      const val = document.createElement('span');
      val.className = 'val';
      val.dataset.sceneVal = p.key;
      let input;
      if (p.type === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!p.value;
        val.textContent = input.checked ? '开' : '关';
        input.addEventListener('change', () => {
          val.textContent = input.checked ? '开' : '关';
          sceneSend({ [p.key]: input.checked });
        });
      } else if (p.type === 'color') {
        input = document.createElement('input');
        input.type = 'color';
        input.value = /^#[0-9a-f]{6}$/i.test(String(p.value)) ? p.value : '#000000';
        val.textContent = input.value;
        input.addEventListener('input', () => { val.textContent = input.value; sceneSend({ [p.key]: input.value }, 260); });
      } else if (p.type === 'slider') {
        input = document.createElement('input');
        input.type = 'range';
        input.min = String(p.min ?? 0);
        input.max = String(p.max ?? 1);
        input.step = String(p.step || 0.01);
        input.value = String(p.value ?? 0);
        val.textContent = String(p.value ?? 0);
        input.addEventListener('input', () => { val.textContent = input.value; sceneSend({ [p.key]: Number(input.value) }); });
      } else if (p.type === 'combo' && Array.isArray(p.options) && p.options.length) {
        input = document.createElement('select');
        p.options.forEach((o, i) => {
          const opt = document.createElement('option');
          opt.value = String(o.value);
          opt.textContent = o.label || ('选项 ' + (i + 1));
          if (String(o.value) === String(p.value)) opt.selected = true;
          input.appendChild(opt);
        });
        val.textContent = '';
        input.addEventListener('change', () => sceneSend({ [p.key]: input.value }));
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = p.value == null ? '' : String(p.value);
        input.addEventListener('change', () => sceneSend({ [p.key]: input.value }));
      }
      input.dataset.sceneKey = p.key;
      wrap.appendChild(input);
      row.append(lbl, wrap, val);
      box.appendChild(row);
    }
  }

  function syncSceneValues(props) {
    for (const p of props) {
      const input = document.querySelector('[data-scene-key="' + p.key + '"]');
      const val = document.querySelector('[data-scene-val="' + p.key + '"]');
      if (val && p.type !== 'bool') val.textContent = p.value == null ? '' : String(p.value);
      if (!input || document.activeElement === input) continue;
      if (p.type === 'bool') { input.checked = !!p.value; if (val) val.textContent = input.checked ? '开' : '关'; }
      else if (p.type === 'color') input.value = /^#[0-9a-f]{6}$/i.test(String(p.value)) ? p.value : '#000000';
      else input.value = p.value == null ? '' : String(p.value);
    }
  }

  function applySceneState(sc, wallpaper) {
    const isScene = !!(wallpaper && wallpaper.kind === 'scene');
    $('sceneCard').hidden = !isScene;
    if (!sc) return;
    $('sceneStatus').textContent = sceneStatusText(sc);
    $('sceneStatus').classList.toggle('ok', !!sc.ready && !sc.error);
    $('sceneStatus').classList.toggle('bad', !!sc.error);
    $('sceneHint').hidden = !sc.error;
    $('sceneHint').textContent = sc.error || '';
    $('sceneFps').value = String(sc.fps || 24);
    $('sceneFpsVal').textContent = (sc.fps || 24) + ' FPS';
    if (sc.size) $('sceneRes').textContent = sc.size.w + ' x ' + sc.size.h;
    const props = sc.properties || [];
    const sig = JSON.stringify(props.map((p) => [p.key, p.type, p.label, p.options ? p.options.length : 0]));
    if (sig !== sceneSig) {
      sceneSig = sig;
      buildSceneControls(props);
    } else {
      syncSceneValues(props);
    }
  }

  function send(patch, delay) {
    pending = Object.assign(pending, patch);
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      const body = pending;
      pending = {};
      vscode.postMessage({ type: 'update', patch: body });
    }, delay === undefined ? 60 : delay);
  }

  function buildRules() {
    const box = $('rules');
    box.textContent = '';
    for (const [key, label] of RULES) {
      const row = document.createElement('div');
      row.className = 'rule';
      const l = document.createElement('span');
      l.className = 'lbl';
      l.textContent = label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.dataset.key = key;
      const v = document.createElement('span');
      v.className = 'val';
      v.dataset.val = key;
      input.addEventListener('input', () => {
        if (applying) return;
        const pct = Number(input.value);
        v.textContent = pct + '%';
        const patch = {};
        patch[key] = pct / 100;
        send({ transparencyRules: Object.assign({}, state ? state.settings.transparencyRules : {}, patch) });
        if (state) state.settings.transparencyRules[key] = pct / 100;
      });
      row.append(l, input, v);
      box.appendChild(row);
    }
  }

  function applyState(next) {
    state = next;
    applying = true;
    const s = next.settings || {};
    const w = next.wallpaper;

    $('wpTitle').textContent = w ? w.title : '未加载壁纸';
    $('wpKind').textContent = w ? w.kindLabel : '—';
    $('wpFile').textContent = w ? w.file : '';
    $('statusDot').classList.toggle('on', !!w);

    $('bgOpacity').value = String(Math.round((s.backgroundOpacity ?? 0.55) * 100));
    $('bgVal').textContent = $('bgOpacity').value + '%';

    $('trEnabled').checked = s.transparencyEnabled !== false;
    const rules = s.transparencyRules || {};
    for (const [key] of RULES) {
      const input = document.querySelector('input[data-key="' + key + '"]');
      const val = document.querySelector('[data-val="' + key + '"]');
      const pct = Math.round((rules[key] ?? 0) * 100);
      if (input) input.value = String(pct);
      if (val) val.textContent = pct + '%';
    }
    const base = s.transparencyBaseColor || '';
    if (base) { $('baseColor').value = base; $('baseAuto').checked = false; }
    else { $('baseAuto').checked = true; }

    applySceneState(next.scene, w);

    $('autoSync').checked = s.autoSync !== false;
    $('pauseOnBlur').checked = s.pauseOnBlur !== false;
    $('kenBurns').checked = s.staticKenBurns !== false;
    if (document.activeElement !== $('customCss')) $('customCss').value = s.customCss || '';

    applying = false;
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'state') applyState(msg);
    else if (msg && msg.type === 'scene') applySceneState(msg.scene, state && state.wallpaper);
  });

  document.addEventListener('DOMContentLoaded', () => {
    buildRules();
    vscode.postMessage({ type: 'ready' });

    $('bgOpacity').addEventListener('input', () => {
      const pct = Number($('bgOpacity').value);
      $('bgVal').textContent = pct + '%';
      if (!applying) send({ backgroundOpacity: pct / 100 });
    });

    $('trEnabled').addEventListener('change', () => {
      if (!applying) send({ transparencyEnabled: $('trEnabled').checked });
    });

    document.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = PRESETS[btn.dataset.preset];
        if (!preset) return;
        send({ transparencyRules: preset, transparencyEnabled: true });
        if (state) state.settings.transparencyRules = Object.assign({}, preset);
        for (const [key] of RULES) {
          const input = document.querySelector('input[data-key="' + key + '"]');
          const val = document.querySelector('[data-val="' + key + '"]');
          const pct = Math.round((preset[key] ?? 0) * 100);
          if (input) input.value = String(pct);
          if (val) val.textContent = pct + '%';
        }
        $('trEnabled').checked = true;
      });
    });

    $('baseAuto').addEventListener('change', () => {
      if (applying) return;
      if ($('baseAuto').checked) send({ transparencyBaseColor: '' });
      else send({ transparencyBaseColor: $('baseColor').value });
    });
    $('baseColor').addEventListener('input', () => {
      if (applying) return;
      $('baseAuto').checked = false;
      send({ transparencyBaseColor: $('baseColor').value });
    });

    $('autoSync').addEventListener('change', () => { if (!applying) send({ autoSync: $('autoSync').checked }); });
    $('pauseOnBlur').addEventListener('change', () => { if (!applying) send({ pauseOnBlur: $('pauseOnBlur').checked }); });
    $('kenBurns').addEventListener('change', () => { if (!applying) send({ staticKenBurns: $('kenBurns').checked }); });

    $('customCss').addEventListener('input', () => { if (!applying) send({ customCss: $('customCss').value }, 450); });

    $('btnSwitch').addEventListener('click', () => vscode.postMessage({ type: 'switch' }));
    $('btnSync').addEventListener('click', () => vscode.postMessage({ type: 'sync' }));
    $('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    $('btnFolder').addEventListener('click', () => vscode.postMessage({ type: 'folder' }));
    $('btnNative').addEventListener('click', () => vscode.postMessage({ type: 'openNativeSettings' }));

    $('sceneFps').addEventListener('input', () => {
      const v = Number($('sceneFps').value);
      $('sceneFpsVal').textContent = v + ' FPS';
      send({ sceneFps: v }, 400);
    });
    $('btnSceneReload').addEventListener('click', () => vscode.postMessage({ type: 'sceneReload' }));
    $('btnSceneSync').addEventListener('click', () => vscode.postMessage({ type: 'sceneSyncDesktop' }));

    setInterval(() => {
      if (!$('sceneCard').hidden) vscode.postMessage({ type: 'sceneStatus' });
    }, 1300);
  });
})();
