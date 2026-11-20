/* Wallpaper Engine Web API mock for VSCode Wallpaper Engine (fixed) */
(function () {
  'use strict';
  var PORT = __PORT__;
  var ROOT = 'http://127.0.0.1:' + PORT;
  var callbacks = { properties: null, audio: null, general: null };
  var userProps = {};

  window.require = function (name) {
    if (name === 'jquery') return window.jQuery || window.$ || {};
    if (name === 'fs') {
      return {
        readFileSync: function () { return ''; },
        readFile: function (p, cb) { if (cb) cb(null, ''); },
        existsSync: function () { return true; },
        readdir: function (p, cb) {
          fetch(ROOT + '/api/readdir?path=' + encodeURIComponent(p)).then(function (r) { return r.json(); })
            .then(function (f) { if (cb) cb(null, f); }).catch(function (e) { if (cb) cb(e); });
        }
      };
    }
    if (name === 'path') return { join: function () { return Array.prototype.join.call(arguments, '/'); }, resolve: function () { return Array.prototype.join.call(arguments, '/'); } };
    if (name === 'electron') return { ipcRenderer: { on: function () {}, send: function () {}, removeListener: function () {} } };
    return {};
  };
  window.module = { exports: {} };
  window.exports = window.module.exports;
  window.process = { type: 'renderer', versions: { electron: 'mock', chrome: 'mock', node: 'mock' }, platform: 'win32', env: { NODE_ENV: 'production' } };
  window.global = window;
  if (typeof window.Smooth === 'undefined') {
    window.Smooth = function (arr) { return function () { return arr && arr.length ? arr[0] : 0; }; };
    window.Smooth.METHOD_CUBIC = 'cubic';
    window.Smooth.METHOD_LINEAR = 'linear';
    window.Smooth.METHOD_NEAREST = 'nearest';
  }

  Object.defineProperty(window, 'wallpaperPropertyListener', {
    configurable: true,
    set: function (l) {
      callbacks.properties = l;
      callbacks.general = l;
      if (l && l.applyUserProperties) { try { l.applyUserProperties(userProps); } catch (e) {} }
    },
    get: function () { return callbacks.properties; }
  });

  window.wallpaperRegisterAudioListener = function (cb) { callbacks.audio = cb; };
  window.wallpaperRegisterMediaStatusListener = function () {};
  window.wallpaperRegisterMediaPropertiesListener = function () {};
  window.wallpaperRegisterMediaPlaybackListener = function () {};
  window.wallpaperRegisterMediaTimelineListener = function () {};
  window.wallpaperRegisterMediaThumbnailListener = function () {};
  window.wallpaperRegisterMediaThumbnailRequest = function () {};
  window.wallpaperRequestRandomFileForProperty = function (prop, cb) {
    fetch(ROOT + '/api/random-file?prop=' + encodeURIComponent(prop))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (cb) cb(prop, d && d.file ? d.file : null); })
      .catch(function () { if (cb) cb(prop, null); });
  };

  fetch(ROOT + '/project.json').then(function (r) { return r.json(); }).then(function (project) {
    var props = (project && project.properties) || (project && project.general && project.general.properties) || {};
    var preset = (project && project.preset) || {};
    Object.keys(props).forEach(function (k) {
      var p = props[k] || {};
      userProps[k] = preset[k] !== undefined ? preset[k] : (p.value !== undefined ? p.value : p.default);
    });
    if (callbacks.properties && callbacks.properties.applyUserProperties) {
      try { callbacks.properties.applyUserProperties(userProps); } catch (e) {}
    }
  }).catch(function () {});

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d) return;
    if ((d.type === 'UPDATE_PROPERTIES' || d.type === 'PROPERTIES') && callbacks.properties) {
      Object.assign(userProps, d.data || {});
      Object.keys(d.data || {}).forEach(function (k) {
        if (d.data[k] && d.data[k].value !== undefined) userProps[k] = d.data[k].value;
      });
      if (callbacks.properties.applyUserProperties) {
        try { callbacks.properties.applyUserProperties(userProps); } catch (err) {}
      }
    } else if (d.type === 'AUDIO_TICK' && callbacks.audio) {
      try { callbacks.audio(d.data); } catch (err) {}
    } else if (d.type === 'INIT_GENERAL' && callbacks.general && callbacks.general.applyGeneralProperties) {
      try { callbacks.general.applyGeneralProperties({ fps: 60, isActive: true }); } catch (err) {}
    }
  });

  var originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    var self = this;
    return originalPlay.call(this).catch(function (e) {
      if (e && e.name === 'NotAllowedError') { self.muted = true; return originalPlay.call(self); }
      throw e;
    });
  };

  var srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get: srcDesc.get,
      set: function (v) {
        if (v === null || v === undefined || v === 'null' || v === 'undefined') return;
        srcDesc.set.call(this, v);
      }
    });
  }

  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments, 2);
    if (typeof url === 'string' && /^https?:/i.test(url) && url.indexOf('127.0.0.1') < 0 && url.indexOf('localhost') < 0) {
      url = '/proxy?url=' + encodeURIComponent(url);
    }
    return open.apply(this, [method, url].concat(args));
  };
})();
