'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { spawn, execFile } = require('child_process');

const CFG = 'vscode-wallpaper-engine';
const EXT_VERSION = (() => { try { return String(require('./package.json').version || '0.0.0'); } catch { return '0.0.0'; } })();
const MARK_START = '<!-- VSCode-Wallpaper-Engine-Start -->';
const MARK_END = '<!-- VSCode-Wallpaper-Engine-End -->';
const OLD_START = '<!-- VSCode-Wallpaper-Injection-Start -->';
const OLD_END = '<!-- VSCode-Wallpaper-Injection-End -->';
const BOOTSTRAP = 'vswe-bootstrap.js';
const WE_MOCK = 'vswe-we-mock.js';
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg'];
const DEFAULT_RULES = {
  'editor.background': 0,
  'editorGroup.emptyBackground': 0,
  'editorGroupHeader.tabsBackground': 0,
  'sideBar.background': 0,
  'panel.background': 0,
  'terminal.background': 0,
  'activityBar.background': 0,
  'titleBar.activeBackground': 0,
  'statusBar.background': 0
};

let extensionContext = null;
let httpServer = null;
let serverPort = 23333;
let current = null;
let sseClients = new Set();
let heartbeat = null;
let reloadFlag = false;
let weWatcher = null;
let weWatchTimer = null;
let output = null;
let overrides = {};

function cfg() {
  return vscode.workspace.getConfiguration(CFG);
}

function normalizeRules(input) {
  const out = Object.assign({}, DEFAULT_RULES);
  if (input && typeof input === 'object') {
    for (const key of Object.keys(out)) {
      const v = input[key];
      if (typeof v === 'number' && isFinite(v)) out[key] = Math.min(1, Math.max(0, v));
    }
  }
  return out;
}

function getSettings() {
  const c = cfg();
  const val = (key) => Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : c.get(key);
  const num = (key, def) => { const v = Number(val(key)); return isFinite(v) ? v : def; };
  return {
    workshopPath: String(val('workshopPath') || ''),
    wallpaperEnginePath: String(val('wallpaperEnginePath') || ''),
    wallpaperId: String(val('wallpaperId') || ''),
    serverPort: num('serverPort', 23333),
    backgroundOpacity: Math.min(1, Math.max(0, num('backgroundOpacity', 0.55))),
    transparencyEnabled: val('transparencyEnabled') !== false,
    transparencyBaseColor: String(val('transparencyBaseColor') || ''),
    transparencyRules: normalizeRules(val('transparencyRules')),
    customCss: String(val('customCss') || ''),
    customJs: String(val('customJs') || ''),
    autoSync: val('autoSync') !== false,
    syncMonitor: String(val('syncMonitor') || 'Monitor0'),
    pauseOnBlur: val('pauseOnBlur') !== false,
    staticKenBurns: val('staticKenBurns') !== false,
    sceneEnabled: val('sceneEnabled') !== false,
    sceneFps: num('sceneFps', 24),
    sceneQuality: num('sceneQuality', 72),
    sceneMaxWidth: num('sceneMaxWidth', 1920),
    sceneMuted: val('sceneMuted') !== false
  };
}

function log(...args) {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (output) output.appendLine(line);
  console.log('[wallpaper]', line);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function findPreview(dir, project) {
  if (project && typeof project.preview === 'string' && project.preview) {
    if (fs.existsSync(path.join(dir, project.preview))) return project.preview;
  }
  for (const name of ['preview.gif', 'preview.jpg', 'preview.jpeg', 'preview.png', 'preview.webp']) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return '';
}

function readWallpaper(root, id) {
  const dir = path.join(root, id);
  const pj = path.join(dir, 'project.json');
  if (!fs.existsSync(pj)) return null;
  const project = readJson(pj);
  if (!project) return null;

  let file = typeof project.file === 'string' ? project.file : '';
  let type = String(project.type || '').toLowerCase();
  let dep = project.dependency;
  if (Array.isArray(dep)) dep = dep[0];

  if ((!file || !type) && dep) {
    const depProject = readJson(path.join(root, String(dep), 'project.json'));
    if (depProject) {
      if (!file && typeof depProject.file === 'string') file = depProject.file;
      if (!type && depProject.type) type = String(depProject.type).toLowerCase();
    }
  }

  if (!file) {
    for (const name of ['index.html', 'index.htm']) {
      if (fs.existsSync(path.join(dir, name))) { file = name; type = type || 'web'; break; }
    }
  }
  if (!file && type === 'scene') file = 'scene.pkg';

  return {
    id,
    title: String(project.title || id),
    dir,
    file,
    type,
    preview: findPreview(dir, project),
    location: String(project.location || ''),
    project
  };
}

function scanWallpapers(root) {
  const list = [];
  if (!root || !fs.existsSync(root)) return list;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return list; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const item = readWallpaper(root, entry.name);
    if (item) list.push(item);
  }
  return list;
}

function extOf(file) {
  return path.extname(String(file || '')).toLowerCase();
}

function kindOf(item) {
  if (!item) return 'unknown';
  const ext = extOf(item.file);
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (item.type === 'web' || ext === '.html' || ext === '.htm') return 'web';
  if (item.type === 'scene' || ext === '.pkg') return 'scene';
  if (item.type === 'video') return 'video';
  if (item.type === 'image') return 'image';
  return 'unknown';
}

function kindLabel(kind) {
  switch (kind) {
    case 'video': return '视频动态壁纸';
    case 'web': return 'Web 动态壁纸';
    case 'image': return '图片壁纸';
    case 'scene': return '场景壁纸（WE 实时渲染）';
    default: return '未知类型';
  }
}

/* ---------------- Wallpaper Engine sync ---------------- */

function guessEnginePath(settings) {
  if (settings.wallpaperEnginePath && fs.existsSync(settings.wallpaperEnginePath)) return settings.wallpaperEnginePath;
  const wp = settings.workshopPath.replace(/\\/g, '/');
  const marker = '/steamapps/workshop/content/431960';
  const idx = wp.toLowerCase().indexOf(marker);
  if (idx >= 0) {
    const candidate = wp.slice(0, idx) + '/steamapps/common/wallpaper_engine';
    if (fs.existsSync(candidate)) return candidate;
  }
  const candidates = [
    'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine',
    'C:/Program Files/Steam/steamapps/common/wallpaper_engine',
    'D:/Program Files/Steam/steamapps/common/wallpaper_engine',
    'D:/Steam/steamapps/common/wallpaper_engine',
    'E:/Steam/steamapps/common/wallpaper_engine',
    'D:/SteamLibrary/steamapps/common/wallpaper_engine',
    'E:/SteamLibrary/steamapps/common/wallpaper_engine'
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c.split('/').join(path.sep);
  return '';
}

function readEngineConfig(settings) {
  const engine = guessEnginePath(settings);
  if (!engine) return null;
  const file = path.join(engine, 'config.json');
  if (!fs.existsSync(file)) return null;
  const json = readJson(file);
  if (!json) return null;
  return { engine, file, json };
}

function selectedFiles(config, settings) {
  const selected = config && config.json && config.json.wow && config.json.wow.general &&
    config.json.wow.general.wallpaperconfig && config.json.wow.general.wallpaperconfig.selectedwallpapers;
  if (!selected) return [];
  if (selected[settings.syncMonitor] && selected[settings.syncMonitor].file) return [selected[settings.syncMonitor].file];
  return Object.values(selected).map(v => v && v.file).filter(Boolean);
}

function wallpaperFromFile(file, settings) {
  if (!file) return null;
  const normalized = path.normalize(file);
  const root = path.normalize(settings.workshopPath);
  const rel = path.relative(root, normalized);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const id = rel.split(path.sep)[0];
  if (!id) return null;
  return readWallpaper(root, id);
}

function syncFromEngine(settings, opts) {
  const config = readEngineConfig(settings);
  if (!config) {
    if (opts && opts.verbose) vscode.window.showWarningMessage('未找到 Wallpaper Engine config.json，请检查 workshopPath / wallpaperEnginePath。');
    return null;
  }
  for (const file of selectedFiles(config, settings)) {
    const item = wallpaperFromFile(file, settings);
    if (item) return item;
  }
  if (opts && opts.verbose) vscode.window.showWarningMessage('Wallpaper Engine 当前没有可同步的壁纸。');
  return null;
}

function watchEngineConfig() {
  if (weWatcher) { try { weWatcher.close(); } catch {} weWatcher = null; }
  const settings = getSettings();
  const config = readEngineConfig(settings);
  if (!config || !settings.autoSync) return;
  try {
    weWatcher = fs.watch(config.file, () => {
      if (weWatchTimer) clearTimeout(weWatchTimer);
      weWatchTimer = setTimeout(() => {
        const s = getSettings();
        if (!s.autoSync) return;
        const item = syncFromEngine(s);
        if (item && (!current || current.id !== item.id)) {
          applyWallpaper(item, { silent: true, persist: true });
        }
      }, 1500);
    });
  } catch (e) { log('watch failed: ' + String(e)); }
}

/* ---------------- scene: Wallpaper Engine real-time render ---------------- */

// 说明：VS Code 的 Electron 无法直接解码 WE 的 scene.pkg。
// 这里的做法是让 Wallpaper Engine 在屏幕外渲染一个「弹出窗口」，
// 由 bin/scene-helper.exe 用 PrintWindow(PW_RENDERFULLCONTENT) 抓帧，
// 再经本地 HTTP 以 JPEG 流送入 VS Code 背景。
// 弹窗始终带 -playInWindow，因此绝不会替换桌面壁纸。

const sceneState = {
  active: false,
  ready: false,
  starting: false,
  title: '',
  proc: null,
  port: 0,
  copyDir: '',
  wallpaperId: '',
  item: null,
  props: [],
  values: {},
  size: { w: 1600, h: 900 },
  fps: 24,
  quality: 72,
  error: '',
  lastResize: 0,
  framesServed: 0
};
let sceneQueue = Promise.resolve();
let sceneGeneration = 0;
let sceneTitleCounter = 0;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// vscode.env.logPath 与 renderer 的 window.vscode.context.configuration().logsPath
// 指向同一个「窗口日志目录」，用它作为窗口指纹可以让注入页面找到自己的服务。
function windowKey() {
  try {
    const raw = String((extensionContext && extensionContext.logUri && extensionContext.logUri.fsPath) || vscode.env.logPath || '');
    // 典型值：...\logs\20261120T214320\window1\exthost
    const m = /[\\/]logs[\\/]([^\\/]+)[\\/]window(\d+)/i.exec(raw);
    if (m) return (m[1] + '#' + m[2]).toLowerCase();
    const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length ? String(parts[parts.length - 1]).toLowerCase() : '';
  } catch { return ''; }
}

function normalizePathKey(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '').toLowerCase();
}

function engineExePath(settings) {
  const dir = guessEnginePath(settings || getSettings());
  if (!dir) return '';
  for (const name of ['wallpaper64.exe', 'wallpaper32.exe']) {
    const exe = path.join(dir, name);
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

function sceneHelperPath() {
  const exe = path.join(extensionContext.extensionPath, 'bin', 'scene-helper.exe');
  return fs.existsSync(exe) ? exe : '';
}

function runExe(file, args, timeoutMs) {
  return new Promise(resolve => {
    let finished = false;
    const done = value => { if (!finished) { finished = true; resolve(value); } };
    let child = null;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      done({ ok: false, error: String(e) });
      return;
    }
    child.on('error', e => done({ ok: false, error: String(e) }));
    child.on('exit', code => done({ ok: code === 0, code }));
    setTimeout(() => {
      try { child.unref(); } catch {}
      done({ ok: true, timeout: true });
    }, timeoutMs || 5000);
  });
}

function weControl(args) {
  const exe = engineExePath();
  if (!exe) return Promise.resolve({ ok: false, error: 'wallpaper64.exe not found' });
  return runExe(exe, ['-control'].concat(args));
}

function weIsRunning() {
  return new Promise(resolve => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq wallpaper64.exe', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(/wallpaper64\.exe/i.test(String(stdout || '')));
    });
  });
}

async function ensureEngine() {
  const exe = engineExePath();
  if (!exe) throw new Error('未找到 wallpaper64.exe，请先在设置中填写 Wallpaper Engine 安装目录。');
  if (await weIsRunning()) return exe;
  log('wallpaper engine not running, starting silently');
  try { spawn(exe, ['-silent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
  for (let i = 0; i < 40; i++) {
    await delay(300);
    if (await weIsRunning()) { await delay(2000); return exe; }
  }
  return exe;
}

function decodeSceneHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = parseInt(dec, 10);
      return isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function scenePlainText(value) {
  let text = String(value || '');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<br\s*\/?\s*>/gi, ' ');
  text = text.replace(/<\/(?:p|div|li|h[1-6]|tr|td|th)>/gi, ' ');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeSceneHtmlEntities(text);
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sceneLabelUsable(label, key) {
  const text = String(label || '').trim();
  if (!text || text.length > 90) return false;
  if (key && text === String(key).trim()) return false;
  if (/^(?:img|src|http|https|www\.|data:)/i.test(text)) return false;
  const compact = text.replace(/\s+/g, '');
  if (compact.length >= 48 && !/[\s\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text)) return false;
  if (compact.length >= 36 && /^[a-z0-9+/=_.:-]+$/i.test(compact) && !/[\s\u3400-\u9fff]/u.test(text)) return false;
  return true;
}

function scenePropLabel(options, fallback) {
  options = options || {};
  const key = String(options.key || '');
  const rawText = String(options.text || '');
  if (/^ui_browse_properties_/i.test(scenePlainText(rawText)) || /^ui_browse_properties_/i.test(key)) {
    return '主题配色 (scheme color)';
  }
  const text = scenePlainText(rawText);
  if (sceneLabelUsable(text, key)) return text;
  if (!rawText.trim()) {
    const plainKey = scenePlainText(key);
    if (sceneLabelUsable(plainKey, '')) return plainKey;
  }
  return String(fallback || '');
}

function weColorToHex(value) {
  const parts = String(value || '').trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(n => !isFinite(n))) return '#000000';
  const byte = n => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0');
  return '#' + byte(parts[0]) + byte(parts[1]) + byte(parts[2]);
}

function hexToWeColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const f = x => {
    const v = (x / 255).toFixed(6);
    return v.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
  };
  return f((n >> 16) & 255) + ' ' + f((n >> 8) & 255) + ' ' + f(n & 255);
}

function coerceSceneValue(prop, value) {
  if (!prop) return value;
  switch (prop.type) {
    case 'bool':
      return !(value === false || value === 0 || value === '0' || value === 'false' || value === '' || value === null || value === undefined);
    case 'color': {
      const direct = hexToWeColor(value);
      if (direct) return direct;
      return String(value === undefined || value === null || value === '' ? (prop.def || '0 0 0') : value);
    }
    case 'slider': {
      let n = Number(value);
      if (!isFinite(n)) n = Number(prop.def) || 0;
      const min = isFinite(Number(prop.min)) ? Number(prop.min) : 0;
      const max = isFinite(Number(prop.max)) ? Number(prop.max) : 1;
      n = Math.max(min, Math.min(max, n));
      const step = Number(prop.step);
      if (isFinite(step) && step > 0) {
        const digits = String(step).split('.')[1] ? String(step).split('.')[1].length : 0;
        n = Number((Math.round(n / step) * step).toFixed(digits));
      }
      return n;
    }
    case 'combo':
      return String(value === undefined || value === null ? (prop.def || '') : value);
    default:
      return String(value === undefined || value === null ? '' : value);
  }
}

function readSceneProps(item) {
  const project = (item && item.project) || {};
  const raw = (project.general && project.general.properties) || project.properties || {};
  const typeNames = { bool: '场景开关', color: '场景颜色', slider: '场景滑块', combo: '场景选项', textinput: '场景文本' };
  const list = [];
  let visibleIndex = 0;
  for (const key of Object.keys(raw)) {
    const p = raw[key] || {};
    const type = String(p.type || 'text').toLowerCase();
    if (type === 'group') continue;
    visibleIndex++;
    const fallback = (typeNames[type] || '场景属性') + ' ' + visibleIndex;
    const label = scenePropLabel(Object.assign({ key }, p), fallback);
    if (type === 'text' && (!sceneLabelUsable(scenePlainText(p.text), key) || !label)) continue;
    list.push({
      key,
      type,
      label: label || fallback,
      order: Number(p.order) || 0,
      min: p.min,
      max: p.max,
      step: p.step,
      options: Array.isArray(p.options)
        ? p.options.map((o, i) => {
            const value = o && o.value;
            const rawOption = o && o.label !== undefined ? o.label : value;
            const optionLabel = scenePlainText(rawOption);
            return {
              label: sceneLabelUsable(optionLabel, String(value)) ? optionLabel : ((typeNames.combo || '选项') + ' ' + (i + 1)),
              value
            };
          })
        : null,
      def: p.value !== undefined ? p.value : (type === 'bool' ? false : '')
    });
  }
  list.sort((a, b) => a.order - b.order);
  return list;
}

function desktopSceneValues(item) {
  const settings = getSettings();
  const config = readEngineConfig(settings);
  if (!config || !item) return {};
  const wp = (config.json.wow && config.json.wow.wproperties) || {};
  const target = normalizePathKey(path.join(item.dir, item.file));
  let entry = null;
  for (const key of Object.keys(wp)) {
    if (normalizePathKey(key) === target) { entry = wp[key]; break; }
  }
  if (!entry) {
    const base = normalizePathKey(item.dir) + '/';
    for (const key of Object.keys(wp)) {
      if (normalizePathKey(key).startsWith(base)) { entry = wp[key]; break; }
    }
  }
  if (!entry || typeof entry !== 'object') return {};
  const loc = entry[settings.syncMonitor] || entry.Monitor0 || entry[Object.keys(entry)[0]];
  return loc && typeof loc === 'object' ? Object.assign({}, loc) : {};
}

function sceneInitialValues(item, props) {
  const values = {};
  const byKey = {};
  for (const p of props) { values[p.key] = p.def; byKey[p.key] = p; }
  const desk = desktopSceneValues(item);
  for (const key of Object.keys(desk)) {
    if (byKey[key]) values[key] = coerceSceneValue(byKey[key], desk[key]);
  }
  let saved = {};
  try { saved = extensionContext.globalState.get('sceneProps.' + item.id) || {}; } catch {}
  for (const key of Object.keys(saved)) {
    if (byKey[key]) values[key] = coerceSceneValue(byKey[key], saved[key]);
  }
  return values;
}

function sceneCopyDir(item) {
  return path.join(extensionContext.globalStorageUri.fsPath, 'scene', String(item.id));
}

function scenePrepareCopy(item) {
  const dest = sceneCopyDir(item);
  fs.mkdirSync(dest, { recursive: true });
  const pkg = path.join(dest, 'scene.pkg');
  if (!fs.existsSync(pkg)) {
    log('copying scene wallpaper resources to ' + dest);
    fs.cpSync(item.dir, dest, {
      recursive: true,
      force: true,
      errorOnExist: false,
      filter: src => {
        const rel = path.relative(item.dir, src);
        if (!rel) return true;
        if (!rel.includes(path.sep) && /^preview\.(gif|jpe?g|png|webp)$/i.test(rel)) return false;
        return true;
      }
    });
  }
  const orig = path.join(dest, 'project.orig.json');
  if (!fs.existsSync(orig)) fs.copyFileSync(path.join(item.dir, 'project.json'), orig);
  return dest;
}

function writeSceneProject() {
  if (!sceneState.copyDir) return;
  const orig = path.join(sceneState.copyDir, 'project.orig.json');
  const out = path.join(sceneState.copyDir, 'project.json');
  const project = readJson(orig);
  if (!project) throw new Error('场景 project.json 读取失败');
  project.general = project.general || {};
  project.general.properties = project.general.properties || {};
  const props = project.general.properties;
  for (const p of sceneState.props) {
    if (!props[p.key]) continue;
    props[p.key].value = coerceSceneValue(p, sceneState.values[p.key]);
  }
  fs.writeFileSync(out, JSON.stringify(project, null, '\t'), 'utf8');
}

function pickScenePort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(0, '127.0.0.1', () => {
      let port = 0;
      try { port = srv.address().port; } catch {}
      srv.close(() => resolve(port));
    });
  });
}

async function startSceneHelper(generation) {
  const exe = sceneHelperPath();
  if (!exe) throw new Error('扩展缺少 bin/scene-helper.exe，请重新安装插件。');
  if (generation !== undefined && generation !== sceneGeneration) return;
  if (sceneState.proc) {
    const old = sceneState.proc;
    sceneState.proc = null;
    try { old.kill(); } catch {}
    await delay(120);
  }
  sceneState.port = await pickScenePort();
  if (!sceneState.port) throw new Error('无法分配本地端口');
  if (generation !== undefined && generation !== sceneGeneration) return;
  const args = ['serve', sceneState.title, String(sceneState.port), String(sceneState.fps), String(sceneState.quality), '1.0'];
  log('scene helper: ' + args.join(' '));
  const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  sceneState.proc = child;
  child.on('error', e => {
    log('scene helper error: ' + String(e));
    if (sceneState.proc === child) sceneState.error = '抓帧组件启动失败：' + String(e);
  });
  child.on('exit', code => {
    if (sceneState.proc === child) {
      sceneState.proc = null;
      sceneState.ready = false;
      log('scene helper exited: ' + code);
      broadcastScene();
    }
  });
}

function sceneProbe(pathname) {
  return new Promise(resolve => {
    if (!sceneState.port) { resolve(null); return; }
    const req = http.get({ host: '127.0.0.1', port: sceneState.port, path: pathname || '/status', timeout: 1500 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (body.length > 40000) req.destroy();
      });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function sceneSeq() {
  const st = await sceneProbe('/status');
  return st && st.ok ? Number(st.frames) || 0 : 0;
}

async function waitSceneReady(timeoutMs, minSeq, generation) {
  const need = Math.max(0, Number(minSeq) || 0);
  const until = Date.now() + (timeoutMs || 25000);
  while (Date.now() < until) {
    if (generation !== undefined && generation !== sceneGeneration) return false;
    const st = await sceneProbe('/status');
    if (st && st.ok && Number(st.frames) > need) {
      sceneState.ready = true;
      sceneState.error = '';
      return true;
    }
    await delay(400);
  }
  if (!sceneState.ready) {
    sceneState.error = sceneState.error || '场景画面启动超时：请确认 Wallpaper Engine 正在运行，且该场景在 WE 中可以正常预览。';
  }
  return false;
}

async function sceneOpenWindow(generation) {
  const dest = sceneState.copyDir;
  if (!dest) return false;
  if (generation !== undefined && generation !== sceneGeneration) return false;
  const pkg = path.join(dest, 'scene.pkg');
  const entry = fs.existsSync(pkg) ? pkg : path.join(dest, 'project.json');
  const exe = sceneHelperPath();

  // 先结束抓帧进程，再彻底清掉本进程创建过的所有 VSWE 窗口，
  // 避免旧实例被 WE 恢复后抢到前台。
  if (sceneState.proc) {
    const oldProc = sceneState.proc;
    sceneState.proc = null;
    try { oldProc.kill(); } catch {}
    await delay(120);
  }
  await sceneCloseTitles(sceneSceneTitlesForPid(process.pid));
  await delay(180);
  if (generation !== undefined && generation !== sceneGeneration) return false;

  // 每次都用新的标题：WE 会按标题复用渲染实例，复用标题会沿用旧的属性值
  sceneTitleCounter++;
  sceneState.title = 'VSWE Scene ' + process.pid + '-' + sceneTitleCounter;
  await sceneRememberTitle(sceneState.title);

  // 关键：place 进程先启动、在内部等待窗口出现，窗口一创建就立刻设置
  // WS_EX_NOACTIVATE 并移到屏幕外，绝不会等到 420ms 后才隐藏。
  const placePromise = exe
    ? runExe(exe, ['place', sceneState.title, '-3000', '-3000', String(sceneState.size.w), String(sceneState.size.h)], 14000)
    : Promise.resolve({ ok: false, error: 'missing scene-helper.exe' });
  const res = await weControl([
    'openWallpaper',
    '-file', entry,
    '-playInWindow', sceneState.title,
    '-width', String(sceneState.size.w),
    '-height', String(sceneState.size.h),
    '-borderless'
  ]);
  let placed = await placePromise;
  if (!placed.ok && exe) {
    log('scene place retry: ' + JSON.stringify(placed));
    placed = await runExe(exe, ['place', sceneState.title, '-3000', '-3000', String(sceneState.size.w), String(sceneState.size.h)], 6000);
  }
  if (!placed.ok) log('scene place failed: ' + JSON.stringify(placed));
  if (!res.ok && !placed.ok) {
    log('openWallpaper failed: ' + JSON.stringify(res));
    throw new Error('Wallpaper Engine 未能打开场景预览窗口：' + (res.error || res.code || 'unknown error'));
  }
  if (generation !== undefined && generation !== sceneGeneration) return false;
  if (getSettings().sceneMuted) await weControl(['mute', '-location', sceneState.title]);
  await startSceneHelper(generation);
  sceneState.seqMark = 0;
  return true;
}

function sceneTargetSize(settings, reported) {
  const maxWidth = Math.max(640, Math.min(3840, Number(settings.sceneMaxWidth) || 1920));
  let w = 1600;
  let h = 900;
  if (reported && Number(reported.w) > 0 && Number(reported.h) > 0) {
    const dpr = Math.max(1, Math.min(2, Number(reported.dpr) || 1));
    w = Math.min(maxWidth, Math.round(Number(reported.w) * dpr));
    h = Math.round(w * Number(reported.h) / Number(reported.w));
  }
  w = Math.max(960, Math.min(maxWidth, w));
  h = Math.max(540, h);
  w -= w % 2;
  h -= h % 2;
  return { w, h };
}

function scenePropsForUi() {
  return sceneState.props.map(p => ({
    key: p.key,
    type: p.type,
    label: p.label,
    min: p.min,
    max: p.max,
    step: p.step,
    options: p.options,
    value: p.type === 'color' ? weColorToHex(sceneState.values[p.key]) : sceneState.values[p.key]
  }));
}

function sceneInfo() {
  const isScene = !!current && kindOf(current) === 'scene';
  return {
    supported: isScene,
    enabled: getSettings().sceneEnabled !== false,
    active: sceneState.active,
    ready: sceneState.ready,
    starting: sceneState.starting,
    error: sceneState.error,
    fps: sceneState.fps,
    quality: sceneState.quality,
    size: sceneState.size,
    port: sceneState.port,
    served: sceneState.framesServed,
    frame: '/scene/frame',
    status: '/scene/status',
    properties: isScene ? scenePropsForUi() : []
  };
}

function broadcastScene() {
  const meta = metaPayload();
  broadcast({ type: 'scene', scene: meta.scene, meta, settings: getSettings() });
}

async function sceneStopNow() {
  const titles = sceneSceneTitlesForPid(process.pid);
  sceneState.active = false;
  sceneState.ready = false;
  sceneState.starting = false;
  if (sceneState.proc) {
    const proc = sceneState.proc;
    sceneState.proc = null;
    try { proc.kill(); } catch {}
    await delay(120);
  }
  sceneState.title = '';
  sceneState.port = 0;
  await sceneCloseTitles(titles);
}

function sceneStop() {
  const generation = ++sceneGeneration;
  return queueScene(async () => {
    if (generation !== sceneGeneration) return;
    await sceneStopNow();
    broadcastScene();
  });
}

async function sceneStartNow(item, opts, generation) {
  opts = opts || {};
  if (generation !== sceneGeneration) return false;
  await sceneStopNow();
  if (generation !== sceneGeneration) return false;

  const settings = getSettings();
  sceneState.error = '';
  if (!item || kindOf(item) !== 'scene') return false;
  if (settings.sceneEnabled === false) {
    sceneState.error = '已在设置中关闭「场景实时渲染」，当前显示封面预览。';
    broadcastScene();
    return false;
  }
  sceneState.starting = true;
  sceneState.item = item;
  sceneState.wallpaperId = item.id;
  sceneState.fps = Math.max(5, Math.min(60, Math.round(Number(settings.sceneFps) || 24)));
  sceneState.quality = Math.max(40, Math.min(95, Math.round(Number(settings.sceneQuality) || 72)));
  sceneState.size = opts.size || sceneTargetSize(settings, opts.reported);
  sceneState.props = readSceneProps(item);
  sceneState.values = opts.values || sceneInitialValues(item, sceneState.props);
  try {
    await ensureEngine();
    if (generation !== sceneGeneration) return false;
    sceneState.copyDir = scenePrepareCopy(item);
    writeSceneProject();
    if (generation !== sceneGeneration) return false;
    sceneState.title = '';
    sceneState.active = true;
    const opened = await sceneOpenWindow(generation);
    if (!opened) {
      if (generation === sceneGeneration) {
        sceneState.active = false;
        sceneState.starting = false;
      }
      return false;
    }
    broadcastScene();
    const ok = await waitSceneReady(opts.timeout || 25000, 8, generation);
    if (generation !== sceneGeneration) {
      await sceneStopNow();
      return false;
    }
    sceneState.starting = false;
    broadcastScene();
    return ok;
  } catch (e) {
    if (generation !== sceneGeneration) {
      await sceneStopNow();
      return false;
    }
    sceneState.starting = false;
    sceneState.active = false;
    sceneState.error = String((e && e.message) || e);
    log('scene start failed: ' + sceneState.error);
    broadcastScene();
    return false;
  }
}

function sceneStart(item, opts) {
  const generation = ++sceneGeneration;
  return queueScene(() => sceneStartNow(item, opts, generation));
}

function queueScene(task) {
  const run = sceneQueue.then(task).catch(e => {
    sceneState.starting = false;
    sceneState.error = String((e && e.message) || e);
    log('scene task failed: ' + sceneState.error);
    broadcastScene();
  });
  sceneQueue = run.catch(() => {});
  return run;
}

function sceneApplyValues(values) {
  const generation = sceneGeneration;
  const wallpaperId = sceneState.wallpaperId;
  return queueScene(async () => {
    if (generation !== sceneGeneration || wallpaperId !== sceneState.wallpaperId || !sceneState.active) return;
    let changed = false;
    for (const p of sceneState.props) {
      if (!values || !Object.prototype.hasOwnProperty.call(values, p.key)) continue;
      const next = coerceSceneValue(p, values[p.key]);
      if (String(next) !== String(sceneState.values[p.key])) {
        sceneState.values[p.key] = next;
        changed = true;
      }
    }
    if (!changed) return;
    try { await extensionContext.globalState.update('sceneProps.' + sceneState.wallpaperId, sceneState.values); } catch {}
    writeSceneProject();
    sceneState.ready = false;
    sceneState.starting = true;
    broadcastScene();
    const opened = await sceneOpenWindow(generation);
    if (!opened || generation !== sceneGeneration) return;
    await waitSceneReady(20000, (sceneState.seqMark || 0) + 8, generation);
    if (generation !== sceneGeneration) return;
    sceneState.starting = false;
    broadcastScene();
  });
}

function sceneResyncDesktop() {
  const generation = sceneGeneration;
  const wallpaperId = sceneState.wallpaperId;
  return queueScene(async () => {
    if (generation !== sceneGeneration || wallpaperId !== sceneState.wallpaperId || !sceneState.active || !sceneState.item) return;
    const fresh = sceneInitialValues(sceneState.item, sceneState.props);
    // 重新同步时丢弃本地保存的覆盖值
    try { await extensionContext.globalState.update('sceneProps.' + sceneState.wallpaperId, undefined); } catch {}
    sceneState.values = fresh;
    writeSceneProject();
    sceneState.ready = false;
    sceneState.starting = true;
    broadcastScene();
    const opened = await sceneOpenWindow(generation);
    if (!opened || generation !== sceneGeneration) return;
    await waitSceneReady(20000, (sceneState.seqMark || 0) + 8, generation);
    if (generation !== sceneGeneration) return;
    sceneState.starting = false;
    broadcastScene();
  });
}

function sceneRelaunch() {
  if (!sceneState.active) {
    if (current && kindOf(current) === 'scene') return sceneStart(current);
    return Promise.resolve();
  }
  const generation = sceneGeneration;
  const wallpaperId = sceneState.wallpaperId;
  return queueScene(async () => {
    if (generation !== sceneGeneration || wallpaperId !== sceneState.wallpaperId) return;
    sceneState.ready = false;
    sceneState.starting = true;
    sceneState.error = '';
    broadcastScene();
    const opened = await sceneOpenWindow(generation);
    if (!opened || generation !== sceneGeneration) return;
    await waitSceneReady(20000, (sceneState.seqMark || 0) + 8, generation);
    if (generation !== sceneGeneration) return;
    sceneState.starting = false;
    broadcastScene();
  });
}

function sceneApplyFps(fps) {
  const next = Math.max(5, Math.min(60, Math.round(Number(fps) || 24)));
  if (next === sceneState.fps) return Promise.resolve();
  sceneState.fps = next;
  if (!sceneState.active) return Promise.resolve();
  const generation = sceneGeneration;
  const wallpaperId = sceneState.wallpaperId;
  return queueScene(async () => {
    if (generation !== sceneGeneration || wallpaperId !== sceneState.wallpaperId || !sceneState.active) return;
    sceneState.ready = false;
    await startSceneHelper(generation);
    await waitSceneReady(12000, 6, generation);
    broadcastScene();
  });
}

function sceneSetSize(reported) {
  if (!sceneState.active) return;
  const target = sceneTargetSize(getSettings(), reported);
  if (Math.abs(target.w - sceneState.size.w) < 48 && Math.abs(target.h - sceneState.size.h) < 48) return;
  const now = Date.now();
  if (now - sceneState.lastResize < 5000) return;
  sceneState.lastResize = now;
  sceneState.size = target;
  log('scene resize to ' + target.w + 'x' + target.h);
  const generation = sceneGeneration;
  const wallpaperId = sceneState.wallpaperId;
  queueScene(async () => {
    if (generation !== sceneGeneration || wallpaperId !== sceneState.wallpaperId || !sceneState.active) return;
    sceneState.ready = false;
    sceneState.starting = true;
    broadcastScene();
    const opened = await sceneOpenWindow(generation);
    if (!opened || generation !== sceneGeneration) return;
    await waitSceneReady(15000, (sceneState.seqMark || 0) + 8, generation);
    if (generation !== sceneGeneration) return;
    sceneState.starting = false;
    broadcastScene();
  });
}

function proxySceneFrame(res) {
  if (!sceneState.active || !sceneState.port) {
    res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end('scene offline');
    return;
  }
  const upstream = http.get({ host: '127.0.0.1', port: sceneState.port, path: '/frame', timeout: 4000 }, up => {
    if (up.statusCode !== 200) {
      res.writeHead(503, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end('no frame');
      up.resume();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    sceneState.framesServed++;
    up.pipe(res);
  });
  upstream.on('timeout', () => {
    upstream.destroy();
    try { res.writeHead(504, { 'Access-Control-Allow-Origin': '*' }); res.end('timeout'); } catch {}
  });
  upstream.on('error', () => {
    try { res.writeHead(503, { 'Access-Control-Allow-Origin': '*' }); res.end('scene offline'); } catch {}
  });
  res.on('close', () => { try { upstream.destroy(); } catch {} });
}

const SCENE_TITLE_RE = /^VSWE Scene (\d+)-(\d+)$/;

function sceneTitlesFromState() {
  const titles = [];
  try {
    const saved = extensionContext.globalState.get('scene.ownedTitles');
    if (Array.isArray(saved)) titles.push(...saved);
  } catch {}
  try {
    const legacy = extensionContext.globalState.get('scene.lastTitle');
    if (legacy) titles.push(legacy);
  } catch {}
  return Array.from(new Set(titles.map(String).filter(t => SCENE_TITLE_RE.test(t))));
}

async function sceneSaveTitleList(titles) {
  const clean = Array.from(new Set((titles || []).map(String).filter(t => SCENE_TITLE_RE.test(t)))).slice(-60);
  try { await extensionContext.globalState.update('scene.ownedTitles', clean); } catch {}
}

async function sceneRememberTitle(title) {
  if (!SCENE_TITLE_RE.test(String(title || ''))) return;
  const titles = sceneTitlesFromState();
  if (!titles.includes(title)) titles.push(title);
  await sceneSaveTitleList(titles);
}

async function sceneForgetTitles(titles) {
  const drop = new Set((titles || []).map(String));
  if (!drop.size) return;
  await sceneSaveTitleList(sceneTitlesFromState().filter(t => !drop.has(t)));
}

function scenePidAlive(pid) {
  const n = Number(pid);
  if (!n || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

function sceneSceneTitlesForPid(pid) {
  const n = Number(pid);
  const titles = sceneTitlesFromState().filter(t => {
    const m = SCENE_TITLE_RE.exec(t);
    return m && Number(m[1]) === n;
  });
  if (sceneState.title && SCENE_TITLE_RE.test(sceneState.title)) {
    const m = SCENE_TITLE_RE.exec(sceneState.title);
    if (m && Number(m[1]) === n && !titles.includes(sceneState.title)) titles.push(sceneState.title);
  }
  return titles;
}

async function sceneCloseTitle(title) {
  if (!SCENE_TITLE_RE.test(String(title || ''))) return;
  const exe = sceneHelperPath();
  if (exe) {
    // WM_CLOSE 只作用于带唯一 VSWE 标题的预览窗口，不会拉起 WE 主界面。
    await runExe(exe, ['close', title], 4500);
    const gone = await runExe(exe, ['waitgone', title, '1200'], 2600);
    if (gone.ok) return;
  }
  if (await weIsRunning()) await weControl(['closeWallpaper', '-location', title]);
  if (exe) {
    const gone = await runExe(exe, ['waitgone', title, '1600'], 3000);
    if (gone.ok) return;
    await runExe(exe, ['close', title], 4000);
  }
}

async function sceneCloseTitles(titles) {
  const unique = Array.from(new Set((titles || []).filter(t => SCENE_TITLE_RE.test(String(t || '')))));
  for (const title of unique) {
    try { await sceneCloseTitle(title); } catch (e) { log('close scene title failed: ' + String(e)); }
  }
  if (unique.length) await sceneForgetTitles(unique);
}

function killStaleSceneHelpers() {
  return new Promise(resolve => {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='scene-helper.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) { resolve(); return; }
      let rows = [];
      try {
        const parsed = JSON.parse(String(stdout).trim());
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch { resolve(); return; }
      for (const row of rows) {
        const helperPid = Number(row && row.ProcessId);
        const owner = /(?:serve|place)\s+VSWE Scene\s+(\d+)-/i.exec(String((row && row.CommandLine) || ''));
        if (!helperPid || !owner) continue;
        const ownerPid = Number(owner[1]);
        if (ownerPid === process.pid || scenePidAlive(ownerPid)) continue;
        try { execFile('taskkill', ['/PID', String(helperPid), '/F'], { windowsHide: true }, () => {}); } catch {}
      }
      resolve();
    });
  });
}

async function cleanupStaleScene() {
  await killStaleSceneHelpers();
  const titles = sceneTitlesFromState();
  const stale = titles.filter(t => {
    const m = SCENE_TITLE_RE.exec(t);
    const pid = m ? Number(m[1]) : 0;
    return pid !== process.pid && !scenePidAlive(pid);
  });
  if (stale.length && await weIsRunning()) await sceneCloseTitles(stale);
  const keep = sceneTitlesFromState().filter(t => {
    const m = SCENE_TITLE_RE.exec(t);
    return m && Number(m[1]) !== process.pid && scenePidAlive(Number(m[1]));
  });
  await sceneSaveTitleList(keep);
  try { await extensionContext.globalState.update('scene.lastTitle', ''); } catch {}
}

/* ---------------- workbench injection ---------------- */

function appRoot() { return vscode.env.appRoot; }

function workbenchDirs() {
  const root = appRoot();
  return [
    path.join(root, 'out', 'vs', 'code', 'electron-browser', 'workbench'),
    path.join(root, 'out', 'vs', 'code', 'electron-sandbox', 'workbench'),
    path.join(root, 'out', 'vs', 'workbench')
  ];
}

function findWorkbenchHtml() {
  for (const dir of workbenchDirs()) {
    const file = path.join(dir, 'workbench.html');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function htmlRelPath(htmlPath) {
  return path.relative(path.join(appRoot(), 'out'), htmlPath).split(path.sep).join('/');
}

function sha256base64(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '');
}

function readProductJson() {
  const productPath = path.join(appRoot(), 'product.json');
  if (!fs.existsSync(productPath)) return null;
  try {
    return { path: productPath, json: JSON.parse(fs.readFileSync(productPath, 'utf8')) };
  } catch (e) {
    log('product.json parse failed: ' + String(e));
    return null;
  }
}

function checksumState(files) {
  const product = readProductJson();
  if (!product || !product.json.checksums) return { available: false, items: [], product: null };
  const items = [];
  for (const rel of files) {
    const abs = path.join(appRoot(), 'out', ...rel.split('/'));
    const raw = product.json.checksums[rel];
    const expected = typeof raw === 'string' ? raw.replace(/=+$/, '') : null;
    const actual = fs.existsSync(abs) ? sha256base64(abs) : null;
    items.push({ rel, abs, expected, actual, ok: expected !== null && actual !== null && expected === actual });
  }
  return { available: true, items, product };
}

// VS Code 的 product.json 使用「无填充」Base64（43 字符）。
// 如果写成带 "=" 的 44 字符形式，VS Code 会提示 “安装似乎损坏，请重新安装”。
function updateChecksums(files) {
  const before = checksumState(files);
  if (!before.available) return { changed: [], mismatch: [] };
  const changed = [];
  for (const item of before.items) {
    if (item.actual === null) continue;
    if (!Object.prototype.hasOwnProperty.call(before.product.json.checksums, item.rel)) continue;
    if (item.expected !== item.actual) {
      before.product.json.checksums[item.rel] = item.actual;
      changed.push(item.rel);
    }
  }
  if (changed.length) {
    try {
      fs.writeFileSync(before.product.path, JSON.stringify(before.product.json, null, '\t'), 'utf8');
      log('checksums repaired: ' + changed.join(', '));
    } catch (e) {
      log('checksum write failed: ' + String(e));
      return { changed: [], mismatch: files.slice() };
    }
  }
  const after = checksumState(files);
  return { changed, mismatch: after.items.filter(i => !i.ok).map(i => i.rel) };
}

function fileEquals(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function copyIfChanged(src, dest) {
  if (!fs.existsSync(src)) return false;
  if (fileEquals(src, dest)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function cleanOldInjection(html, htmlPath) {
  let out = html;
  const oldBlockRe = new RegExp('\\s*' + escapeRe(OLD_START) + '[\\s\\S]*?' + escapeRe(OLD_END), 'g');
  if (out.match(oldBlockRe)) out = out.replace(oldBlockRe, '');
  out = out.split('Content-Security-Policy--replaced-by-wallpaper-engine-plugin').join('Content-Security-Policy');

  const jsCandidates = [
    path.join(appRoot(), 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    path.join(path.dirname(htmlPath), 'workbench.desktop.main.js')
  ];
  for (const js of jsCandidates) {
    if (!fs.existsSync(js)) continue;
    try {
      const content = fs.readFileSync(js, 'utf8');
      const re = /\s*\/\* \[VSCode-Wallpaper-Injection-Start\] \*\/[\s\S]*?\/\* \[VSCode-Wallpaper-Injection-End\] \*\//g;
      if (content.match(re)) {
        fs.writeFileSync(js, content.replace(re, ''), 'utf8');
        updateChecksums(['vs/workbench/workbench.desktop.main.js']);
        log('removed legacy JS injection');
      }
    } catch (e) { log('legacy cleanup failed: ' + String(e)); }
  }
  return out;
}

function buildCsp() {
  return [
    "default-src 'self' vscode-file: file: data: blob: http://127.0.0.1:* https:;",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: vscode-file: file: http://127.0.0.1:*;",
    "style-src 'self' 'unsafe-inline' data: vscode-file: file: http://127.0.0.1:*;",
    "img-src 'self' data: blob: vscode-file: file: http://127.0.0.1:* https:;",
    "media-src 'self' blob: data: vscode-file: file: http://127.0.0.1:* https:;",
    "font-src 'self' data: vscode-file: file: http://127.0.0.1:* https: https://*.vscode-unpkg.net;",
    "connect-src 'self' ws: wss: vscode-file: file: http://127.0.0.1:* https:;",
    "frame-src 'self' vscode-webview: http://127.0.0.1:* https:;"
  ].join(' ');
}
function injectResult(htmlPath, extra) {
  return Object.assign({
    ok: false,
    rel: htmlPath ? htmlRelPath(htmlPath) : '',
    htmlChanged: false,
    checksumsChanged: [],
    mismatch: [],
    needsReload: false,
    previousPort: 0,
    previousVersion: ''
  }, extra || {});
}

function readInjectionInfo(html) {
  const info = { port: 0, version: '' };
  const m = /vswe-bootstrap\.js\?([^"']+)/i.exec(html);
  if (!m) return info;
  const pm = /(?:^|&)port=(\d+)/.exec(m[1]);
  const vm = /(?:^|&)v=([^&"']+)/.exec(m[1]);
  if (pm) info.port = parseInt(pm[1], 10) || 0;
  if (vm) { try { info.version = decodeURIComponent(vm[1]); } catch { info.version = vm[1]; } }
  return info;
}

function ensureInjected(opts) {
  const quiet = !!(opts && opts.quiet);
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) {
    if (!quiet) vscode.window.showErrorMessage('未找到 VS Code workbench.html，无法注入壁纸。');
    return injectResult(null, { error: 'workbench.html not found' });
  }
  try {
    const dir = path.dirname(htmlPath);
    const backup = htmlPath + '.vswe-orig';
    let html = fs.readFileSync(htmlPath, 'utf8');
    const previous = readInjectionInfo(html);
    // 只备份「未注入」的原始文件，绝不用已注入的文件覆盖备份
    if (!fs.existsSync(backup) && !html.includes(MARK_START)) fs.copyFileSync(htmlPath, backup);
    html = cleanOldInjection(html, htmlPath);

    const bootstrapChanged = copyIfChanged(path.join(extensionContext.extensionPath, 'media', 'bootstrap.js'), path.join(dir, BOOTSTRAP));
    copyIfChanged(path.join(extensionContext.extensionPath, 'media', 'we-mock.js'), path.join(dir, WE_MOCK));
    const cssPath = path.join(dir, 'vswe-bootstrap.css');
    const css = '/* VSCode Wallpaper Engine (fixed) */\n';
    if (!fs.existsSync(cssPath) || fs.readFileSync(cssPath, 'utf8') !== css) fs.writeFileSync(cssPath, css, 'utf8');

    const block = [
      MARK_START,
      '<link rel="stylesheet" href="./vswe-bootstrap.css" />',
      '<script src="./' + BOOTSTRAP + '?port=' + serverPort + '&v=' + encodeURIComponent(EXT_VERSION) + '"></script>',
      MARK_END
    ].join('\n');

    const blockRe = new RegExp('\\s*' + escapeRe(MARK_START) + '[\\s\\S]*?' + escapeRe(MARK_END));
    if (blockRe.test(html)) html = html.replace(blockRe, '\n' + block);
    else if (html.includes('</body>')) html = html.replace('</body>', block + '\n</body>');
    else html = html + '\n' + block;

    const metaRe = /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i;
    const cspTag = '<meta http-equiv="Content-Security-Policy" content="' + buildCsp() + '" />';
    if (metaRe.test(html)) html = html.replace(metaRe, cspTag);
    else html = html.replace('</head>', cspTag + '\n</head>');

    let htmlChanged = false;
    if (fs.readFileSync(htmlPath, 'utf8') !== html) {
      fs.writeFileSync(htmlPath, html, 'utf8');
      htmlChanged = true;
      log('workbench.html patched');
    }

    const sums = updateChecksums([htmlRelPath(htmlPath)]);
    if (sums.mismatch.length) log('checksum mismatch remains: ' + sums.mismatch.join(', '));
    // 页面已经在运行时无法换掉它加载的旧 bootstrap；只有首次注入、
    // 版本升级或脚本内容变化时才需要重新加载窗口。端口变化由新 bootstrap
    // 的窗口指纹匹配处理，不需要重载。
    const needsReload = !previous.version || previous.version !== EXT_VERSION || bootstrapChanged;
    return injectResult(htmlPath, {
      ok: sums.mismatch.length === 0,
      htmlChanged,
      checksumsChanged: sums.changed,
      mismatch: sums.mismatch,
      needsReload,
      previousPort: previous.port,
      previousVersion: previous.version
    });
  } catch (e) {
    log('injection failed: ' + String(e));
    if (!quiet) vscode.window.showErrorMessage('注入失败：' + String(e) + '。如果 VS Code 安装在 Program Files，请以管理员身份运行一次。');
    return injectResult(htmlPath, { error: String(e) });
  }
}

function removeInjection() {
  const htmlPath = findWorkbenchHtml();
  if (!htmlPath) return;
  try {
    const backup = htmlPath + '.vswe-orig';
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, htmlPath);
      try { fs.unlinkSync(backup); } catch {}
    } else {
      let html = fs.readFileSync(htmlPath, 'utf8');
      html = cleanOldInjection(html, htmlPath);
      html = html.replace(new RegExp('\\s*' + escapeRe(MARK_START) + '[\\s\\S]*?' + escapeRe(MARK_END), 'g'), '');
      fs.writeFileSync(htmlPath, html, 'utf8');
    }
    const dir = path.dirname(htmlPath);
    for (const f of [BOOTSTRAP, 'vswe-bootstrap.css', WE_MOCK]) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    updateChecksums([htmlRelPath(htmlPath)]);
    log('injection removed');
  } catch (e) {
    log('remove injection failed: ' + String(e));
  }
}
/* ---------------- http server ---------------- */

function mimeOf(file) {
  const map = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.wasm': 'application/wasm', '.frag': 'text/plain', '.vert': 'text/plain', '.glsl': 'text/plain',
    '.txt': 'text/plain; charset=utf-8'
  };
  return map[extOf(file)] || 'application/octet-stream';
}

function serveFile(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not Found'); return; }
  if (!stat.isFile()) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not Found'); return; }
  const headers = {
    'Content-Type': mimeOf(file),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      let start = m[1] === '' ? undefined : parseInt(m[1], 10);
      let end = m[2] === '' ? undefined : parseInt(m[2], 10);
      if (start === undefined && end !== undefined) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
      if (start === undefined) start = 0;
      if (end === undefined || end >= stat.size) end = stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, Object.assign({}, headers, { 'Content-Range': 'bytes */' + stat.size }));
        res.end();
        return;
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  headers['Content-Length'] = String(stat.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

function sendJson(res, obj, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(obj));
}

function themeKind() {
  const k = vscode.window.activeColorTheme.kind;
  return (k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight) ? 'light' : 'dark';
}

function metaPayload() {
  const kind = current ? kindOf(current) : 'none';
  return {
    ok: true,
    port: serverPort,
    wallpaper: current ? {
      id: current.id,
      title: current.title,
      type: current.type,
      kind,
      kindLabel: kindLabel(kind),
      entry: current.file,
      preview: current.preview,
      root: current.dir,
      location: current.location
    } : null,
    settings: getSettings(),
    theme: themeKind(),
    scene: sceneInfo(),
    urls: { media: '/media', preview: '/preview', page: '/', file: '/file', sceneFrame: '/scene/frame' }
  };
}

function broadcast(payload) {
  const data = 'data: ' + JSON.stringify(payload) + '\n\n';
  for (const client of Array.from(sseClients)) {
    try { client.write(data); } catch { sseClients.delete(client); }
  }
}

function pushConfig(reload) {
  if (reload) reloadFlag = true;
  broadcast({ type: 'config', settings: getSettings(), reload: !!reload, meta: metaPayload() });
}

function randomFileForProperty(prop) {
  if (!current) return null;
  const project = current.project || {};
  const props = project.properties || (project.general && project.general.properties) || {};
  let value = '';
  if (props[prop]) value = String(props[prop].value || props[prop].default || '');
  else {
    const key = Object.keys(props).find(k => k.toLowerCase() === String(prop).toLowerCase());
    if (key) value = String(props[key].value || props[key].default || '');
  }
  if (!value) return null;
  const dir = path.join(current.dir, value.replace(/^[\\/]+/, ''));
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png|gif|webp|mp4|webm)$/i.test(f));
    if (!files.length) return null;
    const pick = files[Math.floor(Math.random() * files.length)];
    return 'http://127.0.0.1:' + serverPort + '/file/' + encodeURI(value.split('\\').join('/')) + '/' + encodeURIComponent(pick);
  } catch { return null; }
}

function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  let pathname = url.pathname;
  try { pathname = decodeURIComponent(pathname); } catch {}

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Private-Network': 'true'
    });
    res.end();
    return;
  }

  if (pathname === '/ping') {
    const want = String(url.searchParams.get('window') || '').trim().toLowerCase();
    const mine = windowKey();
    const match = !!(want && mine && want === mine);
    sendJson(res, {
      ok: true,
      port: serverPort,
      version: EXT_VERSION,
      window: match,
      pid: process.pid,
      reload: reloadFlag
    });
    reloadFlag = false;
    return;
  }

  if (pathname === '/status') { sendJson(res, { running: true, port: serverPort, version: EXT_VERSION, wallpaper: current ? current.id : null }); return; }
  if (pathname === '/scene/frame') { proxySceneFrame(res); return; }
  if (pathname === '/scene/status') { sendJson(res, sceneInfo()); return; }
  if (pathname === '/api/scene-size') {
    const sizeW = Number(url.searchParams.get('w') || 0);
    const sizeH = Number(url.searchParams.get('h') || 0);
    const sizeDpr = Number(url.searchParams.get('dpr') || 1);
    if (sizeW > 0 && sizeH > 0) sceneSetSize({ w: sizeW, h: sizeH, dpr: sizeDpr });
    sendJson(res, { ok: true, size: sceneState.size });
    return;
  }
  if (pathname === '/api/scene-props' && req.method === 'POST') {
    let sceneBody = '';
    req.on('data', chunk => { sceneBody += chunk; if (sceneBody.length > 2000000) req.destroy(); });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(sceneBody); } catch {}
      if (!payload || typeof payload !== 'object') { sendJson(res, { ok: false, error: 'invalid json' }, 400); return; }
      sceneApplyValues(payload.values || payload).then(() => sendJson(res, { ok: true, scene: sceneInfo() }));
    });
    return;
  }
  if (pathname === '/api/scene-reload') {
    sceneRelaunch().then(() => sendJson(res, { ok: true, scene: sceneInfo() }));
    return;
  }
  if (pathname === '/meta' || pathname === '/config') { sendJson(res, metaPayload()); return; }

  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('retry: 1500\n\n');
    res.write('data: ' + JSON.stringify({ type: 'config', settings: getSettings(), meta: metaPayload() }) + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let patch = null;
      try { patch = JSON.parse(body); } catch {}
      if (!patch || typeof patch !== 'object') { sendJson(res, { ok: false, error: 'invalid json' }, 400); return; }
      updateSettings(patch, { persist: true }).then(() => sendJson(res, { ok: true, settings: getSettings() }));
    });
    return;
  }

  if (pathname === '/api/readdir') {
    const rel = String(url.searchParams.get('path') || '').replace(/^[\\/]+/, '');
    const files = [];
    try {
      if (current) {
        const target = path.join(current.dir, rel);
        if (target.startsWith(current.dir)) for (const name of fs.readdirSync(target)) files.push(name);
      }
    } catch {}
    sendJson(res, files);
    return;
  }

  if (pathname === '/api/random-file') { sendJson(res, { file: randomFileForProperty(url.searchParams.get('prop') || '') }); return; }

  if (pathname === '/shutdown') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
    setTimeout(() => stopServer(), 100);
    return;
  }

  if (pathname === '/project.json') { sendJson(res, current ? current.project : {}); return; }

  if (pathname === '/open-folder') {
    if (current) vscode.env.openExternal(vscode.Uri.file(current.dir));
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    res.end('ok');
    return;
  }

  if (pathname === '/proxy') {
    const target = url.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) { res.writeHead(400, { 'Access-Control-Allow-Origin': '*' }); res.end('bad url'); return; }
    try {
      const lib = target.startsWith('https:') ? require('https') : http;
      const up = lib.get(target, { headers: { 'user-agent': 'Mozilla/5.0 VSCodeWallpaperEngine' } }, r => {
        res.writeHead(r.statusCode || 200, { 'Content-Type': r.headers['content-type'] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        r.pipe(res);
      });
      up.on('error', () => { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end('proxy error'); });
      up.setTimeout(15000, () => { up.destroy(); });
    } catch (e) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end('proxy error'); }
    return;
  }

  if (pathname === '/mock-api.js' || pathname === '/vswe-we-mock.js') {
    let src = '';
    try { src = fs.readFileSync(path.join(path.dirname(findWorkbenchHtml() || ''), WE_MOCK), 'utf8'); } catch {}
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(src.split('__PORT__').join(String(serverPort)));
    return;
  }

  if (pathname === '/media') {
    if (!current) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('no wallpaper'); return; }
    serveFile(req, res, path.join(current.dir, current.file));
    return;
  }

  if (pathname === '/preview') {
    if (!current || !current.preview) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('no preview'); return; }
    serveFile(req, res, path.join(current.dir, current.preview));
    return;
  }

  if (pathname === '/file' || pathname.startsWith('/file/')) {
    const rel = pathname === '/file' ? String(url.searchParams.get('p') || '') : pathname.slice('/file/'.length);
    if (!current) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('no wallpaper'); return; }
    const base = path.normalize(current.dir);
    const target = path.normalize(path.join(base, rel));
    if (!target.startsWith(base)) { res.writeHead(403, { 'Access-Control-Allow-Origin': '*' }); res.end('forbidden'); return; }
    serveFile(req, res, target);
    return;
  }

  if (pathname === '/' && current && kindOf(current) === 'web') {
    const entry = path.join(current.dir, current.file || 'index.html');
    let html = '';
    try { html = fs.readFileSync(entry, 'utf8'); } catch {}
    if (!html) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('missing index.html'); return; }
    const inject = '<script src="/mock-api.js"></script><script>window.__VSWE_WEB__=true;</script>';
    if (!/<base\s/i.test(html)) {
      const base = '<base href="http://127.0.0.1:' + serverPort + '/file/" />';
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + base) : base + html;
    }
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : inject + html;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(html);
    return;
  }

  if (current) {
    const base = path.normalize(current.dir);
    const target = path.normalize(path.join(base, pathname.replace(/^\/+/, '')));
    if (target.startsWith(base) && fs.existsSync(target)) { serveFile(req, res, target); return; }
  }

  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end('Not Found');
}

function startServer() {
  if (httpServer) return Promise.resolve(serverPort);
  const preferred = getSettings().serverPort || 23333;
  return new Promise(resolve => {
    let attempt = 0;
    const tryListen = port => {
      const srv = http.createServer(handleRequest);
      srv.once('error', err => {
        if (err.code === 'EADDRINUSE' && attempt < 10) { attempt++; tryListen(port + 1); }
        else { log('server error: ' + String(err)); resolve(null); }
      });
      srv.listen(port, '127.0.0.1', () => {
        httpServer = srv;
        serverPort = port;
        heartbeat = setInterval(() => {
          for (const client of Array.from(sseClients)) {
            try { client.write(': ping\n\n'); } catch { sseClients.delete(client); }
          }
        }, 20000);
        log('server listening on ' + port);
        resolve(port);
      });
    };
    tryListen(preferred);
  });
}

function stopServer() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  for (const client of Array.from(sseClients)) { try { client.end(); } catch {} }
  sseClients.clear();
  if (httpServer) {
    try { httpServer.closeAllConnections && httpServer.closeAllConnections(); } catch {}
    try { httpServer.close(); } catch {}
    httpServer = null;
    log('server stopped');
  }
}

/* ---------------- actions ---------------- */

async function applyWallpaper(item, opts) {
  opts = opts || {};
  if (!item) return;
  current = item;
  await startServer();
  ensureInjected({ quiet: true });
  if (kindOf(item) === 'scene') {
    sceneStart(item).catch(e => log('scene start error: ' + String(e)));
  } else {
    sceneStop().catch(() => {});
  }
  if (opts.persist !== false) {
    try { await cfg().update('wallpaperId', item.id, vscode.ConfigurationTarget.Global); } catch {}
  }
  reloadFlag = true;
  broadcast({ type: 'wallpaper', meta: metaPayload(), settings: getSettings() });
  if (!opts.silent) vscode.window.setStatusBarMessage('壁纸已切换：' + item.title, 4000);
  if (opts.reload) setTimeout(() => vscode.commands.executeCommand('workbench.action.reloadWindow'), 300);
}

async function updateSettings(patch, opts) {
  const allowed = ['backgroundOpacity', 'transparencyEnabled', 'transparencyBaseColor', 'transparencyRules',
    'customCss', 'customJs', 'pauseOnBlur', 'staticKenBurns', 'autoSync', 'syncMonitor',
    'sceneEnabled', 'sceneFps', 'sceneQuality', 'sceneMaxWidth', 'sceneMuted'];
  const c = cfg();
  let touched = false;
  for (const key of Object.keys(patch || {})) {
    if (!allowed.includes(key)) continue;
    overrides[key] = patch[key];
    touched = true;
  }
  if (!touched) return;
  pushConfig(true);
  if (Object.prototype.hasOwnProperty.call(patch, 'sceneFps')) sceneApplyFps(patch.sceneFps);
  if (Object.prototype.hasOwnProperty.call(patch, 'sceneEnabled')) {
    if (patch.sceneEnabled === false) sceneStop().catch(() => {});
    else if (current && kindOf(current) === 'scene') sceneStart(current).catch(() => {});
  }
  for (const key of Object.keys(patch || {})) {
    if (!allowed.includes(key)) continue;
    const value = patch[key];
    Promise.resolve()
      .then(() => c.update(key, value, vscode.ConfigurationTarget.Global))
      .catch(e => log('persist failed ' + key + ': ' + String(e)));
  }
}

async function commandSetWallpaper() {
  const settings = getSettings();
  if (!settings.workshopPath) {
    const r = await vscode.window.showWarningMessage('请先设置 Wallpaper Engine 创意工坊目录。', '打开设置');
    if (r) vscode.commands.executeCommand('workbench.action.openSettings', 'vscode-wallpaper-engine.workshopPath');
    return;
  }
  const all = scanWallpapers(settings.workshopPath);
  if (!all.length) { vscode.window.showWarningMessage('未在该目录找到壁纸：' + settings.workshopPath); return; }
  const order = { video: 0, web: 1, image: 2, scene: 3, unknown: 4 };
  all.sort((a, b) => (order[kindOf(a)] - order[kindOf(b)]) || a.title.localeCompare(b.title));
  const items = all.map(w => {
    const kind = kindOf(w);
    return {
      label: w.title,
      description: '[' + kindLabel(kind) + ']  ' + w.id,
      detail: w.file + (kind === 'scene' ? '   · 使用 Wallpaper Engine 官方动画预览' : ''),
      item: w,
      kind
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: '选择壁纸（可输入搜索）· 视频 / Web = 完整动态，场景 = 官方动画预览',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!picked) return;
  await applyWallpaper(picked.item, { reload: false });
  vscode.window.showInformationMessage('已应用：' + picked.item.title + '（' + kindLabel(picked.kind) + '）');
}

async function commandSync() {
  const settings = getSettings();
  if (!settings.workshopPath) { vscode.window.showWarningMessage('请先设置 workshopPath。'); return; }
  const item = syncFromEngine(settings, { verbose: true });
  if (!item) return;
  await applyWallpaper(item, { reload: false });
  vscode.window.showInformationMessage('已同步 Wallpaper Engine 当前壁纸：' + item.title + '（' + kindLabel(kindOf(item)) + '）');
}

async function commandRepairInstallation() {
  const result = ensureInjected({ quiet: true });
  if (!result.ok) {
    const detail = result.error || ('校验值仍不一致：' + (result.mismatch || []).join(', '));
    const pick = await vscode.window.showErrorMessage('安装校验修复失败：' + detail, '打开日志');
    if (pick === '打开日志' && output) output.show(true);
    return;
  }
  const state = checksumState([result.rel]).items[0];
  const healthy = !!state && state.ok && !result.htmlChanged && !result.checksumsChanged.length;
  if (healthy) {
    vscode.window.showInformationMessage('VS Code 注入与完整性校验均正常，无需修复。');
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    '已修复 VS Code 注入与完整性校验（不会再提示“安装似乎损坏”）。重新加载窗口后生效。',
    '重新加载窗口'
  );
  if (pick === '重新加载窗口') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/* ---------------- settings webview ---------------- */

let settingsPanel = null;

function openSettingsPanel(context) {
  if (settingsPanel) { settingsPanel.reveal(); return; }
  const panel = vscode.window.createWebviewPanel(
    'vsweSettings', 'Wallpaper Engine 设置', vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  settingsPanel = panel;
  panel.onDidDispose(() => { settingsPanel = null; });

  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  panel.webview.html = fs.readFileSync(path.join(mediaRoot.fsPath, 'settings.html'), 'utf8')
    .replace(/{{css}}/g, panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.css')).toString())
    .replace(/{{js}}/g, panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.js')).toString())
    .replace(/{{cspSource}}/g, panel.webview.cspSource);

  const post = () => {
    const s = getSettings();
    panel.webview.postMessage({
      type: 'state',
      settings: s,
      wallpaper: current ? {
        id: current.id, title: current.title, kind: kindOf(current),
        kindLabel: kindLabel(kindOf(current)), file: current.file, dir: current.dir
      } : null,
      scene: sceneInfo(),
      library: scanWallpapers(s.workshopPath).map(w => ({ id: w.id, title: w.title, kind: kindOf(w), kindLabel: kindLabel(kindOf(w)) }))
    });
  };
  post();

  panel.webview.onDidReceiveMessage(async msg => {
    if (!msg || !msg.type) return;
    if (msg.type === 'ready') { post(); return; }
    if (msg.type === 'update') { await updateSettings(msg.patch || {}, { persist: true }); post(); return; }
    if (msg.type === 'switch') { await commandSetWallpaper(); post(); return; }
    if (msg.type === 'sync') { await commandSync(); post(); return; }
    if (msg.type === 'refresh') {
      reloadFlag = true;
      broadcast({ type: 'wallpaper', meta: metaPayload(), settings: getSettings() });
      post();
      return;
    }
    if (msg.type === 'folder') { if (current) vscode.env.openExternal(vscode.Uri.file(current.dir)); return; }
    if (msg.type === 'pick') {
      const s = getSettings();
      const item = readWallpaper(s.workshopPath, msg.id);
      if (item) { await applyWallpaper(item, { reload: false }); post(); }
      return;
    }
    if (msg.type === 'sceneProps') { await sceneApplyValues(msg.values || {}); post(); return; }
    if (msg.type === 'sceneReload') { await sceneRelaunch(); post(); return; }
    if (msg.type === 'sceneSyncDesktop') { await sceneResyncDesktop(); post(); return; }
    if (msg.type === 'sceneStatus') { panel.webview.postMessage({ type: 'scene', scene: sceneInfo() }); return; }
    if (msg.type === 'openNativeSettings') { vscode.commands.executeCommand('workbench.action.openSettings', 'vscode-wallpaper-engine'); return; }
  });
}

/* ---------------- activation ---------------- */

async function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Wallpaper Engine');
  cleanupStaleScene().catch(() => {});
  context.subscriptions.push(output);

  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.setWallpaper', commandSetWallpaper));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.syncWallpaper', commandSync));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.openSettings', () => openSettingsPanel(context)));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.refreshWallpaper', () => {
    reloadFlag = true;
    broadcast({ type: 'wallpaper', meta: metaPayload(), settings: getSettings() });
    vscode.window.setStatusBarMessage('壁纸已刷新', 2000);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.repairInstallation', commandRepairInstallation));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.restartScene', () => {
    if (!current || kindOf(current) !== 'scene') {
      vscode.window.showInformationMessage('当前壁纸不是场景（Scene）类型。');
      return;
    }
    vscode.window.setStatusBarMessage('正在重启场景实时渲染…', 3000);
    sceneRelaunch();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.clearWallpaper', () => {
    current = null;
    sceneStop().catch(() => {});
    reloadFlag = true;
    broadcast({ type: 'wallpaper', meta: metaPayload(), settings: getSettings() });
    vscode.window.setStatusBarMessage('壁纸已关闭（重新打开需执行“设置壁纸”）', 4000);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.openFolder', () => {
    if (current) vscode.env.openExternal(vscode.Uri.file(current.dir));
    else vscode.window.showInformationMessage('当前没有加载壁纸。');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('vscode-wallpaper-engine.uninstallWallpaper', async () => {
    const answer = await vscode.window.showWarningMessage('将移除注入到 VS Code 的壁纸代码并恢复原始文件。继续？', { modal: true }, '卸载');
    if (answer !== '卸载') return;
    stopServer();
    removeInjection();
    vscode.window.showInformationMessage('已清理注入。请重启 VS Code 生效。');
  }));

  const settings = getSettings();
  if (settings.wallpaperId && settings.workshopPath) current = readWallpaper(settings.workshopPath, settings.wallpaperId);
  if (settings.autoSync) {
    const synced = syncFromEngine(settings);
    if (synced) current = synced;
  }

  await startServer();
  const inject = ensureInjected({ quiet: true });
  watchEngineConfig();

  // 首次安装 / 升级后，当前页面仍加载着旧脚本。除了检查注入文件，
  // 还要用 globalState 记录「上次激活的扩展版本」，否则当另一个窗口
  // 已经把 workbench.html 写成新版本时，本窗口会误以为自己已经加载了新脚本。
  let lastActivatedVersion = '';
  try { lastActivatedVersion = String(extensionContext.globalState.get('activation.version') || ''); } catch {}
  const versionChanged = lastActivatedVersion !== EXT_VERSION;

  // 自动重载一次；用 globalState 记录时间，避免写入失败时无限重载。
  if ((inject.needsReload || versionChanged) && inject.ok) {
    try { await extensionContext.globalState.update('activation.version', EXT_VERSION); } catch {}
    let lastReload = 0;
    try { lastReload = Number(extensionContext.globalState.get('injection.reloadAt') || 0); } catch {}
    try { await sceneStop(); } catch {}
    if (Date.now() - lastReload > 15000) {
      try { await extensionContext.globalState.update('injection.reloadAt', Date.now()); } catch {}
      vscode.window.setStatusBarMessage('壁纸注入已更新，正在自动重新加载窗口…', 6000);
      setTimeout(() => { vscode.commands.executeCommand('workbench.action.reloadWindow'); }, 900);
    } else {
      const pick = await vscode.window.showInformationMessage('壁纸注入已更新，需要重新加载窗口后生效。', '重新加载窗口');
      if (pick === '重新加载窗口') vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return;
  }

  if (!inject.ok) {
    const pick = await vscode.window.showWarningMessage(
      '壁纸注入失败：' + (inject.error || ('校验值不一致：' + (inject.mismatch || []).join(', '))),
      '打开日志', '立即修复'
    );
    if (pick === '打开日志' && output) output.show(true);
    else if (pick === '立即修复') await commandRepairInstallation();
  } else if (inject.checksumsChanged.length) {
    vscode.window.setStatusBarMessage('已自动修复 VS Code 安装校验（“安装似乎损坏”提示）。', 5000);
  }

  if (current && kindOf(current) === 'scene') {
    sceneStart(current).catch(e => log('scene start error: ' + String(e)));
  }

function reconcileOverrides() {
  const c = cfg();
  for (const key of Object.keys(overrides)) {
    try {
      const v = c.get(key);
      if (JSON.stringify(v) === JSON.stringify(overrides[key])) delete overrides[key];
    } catch {}
  }
}

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('vscode-wallpaper-engine.autoSync') || e.affectsConfiguration('vscode-wallpaper-engine.wallpaperEnginePath')) {
      watchEngineConfig();
    }
    reconcileOverrides();
    if (e.affectsConfiguration('vscode-wallpaper-engine.transparencyRules') ||
        e.affectsConfiguration('vscode-wallpaper-engine.transparencyEnabled') ||
        e.affectsConfiguration('vscode-wallpaper-engine.transparencyBaseColor') ||
        e.affectsConfiguration('vscode-wallpaper-engine.backgroundOpacity') ||
        e.affectsConfiguration('vscode-wallpaper-engine.customCss') ||
        e.affectsConfiguration('vscode-wallpaper-engine.customJs') ||
        e.affectsConfiguration('vscode-wallpaper-engine.pauseOnBlur') ||
        e.affectsConfiguration('vscode-wallpaper-engine.staticKenBurns')) {
      pushConfig(false);
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => pushConfig(false)));
}

function deactivate() {
  if (weWatchTimer) clearTimeout(weWatchTimer);
  if (weWatcher) { try { weWatcher.close(); } catch {} }
  const closing = sceneStop().catch(() => {});
  stopServer();
  return closing;
}

module.exports = {
  activate,
  deactivate,
  __test: {
    ensureInjected,
    readWallpaper,
    sceneStart,
    sceneStop,
    sceneApplyValues,
    sceneResyncDesktop,
    sceneInfo,
    sceneState,
    readSceneProps,
    scenePropLabel,
    scenePlainText,
    sceneLabelUsable,
    setCurrent: item => { current = item; },
    checksumState,
    updateChecksums,
    sha256base64,
    setContext: ctx => { extensionContext = ctx; }
  }
};
