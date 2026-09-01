/* U-Card 前端公共模块 · api.js
 * 统一请求客户端。兼容既有两族语义:
 *  - throwOnError:true  → 非 2xx 抛错(后台/商户端语义)
 *  - throwOnError:false → 永不抛错, 解析失败返回 {}(用户端语义)
 * body 既可传对象(自动 JSON.stringify)也可传已序列化字符串。
 */
(function (global) {
  'use strict';
  var UC = global.UC = global.UC || {};

  UC.createClient = function (options) {
    options = options || {};
    var base = options.base || '';
    var headersFn = options.headers || function () { return {}; };
    var throwOnError = options.throwOnError !== false;

    return function (path, opts) {
      opts = opts || {};
      var init = {
        method: opts.method || 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headersFn()),
        body: opts.body == null ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
      };
      return fetch(base + path, init).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (throwOnError && !res.ok) {
            var e = new Error(data.error || ('HTTP ' + res.status)); e.status = res.status; throw e;
          }
          return data;
        });
      });
    };
  };
})(window);
