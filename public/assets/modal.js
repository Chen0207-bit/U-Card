/* U-Card 前端公共模块 · modal.js
 * 通用弹层: 向指定容器渲染 mask + modal 结构。
 * closeFnName 为触发关闭的全局函数名(供 mask 点击关闭调用)。
 */
(function (global) {
  'use strict';
  var UC = global.UC = global.UC || {};

  UC.showModal = function (containerSelector, title, bodyHTML, closeFnName) {
    var root = document.querySelector(containerSelector);
    if (!root) return;
    var close = closeFnName || 'closeModal';
    root.innerHTML =
      '<div class="mask" onclick="if(event.target===this)' + close + '()"><div class="modal"><h3>' + title + '</h3>' +
      bodyHTML + '</div></div>';
  };
  // 带标题栏与 ✕ 关闭按钮的框架式弹层(运营后台形态)
  UC.showModalFramed = function (containerSelector, title, bodyHTML, closeFnName) {
    var root = document.querySelector(containerSelector);
    if (!root) return;
    var close = closeFnName || 'closeModal';
    root.innerHTML =
      '<div class="overlay" onclick="if(event.target===this)' + close + '()">' +
      '<div class="modal"><div class="modal-head"><h3>' + title + '</h3>' +
      '<button class="modal-x" onclick="' + close + '()">✕</button></div>' +
      '<div class="modal-body">' + bodyHTML + '</div></div></div>';
  };
  UC.closeModal = function (containerSelector) {
    var root = document.querySelector(containerSelector);
    if (root) root.innerHTML = '';
  };
})(window);
