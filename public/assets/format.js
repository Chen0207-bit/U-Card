/* U-Card 前端公共模块 · format.js
 * 纯格式化函数(无 DOM/请求依赖)。各入口以别名方式接入:
 *   var esc = UC.esc, fmtMoney = UC.money, fmtTime = UC.time, ...
 */
(function (global) {
  'use strict';
  var UC = global.UC = global.UC || {};

  UC.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  UC.money = function (n) {
    return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  UC.money0 = function (n) { return '$' + Math.round(Number(n || 0)).toLocaleString('en-US'); };
  UC.num = function (n) { return Number(n) || 0; }; // NaN/undefined 兜底为 0
  UC.pad2 = function (n) { return String(n).padStart(2, '0'); };
  UC.time = function (ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getFullYear() + '-' + UC.pad2(d.getMonth() + 1) + '-' + UC.pad2(d.getDate()) + ' ' + UC.pad2(d.getHours()) + ':' + UC.pad2(d.getMinutes());
  };
  UC.hash = function (h) { return String(h || '').slice(0, 6) + '…' + String(h || '').slice(-4); };
})(window);
