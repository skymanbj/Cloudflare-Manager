/**
 * Cloudflare Manager - 界面渲染方法
 *
 * 以 Object.assign 方式挂载到 CloudflareManager.prototype，
 * 运行时才解析 this 调用，故加载顺序不影响执行；
 * 本文件须在 popup.js（类定义）之后加载。
 */

Object.assign(CloudflareManager.prototype, {
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
,

        // =====================================================
        // Search & Filter Methods
        // =====================================================
        handleSearch(query) {
            this.searchQuery = query.toLowerCase().trim();
            const clearBtn = document.getElementById('clearSearchBtn');
            clearBtn.style.display = this.searchQuery ? 'flex' : 'none';
            this.renderAllRecords();
        }
,

        clearSearch() {
            document.getElementById('searchInput').value = '';
            this.searchQuery = '';
            document.getElementById('clearSearchBtn').style.display = 'none';
            this.renderAllRecords();
        }
,

        handleZoneFilter(zoneId) {
            this.selectedZoneId = zoneId;
            this.renderAllRecords();
        }
,

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
,

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
,

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
,

        /**
         * 更新头部账户名称显示和颜色
         */
        async updateHeaderAccountUI() {
            const headerAccountName = document.getElementById('headerAccountName');
            if (!headerAccountName) return;
    
            if (this.currentAccount) {
                headerAccountName.textContent = this.currentAccount.name;
                headerAccountName.style.display = 'inline-block';
                headerAccountName.className = 'header-account-badge';
    
                // 异步尝试获取颜色，不阻塞主流程
                (async () => {
                    try {
                        // 如果本地已经有 accountId (从缓存加载的)，则直接使用
                        const realAccountId = await this.getAccountId();
                        if (realAccountId && this.currentAccount) {
                            const colorClass = this.getAccountColorClass(realAccountId);
                            headerAccountName.classList.add(colorClass);
                        }
                    } catch (e) {
                        console.log('[UI] Skip color update for now');
                    }
                })();
            } else {
                headerAccountName.style.display = 'none';
            }
        }
,

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
,

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
,

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
,

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
,

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
,

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
,

        // =====================================================
        // Sidebar Methods
        // =====================================================
        openSidebar() {
            document.getElementById('sidebar').classList.add('active');
            document.getElementById('sidebarOverlay').classList.add('active');
            this.renderAccountList();
        }
,

        closeSidebar() {
            document.getElementById('sidebar').classList.remove('active');
            document.getElementById('sidebarOverlay').classList.remove('active');
            this.clearAccountForm();
        }
,

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
,

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
,

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
,

        handleWorkersSearch(query) {
            this.workersSearchQuery = query.toLowerCase().trim();
            this.renderWorkers();
        }
,

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
,

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
,

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
,

        handlePagesSearch(query) {
            this.pagesSearchQuery = query.toLowerCase().trim();
            this.renderPages();
        }
,

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
,

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
,

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
,

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
,

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
,
});
