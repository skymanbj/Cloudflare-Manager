/**
 * Cloudflare Manager - Chrome Extension
 * DNS 记录管理 + Workers + Pages 项目管理
 */

// =====================================================
// GitHub Sync Manager - GitHub 备注同步管理器
// =====================================================
class GitHubSyncManager {
    constructor(manager) {
        this.manager = manager;
        this.config = null;
        this.syncInProgress = false;
        this.SYNC_FILE_PATH = 'cf-remarks.json';
    }

    // 加载配置
    async loadConfig() {
        return new Promise((resolve) => {
            chrome.storage.local.get('githubSyncConfig', (result) => {
                this.config = result.githubSyncConfig || null;
                this.updateSyncStatusUI();
                this.updateSyncSettingsUI();
                resolve(this.config);
            });
        });
    }

    // 保存配置
    async saveConfig(config) {
        this.config = config;
        return new Promise((resolve, reject) => {
            chrome.storage.local.set({ githubSyncConfig: config }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    // 通知 background 更新定时器
                    if (config.enabled && config.timerSync) {
                        chrome.runtime.sendMessage({
                            action: 'updateSyncAlarm',
                            interval: config.syncInterval || 30
                        });
                    } else {
                        chrome.runtime.sendMessage({ action: 'clearSyncAlarm' });
                    }
                    resolve();
                }
            });
        });
    }

    // 验证 GitHub Token
    async validateToken(token) {
        try {
            const response = await fetch('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            return response.ok;
        } catch (error) {
            console.error('[GitHubSync] Token validation failed:', error);
            return false;
        }
    }

    // 获取远程数据
    async getRemoteData() {
        if (!this.config?.token || !this.config?.repo) {
            throw new Error('GitHub 同步未配置');
        }

        const [owner, repo] = this.config.repo.split('/');
        const branch = this.config.branch || 'main';
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${this.SYNC_FILE_PATH}?ref=${branch}`;

        try {
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${this.config.token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });

            if (response.status === 404) {
                // 文件不存在，返回空数据
                return { remarks: {}, deletedKeys: [], sha: null };
            }

            if (!response.ok) {
                throw new Error(`GitHub API 错误: ${response.status}`);
            }

            const data = await response.json();
            // 使用 TextDecoder 处理 UTF-8 字符（避免 Base64 直接解码乱码）
            const binaryString = atob(data.content);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const contentText = new TextDecoder('utf-8').decode(bytes);
            const content = JSON.parse(contentText);
            return { ...content, sha: data.sha };
        } catch (error) {
            console.error('[GitHubSync] Failed to get remote data:', error);
            throw error;
        }
    }

    // 推送数据到 GitHub
    async pushData(data, sha = null) {
        if (!this.config?.token || !this.config?.repo) {
            throw new Error('GitHub 同步未配置');
        }

        const [owner, repo] = this.config.repo.split('/');
        const branch = this.config.branch || 'main';
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${this.SYNC_FILE_PATH}`;

        // 使用符合 UTF-8 标准的方案进行 Base64 编码
        const jsonStr = JSON.stringify(data, null, 2);
        const bytes = new TextEncoder().encode(jsonStr);
        let binaryString = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binaryString += String.fromCharCode(bytes[i]);
        }
        const base64Content = btoa(binaryString);

        const body = {
            message: `Sync remarks - ${new Date().toISOString()}`,
            content: base64Content,
            branch: branch
        };

        if (sha) {
            body.sha = sha;
        }

        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || `推送失败: ${response.status}`);
        }

        return await response.json();
    }

    // 双向同步
    async syncNow() {
        if (this.syncInProgress) {
            this.manager.showToast('同步正在进行中...', 'warning');
            return;
        }

        if (!this.config?.enabled) {
            this.manager.showToast('请先启用并配置 GitHub 同步', 'warning');
            return;
        }

        this.syncInProgress = true;
        this.setSyncStatus('syncing', '正在同步...');

        try {
            // 1. 获取远程数据
            const remoteData = await this.getRemoteData();

            // 2. 获取本地删除记录
            const { deletedKeys = [] } = await this.getLocalDeletedKeys();

            // 3. 合并数据
            const merged = this.mergeRemarks(
                this.manager.remarks,
                remoteData.remarks || {},
                [...(remoteData.deletedKeys || []), ...deletedKeys]
            );

            // 4. 更新本地数据
            this.manager.remarks = merged.remarks;
            await this.manager.saveRemarksToStorage();

            // 5. 推送到远程
            const syncData = {
                version: '1.0',
                syncTime: new Date().toISOString(),
                remarks: merged.remarks,
                deletedKeys: merged.allDeletedKeys,
                metadata: {
                    totalRemarks: Object.keys(merged.remarks).length
                }
            };

            await this.pushData(syncData, remoteData.sha);

            // 6. 清除本地删除记录
            await this.clearLocalDeletedKeys();

            // 7. 更新最后同步时间
            this.config.lastSyncTime = new Date().toISOString();
            await this.saveConfig(this.config);

            this.setSyncStatus('connected', '同步成功');
            this.manager.showToast('同步完成', 'success');
            this.manager.refreshCurrentView();

        } catch (error) {
            console.error('[GitHubSync] Sync failed:', error);
            this.setSyncStatus('error', '同步失败');
            this.manager.showToast('同步失败: ' + error.message, 'error');
        } finally {
            this.syncInProgress = false;
        }
    }

    // 只拉取远程数据
    async pullFromGithub() {
        if (this.syncInProgress) return;

        this.syncInProgress = true;
        this.setSyncStatus('syncing', '正在拉取...');

        try {
            const remoteData = await this.getRemoteData();

            // 处理删除的 key
            if (remoteData.deletedKeys) {
                for (const key of remoteData.deletedKeys) {
                    delete this.manager.remarks[key];
                }
            }

            // 合并远程数据（远程优先）
            if (remoteData.remarks) {
                Object.assign(this.manager.remarks, remoteData.remarks);
            }

            await this.manager.saveRemarksToStorage();

            this.config.lastSyncTime = new Date().toISOString();
            await this.saveConfig(this.config);

            this.setSyncStatus('connected', '拉取成功');
            this.manager.showToast('拉取完成', 'success');
            this.manager.refreshCurrentView();

        } catch (error) {
            this.setSyncStatus('error', '拉取失败');
            this.manager.showToast('拉取失败: ' + error.message, 'error');
        } finally {
            this.syncInProgress = false;
        }
    }

    // 只推送本地数据
    async pushToGithub() {
        if (this.syncInProgress) return;

        this.syncInProgress = true;
        this.setSyncStatus('syncing', '正在推送...');

        try {
            // 先获取远程 sha
            let sha = null;
            try {
                const remoteData = await this.getRemoteData();
                sha = remoteData.sha;
            } catch (e) {
                // 文件不存在，不需要 sha
            }

            const { deletedKeys = [] } = await this.getLocalDeletedKeys();

            const syncData = {
                version: '1.0',
                syncTime: new Date().toISOString(),
                remarks: this.manager.remarks,
                deletedKeys: deletedKeys,
                metadata: {
                    totalRemarks: Object.keys(this.manager.remarks).length
                }
            };

            await this.pushData(syncData, sha);
            await this.clearLocalDeletedKeys();

            this.config.lastSyncTime = new Date().toISOString();
            await this.saveConfig(this.config);

            this.setSyncStatus('connected', '推送成功');
            this.manager.showToast('推送完成', 'success');

        } catch (error) {
            this.setSyncStatus('error', '推送失败');
            this.manager.showToast('推送失败: ' + error.message, 'error');
        } finally {
            this.syncInProgress = false;
        }
    }

    // 合并备注数据（基于时间戳）
    mergeRemarks(local, remote, deletedKeys = []) {
        const result = {};
        const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
        const allDeletedKeys = [...new Set(deletedKeys)];

        for (const key of allKeys) {
            // 如果 key 在删除列表中，跳过
            if (deletedKeys.includes(key)) {
                continue;
            }

            const localItem = local[key];
            const remoteItem = remote[key];

            if (localItem && remoteItem) {
                // 两边都有，比较时间戳
                const localTime = new Date(localItem.updatedAt || 0).getTime();
                const remoteTime = new Date(remoteItem.updatedAt || 0).getTime();
                result[key] = localTime >= remoteTime ? localItem : remoteItem;
            } else if (localItem) {
                result[key] = localItem;
            } else if (remoteItem) {
                result[key] = remoteItem;
            }
        }

        return { remarks: result, allDeletedKeys };
    }

    // 记录删除操作
    async recordDeletion(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get('githubSyncDeletedKeys', (result) => {
                const deletedKeys = result.githubSyncDeletedKeys || [];
                if (!deletedKeys.includes(key)) {
                    deletedKeys.push(key);
                }
                chrome.storage.local.set({ githubSyncDeletedKeys: deletedKeys }, resolve);
            });
        });
    }

    // 获取本地删除记录
    async getLocalDeletedKeys() {
        return new Promise((resolve) => {
            chrome.storage.local.get('githubSyncDeletedKeys', (result) => {
                resolve({ deletedKeys: result.githubSyncDeletedKeys || [] });
            });
        });
    }

    // 清除本地删除记录
    async clearLocalDeletedKeys() {
        return new Promise((resolve) => {
            chrome.storage.local.remove('githubSyncDeletedKeys', resolve);
        });
    }

    // 更新同步状态 UI
    setSyncStatus(status, text) {
        const statusEl = document.getElementById('syncStatus');
        if (!statusEl) return;

        statusEl.className = `sync-status ${status}`;
        const iconEl = statusEl.querySelector('.sync-status-icon');
        const textEl = statusEl.querySelector('.sync-status-text');

        if (iconEl) {
            const icons = { connected: '🟢', syncing: '🔄', error: '🔴', '': '⚪' };
            iconEl.textContent = icons[status] || '⚪';
        }
        if (textEl) {
            textEl.textContent = text;
        }
    }

    // 更新同步状态 UI（基于配置）
    updateSyncStatusUI() {
        if (!this.config?.enabled) {
            this.setSyncStatus('', '未配置');
        } else if (this.config.lastSyncTime) {
            const lastSync = new Date(this.config.lastSyncTime);
            this.setSyncStatus('connected', `已连接`);

            const lastSyncEl = document.getElementById('lastSyncTime');
            if (lastSyncEl) {
                lastSyncEl.textContent = `上次同步: ${lastSync.toLocaleString('zh-CN')}`;
            }
        } else {
            this.setSyncStatus('connected', '已配置，等待首次同步');
        }
    }

    // 更新设置面板 UI
    updateSyncSettingsUI() {
        const enableCheckbox = document.getElementById('enableGithubSync');
        const settingsDiv = document.getElementById('githubSyncSettings');
        const tokenInput = document.getElementById('githubToken');
        const repoInput = document.getElementById('githubRepo');
        const branchInput = document.getElementById('githubBranch');
        const timerCheckbox = document.getElementById('enableTimerSync');
        const intervalGroup = document.getElementById('syncIntervalGroup');
        const intervalSelect = document.getElementById('syncInterval');

        if (this.config) {
            if (enableCheckbox) enableCheckbox.checked = this.config.enabled || false;
            if (settingsDiv) settingsDiv.style.display = this.config.enabled ? 'block' : 'none';
            if (tokenInput) tokenInput.value = this.config.token || '';
            if (repoInput) repoInput.value = this.config.repo || '';
            if (branchInput) branchInput.value = this.config.branch || 'main';
            if (timerCheckbox) timerCheckbox.checked = this.config.timerSync || false;
            if (intervalGroup) intervalGroup.style.display = this.config.timerSync ? 'block' : 'none';
            if (intervalSelect) intervalSelect.value = this.config.syncInterval || '30';
        }
    }
}

class CloudflareManager {
    constructor() {
        this.accounts = [];
        this.currentAccount = null;
        this.zones = [];
        this.allRecords = [];
        this.workers = [];
        this.pages = [];
        this.accountId = null;
        this.currentTab = 'dns';
        this.editingRecordId = null;
        this.editingZoneId = null;
        this.searchQuery = '';
        this.selectedZoneId = '';
        this.workersSearchQuery = '';
        this.pagesSearchQuery = '';
        this.collapsedZones = new Set(); // 存储折叠的域名
        this.collapsedRemarkGroups = new Set(); // 存储折叠的备注分组

        // 加载状态位
        this.isLoadingZones = false;
        this.isLoadingWorkers = false;
        this.isLoadingPages = false;

        // 资源备注相关
        this.remarks = {}; // { 'type:id': { content, tags, updatedAt } }
        this.currentRemarkTarget = null; // { type, id, name, detail }
        this.remarksSearchQuery = '';
        this.remarksTypeFilter = '';
        this.remarksRetryCount = 0; // 备注重试计数器
        this.remarksMaxRetries = 5; // 最大重试次数

        // 账户颜色映射
        this.accountColorMap = new Map();
        this.nextColorIndex = 0;

        // 全局提示框相关
        this.tooltipEl = document.getElementById('globalRemarkTooltip');
        this.tooltipTimer = null;
        this.initGlobalTooltip();

        // GitHub 同步管理器
        this.githubSync = new GitHubSyncManager(this);

        // Markdown 编辑器状态
        this.isPreviewing = false;

        // 初始化 
        // 处理点击外部关闭备注窗口
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.remark-btn')) {
                document.querySelectorAll('.remark-btn.active').forEach(btn => {
                    btn.classList.remove('active');
                });
            }
        });

        this.init();
    }

    async loadResourceCache() {
        if (!this.currentAccount?.id) return;
        const cacheKey = `resourceCache_${this.currentAccount.id}`;
        return new Promise((resolve) => {
            chrome.storage.local.get([cacheKey], (result) => {
                const cache = result[cacheKey] || {};
                if (cache.zones) this.zones = cache.zones;
                if (cache.workers) this.workers = cache.workers;
                if (cache.pages) this.pages = cache.pages;
                if (cache.allRecords) this.allRecords = cache.allRecords;
                console.log(`[Cache] Loaded resource cache for account: ${this.currentAccount.name}`);
                resolve();
            });
        });
    }

    async saveResourceCache() {
        if (!this.currentAccount?.id) return;
        const cacheKey = `resourceCache_${this.currentAccount.id}`;
        return new Promise((resolve) => {
            const cache = {
                zones: this.zones,
                workers: this.workers,
                pages: this.pages,
                allRecords: this.allRecords,
                timestamp: Date.now()
            };
            const data = {};
            data[cacheKey] = cache;
            chrome.storage.local.set(data, () => {
                console.log(`[Cache] Resource cache saved for account: ${this.currentAccount.name}`);
                resolve();
            });
        });
    }

    async init() {
        await this.loadAccounts();
        await this.loadRemarks();
        await this.loadResourceCache(); // 启动时立即恢复缓存，实现秒开
        await this.githubSync.loadConfig();
        this.configMarked();
        this.bindEvents();
        this.bindGithubSyncEvents();
        this.updateUI();
    }

    /**
     * 初始化全局提示框事件委托
     */
    initGlobalTooltip() {
        if (!this.tooltipEl) return;

        // 使用事件委托监听所有备注按钮的划入
        document.body.addEventListener('mouseover', (e) => {
            const btn = e.target.closest('.remark-btn.has-remark');
            if (btn) {
                const type = btn.getAttribute('data-type');
                const id = btn.getAttribute('data-id');
                if (type && id) {
                    this.showGlobalTooltip(btn, type, id);
                }
            }
        });

        document.body.addEventListener('mouseout', (e) => {
            const btn = e.target.closest('.remark-btn.has-remark');
            if (btn) {
                this.hideGlobalTooltip();
            }
        });

        // 鼠标进入提示框本身时保持显示
        this.tooltipEl.addEventListener('mouseenter', () => {
            if (this.tooltipTimer) {
                clearTimeout(this.tooltipTimer);
                this.tooltipTimer = null;
            }
        });

        this.tooltipEl.addEventListener('mouseleave', () => {
            this.hideGlobalTooltip();
        });
    }

    /**
     * 显示全局提示框
     */
    showGlobalTooltip(anchorEl, type, id) {
        if (this.tooltipTimer) {
            clearTimeout(this.tooltipTimer);
            this.tooltipTimer = null;
        }

        const remark = this.getRemark(type, id);
        if (!remark || !remark.content) return;

        // 渲染内容并填充
        this.tooltipEl.innerHTML = this.getRemarkTooltipHtml(type, id);

        // 先设为可见但透明，以计算尺寸
        this.tooltipEl.style.display = 'block';
        this.tooltipEl.style.opacity = '0';

        const rect = anchorEl.getBoundingClientRect();

        // 强制重绘以获取正确尺寸
        this.tooltipEl.offsetHeight;

        const tooltipWidth = this.tooltipEl.offsetWidth || 350;
        const tooltipHeight = this.tooltipEl.offsetHeight || 100;

        // 默认位置：按钮右侧中心对齐
        let left = rect.right + 12;
        let top = rect.top + rect.height / 2 - tooltipHeight / 2;

        // 边界检查：右侧溢出则显示在左侧
        if (left + tooltipWidth > window.innerWidth - 10) {
            left = rect.left - tooltipWidth - 12;
        }

        // 边界检查：上下溢出限制
        if (top < 10) top = 10;
        if (top + tooltipHeight > window.innerHeight - 10) {
            top = window.innerHeight - tooltipHeight - 10;
        }

        this.tooltipEl.style.left = `${left}px`;
        this.tooltipEl.style.top = `${top}px`;
        this.tooltipEl.style.opacity = '1';
        this.tooltipEl.classList.add('show');
    }

    /**
     * 隐藏全局提示框（带延时，方便鼠标移入提示框）
     */
    hideGlobalTooltip() {
        if (this.tooltipTimer) return;

        this.tooltipTimer = setTimeout(() => {
            this.tooltipEl.classList.remove('show');
            setTimeout(() => {
                if (!this.tooltipEl.classList.contains('show')) {
                    this.tooltipEl.style.display = 'none';
                    this.tooltipEl.style.opacity = '0';
                }
            }, 200);
            this.tooltipTimer = null;
        }, 200);
    }

    // =====================================================
    // Storage Methods
    // =====================================================
    async loadAccounts() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['accounts', 'currentAccountId'], (result) => {
                this.accounts = result.accounts || [];
                if (result.currentAccountId) {
                    this.currentAccount = this.accounts.find(a => a.id === result.currentAccountId);
                }
                resolve();
            });
        });
    }

    async saveAccounts() {
        return new Promise((resolve) => {
            chrome.storage.local.set({
                accounts: this.accounts,
                currentAccountId: this.currentAccount?.id || null
            }, () => {
                // 如果切换了账户，重置加载状态但保留缓存，实现快速切换
                this.isLoadingZones = false;
                this.isLoadingWorkers = false;
                this.isLoadingPages = false;
                resolve();
            });
        });
    }

    // =====================================================
    // API Methods
    // =====================================================
    async apiRequest(endpoint, method = 'GET', body = null) {
        if (!this.currentAccount?.token) {
            throw new Error('请先配置账户');
        }

        const url = `https://api.cloudflare.com/client/v4${endpoint}`;
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.currentAccount.token}`
            }
        };

        // Only set Content-Type to application/json if body is NOT FormData
        if (body && !(body instanceof FormData)) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        } else if (body instanceof FormData) {
            // When using FormData, fetch automatically sets the correct Content-Type with boundary
            options.body = body;
        }

        try {
            const response = await fetch(url, options);
            const data = await response.json();

            if (!data.success) {
                const errorMsg = data.errors?.[0]?.message || '请求失败';
                throw new Error(errorMsg);
            }

            return data.result;
        } catch (error) {
            console.error('[API Error]', error);
            if (error.message === 'Failed to fetch') {
                throw new Error('网络请求失败，请检查网络连接或API Token是否有效');
            }
            throw error;
        }
    }

    async validateToken(token) {
        try {
            const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            const data = await response.json();
            return data.success;
        } catch (error) {
            console.error('[Token Validation Error]', error);
            throw new Error('验证 Token 时网络请求失败，请检查网络连接');
        }
    }

    async loadZones() {
        this.isLoadingZones = true;
        this.zones = [];
        let page = 1;
        const perPage = 50;

        while (true) {
            try {
                // Cloudflare pagination is 1-based
                const response = await this.apiRequest(`/zones?per_page=${perPage}&page=${page}`);
                const zones = response || [];

                this.zones.push(...zones);

                if (zones.length < perPage) {
                    break;
                }
                page++;
            } catch (error) {
                console.error('Failed to load zones page', page, error);
                this.isLoadingZones = false; // Ensure loading state is reset on error
                break;
            }
        }
        this.isLoadingZones = false;
        return this.zones;
    }

    // 加载所有域名的所有 DNS 记录
    async loadAllRecords() {
        this.allRecords = [];

        for (const zone of this.zones) {
            try {
                const records = await this.apiRequest(`/zones/${zone.id}/dns_records`);
                // 为每条记录附加 zone 信息
                const recordsWithZone = records.map(record => ({
                    ...record,
                    zoneName: zone.name,
                    zoneId: zone.id,
                    accountName: zone.account?.name || 'Unknown',
                    accountId: zone.account?.id || 'unknown'
                }));
                this.allRecords.push(...recordsWithZone);
            } catch (error) {
                console.error(`加载 ${zone.name} 的记录失败:`, error);
            }
        }

        // 按域名分组排序
        this.allRecords.sort((a, b) => {
            if (a.zoneName !== b.zoneName) {
                return a.zoneName.localeCompare(b.zoneName);
            }
            return a.name.localeCompare(b.name);
        });

        return this.allRecords;
    }

    async createRecord(zoneId, recordData) {
        return await this.apiRequest(`/zones/${zoneId}/dns_records`, 'POST', recordData);
    }

    async updateRecord(zoneId, recordId, recordData) {
        return await this.apiRequest(`/zones/${zoneId}/dns_records/${recordId}`, 'PUT', recordData);
    }

    async deleteRecord(zoneId, recordId) {
        return await this.apiRequest(`/zones/${zoneId}/dns_records/${recordId}`, 'DELETE');
    }

    // Workers API Methods
    async getAccountId() {
        if (this.accountId) return this.accountId;

        // 1. 优先尝试从 zones 获取，因为这是最快且最可靠的相关账户
        if (this.zones && this.zones.length > 0) {
            const currentName = (this.currentAccount?.name || '').toLowerCase();
            const matchedZone = this.zones.find(z =>
                z.account && (z.account.name.toLowerCase().includes(currentName) || currentName.includes(z.account.name.toLowerCase()))
            );

            if (matchedZone) {
                this.accountId = matchedZone.account.id;
                return this.accountId;
            }
            
            // 如果没找到名称匹配的，但有 zones，说明至少能拿到一个有效的 accountId
            if (this.zones[0].account?.id) {
                this.accountId = this.zones[0].account.id;
                return this.accountId;
            }
        }

        // 2. 尝试通过 /accounts API 获取
        try {
            const accounts = await this.apiRequest('/accounts?per_page=50');
            if (accounts && accounts.length > 0) {
                const currentName = (this.currentAccount?.name || '').toLowerCase();
                let matchedAccount = accounts.find(acc =>
                    acc.name.toLowerCase().includes(currentName) ||
                    currentName.includes(acc.name.toLowerCase())
                );

                // 特殊匹配逻辑保留
                if (currentName === 'liubohn69') {
                    const superMatch = accounts.find(acc => acc.name.toLowerCase().includes('liubohn69@gmail.com'));
                    if (superMatch) matchedAccount = superMatch;
                }

                if (matchedAccount) {
                    this.accountId = matchedAccount.id;
                    return this.accountId;
                }

                this.accountId = accounts[0].id;
                return this.accountId;
            }
        } catch (error) {
            console.warn('无法通过 /accounts 获取账户 ID:', error);
        }

        // 3. 如果还是没有，尝试加载一次 zones (如果之前没加载过)
        if (!this.zones || this.zones.length === 0) {
            try {
                const zones = await this.loadZones();
                if (zones && zones.length > 0 && zones[0].account) {
                    this.accountId = zones[0].account.id;
                    return this.accountId;
                }
            } catch (e) { /* ignore */ }
        }

        // 如果真的什么都拿不到，返回 null 而不是抛错，由调用方决定如何处理
        console.warn('未能自动获取 Account ID');
        return null;
    }

    async loadWorkers() {
        this.isLoadingWorkers = true;
        
        // 开启全量扫描模式：不再仅限于特定超级管理员，让所有用户都能更完整地加载资源
        console.log(`[Workers] Loading workers using Deep-Scan mode...`);

        try {
            // Collect accounts from multiple sources to be robust
            const uniqueAccounts = new Map();

            // 1. Current Account (Targeted)
            try {
                const currentId = await this.getAccountId();
                if (currentId) {
                    uniqueAccounts.set(currentId, { id: currentId, name: this.currentAccount?.name || 'Primary' });
                }
            } catch (e) { console.warn('Failed to get account ID via target method:', e); }

            // 2. From /accounts API (Breadth-first)
            try {
                const apiAccounts = await this.apiRequest('/accounts?per_page=50');
                if (Array.isArray(apiAccounts)) {
                    apiAccounts.forEach(acc => {
                        uniqueAccounts.set(acc.id, { id: acc.id, name: acc.name });
                    });
                }
            } catch (e) {
                console.warn('Failed to fetch /accounts for workers:', e);
            }

            // 3. From Zones (Discovery via existing domains)
            if (this.zones && this.zones.length > 0) {
                this.zones.forEach(z => {
                    if (z.account && z.account.id) {
                        if (!uniqueAccounts.has(z.account.id)) {
                            uniqueAccounts.set(z.account.id, {
                                id: z.account.id,
                                name: z.account.name
                            });
                        }
                    }
                });
            }

            const allAccounts = Array.from(uniqueAccounts.values());
            
            if (allAccounts.length === 0) {
                throw new Error('无法发现任何 Cloudflare 账户。请检查 API Token 权限（需要 Account.Workers Scripts 权限）。');
            }

            console.log(`Scanning ${allAccounts.length} accounts for Workers`);

            // Parallel fetch
            const promises = allAccounts.map(async account => {
                try {
                    const response = await this.apiRequest(`/accounts/${account.id}/workers/scripts`);
                    return (response || []).map(worker => ({
                        ...worker,
                        account: {
                            id: account.id,
                            name: account.name
                        }
                    }));
                } catch (err) {
                    console.warn(`Failed to fetch workers for account ${account.name} (${account.id}):`, err);
                    return [];
                }
            });

            const results = await Promise.all(promises);
            this.workers = results.flat();
            console.log(`[Workers] Total workers loaded: ${this.workers.length} from ${allAccounts.length} accounts.`);

            await this.saveResourceCache(); // 保存缓存

            // 异步补全：如果当前正在查看备注页，触发重绘
            if (this.currentTab === 'notes') {
                this.loadRemarksAndRender();
            }

            // Sort: Account Name -> Worker ID
            this.workers.sort((a, b) => {
                const accountA = a.account?.name || '';
                const accountB = b.account?.name || '';
                if (accountA !== accountB) {
                    return accountA.localeCompare(accountB);
                }
                return a.id.localeCompare(b.id);
            });

            this.isLoadingWorkers = false;
            return this.workers;
        } catch (error) {
            this.isLoadingWorkers = false;
            console.error('loadWorkers error:', error);
            throw error;
        }
    }

    async getWorkerRoutes(scriptName) {
        const accountId = await this.getAccountId();
        try {
            const routes = await this.apiRequest(`/accounts/${accountId}/workers/scripts/${scriptName}/routes`);
            return routes || [];
        } catch {
            return [];
        }
    }

    async getWorkerSubdomains() {
        const accountId = await this.getAccountId();
        try {
            const subdomain = await this.apiRequest(`/accounts/${accountId}/workers/subdomain`);
            return subdomain?.subdomain || null;
        } catch {
            return null;
        }
    }

    // Pages API Methods
    async loadPages() {
        this.isLoadingPages = true;
        console.log(`[Pages] Loading pages using Deep-Scan mode...`);

        try {
            // Collect accounts from multiple sources
            const uniqueAccounts = new Map();

            // 1. Current Account
            try {
                const currentId = await this.getAccountId();
                if (currentId) {
                    uniqueAccounts.set(currentId, { id: currentId, name: this.currentAccount?.name || 'Primary' });
                }
            } catch (e) { }

            // 2. From /accounts API
            try {
                const apiAccounts = await this.apiRequest('/accounts?per_page=50');
                if (Array.isArray(apiAccounts)) {
                    apiAccounts.forEach(acc => {
                        uniqueAccounts.set(acc.id, { id: acc.id, name: acc.name });
                    });
                }
            } catch (e) {
                console.warn('Failed to fetch /accounts for pages:', e);
            }

            // 3. From Zones
            if (this.zones && this.zones.length > 0) {
                this.zones.forEach(z => {
                    if (z.account && z.account.id) {
                        if (!uniqueAccounts.has(z.account.id)) {
                            uniqueAccounts.set(z.account.id, {
                                id: z.account.id,
                                name: z.account.name
                            });
                        }
                    }
                });
            }

            const allAccounts = Array.from(uniqueAccounts.values());
            
            if (allAccounts.length === 0) {
                 throw new Error('无法发现任何 Cloudflare 账户。请检查 API Token 权限（需要 Account.Cloudflare Pages 权限）。');
            }
            
            console.log(`Scanning ${allAccounts.length} accounts for Pages`);

            // Parallel fetch
            const promises = allAccounts.map(async account => {
                try {
                    const response = await this.apiRequest(`/accounts/${account.id}/pages/projects`);
                    return (response || []).map(page => ({
                        ...page,
                        account: {
                            id: account.id,
                            name: account.name
                        }
                    }));
                } catch (err) {
                    console.warn(`Failed to fetch pages for account ${account.name} (${account.id}):`, err);
                    return [];
                }
            });

            const results = await Promise.all(promises);
            this.pages = results.flat();
            console.log(`[Pages] Total pages loaded: ${this.pages.length} from ${allAccounts.length} accounts.`);

            await this.saveResourceCache(); // 保存缓存

            // 异步补全
            if (this.currentTab === 'notes') {
                this.loadRemarksAndRender();
            }

            // Sort: Account Name -> Page Name
            this.pages.sort((a, b) => {
                const accountA = a.account?.name || '';
                const accountB = b.account?.name || '';
                if (accountA !== accountB) {
                    return accountA.localeCompare(accountB);
                }
                return a.name.localeCompare(b.name);
            });

            this.isLoadingPages = false;
            return this.pages;
        } catch (error) {
            this.isLoadingPages = false;
            console.error('loadPages error:', error);
            throw error;
        }
    }

    // =====================================================
    // Event Bindings
    // =====================================================
    bindEvents() {
        // Sidebar menu
        document.getElementById('menuBtn').addEventListener('click', () => this.openSidebar());
        document.getElementById('closeSidebar').addEventListener('click', () => this.closeSidebar());
        document.getElementById('sidebarOverlay').addEventListener('click', () => this.closeSidebar());

        // Header actions
        document.getElementById('refreshBtn').addEventListener('click', () => this.refresh());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportData());

        // Welcome section
        document.getElementById('welcomeAddAccountBtn').addEventListener('click', () => this.openSidebar());

        // 点击头部账户名切换到下一个账户
        const headerAccountName = document.getElementById('headerAccountName');
        if (headerAccountName) {
            headerAccountName.addEventListener('click', () => this.switchToNextAccount());
            headerAccountName.title = "点击切换到下一个账户";
        }

        // Account management (in sidebar)
        document.getElementById('saveAccountBtn').addEventListener('click', () => this.saveAccount());
        document.getElementById('deleteAccountBtn').addEventListener('click', () => this.deleteAccount());
        document.getElementById('accountSelect').addEventListener('change', (e) => this.switchAccount(e.target.value));

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // New Deployment buttons
        document.getElementById('createNewWorkerBtn').addEventListener('click', async () => {
            const accountId = await this.getAccountId();
            if (accountId) {
                window.open(`https://dash.cloudflare.com/${accountId}/workers-and-pages/create/workers`, '_blank');
            } else {
                this.showToast('无法获取账户 ID', 'error');
            }
        });
        document.getElementById('createNewPagesBtn').addEventListener('click', async () => {
            const accountId = await this.getAccountId();
            if (accountId) {
                window.open(`https://dash.cloudflare.com/${accountId}/workers-and-pages/create/pages`, '_blank');
            } else {
                this.showToast('无法获取账户 ID', 'error');
            }
        });
        document.getElementById('exportWorkersBtn').addEventListener('click', () => this.exportWorkers());
        document.getElementById('exportPagesBtn').addEventListener('click', () => this.exportPages());

        // DNS record form
        document.getElementById('addRecordBtn').addEventListener('click', () => this.showRecordForm());
        document.getElementById('cancelRecordBtn').addEventListener('click', () => this.hideRecordForm());
        document.getElementById('saveRecordBtn').addEventListener('click', () => this.saveRecord());
        document.getElementById('recordType').addEventListener('change', (e) => this.handleRecordTypeChange(e.target.value));

        // Deployment modal
        document.getElementById('closeDeployModalBtn').addEventListener('click', () => this.hideDeployModal());
        document.getElementById('cancelDeployBtn').addEventListener('click', () => this.hideDeployModal());
        document.getElementById('startDeployBtn').addEventListener('click', () => this.startDeployment());
        document.getElementById('uploadScriptBtn').addEventListener('click', () => document.getElementById('workerScriptFile').click());
        document.getElementById('workerScriptFile').addEventListener('change', (e) => this.handleWorkerScriptUpload(e));

        // Toggle sidebar
        // Toggle all zones
        document.getElementById('toggleAllBtn').addEventListener('click', () => this.toggleAllZones());

        // Search and filter functionality
        document.getElementById('searchInput').addEventListener('input', (e) => this.handleSearch(e.target.value));
        document.getElementById('clearSearchBtn').addEventListener('click', () => this.clearSearch());
        document.getElementById('zoneFilter').addEventListener('change', (e) => this.handleZoneFilter(e.target.value));

        // Workers search
        document.getElementById('workersSearchInput').addEventListener('input', (e) => this.handleWorkersSearch(e.target.value));

        // Pages search
        document.getElementById('pagesSearchInput').addEventListener('input', (e) => this.handlePagesSearch(e.target.value));

        // Remarks events (备注事件)
        const remarksSearchInput = document.getElementById('remarksSearchInput');
        if (remarksSearchInput) {
            remarksSearchInput.addEventListener('input', (e) => this.handleRemarksSearch(e.target.value));
        }

        const remarksTypeFilter = document.getElementById('remarksTypeFilter');
        if (remarksTypeFilter) {
            remarksTypeFilter.addEventListener('change', (e) => this.handleRemarksTypeFilter(e.target.value));
        }

        const exportRemarksBtn = document.getElementById('exportRemarksBtn');
        if (exportRemarksBtn) {
            exportRemarksBtn.addEventListener('click', () => this.exportRemarks());
        }

        // DNS 导出按钮
        const exportDnsBtn = document.getElementById('exportDnsBtn');
        if (exportDnsBtn) {
            exportDnsBtn.addEventListener('click', () => this.exportDnsData());
        }

        // Workers 导出按钮
        const exportWorkersBtn = document.getElementById('exportWorkersBtn');
        if (exportWorkersBtn) {
            exportWorkersBtn.addEventListener('click', () => this.exportWorkersData());
        }

        // Pages 导出按钮
        const exportPagesBtn = document.getElementById('exportPagesBtn');
        if (exportPagesBtn) {
            exportPagesBtn.addEventListener('click', () => this.exportPagesData());
        }

        // 备注弹窗事件
        const closeRemarkModal = document.getElementById('closeRemarkModal');
        if (closeRemarkModal) {
            closeRemarkModal.addEventListener('click', () => this.closeRemarkModal());
        }

        const remarkModalOverlay = document.querySelector('#remarkModal .modal-overlay');
        if (remarkModalOverlay) {
            remarkModalOverlay.addEventListener('click', () => this.closeRemarkModal());
        }

        const saveRemarkBtn = document.getElementById('saveRemarkBtn');
        if (saveRemarkBtn) {
            saveRemarkBtn.addEventListener('click', () => this.saveRemark());
        }

        const deleteRemarkBtn = document.getElementById('deleteRemarkBtn');
        if (deleteRemarkBtn) {
            deleteRemarkBtn.addEventListener('click', () => this.deleteRemark());
        }

        const cancelRemarkBtn = document.getElementById('cancelRemarkBtn');
        if (cancelRemarkBtn) {
            cancelRemarkBtn.addEventListener('click', () => this.closeRemarkModal());
        }

        // Markdown 工具栏绑定
        this.bindMarkdownToolbarEvents();
    }

    // =====================================================
    // GitHub Sync Event Bindings
    // =====================================================
    bindGithubSyncEvents() {
        // 启用同步开关
        const enableCheckbox = document.getElementById('enableGithubSync');
        const settingsDiv = document.getElementById('githubSyncSettings');

        if (enableCheckbox) {
            enableCheckbox.addEventListener('change', () => {
                if (settingsDiv) {
                    settingsDiv.style.display = enableCheckbox.checked ? 'block' : 'none';
                }
            });
        }

        // 定时同步开关
        const timerCheckbox = document.getElementById('enableTimerSync');
        const intervalGroup = document.getElementById('syncIntervalGroup');

        if (timerCheckbox) {
            timerCheckbox.addEventListener('change', () => {
                if (intervalGroup) {
                    intervalGroup.style.display = timerCheckbox.checked ? 'block' : 'none';
                }
            });
        }

        // 保存配置按钮
        const saveConfigBtn = document.getElementById('saveGithubConfigBtn');
        if (saveConfigBtn) {
            saveConfigBtn.addEventListener('click', () => this.saveGithubConfig());
        }

        // 立即同步按钮
        const syncNowBtn = document.getElementById('syncNowBtn');
        if (syncNowBtn) {
            syncNowBtn.addEventListener('click', () => this.githubSync.syncNow());
        }

        // 拉取按钮
        const pullBtn = document.getElementById('pullFromGithubBtn');
        if (pullBtn) {
            pullBtn.addEventListener('click', () => this.githubSync.pullFromGithub());
        }

        // 推送按钮
        const pushBtn = document.getElementById('pushToGithubBtn');
        if (pushBtn) {
            pushBtn.addEventListener('click', () => this.githubSync.pushToGithub());
        }
    }

    // 保存 GitHub 同步配置
    async saveGithubConfig() {
        const enabled = document.getElementById('enableGithubSync')?.checked || false;
        const token = document.getElementById('githubToken')?.value.trim() || '';
        const repo = document.getElementById('githubRepo')?.value.trim() || '';
        const branch = document.getElementById('githubBranch')?.value.trim() || 'main';
        const timerSync = document.getElementById('enableTimerSync')?.checked || false;
        const syncInterval = parseInt(document.getElementById('syncInterval')?.value) || 30;

        if (enabled) {
            if (!token) {
                this.showToast('请输入 GitHub Token', 'warning');
                return;
            }
            if (!repo || !repo.includes('/')) {
                this.showToast('请输入正确的仓库名称 (格式: username/repo)', 'warning');
                return;
            }

            // 验证 Token
            this.showToast('正在验证 Token...', 'info');
            const isValid = await this.githubSync.validateToken(token);
            if (!isValid) {
                this.showToast('GitHub Token 无效', 'error');
                return;
            }
        }

        const config = {
            enabled,
            token,
            repo,
            branch,
            timerSync,
            syncInterval,
            lastSyncTime: this.githubSync.config?.lastSyncTime || null
        };

        try {
            await this.githubSync.saveConfig(config);
            this.githubSync.updateSyncStatusUI();
            this.showToast('配置已保存', 'success');
        } catch (error) {
            this.showToast('保存失败: ' + error.message, 'error');
        }
    }

    // =====================================================
    // Tab Methods
    // =====================================================
    switchTab(tab) {
        this.currentTab = tab;

        // Update tab buttons
        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });

        // Show/hide sections
        document.getElementById('dnsSection').style.display = tab === 'dns' ? 'block' : 'none';
        document.getElementById('workersSection').style.display = tab === 'workers' ? 'block' : 'none';
        document.getElementById('pagesSection').style.display = tab === 'pages' ? 'block' : 'none';
        document.getElementById('notesSection').style.display = tab === 'notes' ? 'block' : 'none';

        // Update stats visibility
        const notesStatCard = document.getElementById('notesStatCard');
        if (notesStatCard) {
            notesStatCard.style.display = tab === 'notes' ? 'flex' : 'none';
        }

        // Load data if needed
        if (tab === 'workers') {
            if (this.workers.length === 0) {
                this.loadWorkersAndRender();
            } else {
                this.renderWorkers();
            }
        }
        if (tab === 'pages') {
            if (this.pages.length === 0) {
                this.loadPagesAndRender();
            } else {
                this.renderPages();
            }
        }
        if (tab === 'notes') {
            this.loadRemarksAndRender();
        }
    }

    // =====================================================
    // Search & Filter Methods
    // =====================================================
    handleSearch(query) {
        this.searchQuery = query.toLowerCase().trim();
        const clearBtn = document.getElementById('clearSearchBtn');
        clearBtn.style.display = this.searchQuery ? 'flex' : 'none';
        this.renderAllRecords();
    }

    clearSearch() {
        document.getElementById('searchInput').value = '';
        this.searchQuery = '';
        document.getElementById('clearSearchBtn').style.display = 'none';
        this.renderAllRecords();
    }

    handleZoneFilter(zoneId) {
        this.selectedZoneId = zoneId;
        this.renderAllRecords();
    }

    renderZoneFilter() {
        const select = document.getElementById('zoneFilter');
        select.innerHTML = '<option value="">全部域名</option>';

        this.zones.forEach(zone => {
            const option = document.createElement('option');
            option.value = zone.id;
            option.textContent = zone.name;
            select.appendChild(option);
        });
    }

    getFilteredRecords() {
        let records = this.allRecords;

        // 先按域名筛选
        if (this.selectedZoneId) {
            records = records.filter(record => record.zoneId === this.selectedZoneId);
        }

        // 再按搜索关键词筛选
        if (this.searchQuery) {
            records = records.filter(record => {
                return record.zoneName.toLowerCase().includes(this.searchQuery) ||
                    record.name.toLowerCase().includes(this.searchQuery) ||
                    record.content.toLowerCase().includes(this.searchQuery) ||
                    record.type.toLowerCase().includes(this.searchQuery);
            });
        }

        return records;
    }

    // =====================================================
    // UI Methods
    // =====================================================
    updateUI() {
        this.renderAccountSelector();

        // 更新头部账户名显示和颜色
        this.updateHeaderAccountUI();

        const tabsSection = document.getElementById('tabsSection');
        const statsSection = document.getElementById('statsSection');
        const welcomeSection = document.getElementById('welcomeSection');

        if (this.accounts.length === 0) {
            // 没有账户，显示欢迎界面
            tabsSection.style.display = 'none';
            statsSection.style.display = 'none';
            welcomeSection.style.display = 'flex';
        } else if (!this.currentAccount) {
            // 有账户但未选择，隐藏欢迎界面，打开侧边栏
            welcomeSection.style.display = 'none';
            tabsSection.style.display = 'none';
            statsSection.style.display = 'none';
            this.openSidebar();
        } else {
            // 有选中的账户，加载数据
            welcomeSection.style.display = 'none';
            this.loadAllZonesAndRecords();
        }
    }

    /**
     * 更新头部账户名称显示和颜色
     */
    async updateHeaderAccountUI() {
        const headerAccountName = document.getElementById('headerAccountName');
        if (!headerAccountName) return;

        if (this.currentAccount) {
            headerAccountName.textContent = this.currentAccount.name;
            headerAccountName.style.display = 'inline-block';

            // 基础类名，保持 header-account-badge
            headerAccountName.className = 'header-account-badge';

            try {
                // 尝试获取真实的 Cloudflare 账户 ID 以匹配颜色
                // 此时 getAccountId 会尝试通过 API 或已加载的 zones 获取
                const realAccountId = await this.getAccountId();
                if (realAccountId) {
                    const colorClass = this.getAccountColorClass(realAccountId);
                    headerAccountName.classList.add(colorClass);
                }
            } catch (e) {
                // 如果暂时获取不到 ID（例如还在加载中），保持默认样式
                console.log('未获取到账户 ID，保持默认颜色');
            }
        } else {
            headerAccountName.style.display = 'none';
        }
    }

    renderAccountSelector() {
        const select = document.getElementById('accountSelect');
        select.innerHTML = '<option value="">请选择账户</option>';

        this.accounts.forEach(account => {
            const option = document.createElement('option');
            option.value = account.id;
            option.textContent = account.name;
            if (this.currentAccount?.id === account.id) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    // 加载所有域名和所有记录
    async loadAllZonesAndRecords() {
        const tabsSection = document.getElementById('tabsSection');
        const statsSection = document.getElementById('statsSection');
        const dnsSection = document.getElementById('dnsSection');
        const recordsList = document.getElementById('recordsList');

        try {
            // 1. 瞬间呈现：显示 Tab 布局，不使用 showLoading() 遮罩阻断用户操作
            tabsSection.style.display = 'block';
            dnsSection.style.display = 'block';
            
            // 2. 局部加载状态：仅在列表区显示加载，不卡死全局
            if (this.allRecords.length === 0) {
                recordsList.innerHTML = '<div class="loading">正在加载缓存记录...</div>';
            }

            // 3. 智能重置：保留全局资源（Workers/Pages），仅重置当前账户相关的 DNS 状态
            this.selectedZoneId = '';
            this.searchQuery = '';
            // 不再重置 this.workers = []; 和 this.pages = []; 确保备注页秒开

            // 4. 重置搜索 UI
            document.getElementById('searchInput').value = '';
            document.getElementById('clearSearchBtn').style.display = 'none';

            // 5. 重要：切换账户时必须彻底清除旧账户的 Workers 和 Pages 状态，防止 UI 混淆
            this.workers = [];
            this.pages = [];
            this.allRecords = [];
            this.zones = [];
            
            // 尝试加载新账户的缓存
            await this.loadResourceCache();

            // 6. 执行加载流程（后台执行，不阻塞 UI 渲染完成）
            // 我们先渲染一次缓存数据
            this.renderAllRecords();
            this.renderZoneFilter();

            // 7. 异步刷新：在后台拉取最新数据
            setTimeout(async () => {
                try {
                    console.log('[AccountSwitch] Background refreshing zones and records...');
                    await this.loadZones();
                    this.renderZoneFilter();
                    
                    await this.loadAllRecords();
                    
                    this.collapsedZones = new Set(this.zones.map(z => z.name));
                    document.getElementById('recordCount').textContent = `${this.allRecords.length} 条记录`;
                    
                    this.updateNotesStatCard();
                    this.renderAllRecords();
                    this.updateHeaderAccountUI();
                    
                    await this.saveResourceCache();
                } catch (e) {
                    console.error('[AccountSwitch] Background refresh failed:', e);
                }
            }, 0);

        } catch (error) {
            this.showToast(error.message, 'error');
        }
    }


    // 获取账户颜色类名
    getAccountColorClass(accountId) {
        if (!accountId) return 'account-color-default';

        if (!this.accountColorMap.has(accountId)) {
            // 分配下一个可用颜色
            const colorIndex = this.nextColorIndex % 6; // 6种预定义颜色
            this.accountColorMap.set(accountId, colorIndex);
            this.nextColorIndex++;
        }

        const index = this.accountColorMap.get(accountId);
        return `account-color-${index}`;
    }

    // 渲染所有记录，按域名分组
    renderAllRecords() {
        const list = document.getElementById('recordsList');
        // 获取过滤后的记录用于统计和分组
        const filteredRecords = this.getFilteredRecords();

        list.innerHTML = '';

        // 按域名分组记录
        const groupedRecords = {};
        filteredRecords.forEach(record => {
            if (!groupedRecords[record.zoneName]) {
                groupedRecords[record.zoneName] = [];
            }
            groupedRecords[record.zoneName].push(record);
        });

        // 确定要显示的域名列表
        let zonesToRender = this.zones;

        // 1. 如果选择了特定域名筛选
        if (this.selectedZoneId) {
            zonesToRender = zonesToRender.filter(z => z.id === this.selectedZoneId);
        }

        // 2. 如果有搜索关键词
        if (this.searchQuery) {
            zonesToRender = zonesToRender.filter(z => {
                const nameMatch = z.name.toLowerCase().includes(this.searchQuery);
                const hasMatchingRecords = groupedRecords[z.name] && groupedRecords[z.name].length > 0;
                return nameMatch || hasMatchingRecords;
            });
        }


        // 如果有搜索关键词，显示搜索结果统计
        if (this.searchQuery) {
            const searchInfo = document.createElement('div');
            searchInfo.className = 'search-result-info';
            // 计算匹配的域名数量和记录数量
            const matchingZones = zonesToRender.length;
            const matchingRecords = filteredRecords.length;
            searchInfo.innerHTML = `找到 <strong>${matchingZones}</strong> 个域名，<strong>${matchingRecords}</strong> 条记录`;
            list.appendChild(searchInfo);
        }

        // 渲染域名分组
        zonesToRender.sort((a, b) => {
            const accountA = a.account?.name || '';
            const accountB = b.account?.name || '';
            if (accountA !== accountB) {
                return accountA.localeCompare(accountB);
            }
            return a.name.localeCompare(b.name);
        }).forEach(zone => {
            const zoneName = zone.name;
            const records = groupedRecords[zoneName] || [];
            const isCollapsed = this.collapsedZones.has(zoneName);

            // 域名分组容器
            const groupContainer = document.createElement('div');
            groupContainer.className = 'zone-group';

            // 获取 zoneId 和账户信息
            const zoneId = zone.id;
            const accountName = zone.account?.name || '';
            const accountId = zone.account?.id || '';

            // 生成账户标签 HTML
            let accountTagHtml = '';
            if (accountName) {
                const colorClass = this.getAccountColorClass(accountId);
                accountTagHtml = `<span class="account-tag ${colorClass}" title="所属账户: ${this.escapeHtml(accountName)}">${this.escapeHtml(accountName)}</span>`;
            }

            // 域名分组标题（可点击折叠）
            const groupHeader = document.createElement('div');
            groupHeader.className = `zone-group-header ${isCollapsed ? 'collapsed' : ''}`;
            const zoneRemarkBtn = this.getRemarkButtonHtml('zone', zoneId, '添加域名备注').replace('data-action="remark"', 'data-action="zone-remark"');

            // 如果没有记录，可以在数量显示上做区分
            const countText = records.length > 0 ? `${records.length} 条记录` : '无记录';

            groupHeader.innerHTML = `
                <div class="zone-header-left">
                    <span class="zone-toggle">${isCollapsed ? '▶' : '▼'}</span>
                    <span class="zone-name">${this.escapeHtml(zoneName)}</span>
                    ${accountTagHtml}
                    ${zoneRemarkBtn}
                </div>
                <span class="zone-record-count">${countText}</span>
            `;

            // 域名备注按钮事件
            groupHeader.querySelector('[data-action="zone-remark"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.openRemarkModal('zone', zoneId, zoneName, countText);
            });

            groupHeader.addEventListener('click', (e) => {
                if (e.target.closest('[data-action="zone-remark"]')) return;
                this.toggleZoneCollapse(zoneName);
            });
            groupContainer.appendChild(groupHeader);

            // 记录列表容器
            const recordsContainer = document.createElement('div');
            recordsContainer.className = `zone-records ${isCollapsed ? 'collapsed' : ''}`;

            if (records.length === 0) {
                recordsContainer.classList.add('empty-records-container');
                recordsContainer.innerHTML = '<div class="empty-records-text">暂无 DNS 记录</div>';
            } else {
                // 该域名下的所有记录
                records.forEach(record => {
                    const item = document.createElement('div');
                    item.className = 'record-item';
                    item.innerHTML = `
                        <div class="record-type type-${record.type.toLowerCase()}">${record.type}</div>
                        <div class="record-info">
                            <div class="record-name-row">
                                <span class="record-name">${this.escapeHtml(record.name)}</span>
                                ${this.getRemarkButtonHtml('dns', record.id, '添加备注')}
                            </div>
                            <div class="record-content">${this.escapeHtml(record.content)}</div>
                        </div>
                        <div class="record-meta">
                            <div class="record-proxied ${record.proxied ? 'proxied-on' : 'proxied-off'}">
                                ${record.proxied ? '☁️' : '⚙️'}
                            </div>
                            <div class="record-ttl">${record.ttl === 1 ? '自动' : record.ttl + 's'}</div>
                        </div>
                        <div class="record-actions">
                            <button class="icon-btn" title="编辑" data-action="edit">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <button class="icon-btn" title="删除" data-action="delete">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                    <polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                        </div>
                    `;

                    item.querySelector('[data-action="remark"]').addEventListener('click', (e) => {
                        this.handleRemarkButtonClick(e, 'dns', record.id, record.name, `${record.type} → ${record.content}`);
                    });
                    item.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
                        e.stopPropagation();
                        console.log('Edit button clicked for record:', record.name);
                        this.editRecord(record);
                    });
                    item.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.confirmDeleteRecord(record.zoneId, record.id);
                    });

                    recordsContainer.appendChild(item);
                });
            }

            groupContainer.appendChild(recordsContainer);
            list.appendChild(groupContainer);
        });
    }

    // 切换域名折叠状态
    toggleZoneCollapse(zoneName) {
        if (this.collapsedZones.has(zoneName)) {
            this.collapsedZones.delete(zoneName);
        } else {
            this.collapsedZones.add(zoneName);
        }
        this.renderAllRecords();
        this.updateToggleAllButton();
    }

    // 全部展开/折叠
    toggleAllZones() {
        const allCollapsed = this.collapsedZones.size === this.zones.length;

        if (allCollapsed) {
            // 全部展开
            this.collapsedZones.clear();
        } else {
            // 全部折叠
            this.collapsedZones = new Set(this.zones.map(z => z.name));
        }

        this.renderAllRecords();
        this.updateToggleAllButton();
    }

    // 更新展开/折叠按钮状态
    updateToggleAllButton() {
        const btn = document.getElementById('toggleAllBtn');
        const icon = document.getElementById('toggleAllIcon');
        const allCollapsed = this.collapsedZones.size === this.zones.length;

        if (allCollapsed) {
            icon.textContent = '▼';
            btn.innerHTML = '<span id="toggleAllIcon">▼</span> 全部展开';
        } else {
            icon.textContent = '▲';
            btn.innerHTML = '<span id="toggleAllIcon">▲</span> 全部折叠';
        }
    }

    // =====================================================
    // Sidebar Methods
    // =====================================================
    openSidebar() {
        document.getElementById('sidebar').classList.add('active');
        document.getElementById('sidebarOverlay').classList.add('active');
        this.renderAccountList();
    }

    closeSidebar() {
        document.getElementById('sidebar').classList.remove('active');
        document.getElementById('sidebarOverlay').classList.remove('active');
        this.clearAccountForm();
    }

    // =====================================================
    // Account Actions
    // =====================================================
    editAccount(accountId) {
        const account = this.accounts.find(a => a.id === accountId);
        if (!account) return;

        document.getElementById('accountName').value = account.name;
        document.getElementById('apiToken').value = account.token;
        document.getElementById('deleteAccountBtn').style.display = 'block';

        this.editingAccountId = accountId;
    }

    clearAccountForm() {
        document.getElementById('accountName').value = '';
        document.getElementById('apiToken').value = '';
        document.getElementById('deleteAccountBtn').style.display = 'none';
        this.editingAccountId = null;
    }

    async saveAccount() {
        const name = document.getElementById('accountName').value.trim();
        const token = document.getElementById('apiToken').value.trim();

        if (!name || !token) {
            this.showToast('请填写账户名称和 API Token', 'warning');
            return;
        }

        try {
            this.showLoading();

            // Validate token
            const isValid = await this.validateToken(token);
            if (!isValid) {
                throw new Error('API Token 无效');
            }

            // Get zones count
            const tempAccount = { token };
            this.currentAccount = tempAccount;
            const zones = await this.loadZones();

            if (this.editingAccountId) {
                // Update existing account
                const index = this.accounts.findIndex(a => a.id === this.editingAccountId);
                if (index !== -1) {
                    this.accounts[index] = {
                        ...this.accounts[index],
                        name,
                        token,
                        zonesCount: zones.length
                    };
                }
            } else {
                // Create new account
                const newAccount = {
                    id: Date.now().toString(),
                    name,
                    token,
                    zonesCount: zones.length
                };
                this.accounts.push(newAccount);
                this.currentAccount = newAccount;
            }

            await this.saveAccounts();
            this.hideLoading();
            this.clearAccountForm();
            this.renderAccountList();
            this.updateUI();
            this.showToast('账户保存成功', 'success');

        } catch (error) {
            this.hideLoading();
            this.showToast(error.message, 'error');
        }
    }

    /**
     * 渲染账户列表（侧边栏）
     */
    renderAccountList() {
        const listEl = document.getElementById('accountList');
        if (!listEl) return;

        if (this.accounts.length === 0) {
            listEl.innerHTML = '<div class="empty-text">暂无已保存的账户</div>';
            return;
        }

        listEl.innerHTML = this.accounts.map(account => `
            <div class="account-list-item ${this.currentAccount?.id === account.id ? 'active' : ''}" data-id="${account.id}">
                <span class="account-list-item-name">${this.escapeHtml(account.name)}</span>
                <div class="account-list-item-actions">
                    <button class="account-list-item-btn" data-action="edit" title="编辑">✏️</button>
                    <button class="account-list-item-btn danger" data-action="delete" title="删除">🗑️</button>
                </div>
            </div>
        `).join('');

        // 绑定事件
        listEl.querySelectorAll('.account-list-item').forEach(item => {
            const accountId = item.dataset.id;

            // 点击切换账户
            item.addEventListener('click', (e) => {
                if (!e.target.closest('.account-list-item-actions')) {
                    this.switchAccount(accountId);
                    this.closeSidebar();
                }
            });

            // 编辑按钮
            item.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.editAccount(accountId);
            });

            // 删除按钮
            item.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.confirmDeleteAccount(accountId);
            });
        });
    }

    confirmDeleteAccount(accountId) {
        if (confirm('确定要删除此账户吗？')) {
            this.accounts = this.accounts.filter(a => a.id !== accountId);
            if (this.currentAccount?.id === accountId) {
                this.currentAccount = this.accounts[0] || null;
            }
            this.saveAccounts();
            this.renderAccountList();
            this.updateUI();
            this.showToast('账户已删除', 'success');
        }
    }

    deleteAccount() {
        if (this.editingAccountId) {
            this.confirmDeleteAccount(this.editingAccountId);
            this.clearAccountForm();
        }
    }

    async switchAccount(accountId) {
        if (!accountId) {
            this.currentAccount = null;
            document.getElementById('statsSection').style.display = 'none';
            document.getElementById('dnsSection').style.display = 'none';
            return;
        }

        this.currentAccount = this.accounts.find(a => a.id === accountId);
        // 重置 accountId，以便 getAccountId 重新获取正确的 Cloudflare ID
        this.accountId = null;

        // 更新头部 UI
        await this.updateHeaderAccountUI();

        await this.saveAccounts();
        await this.loadAllZonesAndRecords();

        // 数据加载完成后，loadAllZonesAndRecords 内部会自动再次调用 updateHeaderAccountUI
    }

    /**
     * 切换到下一个账户
     */
    async switchToNextAccount() {
        if (!this.accounts || this.accounts.length <= 1) {
            this.openSidebar(); // 如果只有一个账户或没有账户，打开侧边栏
            return;
        }

        const currentIndex = this.accounts.findIndex(a => a.id === this.currentAccount?.id);
        const nextIndex = (currentIndex + 1) % this.accounts.length;
        const nextAccount = this.accounts[nextIndex];

        if (nextAccount) {
            this.showToast(`正在切换到: ${nextAccount.name}...`, 'info');
            await this.switchAccount(nextAccount.id);
        }
    }

    // =====================================================
    // Record Actions
    // =====================================================
    showRecordForm() {
        this.editingRecordId = null;
        this.editingZoneId = null;
        this.clearRecordForm();
        this.renderZoneSelector();
        const formEl = document.getElementById('recordForm');
        document.getElementById('recordFormTitle').textContent = '添加 DNS 记录';
        formEl.style.display = 'block';
        this.handleRecordTypeChange('A');
    }

    hideRecordForm() {
        document.getElementById('recordForm').style.display = 'none';
        this.clearRecordForm();
    }

    renderZoneSelector() {
        const select = document.getElementById('recordZone');
        select.innerHTML = '';

        this.zones.forEach(zone => {
            const option = document.createElement('option');
            option.value = zone.id;
            option.textContent = zone.name;
            select.appendChild(option);
        });
    }

    clearRecordForm() {
        document.getElementById('recordType').value = 'A';
        document.getElementById('recordName').value = '';
        document.getElementById('recordContent').value = '';
        document.getElementById('recordTTL').value = '1';
        document.getElementById('recordProxied').checked = false;
        const priorityInput = document.getElementById('recordPriority');
        if (priorityInput) priorityInput.value = '';
        this.editingRecordId = null;
        this.editingZoneId = null;
    }

    handleRecordTypeChange(type) {
        const priorityRow = document.getElementById('recordPriorityRow');
        const proxiedGroup = document.getElementById('recordProxied').closest('.form-group');

        if (type === 'MX' || type === 'SRV') {
            priorityRow.style.display = 'flex';
        } else {
            priorityRow.style.display = 'none';
        }

        // CNAME, A, AAAA usually support proxy. MX, TXT, NS, SRV don't.
        const canProxy = ['A', 'AAAA', 'CNAME'].includes(type);
        if (proxiedGroup) {
            proxiedGroup.style.display = canProxy ? 'block' : 'none';
        }
    }

    editRecord(record) {
        console.log('editRecord called with:', record);
        this.editingRecordId = record.id;
        this.editingZoneId = record.zoneId;

        this.renderZoneSelector();

        const formEl = document.getElementById('recordForm');
        document.getElementById('recordFormTitle').textContent = '编辑 DNS 记录';

        document.getElementById('recordZone').value = record.zoneId;
        document.getElementById('recordType').value = record.type;
        document.getElementById('recordName').value = record.name.replace(`.${record.zoneName}`, '');
        document.getElementById('recordContent').value = record.content;
        document.getElementById('recordTTL').value = record.ttl.toString();
        document.getElementById('recordProxied').checked = record.proxied;

        const priorityInput = document.getElementById('recordPriority');
        if (priorityInput) {
            priorityInput.value = record.priority !== undefined ? record.priority : '';
        }

        this.handleRecordTypeChange(record.type);

        formEl.style.display = 'block';
        // 滚动到表单位置
        formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async saveRecord() {
        const zoneId = document.getElementById('recordZone').value;
        const type = document.getElementById('recordType').value;
        let name = document.getElementById('recordName').value.trim();
        const content = document.getElementById('recordContent').value.trim();
        const ttl = parseInt(document.getElementById('recordTTL').value);
        const proxied = document.getElementById('recordProxied').checked;
        const priorityInput = document.getElementById('recordPriority');
        const priority = (type === 'MX' || type === 'SRV') ? parseInt(priorityInput.value) : undefined;

        if (!zoneId || !name || !content) {
            this.showToast('请填写完整信息', 'warning');
            return;
        }

        // 获取域名
        const zone = this.zones.find(z => z.id === zoneId);
        if (!zone) {
            this.showToast('域名不存在', 'error');
            return;
        }

        // Append zone name if not already present
        if (!name.endsWith(zone.name)) {
            name = name === '@' ? zone.name : `${name}.${zone.name}`;
        }

        const recordData = { type, name, content, ttl };

        // Only include proxied if it's supported by the record type
        if (['A', 'AAAA', 'CNAME'].includes(type)) {
            recordData.proxied = proxied;
        }

        // Include priority for MX and SRV
        if (priority !== undefined && !isNaN(priority)) {
            recordData.priority = priority;
        }

        try {
            this.showLoading();

            if (this.editingRecordId) {
                await this.updateRecord(this.editingZoneId, this.editingRecordId, recordData);
                this.showToast('记录更新成功', 'success');
            } else {
                await this.createRecord(zoneId, recordData);
                this.showToast('记录创建成功', 'success');
            }

            this.hideLoading();
            this.hideRecordForm();
            await this.loadAllZonesAndRecords();

        } catch (error) {
            this.hideLoading();
            this.showToast(error.message, 'error');
        }
    }

    async confirmDeleteRecord(zoneId, recordId) {
        if (confirm('确定要删除此 DNS 记录吗？')) {
            try {
                this.showLoading();
                await this.deleteRecord(zoneId, recordId);
                this.hideLoading();
                this.showToast('记录已删除', 'success');
                await this.loadAllZonesAndRecords();
            } catch (error) {
                this.hideLoading();
                this.showToast(error.message, 'error');
            }
        }
    }

    // =====================================================
    // Export - 导出所有记录
    // =====================================================
    async exportRecords() {
        if (this.allRecords.length === 0) {
            this.showToast('没有可导出的记录', 'warning');
            return;
        }

        const headers = ['Zone Name', 'Type', 'Name', 'Content', 'TTL', 'Proxied'];
        const rows = this.allRecords.map(r => [
            r.zoneName,
            r.type,
            r.name,
            r.content,
            r.ttl,
            r.proxied
        ]);

        const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
        const filename = `all_dns_records_${new Date().toISOString().slice(0, 10)}.csv`;

        const result = await this.downloadCSV(csv, filename);
    }

    async exportData() {
        // 导出所有数据到一个 JSON 文件
        const allData = {
            exportDate: new Date().toISOString(),
            zones: this.zones.map(z => ({
                id: z.id,
                name: z.name,
                status: z.status
            })),
            dnsRecords: this.allRecords.map(r => ({
                zoneName: r.zoneName,
                type: r.type,
                name: r.name,
                content: r.content,
                ttl: r.ttl,
                proxied: r.proxied
            })),
            workers: this.workers.map(w => ({
                id: w.id,
                created_on: w.created_on,
                modified_on: w.modified_on
            })),
            pages: this.pages.map(p => ({
                name: p.name,
                subdomain: p.subdomain || p.name,
                url: `https://${p.subdomain || p.name}.pages.dev`,
                created_on: p.created_on
            })),
            remarks: Object.entries(this.remarks)
                .filter(([_, v]) => v.content)
                .map(([key, value]) => ({
                    key,
                    ...value
                }))
        };

        // 获取当前账户名称
        // 1. 从 accounts 数组中查找当前账户
        // 2. 从下拉框获取选中的文本
        // 3. 使用 currentAccount.name
        let accountName = 'cloudflare';

        // 方法1：从 accounts 数组查找
        if (this.currentAccount?.id) {
            const account = this.accounts.find(a => a.id === this.currentAccount.id);
            if (account?.name) {
                accountName = account.name;
            }
        }

        // 方法2：如果还是默认值，尝试从下拉框获取
        if (accountName === 'cloudflare') {
            const accountSelect = document.getElementById('accountSelect');
            const selectedText = accountSelect?.selectedOptions[0]?.textContent;
            if (selectedText && selectedText !== '请选择账户') {
                accountName = selectedText;
            }
        }

        // 如果账户名看起来像是 UUID，则使用默认名
        if (accountName.length > 30 && (accountName.match(/-/g) || []).length >= 3) {
            accountName = 'cloudflare';
        }

        console.log('导出文件名使用账户名:', accountName); // 调试日志

        // 替换文件名中不允许的字符
        const safeAccountName = accountName.replace(/[<>:"/\\|?*]/g, '_');
        // 生成日期时间字符串：YYYYMMDD-HHMMSS
        const now = new Date();
        const dateTime = now.getFullYear().toString() +
            (now.getMonth() + 1).toString().padStart(2, '0') +
            now.getDate().toString().padStart(2, '0') + '-' +
            now.getHours().toString().padStart(2, '0') +
            now.getMinutes().toString().padStart(2, '0') +
            now.getSeconds().toString().padStart(2, '0');
        const filename = `${safeAccountName}-${dateTime}.json`;
        await this.downloadJSON(allData, filename);
        // 注意：使用 a 标签下载无法准确知道用户是否完成保存，所以不显示完成消息
    }

    async exportWorkers() {
        if (this.workers.length === 0) {
            this.showToast('没有可导出的 Workers', 'warning');
            return;
        }

        const headers = ['Name', 'Created', 'Modified'];
        const rows = this.workers.map(w => [
            w.id,
            w.created_on || '',
            w.modified_on || ''
        ]);

        const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
        const filename = `workers_${new Date().toISOString().slice(0, 10)}.csv`;

        const result = await this.downloadCSV(csv, filename);
    }

    async refresh() {
        if (this.currentAccount) {
            if (this.currentTab === 'dns') {
                await this.loadAllZonesAndRecords();
            } else if (this.currentTab === 'workers') {
                await this.loadWorkersAndRender();
            } else if (this.currentTab === 'pages') {
                await this.loadPagesAndRender();
            }
            this.showToast('刷新完成', 'success');
        }
    }

    // =====================================================
    // Workers Methods
    // =====================================================
    async loadWorkersAndRender() {
        const workersList = document.getElementById('workersList');
        const workersStatCard = document.getElementById('workersStatCard');

        try {
            workersList.innerHTML = '<div class="loading">正在加载 Workers...</div>';

            await this.loadWorkers();

            // 更新统计
            workersStatCard.style.display = 'flex';
            document.getElementById('workersCount').textContent = `${this.workers.length} 个 Workers`;

            this.renderWorkers();
            this.updateTabCounts();

        } catch (error) {
            workersList.innerHTML = `<div class="empty-state"><p>加载失败: ${this.escapeHtml(error.message)}</p></div>`;
        }
    }

    handleWorkersSearch(query) {
        this.workersSearchQuery = query.toLowerCase().trim();
        this.renderWorkers();
    }

    getFilteredWorkers() {
        if (!this.workersSearchQuery) {
            return this.workers;
        }
        return this.workers.filter(w => {
            const query = this.workersSearchQuery;
            const remark = this.getRemark('worker', w.id);
            const alias = remark?.alias?.toLowerCase() || '';
            const id = w.id.toLowerCase();
            return id.includes(query) || alias.includes(query);
        });
    }

    renderWorkers() {
        const list = document.getElementById('workersList');
        const filteredWorkers = this.getFilteredWorkers();

        if (filteredWorkers.length === 0) {
            if (this.workersSearchQuery) {
                list.innerHTML = `
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                            <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                            <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <p>未找到匹配的 Workers</p>
                    </div>
                `;
            } else {
                list.innerHTML = `
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                            <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="2"/>
                            <path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <p>暂无 Workers 项目</p>
                    </div>
                `;
            }
            return;
        }

        list.innerHTML = '';

        // 如果有搜索关键词，显示搜索结果统计
        if (this.workersSearchQuery) {
            const searchInfo = document.createElement('div');
            searchInfo.className = 'search-result-info';
            searchInfo.innerHTML = `找到 <strong>${filteredWorkers.length}</strong> 条匹配的 Workers`;
            list.appendChild(searchInfo);
        }

        filteredWorkers.forEach(worker => {
            const createdDate = worker.created_on ? new Date(worker.created_on).toLocaleDateString('zh-CN') : '-';
            const modifiedDate = worker.modified_on ? new Date(worker.modified_on).toLocaleDateString('zh-CN') : '-';

            const remark = this.getRemark('worker', worker.id);
            const alias = remark?.alias;
            const displayName = alias || worker.id;
            const originalIdHtml = alias ? `<span class="resource-id-hint" title="原始 ID: ${this.escapeHtml(worker.id)}">${this.escapeHtml(worker.id)}</span>` : '';

            const item = document.createElement('div');
            item.className = 'worker-item';
            item.innerHTML = `
                <div class="worker-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <div class="worker-info">
                    <div class="worker-name-row">
                        <a href="https://dash.cloudflare.com/${worker.account?.id || ''}/workers/services/view/${worker.id}/production/settings?antigravity_auto_rename=1" class="worker-name-link dashboard-rename-link" data-type="worker" data-id="${worker.id}" title="前往 Cloudflare 重命名资源 (自动滚屏并点击按钮)">
                            <span class="worker-name">${this.escapeHtml(displayName)}</span>
                        </a>
                        ${originalIdHtml}
                        <button class="edit-alias-btn" data-action="rename" title="修改项目名称">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                            </svg>
                        </button>
                        ${worker.account ? `<span class="account-tag ${this.getAccountColorClass(worker.account.id)}">${this.escapeHtml(worker.account.name)}</span>` : ''}
                        ${this.getRemarkButtonHtml('worker', worker.id, '添加备注')}
                    </div>
                    <div class="worker-meta">
                        <span>📅 创建: ${createdDate}</span>
                        <span>✏️ 修改: ${modifiedDate}</span>
                    </div>
                </div>
                <div class="worker-actions">
                    <a class="worker-url-btn" href="https://dash.cloudflare.com/${worker.account?.id || ''}/workers/services/view/${worker.id}/production" target="_blank" title="在 Dashboard 中查看">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </a>
                    <button class="delete-btn" data-action="delete" title="删除 Worker">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            <line x1="10" y1="11" x2="10" y2="17"></line>
                            <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                    </button>
                </div>
            `;

            item.querySelector('[data-action="remark"]').addEventListener('click', (e) => {
                this.handleRemarkButtonClick(e, 'worker', worker.id, worker.id, `创建于 ${createdDate}`);
            });

            item.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
                this.handleRemarkButtonClick(e, 'worker', worker.id, worker.id, `创建于 ${createdDate}`);
            });

            item.querySelector('.dashboard-rename-link').addEventListener('click', (e) => {
                e.preventDefault();
                this.automateDashboardRename(e.currentTarget.href);
            });

            item.querySelector('[data-action="delete"]').addEventListener('click', () => {
                this.confirmDeleteWorker(worker);
            });

            list.appendChild(item);
        });
    }

    // =====================================================
    // Pages Methods
    // =====================================================
    async loadPagesAndRender() {
        const pagesList = document.getElementById('pagesList');
        const pagesStatCard = document.getElementById('pagesStatCard');

        try {
            pagesList.innerHTML = '<div class="loading">正在加载 Pages...</div>';

            await this.loadPages();

            // 更新统计
            pagesStatCard.style.display = 'flex';
            document.getElementById('pagesCount').textContent = `${this.pages.length} 个 Pages`;

            this.renderPages();
            this.updateTabCounts();

        } catch (error) {
            pagesList.innerHTML = `<div class="empty-state"><p>加载失败: ${this.escapeHtml(error.message)}</p></div>`;
        }
    }

    handlePagesSearch(query) {
        this.pagesSearchQuery = query.toLowerCase().trim();
        this.renderPages();
    }

    getFilteredPages() {
        if (!this.pagesSearchQuery) {
            return this.pages;
        }
        return this.pages.filter(p => {
            const query = this.pagesSearchQuery;
            const remark = this.getRemark('page', p.name);
            const alias = remark?.alias?.toLowerCase() || '';
            const name = p.name.toLowerCase();
            const subdomain = (p.subdomain || '').toLowerCase();
            return name.includes(query) || subdomain.includes(query) || alias.includes(query);
        });
    }

    renderPages() {
        const list = document.getElementById('pagesList');
        const filteredPages = this.getFilteredPages();

        if (filteredPages.length === 0) {
            if (this.pagesSearchQuery) {
                list.innerHTML = `
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                            <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                            <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <p>未找到匹配的 Pages</p>
                    </div>
                `;
            } else {
                list.innerHTML = `
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2"/>
                            <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <p>暂无 Pages 项目</p>
                    </div>
                `;
            }
            return;
        }

        list.innerHTML = '';

        // 如果有搜索关键词，显示搜索结果统计
        if (this.pagesSearchQuery) {
            const searchInfo = document.createElement('div');
            searchInfo.className = 'search-result-info';
            searchInfo.innerHTML = `找到 <strong>${filteredPages.length}</strong> 条匹配的 Pages`;
            list.appendChild(searchInfo);
        }

        filteredPages.forEach(page => {
            const createdDate = page.created_on ? new Date(page.created_on).toLocaleDateString('zh-CN') : '-';
            const subdomain = page.subdomain || page.name;
            const pagesUrl = `https://${subdomain}.pages.dev`;
            const latestDeployment = page.latest_deployment;
            const deployStatus = latestDeployment?.latest_stage?.status || 'unknown';

            const remark = this.getRemark('page', page.name);
            const alias = remark?.alias;
            const displayName = alias || page.name;
            const originalNameHtml = alias ? `<span class="resource-id-hint" title="项目 ID: ${this.escapeHtml(page.name)}">${this.escapeHtml(page.name)}</span>` : '';

            const item = document.createElement('div');
            item.className = 'page-item';
            item.innerHTML = `
                <div class="page-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </div>
                <div class="page-info">
                    <div class="page-name-row">
                        <a href="https://dash.cloudflare.com/${page.account?.id || ''}/pages/view/${page.name}/settings?antigravity_auto_rename=1" class="page-name-link dashboard-rename-link" data-type="page" data-id="${page.name}" title="前往 Cloudflare 重命名资源 (自动滚屏并点击按钮)">
                            <span class="page-name">${this.escapeHtml(displayName)}</span>
                        </a>
                        ${originalNameHtml}
                        <button class="edit-alias-btn" data-action="rename" title="修改项目名称">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                            </svg>
                        </button>
                        ${page.account ? `<span class="account-tag ${this.getAccountColorClass(page.account.id)}">${this.escapeHtml(page.account.name)}</span>` : ''}
                        ${this.getRemarkButtonHtml('page', page.name, '添加备注')}
                    </div>
                    <a class="page-url" href="${pagesUrl}" target="_blank">${pagesUrl}</a>
                    <div class="page-meta">
                        <span>📅 创建: ${createdDate}</span>
                        <span class="page-status ${deployStatus === 'success' ? '' : 'building'}">
                            ${deployStatus === 'success' ? '✅ 已部署' : '🔄 ' + deployStatus}
                        </span>
                    </div>
                </div>
                <div class="page-actions">
                    <a class="page-url-btn" href="https://dash.cloudflare.com/${page.account?.id || ''}/pages/view/${page.name}" target="_blank" title="在 Dashboard 中查看">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </a>
                    <button class="delete-btn" data-action="delete" title="删除项目">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            <line x1="10" y1="11" x2="10" y2="17"></line>
                            <line x1="14" y1="11" x2="14" y2="17"></line>
                        </svg>
                    </button>
                </div>
            `;

            item.querySelector('[data-action="remark"]').addEventListener('click', (e) => {
                this.handleRemarkButtonClick(e, 'page', page.name, page.name, pagesUrl);
            });

            item.querySelector('[data-action="rename"]').addEventListener('click', (e) => {
                this.handleRemarkButtonClick(e, 'page', page.name, page.name, pagesUrl);
            });

            item.querySelector('.dashboard-rename-link').addEventListener('click', (e) => {
                e.preventDefault();
                this.automateDashboardRename(e.currentTarget.href);
            });

            item.querySelector('[data-action="delete"]').addEventListener('click', () => {
                this.confirmDeletePages(page);
            });

            list.appendChild(item);
        });
    }

    async exportPages() {
        if (this.pages.length === 0) {
            this.showToast('没有可导出的 Pages', 'warning');
            return;
        }

        const headers = ['Name', 'Subdomain', 'URL', 'Created'];
        const rows = this.pages.map(p => [
            p.name,
            p.subdomain || p.name,
            `https://${p.subdomain || p.name}.pages.dev`,
            p.created_on || ''
        ]);

        const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
        const filename = `pages_${new Date().toISOString().slice(0, 10)}.csv`;

        const result = await this.downloadCSV(csv, filename);
    }

    // =====================================================
    // Deployment Methods
    // =====================================================
    showDeploymentModal(type, item) {
        this.deployingType = type;
        this.deployingItem = item;

        const modal = document.getElementById('deployModal');
        const pagesOptions = document.getElementById('pagesDeployOptions');
        const workersOptions = document.getElementById('workersDeployOptions');
        const title = document.getElementById('deployModalTitle');

        // Reset options visibility
        pagesOptions.style.display = 'none';
        workersOptions.style.display = 'none';

        if (type === 'page') {
            title.textContent = `部署 Pages: ${item.name}`;
            pagesOptions.style.display = 'block';
            document.getElementById('deployBranch').value = 'main';
        } else if (type === 'worker') {
            title.textContent = `发布 Worker: ${item.id}`;
            workersOptions.style.display = 'block';
            document.getElementById('workerScriptContent').value = '';
        }

        modal.style.display = 'flex';
    }

    hideDeployModal() {
        document.getElementById('deployModal').style.display = 'none';
        this.deployingType = null;
        this.deployingItem = null;
    }

    async startDeployment() {
        if (this.deployingType === 'page') {
            const branch = document.getElementById('deployBranch').value.trim() || 'main';
            await this.triggerPagesDeployment(this.deployingItem, branch);
        } else {
            const code = document.getElementById('workerScriptContent').value.trim();
            const name = this.deployingItem.id;

            if (!code) {
                this.showToast('请输入或上传脚本内容', 'warning');
                return;
            }

            await this.uploadWorkerScript(this.deployingItem, code);
        }
        this.hideDeployModal();
    }



    async handleWorkerScriptUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            document.getElementById('workerScriptContent').value = event.target.result;
        };
        reader.readAsText(file);
    }

    async triggerPagesDeployment(page, branch) {
        const accountId = page.account?.id;
        if (!accountId) {
            this.showToast('未找到关联的账户 ID', 'error');
            return;
        }

        try {
            this.showLoading();
            // Pages Create Deployment with branch
            const body = { branch };
            await this.apiRequest(`/accounts/${accountId}/pages/projects/${page.name}/deployments`, 'POST', body);
            this.showToast(`Pages 部署已触发: ${page.name} (${branch})`, 'success');

            setTimeout(() => this.loadPagesAndRender(), 2000);
        } catch (error) {
            console.error('Pages deployment failed:', error);
            this.showToast(`部署失败: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async uploadWorkerScript(worker, code) {
        const accountId = worker.account?.id;
        if (!accountId) {
            this.showToast('未找到关联的账户 ID', 'error');
            return;
        }

        try {
            this.showLoading();

            // 对 Worker 来说，“新建部署”意味着上传脚本并发布
            // 1. 上传脚本/创建新版本
            // 注意：Cloudflare API 的 Worker 上传通常需要 application/javascript 或 multipart/form-data
            const url = `/accounts/${accountId}/workers/scripts/${worker.id}`;

            // 简单的脚本上传 (Module 模式需要更复杂的 multipart)
            // 这里尝试使用 text/javascript 方式，或者包装成 FormData
            const formData = new FormData();
            const metadata = {
                main_module: 'index.js'
            };
            formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            formData.append('script', new Blob([code], { type: 'application/javascript' }), 'index.js');

            await this.apiRequest(url, 'PUT', formData);
            this.showToast(`Worker 脚本已更新并发布: ${worker.id}`, 'success');

            setTimeout(() => this.loadWorkersAndRender(), 2000);
        } catch (error) {
            console.error('Worker upload failed:', error);
            this.showToast(`上传失败: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    confirmDeletePages(page) {
        if (confirm(`确定要删除 Pages 项目 "${page.name}" 吗？此操作不可撤销。`)) {
            this.deletePagesProject(page);
        }
    }

    confirmDeleteWorker(worker) {
        if (confirm(`确定要删除 Worker "${worker.id}" 吗？此操作不可撤销。`)) {
            this.deleteWorker(worker);
        }
    }

    async deletePagesProject(page) {
        const accountId = page.account?.id;
        if (!accountId) {
            this.showToast('未找到关联的账户 ID', 'error');
            return;
        }
        try {
            this.showLoading();
            await this.apiRequest(`/accounts/${accountId}/pages/projects/${page.name}`, 'DELETE');
            this.showToast(`Pages 项目 "${page.name}" 已删除`, 'success');
            await this.loadPagesAndRender();
        } catch (error) {
            console.error('Delete Pages project failed:', error);
            this.showToast(`删除失败: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async deleteWorker(worker) {
        const accountId = worker.account?.id;
        if (!accountId) {
            this.showToast('未找到关联的账户 ID', 'error');
            return;
        }
        try {
            this.showLoading();
            await this.apiRequest(`/accounts/${accountId}/workers/scripts/${worker.id}`, 'DELETE');
            this.showToast(`Worker "${worker.id}" 已删除`, 'success');
            await this.loadWorkersAndRender();
        } catch (error) {
            console.error('Delete worker failed:', error);
            this.showToast(`删除失败: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    // =====================================================
    // Utility Methods
    // =====================================================

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

    showLoading() {
        document.getElementById('loadingSection').style.display = 'flex';
    }

    hideLoading() {
        document.getElementById('loadingSection').style.display = 'none';
    }

    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type} show`;

        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // =====================================================
    // Remarks Methods - 资源备注管理
    // =====================================================

    /**
     * 加载备注数据
     */
    async loadRemarks() {
        return new Promise((resolve) => {
            chrome.storage.local.get('cfRemarks', (result) => {
                this.remarks = result.cfRemarks || {};
                resolve();
            });
        });
    }

    /**
     * 保存备注数据到存储
     */
    async saveRemarksToStorage() {
        return new Promise((resolve, reject) => {
            chrome.storage.local.set({ cfRemarks: this.remarks }, () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * 获取备注的key
     */
    getRemarkKey(type, id) {
        return `${type}:${id}`;
    }

    /**
     * 检查是否有备注
     */
    hasRemark(type, id) {
        const key = this.getRemarkKey(type, id);
        return this.remarks[key] && this.remarks[key].content;
    }

    /**
     * 获取备注
     */
    getRemark(type, id) {
        const key = this.getRemarkKey(type, id);
        return this.remarks[key] || null;
    }

    /**
     * 更新备注统计卡片
     */
    updateNotesStatCard() {
        const remarksCount = Object.values(this.remarks).filter(r => r.content).length;

        const notesStatCard = document.getElementById('notesStatCard');
        const notesCountEl = document.getElementById('notesCount');

        if (notesStatCard) {
            notesStatCard.style.display = 'flex';
        }
        if (notesCountEl) {
            notesCountEl.textContent = `${remarksCount} 条备注`;
        }

        // 更新标签页中的统计数字
        this.updateTabCounts();
    }

    /**
     * 更新标签页中的统计数字
     */
    updateTabCounts() {
        const tabZoneCount = document.getElementById('tabZoneCount');
        const tabDnsCount = document.getElementById('tabDnsCount');
        const tabWorkersCount = document.getElementById('tabWorkersCount');
        const tabPagesCount = document.getElementById('tabPagesCount');
        const tabNotesCount = document.getElementById('tabNotesCount');

        if (tabZoneCount) tabZoneCount.textContent = this.zones.length;
        if (tabDnsCount) tabDnsCount.textContent = this.allRecords.length;
        if (tabWorkersCount) tabWorkersCount.textContent = this.workers.length;
        if (tabPagesCount) tabPagesCount.textContent = this.pages.length;

        const remarksCount = Object.values(this.remarks).filter(r => r.content).length;
        if (tabNotesCount) tabNotesCount.textContent = remarksCount;
    }

    /**
     * 生成备注tooltip HTML
     */
    getRemarkTooltipHtml(type, id) {
        const remark = this.getRemark(type, id);
        if (!remark || !remark.content) {
            return '';
        }

        // 截取内容预览（最多100字符）
        // Tooltip中不再进行 character-based 截断，防止破坏 Markdown 语法
        const remarkText = remark.content;

        // 生成标签HTML
        let tagsHtml = '';
        if (remark.tags && remark.tags.length > 0) {
            tagsHtml = `
                <div class="remark-tooltip-tags">
                    ${remark.tags.map(tag => `<span class="remark-tooltip-tag">${this.escapeHtml(tag)}</span>`).join('')}
                </div>
            `;
        }

        // 渲染 Markdown
        let renderedContent = '';
        if (typeof marked !== 'undefined') {
            try {
                renderedContent = marked.parse(remarkText);
            } catch (e) {
                console.error('Marked parse error:', e);
                renderedContent = this.escapeHtml(remarkText).replace(/\n/g, '<br>');
            }
        } else {
            // 如果 marked 没加载成功，执行超简易渲染
            renderedContent = this.escapeHtml(remarkText)
                .replace(/\n/g, '<br>')
                .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>')
                .replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');
        }

        return `
            <div class="remark-tooltip-content markdown-body">${renderedContent}</div>
            ${tagsHtml}
        `;
    }

    /**
     * 处理备注按钮点击
     */
    handleRemarkButtonClick(e, type, id, name, detail) {
        e.stopPropagation();
        this.openRemarkModal(type, id, name, detail);
    }

    /**
     * 生成备注按钮HTML
     */
    getRemarkButtonHtml(type, id, title = '添加备注') {
        const hasRemark = this.hasRemark(type, id);

        return `
            <button class="remark-btn ${hasRemark ? 'has-remark' : ''}" 
                    ${hasRemark ? '' : `title="${title}"`} 
                    data-action="remark" 
                    data-type="${type}" 
                    data-id="${id}">
                📝
            </button>
        `;
    }

    /**
     * 打开备注弹窗
     */
    /**
     * 自动在 Cloudflare Dashboard 设置页面滚屏并点击重命名
     */
    async automateDashboardRename(url) {
        // 直接跳转，url 中已带有 antigravity_auto_rename=1 参数
        // 由 content.js 接手自动化逻辑，这样即便 popup 关闭也没关系
        window.open(url, '_blank');
    }

    openRemarkModal(type, id, name, detail) {
        this.currentRemarkTarget = { type, id, name, detail };

        // 设置弹窗标题和目标信息
        const typeLabels = {
            'zone': '域名',
            'dns': 'DNS 记录',
            'worker': 'Worker',
            'page': 'Page'
        };

        document.getElementById('remarkModalTitle').textContent =
            this.hasRemark(type, id) ? '编辑备注' : '添加备注';

        // 查找账号信息
        let accountInfoHtml = '';
        let accountName = '';
        let accountId = '';

        if (type === 'zone' || type === 'dns') {
            const zone = this.zones.find(z => z.id === (type === 'zone' ? id : this.currentRemarkTarget.zoneId));
            if (zone && zone.account) {
                accountName = zone.account.name;
                accountId = zone.account.id;
            }
        } else if (type === 'worker') {
            const worker = this.workers.find(w => w.id === id);
            if (worker && worker.account) {
                accountName = worker.account.name;
                accountId = worker.account.id;
            }
        } else if (type === 'page') {
            const page = this.pages.find(p => p.name === id);
            if (page && page.account) {
                accountName = page.account.name;
                accountId = page.account.id;
            }
        }

        if (accountName) {
            const colorClass = this.getAccountColorClass(accountId);
            accountInfoHtml = `<span class="account-tag ${colorClass}" style="margin-left: 8px; vertical-align: middle;">${this.escapeHtml(accountName)}</span>`;
        }

        document.getElementById('remarkTargetInfo').innerHTML = `
            <div class="remark-target-type">${typeLabels[type] || type}</div>
            <div class="remark-target-name" style="display: flex; align-items: center; flex-wrap: wrap;">
                ${this.escapeHtml(name)}
                ${accountInfoHtml}
            </div>
            ${detail ? `<div class="remark-target-detail">${this.escapeHtml(detail)}</div>` : ''}
        `;

        // 填入现有备注和别名
        const existingRemark = this.getRemark(type, id);
        document.getElementById('remarkContent').value = existingRemark?.content || '';
        document.getElementById('remarkTags').value = existingRemark?.tags?.join(', ') || '';
        document.getElementById('projectAlias').value = existingRemark?.alias || '';

        // 显示/隐藏 Cloudflare 直接更名选项 (已简化为仅根据类型显示/隐藏容器)
        const renameSection = document.getElementById('cloudflareRenameSection');
        if (renameSection) {
            renameSection.style.display = (type === 'worker' || type === 'page') ? 'block' : 'none';
        }

        // 显示/隐藏删除按钮
        document.getElementById('deleteRemarkBtn').style.display =
            existingRemark?.content ? 'inline-block' : 'none';

        // 重置预览状态
        this.isPreviewing = false;
        const previewEl = document.getElementById('remarkPreview');
        const contentEl = document.getElementById('remarkContent');
        const toggleBtn = document.getElementById('togglePreviewBtn');
        if (previewEl) previewEl.style.display = 'none';
        if (contentEl) contentEl.style.display = 'block';
        if (toggleBtn) {
            toggleBtn.innerHTML = '👁️ 预览';
            toggleBtn.classList.remove('active');
        }

        // 显示弹窗
        document.getElementById('remarkModal').style.display = 'flex';

        // 聚焦到内容输入框
        setTimeout(() => {
            document.getElementById('remarkContent').focus();
        }, 100);
    }

    /**
     * 关闭备注弹窗
     */
    closeRemarkModal() {
        document.getElementById('remarkModal').style.display = 'none';
        this.currentRemarkTarget = null;
        document.getElementById('remarkContent').value = '';
        document.getElementById('remarkTags').value = '';
        document.getElementById('projectAlias').value = '';
    }

    /**
     * 保存备注
     */
    async saveRemark() {
        if (!this.currentRemarkTarget) {
            return;
        }

        const { type, id, name } = this.currentRemarkTarget;
        const content = document.getElementById('remarkContent').value.trim();
        const alias = document.getElementById('projectAlias').value.trim();
        const tagsStr = document.getElementById('remarkTags').value.trim();
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];

        const key = this.getRemarkKey(type, id);

        if (content || alias) {
            this.remarks[key] = {
                content,
                alias,
                tags,
                updatedAt: new Date().toISOString(),
                type,
                id,
                name: name || id,  // 保存名称，如果没有则使用 id
                accountId: this.currentAccount?.id || null,
                accountName: this.currentAccount?.name || '未知账号'
            };
        } else {
            // 如果内容和别名都为空，删除备注
            delete this.remarks[key];
        }

        try {
            await this.saveRemarksToStorage();
            this.showToast('备注已保存', 'success');
            this.closeRemarkModal();

            // 重新渲染当前视图以更新备注图标状态
            this.refreshCurrentView();
        } catch (error) {
            this.showToast('保存备注失败: ' + error.message, 'error');
        }
    }

    /**
     * 删除备注
     */
    async deleteRemark() {
        if (!this.currentRemarkTarget) {
            return;
        }

        if (!confirm('确定要删除这条备注吗？')) {
            return;
        }

        const { type, id } = this.currentRemarkTarget;
        const key = this.getRemarkKey(type, id);

        delete this.remarks[key];

        try {
            await this.saveRemarksToStorage();

            // 记录删除操作以便同步
            if (this.githubSync?.config?.enabled) {
                await this.githubSync.recordDeletion(key);
            }

            this.showToast('备注已删除', 'success');
            this.closeRemarkModal();

            // 重新渲染当前视图
            this.refreshCurrentView();
        } catch (error) {
            this.showToast('删除备注失败: ' + error.message, 'error');
        }
    }

    /**
     * 刷新当前视图
     */
    refreshCurrentView() {
        switch (this.currentTab) {
            case 'dns':
                this.renderAllRecords();
                break;
            case 'workers':
                this.renderWorkers();
                break;
            case 'pages':
                this.renderPages();
                break;
            case 'notes':
                this.loadRemarksAndRender();
                break;
        }

        // 更新备注统计卡片
        this.updateNotesStatCard();
    }

    /**
     * 加载并渲染备注列表
     */
    async loadRemarksAndRender() {
        const remarksList = document.getElementById('remarksList');
        const emptyState = document.getElementById('remarksEmptyState');

        // 确保先加载备注数据
        await this.loadRemarks();


        // 1. 深度加载链式检查：必须先确保域名加载完成（用于发现所有账号），然后再加载 Worker/Page
        const triggerLoading = async () => {
            if (this.zones.length === 0 && !this.isLoadingZones) {
                console.log('[Remarks] Priority Loading: Zones...');
                await this.loadZones();
            }
            if (this.workers.length === 0 && !this.isLoadingWorkers) {
                console.log('[Remarks] Priority Loading: Workers...');
                this.loadWorkers(); // 异步触发，不阻塞渲染
            }
            if (this.pages.length === 0 && !this.isLoadingPages) {
                console.log('[Remarks] Priority Loading: Pages...');
                this.loadPages(); // 异步触发，不阻塞渲染
            }
        };
        triggerLoading();

        console.log('[Remarks] RESOURCE STATUS:', {
            zones: this.zones.length, 
            isLoadingZones: this.isLoadingZones,
            workers: this.workers.length, 
            isLoadingWorkers: this.isLoadingWorkers,
            pages: this.pages.length, 
            isLoadingPages: this.isLoadingPages,
            retryCount: this.remarksRetryCount
        });

        // 2. 智能多次重试机制：持续检测直到资源加载完成（最多 5 次）
        const anyLoading = this.isLoadingZones || this.isLoadingWorkers || this.isLoadingPages;
        // 如果列表为空且存在对应分类的备注，说明匹配池尚未就绪
        const hasWorkerRemarks = Object.keys(this.remarks).some(k => k.startsWith('worker:'));
        const hasPageRemarks = Object.keys(this.remarks).some(k => k.startsWith('page:'));
        const pendingData = (this.workers.length === 0 && hasWorkerRemarks) || (this.pages.length === 0 && hasPageRemarks);

        if ((anyLoading || pendingData) && !this.remarksReloadRegistered && this.remarksRetryCount < this.remarksMaxRetries) {
            this.remarksRetryCount++;
            console.log(`[Remarks] Data pending. Scheduling background refresh #${this.remarksRetryCount}/${this.remarksMaxRetries}...`);
            this.remarksReloadRegistered = true;
            
            // 下发异步轮询，但不 return，让列表先显示出来
            setTimeout(() => {
                this.remarksReloadRegistered = false;
                if (this.currentTab === 'notes') {
                    this.loadRemarksAndRender();
                }
            }, 5000); // 增加间隔，减少主线程压力
        }

        // 3. 如果加载已完成或达到最大重试次数，重置计数器并继续渲染
        if (!anyLoading && !pendingData) {
            this.remarksRetryCount = 0;
            console.log('[Remarks] All resources loaded successfully!');
        } else if (this.remarksRetryCount >= this.remarksMaxRetries) {
            console.warn('[Remarks] Max retries reached, rendering with available data...');
            this.remarksRetryCount = 0;
        }

        // 将 remarks 对象转换为数组
        const remarksArray = Object.entries(this.remarks)
            .map(([key, value]) => {
                // 存量数据补全：如果缺失 type 或 id，从 key (format: "type:id") 中解析
                if (!value.type || !value.id) {
                    const parts = key.split(':');
                    if (parts.length >= 2) {
                        value.type = value.type || parts[0];
                        value.id = value.id || parts.slice(1).join(':');
                    }
                }
                return {
                    key,
                    ...value
                };
            })
            .filter(r => r.content) // 过滤掉空备注
            .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)); // 按时间排序

        console.log('[Remarks] Remarks array:', remarksArray);

        // 应用过滤
        const filtered = this.getFilteredRemarks(remarksArray);

        // 更新统计
        this.updateRemarksStats(remarksArray);

        // 更新笔记统计卡片
        const notesStatCard = document.getElementById('notesStatCard');
        if (notesStatCard) {
            const statNumberEl = notesStatCard.querySelector('.stat-number');
            if (statNumberEl) {
                statNumberEl.textContent = remarksArray.length + ' 条备注';
            }
        }

        if (filtered.length === 0) {
            remarksList.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';
        remarksList.innerHTML = '';

        // 按类型分组
        const grouped = {};
        filtered.forEach(remark => {
            const type = remark.type || 'unknown';
            if (!grouped[type]) {
                grouped[type] = [];
            }
            grouped[type].push(remark);
        });

        const typeLabels = {
            'zone': '🌐 域名',
            'dns': '📡 DNS 记录',
            'worker': '⚡ Workers',
            'page': '📄 Pages'
        };

        Object.entries(grouped).forEach(([type, remarks]) => {
            const isCollapsed = this.collapsedRemarkGroups.has(type);
            const groupDiv = document.createElement('div');
            groupDiv.className = `remarks-group ${isCollapsed ? 'collapsed' : ''}`;
            groupDiv.innerHTML = `
                <div class="remarks-group-header" data-type="${type}">
                    <div class="remarks-group-header-left">
                        <span class="remarks-group-toggle">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </span>
                        <span class="remarks-group-title">${typeLabels[type] || type}</span>
                    </div>
                    <span class="remarks-group-count">${remarks.length} 条</span>
                </div>
            `;

            // 绑定分组点击折叠事件
            groupDiv.querySelector('.remarks-group-header').addEventListener('click', () => {
                if (this.collapsedRemarkGroups.has(type)) {
                    this.collapsedRemarkGroups.delete(type);
                    groupDiv.classList.remove('collapsed');
                } else {
                    this.collapsedRemarkGroups.add(type);
                    groupDiv.classList.add('collapsed');
                }
            });

            const listDiv = document.createElement('div');
            listDiv.className = 'remarks-group-list';

            remarks.forEach(remark => {
                const item = document.createElement('div');
                item.className = 'remark-list-item';

                const tagsHtml = remark.tags && remark.tags.length > 0
                    ? `<div class="remark-item-tags">${remark.tags.map(t => `<span class="remark-item-tag">${this.escapeHtml(t)}</span>`).join('')}</div>`
                    : '';

                const dateStr = remark.updatedAt
                    ? new Date(remark.updatedAt).toLocaleString('zh-CN')
                    : '';

                // 优先级: 别名 > 原始名称 > ID
                const displayName = remark.alias || remark.name || remark.id;

                let accountTagHtml = '';
                let finalAccountName = remark.accountName;
                let finalAccountId = remark.accountId;

                // 如果缺失账号信息，尝试从已加载的资源中匹配
                if (!finalAccountName || finalAccountName === '未知账号') {
                    if (remark.type === 'zone' || remark.type === 'dns') {
                        // 尝试匹配 zone ID
                        const targetZoneId = remark.type === 'zone' ? remark.id : remark.zoneId;
                        const zone = this.zones.find(z => z.id === targetZoneId);
                        if (zone && zone.account) {
                            finalAccountName = zone.account.name;
                            finalAccountId = zone.account.id;
                        } else if (remark.type === 'dns') {
                            // DNS 特殊情况：如果 this.zones 里没找到，尝试在 this.records 相关的域里找
                            const parentZone = this.zones.find(z => remark.name && remark.name.endsWith(z.name));
                            if (parentZone && parentZone.account) {
                                finalAccountName = parentZone.account.name;
                                finalAccountId = parentZone.account.id;
                            }
                        }
                    } else if (remark.type === 'worker') {
                        // Worker 匹配策略：全面覆盖 id, name, tag 以及 alias
                        const searchId = (remark.id || '').toLowerCase().trim();
                        const searchName = (remark.name || '').toLowerCase().trim();
                        
                        const worker = this.workers.find(w => {
                            const wId = (w.id || '').toLowerCase().trim();
                            const wName = (w.name || '').toLowerCase().trim();
                            return wId === searchId || wName === searchId || wId === searchName || wName === searchName;
                        });

                        if (worker && worker.account) {
                            finalAccountName = worker.account.name;
                            finalAccountId = worker.account.id;
                        } else {
                            // 诊断日志：如果是第一个失败的，输出匹配池样例
                            if (remark.id === 'joey-cfnew-2-9-1' || remarks.indexOf(remark) === 0) {
                                console.warn(`[Remarks] Worker Match Failed for "${remark.id}". Pool size: ${this.workers.length}. Sample ID from pool: ${this.workers.length > 0 ? this.workers[0].id : 'EMPTY'}`);
                                if (this.workers.length > 0 && remarks.indexOf(remark) === 0) {
                                     console.log('[Remarks] Worker Pool IDs:', this.workers.slice(0, 5).map(w => w.id));
                                }
                            }
                        }
                    } else if (remark.type === 'page') {
                        // Page 匹配策略
                        const searchId = (remark.id || '').toLowerCase().trim();
                        const searchName = (remark.name || '').toLowerCase().trim();
                        
                        const page = this.pages.find(p => {
                            const pId = (p.id || '').toLowerCase().trim();
                            const pName = (p.name || '').toLowerCase().trim();
                            return pId === searchId || pName === searchId || pId === searchName || pName === searchName;
                        });
                        if (page && page.account) {
                            finalAccountName = page.account.name;
                            finalAccountId = page.account.id;
                        }
                    }
                }

                if (finalAccountName) {
                    const colorClass = this.getAccountColorClass(finalAccountId);
                    accountTagHtml = `<span class="account-tag ${colorClass}" style="margin-left: 8px !important; display: inline-block !important; padding: 2px 6px !important; border-radius: 4px !important; font-size: 11px !important; line-height: 1 !important; color: white !important; vertical-align: middle !important;">${this.escapeHtml(finalAccountName)}</span>`;
                } else if (anyLoading || pendingData) {
                    // 异步占位符：显示同步中
                    accountTagHtml = `<span class="account-tag" style="margin-left: 8px !important; display: inline-block !important; padding: 2px 6px !important; border-radius: 4px !important; font-size: 11px !important; line-height: 1 !important; color: rgba(255,255,255,0.7) !important; background: rgba(255,255,255,0.1) !important; vertical-align: middle !important; border: 1px dashed rgba(255,255,255,0.2) !important;">同步中...</span>`;
                } else {
                    // 最终确实没匹配到
                    if (remark.type === 'worker' && this.workers.length > 0 && remarks.indexOf(remark) === 0) {
                        console.warn(`[Remarks] Worker Match Failed! Remark ID: "${remark.id}". Pool size: ${this.workers.length}`);
                    }
                }

                const renderedContent = typeof marked !== 'undefined' ? marked.parse(remark.content) : this.escapeHtml(remark.content);
                // 判断内容是否过长（字符数 > 300 或 行数 > 8）
                const lineCount = (remark.content.match(/\n/g) || []).length + 1;
                const isLong = remark.content.length > 400 || lineCount > 10;

                item.innerHTML = `
                    <div class="remark-item-header" style="display: flex !important; justify-content: space-between !important; align-items: flex-start !important; gap: 10px !important; margin-bottom: 8px !important;">
                        <div class="remark-item-title-row" style="flex: 1 !important; display: flex !important; align-items: center !important; flex-wrap: wrap !important; gap: 4px !important;">
                            <span class="remark-item-name" style="font-weight: 600 !important; font-size: 14px !important; color: var(--text-main) !important;">${this.escapeHtml(displayName)}</span>
                            ${accountTagHtml}
                        </div>
                        <span class="remark-item-date" style="white-space: nowrap !important; font-size: 11px !important; opacity: 0.6 !important;">${dateStr}</span>
                    </div>
                    <div class="remark-item-content markdown-body ${isLong ? 'foldable' : ''}">${renderedContent}</div>
                    ${isLong ? `
                        <div class="remark-content-toggle">
                            <span>展开全部</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </div>
                    ` : ''}
                    ${tagsHtml}
                    <div class="remark-item-actions">
                        <button class="btn-sm btn-secondary" data-action="edit">编辑</button>
                        <button class="btn-sm btn-danger" data-action="delete">删除</button>
                    </div>
                `;

                // 绑定内容折叠切换事件
                if (isLong) {
                    const contentEl = item.querySelector('.remark-item-content');
                    const toggleEl = item.querySelector('.remark-content-toggle');
                    toggleEl.addEventListener('click', () => {
                        const isExpanded = contentEl.classList.toggle('expanded');
                        contentEl.classList.toggle('foldable', !isExpanded);
                        toggleEl.querySelector('span').textContent = isExpanded ? '收起内容' : '展开全部';
                        toggleEl.querySelector('svg').style.transform = isExpanded ? 'rotate(180deg)' : '';
                    });
                }

                item.querySelector('[data-action="edit"]').addEventListener('click', () => {
                    this.openRemarkModal(remark.type, remark.id, displayName, '');
                });

                item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
                    if (confirm('确定要删除这条备注吗？')) {
                        delete this.remarks[remark.key];
                        await this.saveRemarksToStorage();
                        this.showToast('备注已删除', 'success');
                        this.loadRemarksAndRender();
                    }
                });

                listDiv.appendChild(item);
            });

            groupDiv.appendChild(listDiv);
            remarksList.appendChild(groupDiv);
        });
    }

    /**
     * 获取过滤后的备注
     */
    getFilteredRemarks(remarksArray) {
        return remarksArray.filter(remark => {
            // 类型过滤
            if (this.remarksTypeFilter && remark.type !== this.remarksTypeFilter) {
                return false;
            }

            // 搜索过滤
            if (this.remarksSearchQuery) {
                const query = this.remarksSearchQuery.toLowerCase();
                const content = (remark.content || '').toLowerCase();
                const alias = (remark.alias || '').toLowerCase();
                const id = (remark.id || '').toLowerCase();
                const name = (remark.name || '').toLowerCase();
                
                return content.includes(query) || 
                       alias.includes(query) || 
                       id.includes(query) || 
                       name.includes(query);
            }

            return true;
        });
    }

    /**
     * 更新备注统计
     */
    updateRemarksStats(remarksArray) {
        const totalEl = document.getElementById('totalRemarksCount');
        const zoneEl = document.getElementById('zoneRemarksCount');
        const dnsEl = document.getElementById('dnsRemarksCount');
        const workerEl = document.getElementById('workerRemarksCount');
        const pageEl = document.getElementById('pageRemarksCount');

        if (totalEl) totalEl.textContent = remarksArray.length;
        if (zoneEl) zoneEl.textContent = remarksArray.filter(r => r.type === 'zone').length;
        if (dnsEl) dnsEl.textContent = remarksArray.filter(r => r.type === 'dns').length;
        if (workerEl) workerEl.textContent = remarksArray.filter(r => r.type === 'worker').length;
        if (pageEl) pageEl.textContent = remarksArray.filter(r => r.type === 'page').length;
    }

    /**
     * 处理备注搜索
     */
    handleRemarksSearch(query) {
        this.remarksSearchQuery = query.trim();
        this.loadRemarksAndRender();
    }

    /**
     * 处理备注类型过滤
     */
    handleRemarksTypeFilter(type) {
        this.remarksTypeFilter = type;
        this.loadRemarksAndRender();
    }

    /**
     * 导出备注
     */
    async exportRemarks() {
        const remarksArray = Object.entries(this.remarks)
            .map(([key, value]) => ({
                key,
                ...value
            }))
            .filter(r => r.content);

        if (remarksArray.length === 0) {
            this.showToast('没有可导出的备注', 'warning');
            return;
        }

        const data = {
            exportDate: new Date().toISOString(),
            remarks: remarksArray
        };

        // 获取账户名称
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

        // 生成日期时间
        const now = new Date();
        const dateTime = now.getFullYear().toString() +
            (now.getMonth() + 1).toString().padStart(2, '0') +
            now.getDate().toString().padStart(2, '0') + '-' +
            now.getHours().toString().padStart(2, '0') +
            now.getMinutes().toString().padStart(2, '0') +
            now.getSeconds().toString().padStart(2, '0');

        const filename = `${safeAccountName}-remark-${dateTime}.json`;
        const result = await this.downloadJSON(data, filename);
    }

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
        const dateTime = now.getFullYear().toString() +
            (now.getMonth() + 1).toString().padStart(2, '0') +
            now.getDate().toString().padStart(2, '0') + '-' +
            now.getHours().toString().padStart(2, '0') +
            now.getMinutes().toString().padStart(2, '0') +
            now.getSeconds().toString().padStart(2, '0');

        return suffix ? `${safeAccountName}-${suffix}-${dateTime}.json` : `${safeAccountName}-${dateTime}.json`;
    }

    /**
     * 导出 DNS 数据
     */
    async exportDnsData() {
        if (this.allRecords.length === 0) {
            this.showToast('没有可导出的 DNS 记录', 'warning');
            return;
        }

        const data = {
            exportDate: new Date().toISOString(),
            zones: this.zones.map(z => ({
                id: z.id,
                name: z.name,
                status: z.status
            })),
            dnsRecords: this.allRecords.map(r => ({
                zoneName: r.zoneName,
                type: r.type,
                name: r.name,
                content: r.content,
                ttl: r.ttl,
                proxied: r.proxied
            }))
        };

        const filename = this.getExportFilename('dns');
        await this.downloadJSON(data, filename);
    }

    /**
     * 导出 Workers 数据
     */
    async exportWorkersData() {
        if (this.workers.length === 0) {
            this.showToast('没有可导出的 Workers', 'warning');
            return;
        }

        const data = {
            exportDate: new Date().toISOString(),
            workers: this.workers.map(w => ({
                id: w.id,
                created_on: w.created_on,
                modified_on: w.modified_on
            }))
        };

        const filename = this.getExportFilename('workers');
        await this.downloadJSON(data, filename);
    }

    /**
     * 导出 Pages 数据
     */
    async exportPagesData() {
        if (this.pages.length === 0) {
            this.showToast('没有可导出的 Pages', 'warning');
            return;
        }

        const data = {
            exportDate: new Date().toISOString(),
            pages: this.pages.map(p => ({
                name: p.name,
                subdomain: p.subdomain || p.name,
                url: `https://${p.subdomain || p.name}.pages.dev`,
                created_on: p.created_on
            }))
        };

        const filename = this.getExportFilename('pages');
        await this.downloadJSON(data, filename);
    }

    /**
     * 配置 Marked 渲染器
     */
    configMarked() {
        if (typeof marked !== 'undefined' && typeof marked.setOptions === 'function') {
            marked.setOptions({
                gfm: true,
                breaks: true,
                headerIds: false,
                mangle: false,
                sanitize: false // 我们手动处理或依赖 marked 的安全性
            });
        }
    }

    /**
     * 绑定 Markdown 工具栏事件
     */
    bindMarkdownToolbarEvents() {
        const toolbar = document.getElementById('markdownToolbar');
        if (!toolbar) return;

        toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.toolbar-btn');
            if (!btn) return;

            const action = btn.dataset.action;
            const textarea = document.getElementById('remarkContent');

            if (action === 'preview') {
                this.toggleMarkdownPreview();
            } else if (action === 'image-local') {
                document.getElementById('localImageInput').click();
            } else {
                this.handleMarkdownAction(action, textarea);
            }
        });

        // 本地图片上传处理
        const fileInput = document.getElementById('localImageInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.handleLocalImageUpload(e));
        }

        // 快捷键支持
        const textarea = document.getElementById('remarkContent');
        if (textarea) {
            textarea.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.metaKey) {
                    if (e.key === 'b') {
                        e.preventDefault();
                        this.handleMarkdownAction('bold', textarea);
                    } else if (e.key === 'i') {
                        e.preventDefault();
                        this.handleMarkdownAction('italic', textarea);
                    }
                }
            });
        }
    }

    /**
     * 切换 Markdown 预览
     */
    toggleMarkdownPreview() {
        const previewEl = document.getElementById('remarkPreview');
        const contentEl = document.getElementById('remarkContent');
        const toggleBtn = document.getElementById('togglePreviewBtn');

        this.isPreviewing = !this.isPreviewing;

        if (this.isPreviewing) {
            const content = contentEl.value;
            previewEl.innerHTML = typeof marked !== 'undefined' ? marked.parse(content) : this.escapeHtml(content).replace(/\n/g, '<br>');
            previewEl.style.display = 'block';
            contentEl.style.display = 'none';
            toggleBtn.innerHTML = '📝 编辑';
            toggleBtn.classList.add('active');
        } else {
            previewEl.style.display = 'none';
            contentEl.style.display = 'block';
            toggleBtn.innerHTML = '👁️ 预览';
            toggleBtn.classList.remove('active');
            contentEl.focus();
        }
    }

    /**
     * 处理 Markdown 操作
     */
    handleMarkdownAction(action, textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const text = textarea.value;
        const selected = text.substring(start, end);
        let replacement = '';
        let cursorOffset = 0;

        switch (action) {
            case 'bold':
                replacement = `**${selected || '加粗文本'}**`;
                cursorOffset = selected ? replacement.length : 2;
                break;
            case 'italic':
                replacement = `*${selected || '斜体文本'}*`;
                cursorOffset = selected ? replacement.length : 1;
                break;
            case 'list':
                replacement = selected.split('\n').map(line => `- ${line}`).join('\n');
                if (!selected) replacement = '- 列表项';
                cursorOffset = replacement.length;
                break;
            case 'link':
                replacement = `[${selected || '链接文字'}](https://)`;
                cursorOffset = selected ? replacement.length - 1 : 1;
                break;
            case 'image-url':
                replacement = `![${selected || '图片描述'}](https://)`;
                cursorOffset = selected ? replacement.length - 1 : 2;
                break;
            case 'table':
                replacement = `\n| 标题1 | 标题2 | 标题3 |\n| :--- | :--- | :--- |\n| 内容1 | 内容2 | 内容3 |\n`;
                cursorOffset = replacement.length;
                break;
        }

        textarea.value = text.substring(0, start) + replacement + text.substring(end);
        textarea.focus();

        // 设置光标位置
        const newPos = start + cursorOffset;
        textarea.setSelectionRange(newPos, newPos);

        // 如果是预览模式，自动更新预览
        if (this.isPreviewing) {
            this.toggleMarkdownPreview(); // 刷新预览（先关再开最简单）
            this.toggleMarkdownPreview();
        }
    }

    /**
     * 处理本地图片上传
     */
    async handleLocalImageUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        // 检查文件大小 (限制为 1MB，因为 chrome.storage.local 有限制)
        if (file.size > 1024 * 1024) {
            this.showToast('图片太大，请选择 1MB 以内的图片', 'warning');
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const dataUrl = event.target.result;
            const textarea = document.getElementById('remarkContent');
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;

            const replacement = `![图片描述](${dataUrl})`;
            textarea.value = text.substring(0, start) + replacement + text.substring(end);

            // 触发 input 事件以可能的自动保存或其他逻辑
            textarea.dispatchEvent(new Event('input'));

            if (this.isPreviewing) {
                this.toggleMarkdownPreview();
                this.toggleMarkdownPreview();
            }

            this.showToast('图片上传成功', 'success');
        };
        reader.readAsDataURL(file);

        // 重置 input 以便下次选择同一张图
        e.target.value = '';
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new CloudflareManager();
});
