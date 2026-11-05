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

    // Cloudflare Tunnel (cfd_tunnel) API Methods
    /**
     * 判断扫描到的 Cloudflare 账户（{id, name}）是否属于当前选中的本地账号。
     * 只做保守匹配：id 精确命中，或名称互相包含（邮箱简写互认）。
     * 一旦误判，就会拿别的账号的凭据去请求，结果当前账号的 Tunnel 读不出来。
     */
    isCurrentAccountCfAccount(account) {
        if (!account || !this.currentAccount) return false;
        const current = this.currentAccount;
        if (current.cfAccountId && current.cfAccountId === account.id) return true;

        const localName = (current.name || '').toLowerCase().trim();
        const cfName = (account.name || '').toLowerCase().trim();
        if (!localName || !cfName) return false;
        if (cfName === localName || cfName.includes(localName)) return true;
        if (cfName.length >= 4 && localName.includes(cfName)) return true;
        // 邮箱简写互认：liubohn69 与 liubohn69@gmail.com 视为同一账号
        const localShort = localName.split('@')[0];
        return localShort.length >= 4 && cfName.includes(localShort);
    }
    ,

    /**
     * 根据扫描到的 Cloudflare 账户（{id, name}）找到本地已保存的账户。
     * 本地账户使用 Date.now() 生成的 id，因此只能通过 cfAccountId 精确匹配；
     * 名称匹配仅作兜底，且要求名称足够具体，避免模糊匹配把账户串到别的账号。
     */
    findStoredAccount(cfId, cfName) {
        const list = this.accounts || [];
        if (!list.length) return null;
        let acc = list.find(a => a.cfAccountId && a.cfAccountId === cfId);
        if (acc) return acc;
        const lowerName = (cfName || '').toLowerCase().trim();
        if (!lowerName || lowerName.length < 4) return null;
        acc = list.find(a => {
            const n = (a.name || '').toLowerCase().trim();
            if (!n) return false;
            return n === lowerName || (n.length >= 4 && (n.includes(lowerName) || lowerName.includes(n)));
        });
        return acc || null;
    }
    ,

    /**
     * 解析某个 Cloudflare 账户可用的 Tunnel 凭据候选（按优先级排列）。
     *
     * 关键原则：当前选中账号自己的 Cloudflare 账户，只使用它自己的凭据，
     * 不借用其它本地账号的 Token —— 否则会用别的凭据去请求当前账号的账户，
     * 请求被 403 拒绝后被静默忽略，表现为「当前账号的 Tunnel 看不到」。
     *
     * 优先级：
     * 1. 当前账号单独保存的 Tunnel Token（tunnelApiTokenByAccount[本地账户id]）
     * 2. 当前账号自身的 API Token
     * 3. 该 CF 账户明确归属于另一个本地账号时，才借用那个账号的凭据
     * 4. 全局 Tunnel Token（兼容旧配置）
     */
    getTunnelTokenCandidates(account) {
        const current = this.currentAccount;
        const candidates = [];
        const push = (token) => {
            const value = (token || '').trim();
            if (value && !candidates.includes(value)) candidates.push(value);
        };

        // 1 / 2：当前账号自己的凭据
        push(current?.id ? this.tunnelApiTokenByAccount?.[current.id] : '');
        push(current?.token);

        // 3：只有当这个 CF 账户不属于当前账号时，才允许借用归属账号的凭据
        if (!this.isCurrentAccountCfAccount(account)) {
            const stored = this.findStoredAccount(account?.id, account?.name);
            if (stored && stored.id !== current?.id) {
                push(this.tunnelApiTokenByAccount?.[stored.id]);
                push(stored.token);
            }
        }

        // 4：全局 Tunnel Token（兼容旧配置）
        push(this.tunnelApiToken);

        return candidates;
    }
    ,

    async loadTunnels(force = false) {
        if (this.isLoadingTunnels) return;
        this.isLoadingTunnels = true;
        this.tunnelLoadErrors = [];
        console.log(`[Tunnels] Loading tunnels using Deep-Scan mode...`);

        try {
            // Collect accounts from multiple sources (same as Workers / Pages)
            const uniqueAccounts = new Map();

            // 1. From /accounts API（当前账号 Token 可见的全部 Cloudflare 账户）
            try {
                const apiAccounts = await this.apiRequest('/accounts?per_page=50');
                if (Array.isArray(apiAccounts)) {
                    apiAccounts.forEach(acc => {
                        uniqueAccounts.set(acc.id, { id: acc.id, name: acc.name });
                    });
                }
            } catch (e) {
                console.warn('Failed to fetch /accounts for tunnels:', e);
            }

            // 2. From Zones
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

            // 3. 当前账号兜底（/accounts 失败或未返回时）
            try {
                const currentId = await this.getAccountId();
                if (currentId && !uniqueAccounts.has(currentId)) {
                    uniqueAccounts.set(currentId, { id: currentId, name: this.currentAccount?.name || 'Primary' });
                }
            } catch (e) { }

            const allAccounts = Array.from(uniqueAccounts.values());

            if (allAccounts.length === 0) {
                throw new Error('无法发现任何 Cloudflare 账户。请检查 API Token 权限。');
            }

            // 3.5 记录当前账号对应的 Cloudflare 账户 id。
            //     仅在名称确实匹配时写入，避免把别的账户记到自己头上（会导致后续请求用错凭据）。
            const primary = allAccounts.find(a => this.isCurrentAccountCfAccount(a));
            if (primary && this.currentAccount && this.currentAccount.cfAccountId !== primary.id) {
                this.currentAccount.cfAccountId = primary.id;
                this.saveAccounts();
            }

            console.log(`Scanning ${allAccounts.length} accounts for Tunnels`);

            // Parallel fetch：分页拉取每个账号下的 Tunnel（排除已删除）
            // 每个账号按「候选凭据」依次尝试，任一凭据成功即采用；
            // 全部失败时记录错误，交给 UI 提示（不再静默丢弃）。
            const perPage = 50;
            const promises = allAccounts.map(async account => {
                const candidates = this.getTunnelTokenCandidates(account);
                let lastError = null;
                for (const token of candidates) {
                    try {
                        const tunnels = [];
                        let page = 1;
                        while (page <= 20) { // 安全上限：最多 1000 条
                            const response = await this.cfApiFetch(
                                `/accounts/${account.id}/cfd_tunnel?is_deleted=false&per_page=${perPage}&page=${page}`,
                                token
                            );
                            const batch = response || [];
                            tunnels.push(...batch);
                            if (batch.length < perPage) break;
                            page++;
                        }
                        return {
                            tunnels: tunnels.map(tunnel => ({
                                ...tunnel,
                                account: {
                                    id: account.id,
                                    name: account.name
                                }
                            })),
                            error: null
                        };
                    } catch (err) {
                        lastError = err;
                    }
                }
                console.warn(`Failed to fetch tunnels for account ${account.name} (${account.id}):`, lastError);
                return {
                    tunnels: [],
                    error: {
                        name: account.name,
                        id: account.id,
                        message: lastError?.message || '未知错误',
                        isCurrent: this.isCurrentAccountCfAccount(account)
                    }
                };
            });

            const results = await Promise.all(promises);
            const newTunnels = results.flatMap(r => r.tunnels);
            const loadErrors = results.map(r => r.error).filter(Boolean);
            this.tunnelLoadErrors = loadErrors;

            if (force || newTunnels.length > 0 || this.tunnels.length === 0) {
                this.tunnels = newTunnels;
                // Sort: created_at descending (from newest to oldest)
                this.tunnels.sort((a, b) => {
                    const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
                    const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
                    return dateB - dateA;
                });
            } else {
                console.log('[Tunnels] Retaining cached tunnels due to empty fetch result (possibly offline).');
            }

            console.log(`[Tunnels] Total tunnels loaded: ${this.tunnels.length} from ${allAccounts.length} accounts.`);

            // 记录本次数据所属账号，供切账号时判断是否需要重新拉取
            this.tunnelsLoadedForAccountId = this.currentAccount?.id || '';

            await this.saveResourceCache(); // 保存缓存

            this.isLoadingTunnels = false;
            return this.tunnels;
        } catch (error) {
            this.isLoadingTunnels = false;
            console.error('loadTunnels error:', error);
            throw error;
        }
    }
    ,

    confirmDeleteTunnel(tunnel) {
        if (confirm(`确定要删除 Tunnel "${tunnel.name || tunnel.id}" 吗？此操作不可撤销。`)) {
            this.deleteTunnel(tunnel);
        }
    }
    ,

    async deleteTunnel(tunnel) {
        const accountId = tunnel.account?.id;
        if (!accountId) {
            this.showToast('未找到关联的账户 ID', 'error');
            return;
        }
        try {
            this.showLoading();
            const token = this.getTunnelTokenCandidates(tunnel.account)[0] || '';
            await this.cfApiFetch(
                `/accounts/${accountId}/cfd_tunnel/${tunnel.id}`,
                token,
                'DELETE'
            );
            this.showToast(`Tunnel "${tunnel.name || tunnel.id}" 已删除`, 'success');
            await this.loadTunnelsAndRender();
        } catch (error) {
            console.error('Delete tunnel failed:', error);
            const noPerm = error.status === 401 || error.status === 403 ||
                /not authorized|permission|insufficient|forbidden/i.test(error.message || '');
            this.showToast(noPerm
                ? '删除失败：该账户的 API Token 缺少 Cloudflare Tunnel:Edit 权限。请为该账户（或按账号设置的 Tunnel Token）添加 Account - Cloudflare Tunnel:Edit'
                : `删除失败: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }
    ,

    // 加载所有域名和所有记录
    async loadAllZonesAndRecords() {
        const tabsSection = document.getElementById('tabsSection');
        const recordsList = document.getElementById('recordsList');

        try {
            // 1. 呈现 Tab，并按当前标签只显示对应区块
            //    （避免在 Workers/Pages/Tunnel/笔记 标签下切换账号时，DNS 区与当前区同时出现）
            if (tabsSection) tabsSection.style.display = 'block';
            const tabSections = {
                dns: 'dnsSection',
                workers: 'workersSection',
                pages: 'pagesSection',
                tunnels: 'tunnelsSection',
                notes: 'notesSection'
            };
            Object.entries(tabSections).forEach(([tab, id]) => {
                const el = document.getElementById(id);
                if (el) el.style.display = tab === this.currentTab ? 'block' : 'none';
            });

            // 2. 状态重置（同时清空各列表搜索框，避免 UI 与查询条件不一致）
            this.selectedZoneId = '';
            this.searchQuery = '';
            this.workersSearchQuery = '';
            this.pagesSearchQuery = '';
            this.remarksSearchQuery = '';
            this.remarksTypeFilter = '';
            const searchInput = document.getElementById('searchInput');
            if (searchInput) searchInput.value = '';
            const clearSearchBtn = document.getElementById('clearSearchBtn');
            if (clearSearchBtn) clearSearchBtn.style.display = 'none';
            ['workersSearchInput', 'pagesSearchInput', 'remarksSearchInput', 'tunnelsSearchInput'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            const remarksTypeFilterEl = document.getElementById('remarksTypeFilter');
            if (remarksTypeFilterEl) remarksTypeFilterEl.value = '';

            // 3. 数据重置，但先尝试加载缓存以保持界面不为空白
            this.zones = [];
            this.allRecords = [];
            this.workers = [];
            this.pages = [];
            this.tunnels = [];
            this.tunnelsSearchQuery = '';
            this.tunnelsLoadedForAccountId = ''; // 标记 Tunnel 数据待重新拉取（避免显示上一个账号的缓存）
            this.tunnelLoadErrors = [];
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
                    // 仅保留仍存在的域名的折叠状态，避免每次刷新都把用户展开的全收起
                    const zoneNames = new Set(this.zones.map(z => z.name));
                    this.collapsedZones = new Set([...this.collapsedZones].filter(n => zoneNames.has(n)));
                    const recordCountEl = document.getElementById('recordCount');
                    if (recordCountEl) recordCountEl.textContent = `${this.allRecords.length} 条记录`;

                    this.updateNotesStatCard();
                    this.renderAllRecords();

                    // 最后触发一次 UI 颜色等更新 (因为此时 accountId 肯定拿到了)
                    this.updateHeaderAccountUI();

                    // 自动加载当前 Tab 对应的数据
                    if (this.currentTab === 'workers') this.loadWorkersAndRender();
                    if (this.currentTab === 'pages') this.loadPagesAndRender();
                    if (this.currentTab === 'tunnels') this.loadTunnelsAndRender();
                    if (this.currentTab === 'notes') this.loadRemarksAndRender();

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
    async cfApiFetch(endpoint, token, method = 'GET', body = null) {
        const url = `https://api.cloudflare.com/client/v4${endpoint}`;
        const options = {
            method,
            headers: { 'Authorization': `Bearer ${(token || '').trim()}` }
        };
        if (body !== null && body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const data = await response.json();
        if (!data.success) {
            const err = new Error(data.errors?.[0]?.message || '请求失败');
            err.status = response.status;
            throw err;
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
