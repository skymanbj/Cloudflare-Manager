/**
 * 主题预加载（在 <head> 中同步执行）
 *
 * 目的：在首屏绘制前就把 data-theme 设好，避免亮色用户先看到暗色再跳变（FOUC）。
 * 读取顺序：localStorage 保存的偏好 → 系统 prefers-color-scheme → 默认暗色。
 * 之后由 js/utils.js 的 initTheme() 与 chrome.storage 做持久化同步。
 */
(function () {
    try {
        var saved = localStorage.getItem('cf-theme');
        if (saved !== 'light' && saved !== 'dark') {
            saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
                ? 'light'
                : 'dark';
        }
        document.documentElement.setAttribute('data-theme', saved);
    } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();
