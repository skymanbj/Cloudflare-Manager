/**
 * Cloudflare Manager - 备注数据层
 *
 * 负责备注的存储读写、增删、筛选统计与备注列表渲染。
 * 编辑器（弹窗、Markdown 工具栏、预览）见 js/remark-editor.js。
 *
 * 以 Object.assign 方式挂载到 CloudflareManager.prototype，
 * 运行时才解析 this 调用，故加载顺序不影响执行；
 * 本文件须在 popup.js（类定义）之后加载。
 */

Object.assign(CloudflareManager.prototype, {
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
,

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
,

        /**
         * 获取备注的key
         */
        getRemarkKey(type, id) {
            return `${type}:${id}`;
        }
,

        /**
         * 检查是否有备注
         */
        hasRemark(type, id) {
            const key = this.getRemarkKey(type, id);
            return this.remarks[key] && this.remarks[key].content;
        }
,

        /**
         * 获取备注
         */
        getRemark(type, id) {
            const key = this.getRemarkKey(type, id);
            return this.remarks[key] || null;
        }
,

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
                    name: name || id,
                    accountId: this.currentRemarkTarget.accountId,
                    accountName: this.currentRemarkTarget.accountName
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
,

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
,

        /**
         * 加载并渲染备注列表
         */
        async loadRemarksAndRender() {
            try {
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
    
                if (!this.remarks || Object.keys(this.remarks).length === 0) {
                    if (remarksList) remarksList.innerHTML = '';
                    if (emptyState) {
                        emptyState.style.display = 'block';
                        // DEBUG INFO
                        const debugInfo = document.createElement('div');
                        debugInfo.style.cssText = 'margin-top: 10px; font-size: 10px; color: #999; text-align: center;';
                        debugInfo.textContent = `Debug: Storage key count = ${this.remarks ? Object.keys(this.remarks).length : 'null'}`;
                        emptyState.appendChild(debugInfo);
                    }
                    this.updateRemarksStats([]);
                    return;
                }
    
                // 将 remarks 对象转换为数组，并进行实时账户关联补全
                const remarksArray = Object.entries(this.remarks)
                    .map(([key, value]) => {
                        // Safety check
                        if (!value || typeof value !== 'object') return null;
    
                        // 1. 存量数据解析：如果缺失 type 或 id，从 key (format: "type:id") 中解析
                        if (!value.type || !value.id) {
                            const parts = key.split(':');
                            if (parts.length >= 2) {
                                value.type = value.type || parts[0];
                                value.id = value.id || parts.slice(1).join(':');
                            }
                        }
    
                        // 2. 实时资源匹配补全 accountId (关键：供跨账户过滤使用)
                        if (!value.accountId || value.accountId === 'unknown') {
                            if (value.type === 'zone' || value.type === 'dns') {
                                const targetId = value.type === 'zone' ? value.id : value.zoneId;
                                let zone = null;
    
                                if (targetId) {
                                    zone = this.zones.find(z => z.id === targetId);
                                }
    
                                // 2. 如果通过 ID 没找到，或者是 DNS 记录且没有 zoneId，尝试通过域名后缀匹配
                                if (!zone && (value.type === 'dns' || value.type === 'zone')) {
                                    const recordName = (value.name || '').toLowerCase();
                                    if (recordName) {
                                        zone = this.zones
                                            .filter(z => recordName.endsWith(z.name.toLowerCase()))
                                            .sort((a, b) => b.name.length - a.name.length)[0];
    
                                        if (zone) {
                                            value.zoneId = zone.id;
                                        }
                                    }
                                }
    
                                if (zone && zone.account) {
                                    value.accountId = zone.account.id;
                                    value.accountName = zone.account.name;
                                }
                            } else if (value.type === 'worker') {
                                const searchId = (value.id || '').toLowerCase().trim();
                                const worker = this.workers.find(w =>
                                    (w.id || '').toLowerCase() === searchId ||
                                    (w.name || '').toLowerCase() === searchId
                                );
                                if (worker && worker.account) {
                                    value.accountId = worker.account.id;
                                    value.accountName = worker.account.name;
                                }
                            } else if (value.type === 'page') {
                                const searchId = (value.id || '').toLowerCase().trim();
                                const page = this.pages.find(p =>
                                    (p.id || '').toLowerCase() === searchId ||
                                    (p.name || '').toLowerCase() === searchId
                                );
                                if (page && page.account) {
                                    value.accountId = page.account.id;
                                    value.accountName = page.account.name;
                                }
                            }
                        }
    
                        return {
                            key,
                            ...value
                        };
                    })
                    .filter(r => r && r.content) // 过滤掉无效或空备注
                    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)); // 按时间排序
    
                console.log('[Remarks] Remarks array:', remarksArray);
    
                // 应用过滤
                const filtered = this.getFilteredRemarks(remarksArray);
    
                // 更新统计 (仅统计当前可见的备注)
                this.updateRemarksStats(filtered);
    
                // 更新总数统计卡片 (反映当前可见数量)
                const notesStatCard = document.getElementById('notesStatCard');
                if (notesStatCard) {
                    const statNumberEl = notesStatCard.querySelector('.stat-number');
                    if (statNumberEl) {
                        statNumberEl.textContent = filtered.length + ' 条备注';
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
    
                // 按照各分组中最新备注的生成/修改时间从新到旧对分组进行排序
                const sortedGroupedEntries = Object.entries(grouped).sort((a, b) => {
                    const maxA = Math.max(...a[1].map(r => r.updatedAt ? new Date(r.updatedAt).getTime() : 0));
                    const maxB = Math.max(...b[1].map(r => r.updatedAt ? new Date(r.updatedAt).getTime() : 0));
                    return maxB - maxA;
                });
    
                sortedGroupedEntries.forEach(([type, remarks]) => {
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
                                    if (remarks.indexOf(remark) === 0 && this.workers.length > 0) {
                                        console.debug(`[Remarks] First remark match failed. ID: "${remark.id}". Pool size: ${this.workers.length}.`);
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
            } catch (error) {
                console.error('[Remarks] Render error:', error);
                this.showToast('备注加载失败: ' + error.message, 'error');
                const remarksList = document.getElementById('remarksList');
                if (remarksList) remarksList.innerHTML = `<div class="error-state" style="padding: 20px; text-align: center; color: #ff4d4f;">加载失败: ${this.escapeHtml(error.message)}</div>`;
            }
        }
,

        /**
         * 获取过滤后的备注
         */
        getFilteredRemarks(remarksArray) {
            return remarksArray.filter(remark => {
                // 已取消账户隔离：所有账户下均显示全部备注
    
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
,

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
,

        /**
         * 处理备注搜索
         */
        handleRemarksSearch(query) {
            this.remarksSearchQuery = query.trim();
            this.loadRemarksAndRender();
        }
,

        /**
         * 处理备注类型过滤
         */
        handleRemarksTypeFilter(type) {
            this.remarksTypeFilter = type;
            this.loadRemarksAndRender();
        }
,
});
