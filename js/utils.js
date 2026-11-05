/**
 * Cloudflare Manager - 工具与 UI 基础方法
 *
 * 以 Object.assign 方式挂载到 CloudflareManager.prototype，
 * 运行时才解析 this 调用，故加载顺序不影响执行；
 * 本文件须在 popup.js（类定义）之后加载。
 */

Object.assign(CloudflareManager.prototype, {
        /**
         * 初始化主题
         * 首屏已由 theme-init.js 同步设置；这里再与 chrome.storage 对齐（用于跨设备/旧版本迁移）。
         */
        initTheme() {
            const isTheme = (t) => t === 'light' || t === 'dark';
            const apply = (theme) => this.applyTheme(isTheme(theme) ? theme : 'dark');

            // 1. 同步读取 localStorage（theme-init.js 写入的那份）
            let local = null;
            try { local = localStorage.getItem('cf-theme'); } catch (e) { /* 忽略 */ }
            if (isTheme(local)) apply(local);

            // 2. 与 chrome.storage 对齐；仅当本地没有偏好时才覆盖
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try {
                    chrome.storage.local.get('theme', (result) => {
                        const stored = result && result.theme;
                        if (isTheme(stored)) {
                            if (!isTheme(local)) apply(stored);
                        } else if (!isTheme(local)) {
                            const prefersLight = window.matchMedia &&
                                window.matchMedia('(prefers-color-scheme: light)').matches;
                            apply(prefersLight ? 'light' : 'dark');
                        }
                    });
                } catch (e) {
                    if (!isTheme(local)) apply('dark');
                }
            } else if (!isTheme(local)) {
                const prefersLight = window.matchMedia &&
                    window.matchMedia('(prefers-color-scheme: light)').matches;
                apply(prefersLight ? 'light' : 'dark');
            }
        }
,

        /**
         * 应用主题到 <html data-theme>，同步写入 localStorage 与按钮可访问性状态
         */
        applyTheme(theme) {
            const next = theme === 'light' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('cf-theme', next); } catch (e) { /* 忽略 */ }
            this.updateThemeToggleA11y(next);
        }
,

        /**
         * 同步主题按钮的 title / aria-pressed
         */
        updateThemeToggleA11y(theme) {
            const btn = document.getElementById('themeToggleBtn');
            if (!btn) return;
            const isLight = theme === 'light';
            btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
            btn.title = isLight ? '切换到暗色主题' : '切换到亮色主题';
        }
,

        /**
         * 切换亮色 / 暗色，并持久化偏好
         */
        toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
            const next = current === 'light' ? 'dark' : 'light';
            this.applyTheme(next);
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                try { chrome.storage.local.set({ theme: next }); } catch (e) { /* 忽略持久化失败 */ }
            }
        }
,

        /**
         * 使用 <a> 标签下载 CSV 文件
         */
        downloadCSV(csvContent, filename) {
            return new Promise((resolve) => {
                // 添加 BOM 以确保 Excel 正确识别 UTF-8 编码
                const BOM = '\uFEFF';
                const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
    
                // 使用 <a> 标签下载
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
    
                setTimeout(() => {
                    URL.revokeObjectURL(url);
                }, 1000);
    
                resolve({ success: true, filename: filename });
            });
        }
,

        /**
         * 使用 chrome.downloads API 下载 JSON 文件
         * @returns {Promise<{success: boolean, filename?: string}>}
         */
        downloadJSON(data, filename) {
            console.log('downloadJSON 接收到的文件名:', filename);
            return new Promise((resolve) => {
                const jsonString = JSON.stringify(data, null, 2);
                const blob = new Blob([jsonString], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
    
                // 使用 <a> 标签下载，确保文件名正确
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
    
                // 延迟清理 URL
                setTimeout(() => {
                    URL.revokeObjectURL(url);
                }, 1000);
    
                resolve({ success: true, filename: filename });
            });
        }
,

        showLoading() {
            document.getElementById('loadingSection').style.display = 'flex';
        }
,

        hideLoading() {
            document.getElementById('loadingSection').style.display = 'none';
        }
,

        showToast(message, type = 'info') {
            const toast = document.getElementById('toast');
            if (!toast) return;
            // 清除上一条提示的定时器，避免它提前隐藏新提示
            if (this._toastTimer) {
                clearTimeout(this._toastTimer);
                this._toastTimer = null;
            }
            toast.textContent = message;
            toast.className = `toast ${type} show`;
    
            this._toastTimer = setTimeout(() => {
                toast.classList.remove('show');
                this._toastTimer = null;
            }, 3000);
        }
,

        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
,

        /**
         * 生成导出文件名用的日期时间字符串：YYYYMMDD-HHMMSS
         */
        formatExportDateTime(now = new Date()) {
            return now.getFullYear().toString() +
                (now.getMonth() + 1).toString().padStart(2, '0') +
                now.getDate().toString().padStart(2, '0') + '-' +
                now.getHours().toString().padStart(2, '0') +
                now.getMinutes().toString().padStart(2, '0') +
                now.getSeconds().toString().padStart(2, '0');
        }
,

        /**
         * 获取账户名称和日期时间用于文件名
         */
        getExportFilename(suffix = '') {
            let accountName = 'cloudflare';
            if (this.currentAccount?.id) {
                const account = this.accounts.find(a => a.id === this.currentAccount.id);
                if (account?.name) {
                    accountName = account.name;
                }
            }
            if (accountName === 'cloudflare') {
                const accountSelect = document.getElementById('accountSelect');
                const selectedText = accountSelect?.selectedOptions[0]?.textContent;
                if (selectedText && selectedText !== '请选择账户') {
                    accountName = selectedText;
                }
            }
            const safeAccountName = accountName.replace(/[<>:"/\\|?*]/g, '_');
    
            const now = new Date();
            const dateTime = this.formatExportDateTime(now);
    
            return suffix ? `Cloudflare Manager-${safeAccountName}-${suffix}-${dateTime}.json` : `Cloudflare Manager-${safeAccountName}-${dateTime}.json`;
        }
,
});
