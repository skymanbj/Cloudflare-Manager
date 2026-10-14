/**
 * Cloudflare Manager - Cloudflare API 交互方法
 *
 * 以 Object.assign 方式挂载到 CloudflareManager.prototype，
 * 运行时才解析 this 调用，故加载顺序不影响执行；
 * 本文件须在 popup.js（类定义）之后加载。
 */

Object.assign(CloudflareManager.prototype, {
        // =====================================================
        // API Methods
        // =====================================================
        async apiRequest(endpoint, method = 'GET', body = null) {
            if (!this.currentAccount?.token) {
                throw new Error('请先配置账户');
            }
    
            const url = `https://api.cloudflare.com/client/v4${endpoint}`;
    
            // Sanitize token: remove whitespace/newlines which cause fetch to throw "Failed to fetch" (TypeError)
            const token = (this.currentAccount.token || '').trim();
    
            const options = {
                method,
                headers: {
                    'Authorization': `Bearer ${token}`
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
                    console.error('[API Error] Network request failed. If you are in a restricted region, please check your proxy settings.');
                    throw new Error('网络请求失败 (Failed to fetch)。\n请检查您的网络连接，或确保代理设置允许访问 Cloudflare API。');
                }
                throw error;
            }
        }
,

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
,

        async loadZones() {
            if (this.isLoadingZones) return; // 防止重复加载
            this.isLoadingZones = true;
            const newZones = [];
            let page = 1;
            const perPage = 50;
            let hasError = false;
    
            while (true) {
                try {
                    // Cloudflare pagination is 1-based
                    const response = await this.apiRequest(`/zones?per_page=${perPage}&page=${page}`);
                    const zones = response || [];
    
                    newZones.push(...zones);
    
                    if (zones.length < perPage) {
                        break;
                    }
                    page++;
                } catch (error) {
                    console.error('Failed to load zones page', page, error);
                    hasError = true;
                    break;
                }
            }
    
            // 只有当至少加载到一些数据，或者虽然报错但之前是空的（首次加载），才更新
            // 如果之前有数据（缓存），且这次完全失败（hasError && newZones.length === 0），则不覆盖，保留缓存
            if (newZones.length > 0 || !hasError || this.zones.length === 0) {
                this.zones = newZones;
                if (hasError && this.zones.length > 0) {
                    this.showToast('仅加载了部分域名 (网络中断)', 'warning');
                }
            } else if (hasError && this.zones.length > 0) {
                this.showToast('加载失败，显示缓存数据', 'warning');
                console.log('[Offline] Kept cached zones due to load failure');
            }
    
            this.isLoadingZones = false;
            return this.zones;
        }
,

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
,

        async createRecord(zoneId, recordData) {
            return await this.apiRequest(`/zones/${zoneId}/dns_records`, 'POST', recordData);
        }
,

        async updateRecord(zoneId, recordId, recordData) {
            return await this.apiRequest(`/zones/${zoneId}/dns_records/${recordId}`, 'PUT', recordData);
        }
,

        async deleteRecord(zoneId, recordId) {
            return await this.apiRequest(`/zones/${zoneId}/dns_records/${recordId}`, 'DELETE');
        }
,

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
,

        async loadWorkers() {
            if (this.isLoadingWorkers) return;
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
                /* 
                   即使没有找到账户，也不应该抛错导致通过不了 offline 检查。
                   如果离线，allAccounts 可能为空（如果 zones 也为空）。
                   如果 zones 有缓存，allAccounts 就有值。
                */
                if (allAccounts.length === 0) {
                    console.warn('[Workers] No accounts found to scan (possibly offline).');
                } else {
                    console.log(`Scanning ${allAccounts.length} accounts for Workers`);
                }
    
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
                        // console.warn(`Failed to fetch workers for account ${account.name} (${account.id}):`, err);
                        return [];
                    }
                });
    
                const results = await Promise.all(promises);
                const newWorkers = results.flat();
    
                // Only update if we got something OR if we didn't have anything before
                // If we have cache and network failed (newWorkers empty but allAccounts > 0), keep cache
                const hasNetworkSuccess = results.some(r => r.length > 0) || (allAccounts.length > 0 && results.length > 0);
                // 简单的逻辑：如果有新数据，或者之前没数据，就更新。
                // 但如果这次全是空（可能是网络错，也可能是真没数据），比较难判断。
                // 我们可以看 results 的长度。如果 allAccounts 有值，但 promises 全部 catch 返回 []，那可能是网络错。
                // 但这里 catch 里返回 []， indistinguishable from empty account.
    
                // 改进：只要 results 有长度（即尝试了请求），我们就认为尝试过了。
                // 如果 newWorkers.length > 0，肯定更新。
                // 如果 newWorkers.length === 0, 且 this.workers.length > 0, 我们怎么知道是网络错还是真删了？
                // 鉴于 APIRequest 会 throw，catch 里返回 []。
                // 我们应该在 catch 里标记 error。
    
                if (newWorkers.length > 0 || this.workers.length === 0) {
                    this.workers = newWorkers;
                    // Sort: created_on descending (from newest to oldest)
                    this.workers.sort((a, b) => {
                        const dateA = a.created_on ? new Date(a.created_on).getTime() : 0;
                        const dateB = b.created_on ? new Date(b.created_on).getTime() : 0;
                        return dateB - dateA;
                    });
                } else {
                    console.log('[Workers] Retaining cached workers due to empty fetch result (possibly offline).');
                }
    
                console.log(`[Workers] Total workers loaded: ${this.workers.length} from ${allAccounts.length} accounts.`);
    
                await this.saveResourceCache(); // 保存缓存
    
                // 异步补全：如果当前正在查看备注页，触发重绘
                if (this.currentTab === 'notes') {
                    this.loadRemarksAndRender();
                }
    
                this.isLoadingWorkers = false;
                return this.workers;
            } catch (error) {
                this.isLoadingWorkers = false;
                console.error('loadWorkers error:', error);
                // Don't re-throw if we want specific behavior, but here general error is fine.
                // But we kept cache implicitly by not updating this.workers if main block failed.
                throw error;
            }
        }
,

        async getWorkerRoutes(scriptName) {
            const accountId = await this.getAccountId();
            try {
                const routes = await this.apiRequest(`/accounts/${accountId}/workers/scripts/${scriptName}/routes`);
                return routes || [];
            } catch {
                return [];
            }
        }
,

        async getWorkerSubdomains() {
            const accountId = await this.getAccountId();
            try {
                const subdomain = await this.apiRequest(`/accounts/${accountId}/workers/subdomain`);
                return subdomain?.subdomain || null;
            } catch {
                return null;
            }
        }
,

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
    
                // Sort: created_on descending (from newest to oldest)
                this.pages.sort((a, b) => {
                    const dateA = a.created_on ? new Date(a.created_on).getTime() : 0;
                    const dateB = b.created_on ? new Date(b.created_on).getTime() : 0;
                    return dateB - dateA;
                });
    
                await this.saveResourceCache(); // 保存缓存
    
                // 异步补全
                if (this.currentTab === 'notes') {
                    this.loadRemarksAndRender();
                }
    
                this.isLoadingPages = false;
                return this.pages;
            } catch (error) {
                this.isLoadingPages = false;
                console.error('loadPages error:', error);
                throw error;
            }
        }
,

        // 加载所有域名和所有记录
        async loadAllZonesAndRecords() {
            const tabsSection = document.getElementById('tabsSection');
            const dnsSection = document.getElementById('dnsSection');
            const recordsList = document.getElementById('recordsList');
    
            try {
                // 1. 瞬间呈现 Tab
                tabsSection.style.display = 'block';
                dnsSection.style.display = 'block';
    
                // 2. 状态重置
                this.selectedZoneId = '';
                this.searchQuery = '';
                document.getElementById('searchInput').value = '';
                document.getElementById('clearSearchBtn').style.display = 'none';
    
                // 3. 数据重置，但先尝试加载缓存以保持界面不为空白
                this.zones = [];
                this.allRecords = [];
                this.workers = [];
                this.pages = [];
                this.accountId = null; // 必须重置，否则 getAccountId 会返回旧记录
    
                // 4. 加载缓存（极速）
                await this.loadResourceCache();
    
                // 5. 瞬间渲染缓存数据
                this.renderAllRecords();
                this.renderZoneFilter();
                this.updateNotesStatCard();
    
                if (this.allRecords.length === 0) {
                    recordsList.innerHTML = '<div class="loading">正在拉取 Cloudflare 实时数据...</div>';
                }
    
                // 6. 异步刷新：在后台拉取最新数据，完全不阻塞 switchAccount 的完成
                setTimeout(async () => {
                    try {
                        console.log('[AccountSwitch] Background refreshing...');
    
                        // 拉取 Zones
                        await this.loadZones();
                        this.renderZoneFilter();
    
                        // 拉取 DNS
                        await this.loadAllRecords();
    
                        // 更新统计与 UI
                        this.collapsedZones = new Set(this.zones.map(z => z.name));
                        const recordCountEl = document.getElementById('recordCount');
                        if (recordCountEl) recordCountEl.textContent = `${this.allRecords.length} 条记录`;
    
                        this.updateNotesStatCard();
                        this.renderAllRecords();
    
                        // 最后触发一次 UI 颜色等更新 (因为此时 accountId 肯定拿到了)
                        this.updateHeaderAccountUI();
    
                        // 自动加载 Workers/Pages (取决于当前在哪个 Tab)
                        if (this.currentTab === 'workers') this.loadWorkersAndRender();
                        if (this.currentTab === 'pages') this.loadPagesAndRender();
    
                        await this.saveResourceCache();
                        console.log('[AccountSwitch] Background refresh completed.');
                    } catch (e) {
                        console.error('[AccountSwitch] Background refresh failed:', e);
                    }
                }, 50); // 微弱延迟，确保主渲染队列完成
    
            } catch (error) {
                this.showToast(error.message, 'error');
            }
        }
,

        /**
         * 通用 Cloudflare API 请求（指定 token，不依赖当前选中账户）
         * 导出时按账户逐个抓取数据，不干扰当前视图状态
         */
        async cfApiFetch(endpoint, token) {
            const url = `https://api.cloudflare.com/client/v4${endpoint}`;
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${(token || '').trim()}` }
            });
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.errors?.[0]?.message || '请求失败');
            }
            return data.result;
        }
,

        /**
         * 抓取单个账户的完整数据快照（只读，不修改 this.zones / this.workers 等视图状态）
         * @param {{id:string,name:string,token:string}} account
         */
        async fetchAccountSnapshot(account) {
            const snapshot = {
                id: account.id,
                name: account.name,
                zones: [],
                dnsRecords: [],
                workers: [],
                pages: []
            };
    
            // 1. 域名列表（分页拉取）
            try {
                const perPage = 50;
                let page = 1;
                while (page <= 40) { // 安全上限：最多 2000 个域名，防止异常死循环
                    const batch = await this.cfApiFetch(`/zones?per_page=${perPage}&page=${page}`, account.token);
                    if (!Array.isArray(batch) || batch.length === 0) break;
                    snapshot.zones.push(...batch);
                    if (batch.length < perPage) break;
                    page++;
                }
            } catch (error) {
                console.warn(`[ExportAll] 账户「${account.name}」域名加载失败:`, error);
                snapshot.zoneError = error.message;
            }
    
            // 2. DNS 记录（按域名并发拉取）
            const recordGroups = await Promise.all(snapshot.zones.map(async (zone) => {
                try {
                    const records = await this.cfApiFetch(`/zones/${zone.id}/dns_records`, account.token);
                    return (records || []).map(record => ({
                        zoneName: zone.name,
                        type: record.type,
                        name: record.name,
                        content: record.content,
                        ttl: record.ttl,
                        proxied: record.proxied
                    }));
                } catch (error) {
                    console.warn(`[ExportAll] ${zone.name} 记录加载失败:`, error);
                    return [];
                }
            }));
            snapshot.dnsRecords = recordGroups.flat();
    
            // 3. 收集该账户可见的所有 Cloudflare Account ID（用于 Workers / Pages）
            const accountIds = new Map();
            snapshot.zones.forEach(z => {
                if (z.account?.id) accountIds.set(z.account.id, z.account.name || 'Unknown');
            });
            try {
                const apiAccounts = await this.cfApiFetch('/accounts?per_page=50', account.token);
                (apiAccounts || []).forEach(a => accountIds.set(a.id, a.name));
            } catch (error) {
                console.warn(`[ExportAll] 账户「${account.name}」/accounts 加载失败:`, error);
            }
    
            // 4. Workers / Pages
            const resourceGroups = await Promise.all(Array.from(accountIds.entries()).map(async ([accId, accName]) => {
                const workers = [];
                const pages = [];
                try {
                    const list = await this.cfApiFetch(`/accounts/${accId}/workers/scripts`, account.token);
                    (list || []).forEach(w => workers.push({
                        id: w.id,
                        accountId: accId,
                        accountName: accName,
                        created_on: w.created_on,
                        modified_on: w.modified_on
                    }));
                } catch (error) {
                    console.warn(`[ExportAll] Workers 加载失败 (${accName}):`, error);
                }
                try {
                    const list = await this.cfApiFetch(`/accounts/${accId}/pages/projects`, account.token);
                    (list || []).forEach(p => pages.push({
                        name: p.name,
                        subdomain: p.subdomain || p.name,
                        url: `https://${p.subdomain || p.name}.pages.dev`,
                        accountId: accId,
                        accountName: accName,
                        created_on: p.created_on
                    }));
                } catch (error) {
                    console.warn(`[ExportAll] Pages 加载失败 (${accName}):`, error);
                }
                return { workers, pages };
            }));
            snapshot.workers = resourceGroups.flatMap(g => g.workers);
            snapshot.pages = resourceGroups.flatMap(g => g.pages);
    
            // 5. 精简 zones 输出字段
            snapshot.zones = snapshot.zones.map(z => ({
                id: z.id,
                name: z.name,
                status: z.status,
                accountId: z.account?.id,
                accountName: z.account?.name
            }));
    
            snapshot.summary = {
                zones: snapshot.zones.length,
                dnsRecords: snapshot.dnsRecords.length,
                workers: snapshot.workers.length,
                pages: snapshot.pages.length
            };
    
            return snapshot;
        }
,

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
,

        hideDeployModal() {
            document.getElementById('deployModal').style.display = 'none';
            this.deployingType = null;
            this.deployingItem = null;
        }
,

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
,

        async handleWorkerScriptUpload(e) {
            const file = e.target.files[0];
            if (!file) return;
    
            const reader = new FileReader();
            reader.onload = (event) => {
                document.getElementById('workerScriptContent').value = event.target.result;
            };
            reader.readAsText(file);
        }
,

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
,

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
,

        confirmDeletePages(page) {
            if (confirm(`确定要删除 Pages 项目 "${page.name}" 吗？此操作不可撤销。`)) {
                this.deletePagesProject(page);
            }
        }
,

        confirmDeleteWorker(worker) {
            if (confirm(`确定要删除 Worker "${worker.id}" 吗？此操作不可撤销。`)) {
                this.deleteWorker(worker);
            }
        }
,

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
,

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
,

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
,
});
