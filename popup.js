/**
 * Cloudflare Manager - Chrome Extension
 * DNS 记录管理 + Workers + Pages 项目管理
 *
 * 说明：本文件只保留 CloudflareManager 主类的核心逻辑（构造、初始化、
 * 账户管理、记录表单、事件绑定）。其余职责已拆分至 js/ 目录：
 *   js/github-sync.js  GitHub 同步
 *   js/api.js          Cloudflare API 交互
 *   js/render.js       界面渲染
 *   js/remarks.js      备注模块
 *   js/export.js       数据导出/导入
 *   js/utils.js        工具与 UI 基础方法
 */

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
                if (cache.workers) {
                    this.workers = cache.workers;
                    this.workers.sort((a, b) => {
                        const dateA = a.created_on ? new Date(a.created_on).getTime() : 0;
                        const dateB = b.created_on ? new Date(b.created_on).getTime() : 0;
                        return dateB - dateA;
                    });
                }
                if (cache.pages) {
                    this.pages = cache.pages;
                    this.pages.sort((a, b) => {
                        const dateA = a.created_on ? new Date(a.created_on).getTime() : 0;
                        const dateB = b.created_on ? new Date(b.created_on).getTime() : 0;
                        return dateB - dateA;
                    });
                }
                if (cache.allRecords) this.allRecords = cache.allRecords;
                console.log(`[Cache] Loaded resource cache for account: ${this.currentAccount?.name}`);
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
                console.log(`[Cache] Resource cache saved for account: ${this.currentAccount?.name}`);
                resolve();
            });
        });
    }

    async init() {
        await this.loadAccounts(); // Load accounts first
        this.renderAccountList(); // Render sidebar list

        // Account Export/Import Events
        const exportAccBtn = document.getElementById('exportAccountsBtn');
        const importAccBtn = document.getElementById('importAccountsBtn');
        const importAccInput = document.getElementById('importAccountsInput');

        if (exportAccBtn) {
            exportAccBtn.addEventListener('click', () => this.exportAccountsConfig());
        }
        if (importAccBtn) {
            importAccBtn.addEventListener('click', () => importAccInput && importAccInput.click());
        }
        if (importAccInput) {
            importAccInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    this.importAccountsConfig(e.target.files[0]);
                    e.target.value = ''; // Reset for next use
                }
            });
        }

        await this.loadRemarks();
        await this.loadResourceCache(); // 启动时立即恢复缓存，实现秒开
        await this.githubSync.loadConfig();

        this.initTheme();
        this.configMarked();
        this.bindEvents();
        this.bindGithubSyncEvents();

        // Auto-select account if none selected but available
        if (!this.currentAccount && this.accounts.length > 0) {
            this.switchAccount(this.accounts[0].id);
        } else {
            this.updateUI();
        }
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
        document.getElementById('exportAllBtn')?.addEventListener('click', () => this.exportAllAccountsData());

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
        console.log('[CloudflareManager] Saving GitHub config...'); // Debug log to confirm new version
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
        this.accountId = null;

        // 瞬间更新名称（不等待获取颜色 ID）
        this.updateHeaderAccountUI();

        // 极速保存并进入并行加载流程
        await this.saveAccounts();

        // loadAllZonesAndRecords 内部现在已经异步化，不会阻塞 switchAccount 返回
        await this.loadAllZonesAndRecords();
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

}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new CloudflareManager();
});