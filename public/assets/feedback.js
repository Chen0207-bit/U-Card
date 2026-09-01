/* U-Card 前端公共模块 · feedback.js
 * toast 两族:
 *  - UC.toastStack(sel, opts): 堆叠式(后台/商户端, 追加到容器逐条消失)
 *  - UC.toastSingle(sel, opts): 单例式(用户端, 复用同一元素 + on class)
 */
(function (global) {
  'use strict';
  var UC = global.UC = global.UC || {};

  UC.toastStack = function (selector, opts) {
    opts = opts || {};
    var icons = opts.icons === 'span'; // true: <span>❌</span><span>msg</span>; false: 文本前缀 ❌ msg
    var duration = opts.duration || 3200;
    var fade = !!opts.fade; // true: 淡出动画(.out + 260ms 后移除)
    var escFn = UC.esc || String;
    return function (msg, kind) {
      var type = kind === 'err' || kind === 'warn' ? kind : (kind ? 'err' : '');
      var box = document.querySelector(selector);
      if (!box) return;
      var el = document.createElement('div');
      el.className = 'toast' + (type ? ' ' + type : '');
      var icon = type === 'err' ? '❌' : type === 'warn' ? '⚠️' : '✅';
      if (icons) el.innerHTML = '<span>' + icon + '</span><span>' + escFn(msg) + '</span>';
      else el.textContent = icon + ' ' + msg;
      box.appendChild(el);
      setTimeout(function () {
        if (fade) { el.classList.add('out'); setTimeout(function () { el.remove(); }, 260); }
        else el.remove();
      }, duration);
    };
  };

  UC.toastSingle = function (selector, opts) {
    opts = opts || {};
    var timer = null;
    var errMs = opts.errDuration || 3600;
    var okMs = opts.okDuration || 2600;
    return function (msg, type) {
      var el = document.querySelector(selector);
      if (!el) return;
      el.textContent = msg;
      var cls = 'toast' + (type === 'ok' ? ' ok' : type === 'err' ? ' err' : '');
      el.className = cls + ' on';
      clearTimeout(timer);
      timer = setTimeout(function () { el.className = cls; }, type === 'err' ? errMs : okMs);
    };
  };
})(window);
