/* U-Card 前端公共模块 · demo-auth.js
 * Demo 免密身份: localStorage 持久化 + 账号下拉加载。
 * 三个入口复用同一模式(x-sales / x-user / x-mch)。
 */
(function (global) {
  'use strict';
  var UC = global.UC = global.UC || {};

  UC.demoId = function (storageKey) {
    return {
      get: function () { return parseInt(localStorage.getItem(storageKey) || '0', 10) || 0; },
      set: function (id) { localStorage.setItem(storageKey, String(id)); },
      clear: function () { localStorage.removeItem(storageKey); },
      has: function () { return !!localStorage.getItem(storageKey); },
    };
  };

  // 拉取账号选择列表(/api/admin/accounts | /api/app/users | /api/mch/merchants)
  UC.loadChoices = function (client, path, listKey) {
    return client(path).then(function (d) {
      var list = d[listKey || 'list'] || [];
      if (!Array.isArray(list) && listKey == null) list = d && d.list || []; // 用户端直接返回数组
      return Array.isArray(list) ? list : [];
    }).catch(function () { return null; });
  };
})(window);
