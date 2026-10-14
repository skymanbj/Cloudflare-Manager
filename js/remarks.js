/**
 * Cloudflare Manager - 备注模块（含 Markdown 编辑器）
 *
 * 以 Object.assign 方式挂载到 CloudflareManager.prototype，
 * 运行时才解析 this 调用，故加载顺序不影响执行；
 * 本文件须在 popup.js（类定义）之后加载。
 */

Object.assign(CloudflareManager.prototype, {
        /**
         * 插入 Markdown 语法
         */
        insertMarkdown(textarea, action) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const text = textarea.value;
            const selected = text.substring(start, end);
    
            let replacement = '';
            let cursorOffset = 0;
    
            switch (action) {
                case 'bold':
                    replacement = `**${selected || '粗体文本'}**`;
                    cursorOffset = selected ? 0 : -2;
                    break;
                case 'italic':
                    replacement = `*${selected || '斜体文本'}*`;
                    cursorOffset = selected ? 0 : -1;
                    break;
                case 'list':
                    replacement = `\n- ${selected || '列表项'}`;
                    cursorOffset = 0;
                    break;
                case 'link':
                    replacement = `[${selected || '链接文字'}](https://example.com)`;
                    cursorOffset = selected ? 0 : -1; // End of url
                    break;
                case 'image-url':
                    replacement = `![${selected || '图片描述'}](https://example.com/image.png)`;
                    cursorOffset = 0;
                    break;
                case 'table':
                    replacement = `\n| 表头1 | 表头2 |\n| --- | --- |\n| 内容1 | 内容2 |\n`;
                    cursorOffset = 0;
                    break;
                default:
                    return;
            }
    
            textarea.setRangeText(replacement, start, end, 'select');
    
            // Adjust cursor if no text was selected (to place inside syntax)
            if (!selected && cursorOffset !== 0) {
                const newPos = start + replacement.length + cursorOffset;
                textarea.setSelectionRange(newPos, newPos);
            }
    
            textarea.focus();
        }
,

        togglePreview(textarea, previewArea, btn) {
            this.isPreviewing = !this.isPreviewing;
            if (this.isPreviewing) {
                previewArea.innerHTML = marked.parse(textarea.value);
                textarea.style.display = 'none';
                previewArea.style.display = 'block';
                btn.textContent = '✏️ 编辑';
            } else {
                textarea.style.display = 'block';
                previewArea.style.display = 'none';
                btn.textContent = '👁️ 预览';
            }
        }
,

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
,

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
,

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
,

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
,

        /**
         * 处理备注按钮点击
         */
        handleRemarkButtonClick(e, type, id, name, detail) {
            e.stopPropagation();
            this.openRemarkModal(type, id, name, detail);
        }
,

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
,

        openRemarkModal(type, id, name, detail) {
            // 1. 查找账号信息（从内存资源池匹配）
            let accountName = '';
            let accountId = '';
    
            if (type === 'zone' || type === 'dns') {
                const targetZoneId = type === 'zone' ? id : (this.currentRemarkTarget?.zoneId || id);
                const zone = this.zones.find(z => z.id === targetZoneId);
                if (zone && zone.account) {
                    accountName = zone.account.name;
                    accountId = zone.account.id;
                }
            } else if (type === 'worker') {
                const searchId = (id || '').toLowerCase().trim();
                const worker = this.workers.find(w => (w.id || '').toLowerCase() === searchId);
                if (worker && worker.account) {
                    accountName = worker.account.name;
                    accountId = worker.account.id;
                }
            } else if (type === 'page') {
                const searchId = (id || '').toLowerCase().trim();
                const page = this.pages.find(p => (p.name || '').toLowerCase() === searchId);
                if (page && page.account) {
                    accountName = page.account.name;
                    accountId = page.account.id;
                }
            }
    
            // 2. 锁定目标及其所属账户信息（用于后续持久化）
            this.currentRemarkTarget = {
                type,
                id,
                name,
                detail,
                accountId: accountId || this.currentAccount?.id || null,
                accountName: accountName || this.currentAccount?.name || '未知账号'
            };
    
            // 设置弹窗标题
            const typeLabels = { 'zone': '域名', 'dns': 'DNS 记录', 'worker': 'Worker', 'page': 'Page' };
            document.getElementById('remarkModalTitle').textContent =
                this.hasRemark(type, id) ? '编辑备注' : '添加备注';
    
            // 设置账户标签 HTML
            let accountInfoHtml = '';
            if (this.currentRemarkTarget.accountName && this.currentRemarkTarget.accountName !== '未知账号') {
                const colorClass = this.getAccountColorClass(this.currentRemarkTarget.accountId);
                accountInfoHtml = `<span class="account-tag ${colorClass}" style="margin-left: 8px; vertical-align: middle;">${this.escapeHtml(this.currentRemarkTarget.accountName)}</span>`;
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
    
            // 显示/隐藏 Cloudflare 直接更名选项
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
    
            // 显示弹窗并聚焦
            document.getElementById('remarkModal').style.display = 'flex';
            setTimeout(() => {
                document.getElementById('remarkContent').focus();
            }, 100);
        }
,

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
,

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
,

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
,

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
,

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
,
});
