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
         */
        initTheme() {
            // Currently using CSS variables for theme, could be extended for toggle
            // Checks for system preference if needed in future
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
            toast.textContent = message;
            toast.className = `toast ${type} show`;
    
            setTimeout(() => {
                toast.classList.remove('show');
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
