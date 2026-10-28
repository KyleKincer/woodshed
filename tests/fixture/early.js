// The fixture's first script (architecture §11.2). The fixture's Vite plugin
// serves it as a classic script at /__fixture/early.js and puts it first in
// <head>, ahead of public/theme-init.js, so the pre-paint read of
// localStorage['ws.prefs'] and every later Date already see these switches:
//   fx-reset=1        clear the persisted fixture db (sessionStorage['fx-db']) and every ws.* key
//   fx-prefs=<json>   deep-merge JSON into localStorage['ws.prefs'] ({v: 1} is added when absent)
//   fx-now=<ISO>      shift Date (and so src/app/clock.js now()) to start at that instant;
//                     time keeps flowing from there (use page.clock.setFixedTime to freeze it)
//   fx-view=<group>-<layout>, fx-practice=chart|tracks, fx-notation=score|lanes, fx-overview=1
//                     write the 1.9 ws.* keys, so the one-way prefs migration can be exercised
// It also sets window.__FIXTURE__ = true (src/app/dev-handle.js installs window.__woodshed).
// Everything else (fakes, platform, features) happens in preamble.js, the first module.
(function (win) {
  'use strict';
  var fx = {};
  new URLSearchParams(win.location.search).forEach(function (value, key) { if (key.indexOf('fx-') === 0) fx[key.slice(3)] = value; });
  win.__FIXTURE__ = true;
  var early = win.__FIXTURE_EARLY__ = {fx: fx, now: null};
  var fail = function (message) { win.console.error('[fixture] ' + message); };

  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function merge(target, source) {
    var out = isObject(target) ? Object.assign({}, target) : {};
    Object.keys(source).forEach(function (key) { out[key] = isObject(source[key]) ? merge(out[key], source[key]) : source[key]; });
    return out;
  }
  function keysOf(storage) { var keys = []; for (var i = 0; i < storage.length; i++) keys.push(storage.key(i)); return keys; }

  try {
    var local = win.localStorage, session = win.sessionStorage;
    if (fx.reset === '1') {
      session.removeItem('fx-db');
      keysOf(local).forEach(function (key) { if (key.indexOf('ws.') === 0) local.removeItem(key); });
      keysOf(session).forEach(function (key) { if (key.indexOf('ws.') === 0) session.removeItem(key); });
    }
    if (fx.prefs !== undefined) {
      var patch;
      try { patch = JSON.parse(fx.prefs); } catch (error) { patch = null; }
      if (!isObject(patch)) fail('fx-prefs must be a JSON object, got ' + JSON.stringify(fx.prefs));
      else {
        var current = null;
        try { current = JSON.parse(local.getItem('ws.prefs') || 'null'); } catch (error) { current = null; }
        var next = merge(current, patch);
        if (next.v === undefined) next.v = 1;
        local.setItem('ws.prefs', JSON.stringify(next));
      }
    }
    if (fx.view) { var parts = fx.view.split('-'); local.setItem('ws.view', JSON.stringify({group: parts[0], layout: parts[1] || 'grid'})); }
    if (fx.practice) local.setItem('ws.practice.view', fx.practice);
    if (fx.overview) local.setItem('ws.overview', '1');
    if (fx.notation) local.setItem('ws.notation.layout', fx.notation);
  } catch (error) {
    win.console.warn('[fixture] storage is unavailable:', error && error.message);
  }

  if (fx.now !== undefined) {
    var RealDate = win.Date, target = RealDate.parse(fx.now);
    if (!isFinite(target)) fail('fx-now must be an ISO date, got ' + JSON.stringify(fx.now));
    else {
      var offset = target - RealDate.now();
      var FxDate = function () {
        var args = Array.prototype.slice.call(arguments);
        if (!new.target) return new RealDate(FxDate.now()).toString();
        return Reflect.construct(RealDate, args.length ? args : [RealDate.now() + offset], new.target);
      };
      Object.setPrototypeOf(FxDate, RealDate);
      FxDate.prototype = RealDate.prototype;
      FxDate.now = function () { return RealDate.now() + offset; };
      FxDate.toString = function () { return RealDate.toString(); };
      win.Date = FxDate;
      early.now = {target: target, offset: offset, RealDate: RealDate};
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
