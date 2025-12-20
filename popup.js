/**
 * Cloudflare Manager - Chrome Extension
 * DNS 记录管理 + Workers + Pages 项目管理
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
        
        // 资源备注相关
        this.remarks = {}; // { 'type:id': { content, tags, updatedAt } }
        this.currentRemarkTarget = null; // { type, id, name, detail }
        this.remarksSearchQuery = '';
        this.remarksTypeFilter = '';
        
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

    async init() {
        await this.loadAccounts();
        await this.loadRemarks();
        this.bindEvents();
        this.updateUI();
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
            }, resolve);
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
                'Authorization': `Bearer ${this.currentAccount.token}`,
                'Content-Type': 'application/json'
            }
        };

        if (body) {
            options.body = JSON.stringify(body);
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
        this.zones = await this.apiRequest('/zones');
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
                    zoneId: zone.id
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
        
        // 优先从已加载的 zones 中获取 account_id
        if (this.zones && this.zones.length > 0 && this.zones[0].account) {
            this.accountId = this.zones[0].account.id;
            return this.accountId;
        }
        
        // 如果 zones 没有加载，尝试调用 /accounts API
        try {
            const accounts = await this.apiRequest('/accounts');
            if (accounts && accounts.length > 0) {
                this.accountId = accounts[0].id;
                return this.accountId;
            }
        } catch (error) {
            console.warn('无法通过 /accounts 获取账户 ID:', error);
        }
        
        // 如果都失败，尝试加载一个 zone 来获取 account_id
        if (this.zones.length === 0) {
            await this.loadZones();
            if (this.zones.length > 0 && this.zones[0].account) {
                this.accountId = this.zones[0].account.id;
                return this.accountId;
            }
        }
        
        throw new Error('无法获取账户 ID，请确保 API Token 有正确的权限');
    }

    async loadWorkers() {
        const accountId = await this.getAccountId();
        const response = await this.apiRequest(`/accounts/${accountId}/workers/scripts`);
        this.workers = response || [];
        return this.workers;
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
        const accountId = await this.getAccountId();
        const response = await this.apiRequest(`/accounts/${accountId}/pages/projects`);
        this.pages = response || [];
        return this.pages;
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

        // Account management (in sidebar)
        document.getElementById('saveAccountBtn').addEventListener('click', () => this.saveAccount());
        document.getElementById('deleteAccountBtn').addEventListener('click', () => this.deleteAccount());
        document.getElementById('accountSelect').addEventListener('change', (e) => this.switchAccount(e.target.value));

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // DNS record form
        document.getElementById('addRecordBtn').addEventListener('click', () => this.showRecordForm());
        document.getElementById('cancelRecordBtn').addEventListener('click', () => this.hideRecordForm());
        document.getElementById('saveRecordBtn').addEventListener('click', () => this.saveRecord());

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
        if (tab === 'workers' && this.workers.length === 0) {
            this.loadWorkersAndRender();
        }
        if (tab === 'pages' && this.pages.length === 0) {
            this.loadPagesAndRender();
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
            this.showLoading();
            
            // 重置状态
            this.selectedZoneId = '';
            this.searchQuery = '';
            this.workers = [];
            this.accountId = null;
            document.getElementById('searchInput').value = '';
            document.getElementById('clearSearchBtn').style.display = 'none';
            
            // 加载所有域名
            await this.loadZones();
            
            // 显示标签页和统计信息
            tabsSection.style.display = 'block';
            statsSection.style.display = 'flex';
            document.getElementById('zoneCount').textContent = `${this.zones.length} 个域名`;
            
            // 填充域名筛选器
            this.renderZoneFilter();
            
            // 加载所有记录
            dnsSection.style.display = 'block';
            recordsList.innerHTML = '<div class="loading">正在加载所有 DNS 记录...</div>';
            
            await this.loadAllRecords();
            
            // 默认折叠所有域名
            this.collapsedZones = new Set(this.zones.map(z => z.name));
            
            document.getElementById('recordCount').textContent = `${this.allRecords.length} 条记录`;
            
            // 更新备注统计卡片
            this.updateNotesStatCard();
            
            this.hideLoading();
            this.renderAllRecords();
            
        } catch (error) {
            this.hideLoading();
            this.showToast(error.message, 'error');
        }
    }

    // 渲染所有记录，按域名分组
    renderAllRecords() {
        const list = document.getElementById('recordsList');
        const filteredRecords = this.getFilteredRecords();
        
        if (filteredRecords.length === 0) {
            if (this.searchQuery) {
                list.innerHTML = `
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                            <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                            <path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2"/>
                        </svg>
                        <p>未找到匹配 "${this.escapeHtml(this.searchQuery)}" 的记录</p>
                    </div>
                `;
            } else {
                list.innerHTML = `
                    <div class="empty-state">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
                            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        <p>暂无 DNS 记录</p>
                    </div>
                `;
            }
            return;
        }
        
        list.innerHTML = '';
        
        // 按域名分组
        const groupedRecords = {};
        filteredRecords.forEach(record => {
            if (!groupedRecords[record.zoneName]) {
                groupedRecords[record.zoneName] = [];
            }
            groupedRecords[record.zoneName].push(record);
        });
        
        // 如果有搜索关键词，显示搜索结果统计
        if (this.searchQuery) {
            const searchInfo = document.createElement('div');
            searchInfo.className = 'search-result-info';
            searchInfo.innerHTML = `找到 <strong>${filteredRecords.length}</strong> 条匹配的记录`;
            list.appendChild(searchInfo);
        }
        
        // 渲染每个域名分组
        Object.keys(groupedRecords).sort().forEach(zoneName => {
            const records = groupedRecords[zoneName];
            const isCollapsed = this.collapsedZones.has(zoneName);
            
            // 域名分组容器
            const groupContainer = document.createElement('div');
            groupContainer.className = 'zone-group';
            
            // 获取 zoneId
            const zoneId = records[0]?.zoneId || zoneName;
            
            // 域名分组标题（可点击折叠）
            const groupHeader = document.createElement('div');
            groupHeader.className = `zone-group-header ${isCollapsed ? 'collapsed' : ''}`;
            const zoneRemarkBtn = this.getRemarkButtonHtml('zone', zoneId, '添加域名备注').replace('data-action="remark"', 'data-action="zone-remark"');
            groupHeader.innerHTML = `
                <div class="zone-header-left">
                    <span class="zone-toggle">${isCollapsed ? '▶' : '▼'}</span>
                    <span class="zone-name">${this.escapeHtml(zoneName)}</span>
                    ${zoneRemarkBtn}
                </div>
                <span class="zone-record-count">${records.length} 条记录</span>
            `;
            
            // 域名备注按钮事件
            groupHeader.querySelector('[data-action="zone-remark"]').addEventListener('click', (e) => {
                e.stopPropagation();
                this.openRemarkModal('zone', zoneId, zoneName, `${records.length} 条 DNS 记录`);
            });
            
            groupHeader.addEventListener('click', (e) => {
                if (e.target.closest('[data-action="zone-remark"]')) return;
                this.toggleZoneCollapse(zoneName);
            });
            groupContainer.appendChild(groupHeader);
            
            // 记录列表容器
            const recordsContainer = document.createElement('div');
            recordsContainer.className = `zone-records ${isCollapsed ? 'collapsed' : ''}`;
            
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
        await this.saveAccounts();
        await this.loadAllZonesAndRecords();
    }

    // =====================================================
    // Record Actions
    // =====================================================
    showRecordForm() {
        this.editingRecordId = null;
        this.editingZoneId = null;
        this.clearRecordForm();
        this.renderZoneSelector();
        document.getElementById('recordForm').style.display = 'block';
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
        this.editingRecordId = null;
        this.editingZoneId = null;
    }

    editRecord(record) {
        console.log('editRecord called with:', record);
        this.editingRecordId = record.id;
        this.editingZoneId = record.zoneId;
        
        this.renderZoneSelector();
        
        const formEl = document.getElementById('recordForm');
        console.log('Record form element:', formEl);
        
        document.getElementById('recordZone').value = record.zoneId;
        document.getElementById('recordType').value = record.type;
        document.getElementById('recordName').value = record.name.replace(`.${record.zoneName}`, '');
        document.getElementById('recordContent').value = record.content;
        document.getElementById('recordTTL').value = record.ttl.toString();
        document.getElementById('recordProxied').checked = record.proxied;
        
        formEl.style.display = 'block';
        console.log('Record form display set to block');
        
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
        
        const recordData = { type, name, content, ttl, proxied };
        
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
    exportRecords() {
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
        
        this.downloadCSV(csv, `all_dns_records_${new Date().toISOString().slice(0,10)}.csv`);
        this.showToast(`已导出 ${this.allRecords.length} 条记录`, 'success');
    }

    exportData() {
        if (this.currentTab === 'dns') {
            this.exportRecords();
        } else if (this.currentTab === 'workers') {
            this.exportWorkers();
        } else if (this.currentTab === 'pages') {
            this.exportPages();
        }
    }

    exportWorkers() {
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
        
        this.downloadCSV(csv, `workers_${new Date().toISOString().slice(0,10)}.csv`);
        this.showToast(`已导出 ${this.workers.length} 个 Workers`, 'success');
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
        return this.workers.filter(w => 
            w.id.toLowerCase().includes(this.workersSearchQuery)
        );
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
        
        filteredWorkers.forEach(worker => {
            const createdDate = worker.created_on ? new Date(worker.created_on).toLocaleDateString('zh-CN') : '-';
            const modifiedDate = worker.modified_on ? new Date(worker.modified_on).toLocaleDateString('zh-CN') : '-';
            
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
                        <span class="worker-name">${this.escapeHtml(worker.id)}</span>
                        ${this.getRemarkButtonHtml('worker', worker.id, '添加备注')}
                    </div>
                    <div class="worker-meta">
                        <span>📅 创建: ${createdDate}</span>
                        <span>✏️ 修改: ${modifiedDate}</span>
                    </div>
                </div>
                <div class="worker-actions">
                    <a href="https://dash.cloudflare.com/?to=/:account/workers/services/view/${worker.id}" target="_blank" title="在 Cloudflare 控制台中查看">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </a>
                </div>
            `;
            
            item.querySelector('[data-action="remark"]').addEventListener('click', (e) => {
                this.handleRemarkButtonClick(e, 'worker', worker.id, worker.id, `创建于 ${createdDate}`);
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
        return this.pages.filter(p => 
            p.name.toLowerCase().includes(this.pagesSearchQuery) ||
            (p.subdomain && p.subdomain.toLowerCase().includes(this.pagesSearchQuery))
        );
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
        
        filteredPages.forEach(page => {
            const createdDate = page.created_on ? new Date(page.created_on).toLocaleDateString('zh-CN') : '-';
            const subdomain = page.subdomain || page.name;
            const pagesUrl = `https://${subdomain}.pages.dev`;
            const latestDeployment = page.latest_deployment;
            const deployStatus = latestDeployment?.latest_stage?.status || 'unknown';
            
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
                        <span class="page-name">${this.escapeHtml(page.name)}</span>
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
                    <a href="https://dash.cloudflare.com/?to=/:account/pages/view/${page.name}" target="_blank" title="在 Cloudflare 控制台中查看">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </a>
                </div>
            `;
            
            item.querySelector('[data-action="remark"]').addEventListener('click', (e) => {
                this.handleRemarkButtonClick(e, 'page', page.name, page.name, pagesUrl);
            });
            
            list.appendChild(item);
        });
    }

    exportPages() {
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
        
        this.downloadCSV(csv, `pages_${new Date().toISOString().slice(0,10)}.csv`);
        this.showToast(`已导出 ${this.pages.length} 个 Pages`, 'success');
    }

    // =====================================================
    // Utility Methods
    // =====================================================
    
    /**
     * 使用 chrome.downloads API 下载 CSV 文件
     * 在扩展弹出窗口中，<a>.click() 方式不可靠，需要使用 chrome.downloads API
     */
    downloadCSV(csvContent, filename) {
        // 添加 BOM 以确保 Excel 正确识别 UTF-8 编码
        const BOM = '\uFEFF';
        const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        
        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        }, (downloadId) => {
            // 清理 Object URL
            setTimeout(() => {
                URL.revokeObjectURL(url);
            }, 1000);
            
            if (chrome.runtime.lastError) {
                console.error('下载失败:', chrome.runtime.lastError);
                this.showToast('下载失败: ' + chrome.runtime.lastError.message, 'error');
            }
        });
    }
    
    /**
     * 使用 chrome.downloads API 下载 JSON 文件
     */
    downloadJSON(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: true
        }, (downloadId) => {
            setTimeout(() => {
                URL.revokeObjectURL(url);
            }, 1000);
            
            if (chrome.runtime.lastError) {
                console.error('下载失败:', chrome.runtime.lastError);
                this.showToast('下载失败: ' + chrome.runtime.lastError.message, 'error');
            }
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
            <div class="remark-tooltip">
                <div class="remark-tooltip-content">${renderedContent}</div>
                ${tagsHtml}
            </div>
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
        const tooltipHtml = hasRemark ? this.getRemarkTooltipHtml(type, id) : '';
        
        return `
            <button class="remark-btn ${hasRemark ? 'has-remark' : ''}" ${hasRemark ? '' : `title="${title}"`} data-action="remark">
                📝
                ${tooltipHtml}
            </button>
        `;
    }
    
    /**
     * 打开备注弹窗
     */
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
        
        document.getElementById('remarkTargetInfo').innerHTML = `
            <div class="remark-target-type">${typeLabels[type] || type}</div>
            <div class="remark-target-name">${this.escapeHtml(name)}</div>
            ${detail ? `<div class="remark-target-detail">${this.escapeHtml(detail)}</div>` : ''}
        `;
        
        // 填入现有备注
        const existingRemark = this.getRemark(type, id);
        document.getElementById('remarkContent').value = existingRemark?.content || '';
        document.getElementById('remarkTags').value = existingRemark?.tags?.join(', ') || '';
        
        // 显示/隐藏删除按钮
        document.getElementById('deleteRemarkBtn').style.display = 
            existingRemark?.content ? 'inline-block' : 'none';
        
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
        const tagsStr = document.getElementById('remarkTags').value.trim();
        const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(t => t) : [];
        
        const key = this.getRemarkKey(type, id);
        
        if (content) {
            this.remarks[key] = {
                content,
                tags,
                updatedAt: new Date().toISOString(),
                type,
                id,
                name: name || id  // 保存名称，如果没有则使用 id
            };
        } else {
            // 如果内容为空，删除备注
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
        
        console.log('[Remarks] Loading remarks, count:', Object.keys(this.remarks).length);
        
        // 将 remarks 对象转换为数组
        const remarksArray = Object.entries(this.remarks)
            .map(([key, value]) => ({
                key,
                ...value
            }))
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
            const groupDiv = document.createElement('div');
            groupDiv.className = 'remarks-group';
            groupDiv.innerHTML = `
                <div class="remarks-group-header">
                    <span class="remarks-group-title">${typeLabels[type] || type}</span>
                    <span class="remarks-group-count">${remarks.length}</span>
                </div>
            `;
            
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
                
                // 使用 name 显示，如果没有则回退到 id
                const displayName = remark.name || remark.id;
                
                item.innerHTML = `
                    <div class="remark-item-header">
                        <span class="remark-item-name">${this.escapeHtml(displayName)}</span>
                        <span class="remark-item-date">${dateStr}</span>
                    </div>
                    <div class="remark-item-content">${typeof marked !== 'undefined' ? marked.parse(remark.content) : this.escapeHtml(remark.content)}</div>
                    ${tagsHtml}
                    <div class="remark-item-actions">
                        <button class="btn-sm btn-secondary" data-action="edit">编辑</button>
                        <button class="btn-sm btn-danger" data-action="delete">删除</button>
                    </div>
                `;
                
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
                const matchId = remark.id?.toLowerCase().includes(query);
                const matchContent = remark.content?.toLowerCase().includes(query);
                const matchTags = remark.tags?.some(t => t.toLowerCase().includes(query));
                if (!matchId && !matchContent && !matchTags) {
                    return false;
                }
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
    exportRemarks() {
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
        
        this.downloadJSON(data, `cloudflare-remarks-${new Date().toISOString().slice(0,10)}.json`);
        this.showToast('备注已导出', 'success');
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new CloudflareManager();
});
