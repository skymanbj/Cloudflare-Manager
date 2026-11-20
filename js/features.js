/**
 * Cloudflare Manager - 扩展实用功能模块
 * 包含：
 *   1. 跨账户全局搜索
 */

Object.assign(CloudflareManager.prototype, {
    initFeatures() {
        this.initGlobalSearch();
        this.initTokenPermCheck();
        this.initDnsBatchAndSnapshots();
        this.initDnsTemplates();
        this.initResourceDetailModal();
    },

    // =====================================================
    // 1. 跨账户全局搜索
    // =====================================================
    initGlobalSearch() {
        const openBtn = document.getElementById('globalSearchBtn');
        const closeBtn = document.getElementById('closeGlobalSearchBtn');
        const overlay = document.getElementById('globalSearchOverlay');
        const input = document.getElementById('globalSearchInput');
        const refreshAllBtn = document.getElementById('refreshAllCachesBtn');

        openBtn?.addEventListener('click', () => this.openGlobalSearchModal());
        closeBtn?.addEventListener('click', () => this.closeGlobalSearchModal());
        overlay?.addEventListener('click', () => this.closeGlobalSearchModal());
        input?.addEventListener('input', (e) => this.renderGlobalSearchResults(e.target.value));
        refreshAllBtn?.addEventListener('click', () => this.refreshAllAccountCaches());

        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                this.openGlobalSearchModal();
            } else if (e.key === 'Escape') {
                const modal = document.getElementById('globalSearchModal');
                if (modal && modal.style.display === 'flex') {
                    this.closeGlobalSearchModal();
                }
            }
        });
    },

    async openGlobalSearchModal() {
        const modal = document.getElementById('globalSearchModal');
        const input = document.getElementById('globalSearchInput');
        if (!modal) return;
        modal.style.display = 'flex';
        await this.loadAllAccountCachesForSearch();
        if (input) {
            input.focus();
            input.select();
            this.renderGlobalSearchResults(input.value || '');
        }
    },

    closeGlobalSearchModal() {
        const modal = document.getElementById('globalSearchModal');
        if (modal) modal.style.display = 'none';
    },

    async loadAllAccountCachesForSearch() {
        const accounts = this.accounts || [];
        const keys = accounts.map(a => `resourceCache_${a.id}`);
        const stored = await new Promise((resolve) => {
            if (keys.length === 0) return resolve({});
            chrome.storage.local.get(keys, (res) => resolve(res || {}));
        });

        let cachedAccountCount = 0;
        this._globalSearchIndex = accounts.map(acc => {
            const isCurrent = this.currentAccount?.id === acc.id;
            const cache = stored[`resourceCache_${acc.id}`] || {};
            const zones = isCurrent ? (this.zones || []) : (cache.zones || []);
            const allRecords = isCurrent ? (this.allRecords || []) : (cache.allRecords || []);
            const workers = isCurrent ? (this.workers || []) : (cache.workers || []);
            const pages = isCurrent ? (this.pages || []) : (cache.pages || []);
            const tunnels = isCurrent ? (this.tunnels || []) : (cache.tunnels || []);

            if (isCurrent || cache.timestamp) cachedAccountCount++;
            return { account: acc, zones, allRecords, workers, pages, tunnels };
        });

        const hint = document.getElementById('globalSearchHint');
        if (hint) {
            hint.textContent = `已扫描 ${cachedAccountCount}/${accounts.length} 个账户的本地缓存数据（未缓存的账户可点击右侧「同步全部缓存」）。`;
        }
    },

    async refreshAllAccountCaches() {
        if (!this.accounts || this.accounts.length === 0) {
            this.showToast('请先添加 Cloudflare 账户', 'warning');
            return;
        }
        const btn = document.getElementById('refreshAllCachesBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 同步中...';
        }
        try {
            let successCount = 0;
            for (const acc of this.accounts) {
                try {
                    const snap = await this.fetchAccountSnapshot(acc);
                    const cacheKey = `resourceCache_${acc.id}`;
                    const existing = await new Promise(r => chrome.storage.local.get([cacheKey], res => r(res[cacheKey] || {})));
                    const cacheData = {
                        zones: snap.zones || [],
                        allRecords: snap.dnsRecords || [],
                        workers: snap.workers || [],
                        pages: snap.pages || [],
                        tunnels: existing.tunnels || [],
                        timestamp: Date.now()
                    };
                    await new Promise(r => chrome.storage.local.set({ [cacheKey]: cacheData }, r));
                    successCount++;
                } catch (err) {
                    console.warn(`[GlobalSearch] 同步账户 ${acc.name} 失败:`, err);
                }
            }
            await this.loadAllAccountCachesForSearch();
            const input = document.getElementById('globalSearchInput');
            this.renderGlobalSearchResults(input?.value || '');
            this.showToast(`已完成 ${successCount}/${this.accounts.length} 个账户缓存同步`, 'success');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🔄 同步全部缓存';
            }
        }
    },

    renderGlobalSearchResults(rawQuery) {
        const container = document.getElementById('globalSearchResults');
        if (!container) return;

        const q = (rawQuery || '').trim().toLowerCase();
        if (!q) {
            container.innerHTML = '<div class="global-search-empty">请输入关键词开始搜索（支持域名、DNS记录值、Worker/Pages/Tunnel 名称或备注别名）</div>';
            return;
        }

        const results = [];
        const limit = 60;

        for (const entry of (this._globalSearchIndex || [])) {
            const acc = entry.account;

            for (const z of entry.zones) {
                const remark = this.remarks?.[`zone:${z.id}`];
                const matchText = `${z.name} ${remark?.alias || ''} ${remark?.content || ''} ${(remark?.tags || []).join(' ')}`.toLowerCase();
                if (matchText.includes(q)) {
                    results.push({
                        accountId: acc.id,
                        accountName: acc.name,
                        tab: 'dns',
                        typeLabel: '域名',
                        typeClass: 'gs-badge-zone',
                        title: z.name,
                        subtitle: remark?.alias ? `别名: ${remark.alias}` : `状态: ${z.status || 'active'}`,
                        searchText: z.name
                    });
                }
            }

            for (const r of entry.allRecords) {
                const remark = r.id ? this.remarks?.[`dns:${r.id}`] : null;
                const matchText = `${r.type} ${r.name} ${r.content} ${r.zoneName || ''} ${remark?.alias || ''} ${remark?.content || ''}`.toLowerCase();
                if (matchText.includes(q)) {
                    results.push({
                        accountId: acc.id,
                        accountName: acc.name,
                        tab: 'dns',
                        typeLabel: `DNS · ${r.type}`,
                        typeClass: 'gs-badge-dns',
                        title: r.name,
                        subtitle: `${r.content} (${r.zoneName || ''})`,
                        searchText: r.name
                    });
                }
            }

            for (const w of entry.workers) {
                const wName = w.id || w.name || '';
                const remark = this.remarks?.[`worker:${wName}`];
                const matchText = `${wName} ${remark?.alias || ''} ${remark?.content || ''} ${(remark?.tags || []).join(' ')}`.toLowerCase();
                if (matchText.includes(q)) {
                    results.push({
                        accountId: acc.id,
                        accountName: acc.name,
                        tab: 'workers',
                        typeLabel: 'Worker',
                        typeClass: 'gs-badge-worker',
                        title: wName,
                        subtitle: remark?.alias ? `别名: ${remark.alias}` : (w.accountName || ''),
                        searchText: wName
                    });
                }
            }

            for (const p of entry.pages) {
                const pName = p.name || '';
                const remark = this.remarks?.[`page:${pName}`];
                const matchText = `${pName} ${p.subdomain || ''} ${remark?.alias || ''} ${remark?.content || ''}`.toLowerCase();
                if (matchText.includes(q)) {
                    results.push({
                        accountId: acc.id,
                        accountName: acc.name,
                        tab: 'pages',
                        typeLabel: 'Pages',
                        typeClass: 'gs-badge-page',
                        title: pName,
                        subtitle: `${p.subdomain || pName}.pages.dev`,
                        searchText: pName
                    });
                }
            }

            for (const t of entry.tunnels) {
                const tName = t.name || t.id || '';
                const matchText = `${tName} ${t.id || ''} ${t.status || ''}`.toLowerCase();
                if (matchText.includes(q)) {
                    results.push({
                        accountId: acc.id,
                        accountName: acc.name,
                        tab: 'tunnels',
                        typeLabel: 'Tunnel',
                        typeClass: 'gs-badge-tunnel',
                        title: tName,
                        subtitle: `状态: ${t.status || '未知'}`,
                        searchText: tName
                    });
                }
            }
        }

        if (results.length === 0) {
            container.innerHTML = '<div class="global-search-empty">未找到匹配的资源。如果目标账户尚未加载过，可点击右上角「同步全部缓存」。</div>';
            return;
        }

        const shown = results.slice(0, limit);
        container.innerHTML = '';
        shown.forEach(item => {
            const row = document.createElement('div');
            row.className = 'global-search-item';
            row.innerHTML = `
                <div class="gs-item-main">
                    <span class="gs-badge ${item.typeClass}">${this.escapeHtml(item.typeLabel)}</span>
                    <span class="gs-title">${this.escapeHtml(item.title)}</span>
                    <span class="gs-subtitle">${this.escapeHtml(item.subtitle)}</span>
                </div>
                <div class="gs-item-account">
                    <span class="account-tag ${this.getAccountColorClass(item.accountId)}">${this.escapeHtml(item.accountName)}</span>
                    <span class="gs-jump-hint">跳转 →</span>
                </div>
            `;
            row.addEventListener('click', () => this.jumpToSearchResult(item));
            container.appendChild(row);
        });

        if (results.length > limit) {
            const more = document.createElement('div');
            more.className = 'global-search-empty';
            more.textContent = `共匹配 ${results.length} 条，当前显示前 ${limit} 条，请缩小关键词范围`;
            container.appendChild(more);
        }
    },

    async jumpToSearchResult(item) {
        this.closeGlobalSearchModal();
        if (this.currentAccount?.id !== item.accountId) {
            this.showToast(`正在切换到账户「${item.accountName}」...`, 'info');
            await this.switchAccount(item.accountId);
        }
        this.switchTab(item.tab);

        if (item.tab === 'dns') {
            const input = document.getElementById('searchInput');
            if (input) input.value = item.searchText;
            this.handleSearch(item.searchText);
        } else if (item.tab === 'workers') {
            const input = document.getElementById('workersSearchInput');
            if (input) input.value = item.searchText;
            this.handleWorkersSearch(item.searchText);
        } else if (item.tab === 'pages') {
            const input = document.getElementById('pagesSearchInput');
            if (input) input.value = item.searchText;
            this.handlePagesSearch(item.searchText);
        } else if (item.tab === 'tunnels') {
            const input = document.getElementById('tunnelsSearchInput');
            if (input) input.value = item.searchText;
            this.handleTunnelsSearch(item.searchText);
        }
    }
});


// =====================================================
// 2. 一键清缓存 & 开发模式开关
// =====================================================
Object.assign(CloudflareManager.prototype, {
    async purgeZoneCache(zoneId, zoneName) {
        if (!confirm(`确定要清空域名「${zoneName}」的全部 Cloudflare 缓存吗？`)) return;
        try {
            this.showToast(`正在清空 ${zoneName} 缓存...`, 'info');
            await this.apiRequest(`/zones/${zoneId}/purge_cache`, 'POST', { purge_everything: true });
            this.showToast(`已清空「${zoneName}」全部缓存`, 'success');
        } catch (err) {
            this.showToast(`清缓存失败: ${err.message}`, 'error');
        }
    },

    async toggleZoneDevMode(zoneId, zoneName, btnEl) {
        try {
            const current = await this.apiRequest(`/zones/${zoneId}/settings/development_mode`, 'GET');
            const isCurrentlyOn = current?.value === 'on';
            const nextValue = isCurrentlyOn ? 'off' : 'on';
            await this.apiRequest(`/zones/${zoneId}/settings/development_mode`, 'PATCH', { value: nextValue });

            const zoneObj = this.zones?.find(z => z.id === zoneId);
            if (zoneObj) zoneObj.development_mode = nextValue === 'on' ? 10800 : 0;

            if (btnEl) {
                btnEl.dataset.active = nextValue;
                btnEl.classList.toggle('active', nextValue === 'on');
                btnEl.textContent = nextValue === 'on' ? '🛠️ 开发模式·开' : '🛠️ 开发模式';
            }
            this.showToast(
                nextValue === 'on'
                    ? `「${zoneName}」已开启开发模式（3小时后自动关闭）`
                    : `「${zoneName}」已关闭开发模式`,
                'success'
            );
        } catch (err) {
            this.showToast(`切换开发模式失败: ${err.message}`, 'error');
        }
    }
});


// =====================================================
// 3. Token 权限“红绿灯”体检
// =====================================================
Object.assign(CloudflareManager.prototype, {
    initTokenPermCheck() {
        const btn = document.getElementById('checkTokenPermBtn');
        btn?.addEventListener('click', () => this.runTokenPermissionCheck());
    },

    async runTokenPermissionCheck() {
        const box = document.getElementById('tokenPermResult');
        const btn = document.getElementById('checkTokenPermBtn');
        if (!this.currentAccount?.token) {
            this.showToast('请先选择一个账户', 'warning');
            return;
        }
        const token = this.currentAccount.token;
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ 正在体检...';
        }
        if (box) {
            box.style.display = 'block';
            box.innerHTML = '<div class="perm-loading">正在检测 Token 状态与权限...</div>';
        }

        const probe = async (endpoint) => {
            try {
                const res = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });
                const data = await res.json().catch(() => ({}));
                return { ok: res.ok && data.success !== false, status: res.status, data };
            } catch (e) {
                return { ok: false, status: 0, error: e.message };
            }
        };

        try {
            const verifyRes = await probe('/user/tokens/verify');
            const zonesRes = await probe('/zones?per_page=1');
            const accountsRes = await probe('/accounts?per_page=1');

            const firstZoneId = zonesRes.ok && Array.isArray(zonesRes.data?.result) && zonesRes.data.result[0]?.id;
            const firstAccId = (accountsRes.ok && Array.isArray(accountsRes.data?.result) && accountsRes.data.result[0]?.id)
                || (zonesRes.ok && zonesRes.data?.result?.[0]?.account?.id)
                || '';

            const dnsRes = firstZoneId ? await probe(`/zones/${firstZoneId}/dns_records?per_page=1`) : null;
            const workersRes = firstAccId ? await probe(`/accounts/${firstAccId}/workers/scripts`) : null;
            const pagesRes = firstAccId ? await probe(`/accounts/${firstAccId}/pages/projects?per_page=1`) : null;
            const tunnelRes = firstAccId ? await probe(`/accounts/${firstAccId}/cfd_tunnel?per_page=1`) : null;

            const items = [];
            if (verifyRes.ok && verifyRes.data?.result) {
                const st = verifyRes.data.result.status || 'active';
                const exp = verifyRes.data.result.expires_on
                    ? `（到期: ${new Date(verifyRes.data.result.expires_on).toLocaleDateString()}）`
                    : '（永久有效）';
                items.push({
                    ok: st === 'active',
                    label: `Token 状态: ${st === 'active' ? '正常有效' : st} ${exp}`
                });
            } else {
                items.push({ ok: false, label: 'Token 状态: 验证失败或无效' });
            }

            items.push({ ok: zonesRes.ok, label: '域名列表 (Zone:Read)' });
            items.push(dnsRes === null
                ? { unknown: true, label: 'DNS 记录（账号下暂无域名，无法探测）' }
                : { ok: dnsRes.ok, label: 'DNS 记录读取 (DNS:Read)' });
            items.push(workersRes === null
                ? { unknown: true, label: 'Workers（未获取到 Account ID）' }
                : { ok: workersRes.ok, label: 'Workers 管理 (Workers:Read)' });
            items.push(pagesRes === null
                ? { unknown: true, label: 'Pages（未获取到 Account ID）' }
                : { ok: pagesRes.ok, label: 'Pages 管理 (Pages:Read)' });
            items.push(tunnelRes === null
                ? { unknown: true, label: 'Tunnel（未获取到 Account ID）' }
                : { ok: tunnelRes.ok, label: 'Tunnel 管理 (Tunnel:Read)' });

            if (box) {
                box.innerHTML = items.map(it => {
                    const icon = it.unknown ? '⚪' : (it.ok ? '✅' : '❌');
                    const cls = it.unknown ? 'perm-unknown' : (it.ok ? 'perm-ok' : 'perm-bad');
                    return `<div class="perm-item ${cls}"><span>${icon}</span><span>${this.escapeHtml(it.label)}</span></div>`;
                }).join('');
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '🩺 Token 权限体检';
            }
        }
    }
});


// =====================================================
// 4. DNS 批量操作 & 操作快照/备份恢复
// =====================================================
Object.assign(CloudflareManager.prototype, {
    initDnsBatchAndSnapshots() {
        this.selectedRecordIds = new Set();

        document.getElementById('batchProxyOnBtn')?.addEventListener('click', () => this.batchToggleProxy(true));
        document.getElementById('batchProxyOffBtn')?.addEventListener('click', () => this.batchToggleProxy(false));
        document.getElementById('batchDeleteRecordsBtn')?.addEventListener('click', () => this.batchDeleteRecords());
        document.getElementById('clearRecordSelectionBtn')?.addEventListener('click', () => this.clearRecordSelection());

        document.getElementById('dnsSnapshotsBtn')?.addEventListener('click', () => this.openDnsSnapshotsModal());
        document.getElementById('closeDnsSnapshotsBtn')?.addEventListener('click', () => this.closeDnsSnapshotsModal());
        document.getElementById('dnsSnapshotsOverlay')?.addEventListener('click', () => this.closeDnsSnapshotsModal());

        const importBtn = document.getElementById('importDnsJsonBtn');
        const importInput = document.getElementById('importDnsJsonInput');
        importBtn?.addEventListener('click', () => importInput?.click());
        importInput?.addEventListener('change', (e) => {
            if (e.target.files?.[0]) {
                this.importDnsRecordsFromFile(e.target.files[0]);
                e.target.value = '';
            }
        });
    },

    toggleRecordSelection(recordId, checked) {
        if (!this.selectedRecordIds) this.selectedRecordIds = new Set();
        if (checked) this.selectedRecordIds.add(recordId);
        else this.selectedRecordIds.delete(recordId);
        this.updateDnsBatchBar();
    },

    clearRecordSelection() {
        this.selectedRecordIds?.clear();
        document.querySelectorAll('.record-select-checkbox').forEach(cb => { cb.checked = false; });
        this.updateDnsBatchBar();
    },

    updateDnsBatchBar() {
        const bar = document.getElementById('dnsBatchBar');
        const countEl = document.getElementById('dnsSelectedCount');
        const count = this.selectedRecordIds?.size || 0;
        if (countEl) countEl.textContent = String(count);
        if (bar) bar.style.display = count > 0 ? 'flex' : 'none';
    },

    getSelectedRecords() {
        const ids = this.selectedRecordIds || new Set();
        return (this.allRecords || []).filter(r => ids.has(r.id));
    },

    async batchToggleProxy(proxied) {
        const selected = this.getSelectedRecords().filter(r => ['A', 'AAAA', 'CNAME'].includes(r.type));
        if (selected.length === 0) {
            this.showToast('所选记录中没有支持橙云代理的记录（仅 A / AAAA / CNAME 支持）', 'warning');
            return;
        }
        await this.saveDnsSnapshot(`批量${proxied ? '开启' : '关闭'}代理前`, selected);
        this.showLoading();
        let ok = 0;
        for (const r of selected) {
            try {
                await this.updateRecord(r.zoneId, r.id, {
                    type: r.type,
                    name: r.name,
                    content: r.content,
                    ttl: r.ttl,
                    proxied
                });
                ok++;
            } catch (err) {
                console.warn('[BatchProxy] 失败:', r.name, err);
            }
        }
        this.hideLoading();
        this.clearRecordSelection();
        this.showToast(`已完成 ${ok}/${selected.length} 条记录的代理切换`, 'success');
        await this.loadAllZonesAndRecords();
    },

    async batchDeleteRecords() {
        const selected = this.getSelectedRecords();
        if (selected.length === 0) return;
        if (!confirm(`确定要批量删除选中的 ${selected.length} 条 DNS 记录吗？\n（删除前会自动保存恢复快照）`)) return;

        await this.saveDnsSnapshot('批量删除前', selected);
        this.showLoading();
        let ok = 0;
        for (const r of selected) {
            try {
                await this.deleteRecord(r.zoneId, r.id);
                ok++;
            } catch (err) {
                console.warn('[BatchDelete] 失败:', r.name, err);
            }
        }
        this.hideLoading();
        this.clearRecordSelection();
        this.showToast(`已删除 ${ok}/${selected.length} 条记录（可在“备份恢复”中找回）`, 'success');
        await this.loadAllZonesAndRecords();
    },

    async saveDnsSnapshot(actionLabel, records) {
        if (!records || records.length === 0) return;
        const snapshot = {
            id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            accountId: this.currentAccount?.id || '',
            accountName: this.currentAccount?.name || '',
            action: actionLabel,
            timestamp: Date.now(),
            records: records.map(r => ({
                id: r.id,
                zoneId: r.zoneId,
                zoneName: r.zoneName,
                type: r.type,
                name: r.name,
                content: r.content,
                ttl: r.ttl,
                proxied: r.proxied,
                priority: r.priority
            }))
        };
        const existing = await new Promise(res => chrome.storage.local.get(['dnsSnapshots'], d => res(d.dnsSnapshots || [])));
        const next = [snapshot, ...existing].slice(0, 30);
        await new Promise(res => chrome.storage.local.set({ dnsSnapshots: next }, res));
    },

    async openDnsSnapshotsModal() {
        const modal = document.getElementById('dnsSnapshotsModal');
        if (!modal) return;
        modal.style.display = 'flex';
        await this.renderDnsSnapshotsList();
    },

    closeDnsSnapshotsModal() {
        const modal = document.getElementById('dnsSnapshotsModal');
        if (modal) modal.style.display = 'none';
    },

    async renderDnsSnapshotsList() {
        const container = document.getElementById('dnsSnapshotsList');
        if (!container) return;
        const snapshots = await new Promise(res => chrome.storage.local.get(['dnsSnapshots'], d => res(d.dnsSnapshots || [])));

        if (snapshots.length === 0) {
            container.innerHTML = '<div class="global-search-empty">暂无操作快照。当您修改或删除 DNS 记录时，系统会自动在此保留备份。</div>';
            return;
        }

        container.innerHTML = '';
        snapshots.forEach(snap => {
            const first = snap.records[0] || {};
            const summary = snap.records.length === 1
                ? `${first.type} ${first.name} → ${first.content}`
                : `${snap.records.length} 条记录（如 ${first.name} 等）`;

            const row = document.createElement('div');
            row.className = 'global-search-item';
            row.style.cursor = 'default';
            row.innerHTML = `
                <div class="gs-item-main" style="flex-direction: column; align-items: flex-start; gap: 3px;">
                    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <span class="gs-badge gs-badge-dns">${this.escapeHtml(snap.action)}</span>
                        <span class="gs-title">${this.escapeHtml(summary)}</span>
                    </div>
                    <div class="gs-subtitle">
                        ${new Date(snap.timestamp).toLocaleString()} · 账户: ${this.escapeHtml(snap.accountName || '未知')}
                    </div>
                </div>
                <div class="gs-item-account">
                    <button class="btn-primary btn-sm" data-action="restore-snap">⏪ 恢复</button>
                </div>
            `;
            row.querySelector('[data-action="restore-snap"]').addEventListener('click', () => this.restoreDnsSnapshot(snap));
            container.appendChild(row);
        });
    },

    async restoreDnsSnapshot(snap) {
        if (!this.currentAccount) {
            this.showToast('请先登录/选择对应账户', 'warning');
            return;
        }
        if (snap.accountId && snap.accountId !== this.currentAccount.id) {
            if (!confirm(`该快照属于账户「${snap.accountName}」，当前账户是「${this.currentAccount.name}」。是否切换到目标账户并恢复？`)) return;
            await this.switchAccount(snap.accountId);
        }

        this.showLoading();
        let restored = 0;
        for (const r of snap.records) {
            const payload = {
                type: r.type,
                name: r.name,
                content: r.content,
                ttl: r.ttl || 1
            };
            if (['A', 'AAAA', 'CNAME'].includes(r.type) && r.proxied !== undefined) payload.proxied = r.proxied;
            if ((r.type === 'MX' || r.type === 'SRV') && r.priority !== undefined) payload.priority = r.priority;

            try {
                const exists = this.allRecords?.find(cur => cur.id === r.id);
                if (exists) {
                    await this.updateRecord(r.zoneId, r.id, payload);
                } else {
                    await this.createRecord(r.zoneId, payload);
                }
                restored++;
            } catch (err) {
                console.warn('[RestoreSnapshot] 失败:', r.name, err);
            }
        }
        this.hideLoading();
        this.closeDnsSnapshotsModal();
        this.showToast(`已恢复 ${restored}/${snap.records.length} 条 DNS 记录`, 'success');
        await this.loadAllZonesAndRecords();
    },

    async importDnsRecordsFromFile(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            const rawRecords = Array.isArray(data) ? data : (data.records || data.dnsRecords || []);
            if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
                this.showToast('JSON 文件中未找到有效的 DNS 记录数组', 'error');
                return;
            }
            if (!confirm(`共读取到 ${rawRecords.length} 条记录，将尝试按域名匹配当前账户并补充创建缺失的记录。继续吗？`)) return;

            this.showLoading();
            let created = 0;
            let skipped = 0;
            for (const r of rawRecords) {
                const zone = this.zones?.find(z => z.name === r.zoneName || r.name?.endsWith(`.${z.name}`) || r.name === z.name);
                if (!zone) { skipped++; continue; }

                const dup = this.allRecords?.find(cur =>
                    cur.zoneId === zone.id && cur.type === r.type && cur.name === r.name && cur.content === r.content
                );
                if (dup) { skipped++; continue; }

                const payload = {
                    type: r.type,
                    name: r.name,
                    content: r.content,
                    ttl: r.ttl || 1
                };
                if (['A', 'AAAA', 'CNAME'].includes(r.type) && r.proxied !== undefined) payload.proxied = !!r.proxied;
                if ((r.type === 'MX' || r.type === 'SRV') && r.priority !== undefined) payload.priority = r.priority;

                try {
                    await this.createRecord(zone.id, payload);
                    created++;
                } catch (err) {
                    console.warn('[ImportDNS] 创建失败:', r.name, err);
                }
            }
            this.hideLoading();
            this.closeDnsSnapshotsModal();
            this.showToast(`导入完成：新增 ${created} 条，跳过已存在/无匹配域名 ${skipped} 条`, 'success');
            await this.loadAllZonesAndRecords();
        } catch (err) {
            this.hideLoading();
            this.showToast(`导入失败: ${err.message}`, 'error');
        }
    }
});


// =====================================================
// 5. 常用 DNS 快捷模板
// =====================================================
Object.assign(CloudflareManager.prototype, {
    initDnsTemplates() {
        document.querySelectorAll('[data-dns-tpl]').forEach(btn => {
            btn.addEventListener('click', () => this.applyDnsTemplate(btn.dataset.dnsTpl));
        });
    },

    async applyDnsTemplate(tplKey) {
        const zoneId = document.getElementById('recordZone')?.value;
        const zone = this.zones?.find(z => z.id === zoneId);
        if (!zone) {
            this.showToast('请先在下方选择一个域名', 'warning');
            return;
        }

        const fillSingle = (type, name, content, proxied = false) => {
            document.getElementById('recordType').value = type;
            document.getElementById('recordName').value = name;
            document.getElementById('recordContent').value = content;
            document.getElementById('recordProxied').checked = proxied;
            this.handleRecordTypeChange(type);
            this.showToast('已填入模板内容，核对无误后点击“保存记录”', 'info');
        };

        if (tplKey === 'vercel-a') {
            return fillSingle('A', '@', '76.76.21.21', false);
        }
        if (tplKey === 'vercel-cname') {
            return fillSingle('CNAME', 'www', 'cname.vercel-dns.com', false);
        }

        const batchPresets = {
            'github-pages': {
                label: 'GitHub Pages (4条根域名 A 记录)',
                records: [
                    { type: 'A', name: zone.name, content: '185.199.108.153', ttl: 1, proxied: false },
                    { type: 'A', name: zone.name, content: '185.199.109.153', ttl: 1, proxied: false },
                    { type: 'A', name: zone.name, content: '185.199.110.153', ttl: 1, proxied: false },
                    { type: 'A', name: zone.name, content: '185.199.111.153', ttl: 1, proxied: false }
                ]
            },
            'qq-mail': {
                label: '腾讯企业邮 (2条 MX + 1条 SPF TXT)',
                records: [
                    { type: 'MX', name: zone.name, content: 'mxbiz1.qq.com', priority: 5, ttl: 1 },
                    { type: 'MX', name: zone.name, content: 'mxbiz2.qq.com', priority: 10, ttl: 1 },
                    { type: 'TXT', name: zone.name, content: 'v=spf1 include:spf.mail.qq.com ~all', ttl: 1 }
                ]
            },
            '163-mail': {
                label: '网易企业邮 (2条 MX + 1条 SPF TXT)',
                records: [
                    { type: 'MX', name: zone.name, content: 'hzmx01.mxmail.netease.com', priority: 5, ttl: 1 },
                    { type: 'MX', name: zone.name, content: 'hzmx02.mxmail.netease.com', priority: 10, ttl: 1 },
                    { type: 'TXT', name: zone.name, content: 'v=spf1 include:spf.163.com -all', ttl: 1 }
                ]
            }
        };

        const preset = batchPresets[tplKey];
        if (!preset) return;
        if (!confirm(`确定为域名「${zone.name}」一键添加：${preset.label}？`)) return;

        this.showLoading();
        let created = 0;
        for (const rec of preset.records) {
            try {
                await this.createRecord(zone.id, rec);
                created++;
            } catch (err) {
                console.warn('[DNS Template] 创建失败:', rec, err);
            }
        }
        this.hideLoading();
        this.hideRecordForm();
        this.showToast(`已成功添加 ${created}/${preset.records.length} 条模板记录`, 'success');
        await this.loadAllZonesAndRecords();
    }
});


// =====================================================
// 6. Workers / Pages 状态与环境变量查看
// =====================================================
Object.assign(CloudflareManager.prototype, {
    initResourceDetailModal() {
        document.getElementById('closeResourceDetailBtn')?.addEventListener('click', () => this.closeResourceDetailModal());
        document.getElementById('resourceDetailOverlay')?.addEventListener('click', () => this.closeResourceDetailModal());
    },

    closeResourceDetailModal() {
        const modal = document.getElementById('resourceDetailModal');
        if (modal) modal.style.display = 'none';
    },

    async openWorkerDetailModal(worker) {
        const modal = document.getElementById('resourceDetailModal');
        const title = document.getElementById('resourceDetailTitle');
        const body = document.getElementById('resourceDetailBody');
        if (!modal || !body) return;

        title.textContent = `⚡ Worker 详情 · ${worker.id}`;
        body.innerHTML = '<div class="loading">正在从 Cloudflare 加载绑定、环境变量与部署记录...</div>';
        modal.style.display = 'flex';

        const accId = worker.account?.id || await this.getAccountId();
        if (!accId) {
            body.innerHTML = '<div class="global-search-empty">无法获取 Cloudflare Account ID</div>';
            return;
        }

        let settings = null;
        let deployments = [];
        try {
            settings = await this.apiRequest(`/accounts/${accId}/workers/scripts/${encodeURIComponent(worker.id)}/settings`, 'GET');
        } catch (e) {
            console.warn('[WorkerDetail] settings 获取失败:', e);
        }
        try {
            const depRes = await this.apiRequest(`/accounts/${accId}/workers/scripts/${encodeURIComponent(worker.id)}/deployments`, 'GET');
            deployments = depRes?.deployments || (Array.isArray(depRes) ? depRes : []);
        } catch (e) {
            console.warn('[WorkerDetail] deployments 获取失败:', e);
        }

        const bindings = settings?.bindings || [];
        let html = '<div class="detail-section"><h4>环境变量与资源绑定</h4>';
        if (bindings.length === 0) {
            html += '<div class="detail-empty">暂无环境变量或绑定（或当前 Token 无权读取）</div>';
        } else {
            html += '<div class="detail-list">';
            bindings.forEach(b => {
                const isSecret = b.type === 'secret_text';
                const val = isSecret ? '••••••••（已加密 Secret）' : (b.text || b.namespace_id || b.id || b.bucket_name || b.service || b.type);
                html += `
                    <div class="detail-row">
                        <span class="gs-badge gs-badge-worker">${this.escapeHtml(b.type)}</span>
                        <strong>${this.escapeHtml(b.name)}</strong>
                        <span class="detail-val">${this.escapeHtml(String(val))}</span>
                    </div>
                `;
            });
            html += '</div>';
        }
        html += '</div>';

        html += '<div class="detail-section"><h4>最近部署记录</h4>';
        if (deployments.length === 0) {
            html += '<div class="detail-empty">暂无部署记录</div>';
        } else {
            html += '<div class="detail-list">';
            deployments.slice(0, 5).forEach(d => {
                const time = d.created_on ? new Date(d.created_on).toLocaleString() : '-';
                const source = d.source || d.strategy || 'upload';
                html += `
                    <div class="detail-row">
                        <span class="gs-badge gs-badge-dns">${this.escapeHtml(source)}</span>
                        <span>${this.escapeHtml(time)}</span>
                    </div>
                `;
            });
            html += '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    },

    async openPagesDetailModal(page) {
        const modal = document.getElementById('resourceDetailModal');
        const title = document.getElementById('resourceDetailTitle');
        const body = document.getElementById('resourceDetailBody');
        if (!modal || !body) return;

        title.textContent = `📄 Pages 详情 · ${page.name}`;
        body.innerHTML = '<div class="loading">正在加载部署记录与环境变量...</div>';
        modal.style.display = 'flex';

        const accId = page.account?.id || await this.getAccountId();
        if (!accId) {
            body.innerHTML = '<div class="global-search-empty">无法获取 Cloudflare Account ID</div>';
            return;
        }

        let detail = page;
        let deployments = [];
        try {
            detail = await this.apiRequest(`/accounts/${accId}/pages/projects/${encodeURIComponent(page.name)}`, 'GET');
        } catch (e) {
            console.warn('[PagesDetail] 项目详情获取失败:', e);
        }
        try {
            const deps = await this.apiRequest(`/accounts/${accId}/pages/projects/${encodeURIComponent(page.name)}/deployments?per_page=5`, 'GET');
            if (Array.isArray(deps)) deployments = deps;
        } catch (e) {
            console.warn('[PagesDetail] 部署列表获取失败:', e);
        }

        const prodVars = detail?.deployment_configs?.production?.env_vars || {};
        const varEntries = Object.entries(prodVars);

        let html = '<div class="detail-section"><h4>生产环境变量 (Production)</h4>';
        if (varEntries.length === 0) {
            html += '<div class="detail-empty">暂无环境变量</div>';
        } else {
            html += '<div class="detail-list">';
            varEntries.forEach(([k, v]) => {
                const isSecret = v?.type === 'secret_text' || v?.value === undefined;
                const valText = isSecret ? '••••••••（Secret）' : String(v.value);
                html += `
                    <div class="detail-row">
                        <span class="gs-badge gs-badge-page">${isSecret ? 'Secret' : 'Text'}</span>
                        <strong>${this.escapeHtml(k)}</strong>
                        <span class="detail-val">${this.escapeHtml(valText)}</span>
                    </div>
                `;
            });
            html += '</div>';
        }
        html += '</div>';

        html += '<div class="detail-section"><h4>最近 5 次部署记录</h4>';
        if (deployments.length === 0) {
            html += '<div class="detail-empty">暂无部署记录</div>';
        } else {
            html += '<div class="detail-list">';
            deployments.slice(0, 5).forEach(d => {
                const status = d.latest_stage?.status || 'unknown';
                const statusIcon = status === 'success' ? '✅ 成功' : (status === 'failure' ? '❌ 失败' : `⏳ ${status}`);
                const branch = d.deployment_trigger?.metadata?.branch || '-';
                const msg = d.deployment_trigger?.metadata?.commit_message || '';
                const time = d.created_on ? new Date(d.created_on).toLocaleString() : '-';
                html += `
                    <div class="detail-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
                        <div style="display:flex; align-items:center; gap:8px; width:100%; justify-content:space-between;">
                            <span><strong>${this.escapeHtml(statusIcon)}</strong> · 分支 <code>${this.escapeHtml(branch)}</code></span>
                            <span class="detail-val">${this.escapeHtml(time)}</span>
                        </div>
                        ${msg ? `<div class="gs-subtitle">${this.escapeHtml(msg)}</div>` : ''}
                    </div>
                `;
            });
            html += '</div>';
        }
        html += '</div>';
        body.innerHTML = html;
    }
});


// =====================================================
// 7. 主密码加密工具（Web Crypto AES-GCM + PBKDF2）
// =====================================================
Object.assign(CloudflareManager.prototype, {
    async encryptDataWithPassword(plainObj, password) {
        const enc = new TextEncoder();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const keyMaterial = await crypto.subtle.importKey(
            'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
        );
        const key = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt']
        );
        const cipherBuf = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            enc.encode(JSON.stringify(plainObj))
        );
        const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
        return {
            encrypted: true,
            v: 1,
            salt: toB64(salt),
            iv: toB64(iv),
            data: toB64(cipherBuf)
        };
    },

    async decryptDataWithPassword(encObj, password) {
        const fromB64 = (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0));
        const enc = new TextEncoder();
        const dec = new TextDecoder();
        const salt = fromB64(encObj.salt);
        const iv = fromB64(encObj.iv);
        const cipher = fromB64(encObj.data);
        const keyMaterial = await crypto.subtle.importKey(
            'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
        );
        const key = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
        const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
        return JSON.parse(dec.decode(plainBuf));
    }
});
