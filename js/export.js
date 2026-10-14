/**
 * Cloudflare Manager - 数据导出/导入方法
 *
 * 以 Object.assign 方式挂载到 CloudflareManager.prototype，
 * 运行时才解析 this 调用，故加载顺序不影响执行；
 * 本文件须在 popup.js（类定义）之后加载。
 */

Object.assign(CloudflareManager.prototype, {
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
            const filename = `Cloudflare Manager-all_dns_records_${new Date().toISOString().slice(0, 10)}.csv`;
    
            const result = await this.downloadCSV(csv, filename);
        }
,

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
            const dateTime = this.formatExportDateTime(now);
            const filename = `Cloudflare Manager-${safeAccountName}-${dateTime}.json`;
            await this.downloadJSON(allData, filename);
            // 注意：使用 a 标签下载无法准确知道用户是否完成保存，所以不显示完成消息
        }
,

        /**
         * 导出所有账户的数据（右上角「导出所有账户」按钮）
         */
        async exportAllAccountsData() {
            if (!this.accounts || this.accounts.length === 0) {
                this.showToast('没有可导出的账户', 'warning');
                return;
            }
    
            const confirmed = confirm(
                `即将导出全部 ${this.accounts.length} 个账户的数据。\n\n` +
                `包含：域名、DNS 记录、Workers、Pages 以及全部资源备注。\n` +
                `导出时需要逐一向 Cloudflare 请求，账户较多时耗时较长，请耐心等待。\n\n是否继续？`
            );
            if (!confirmed) return;
    
            this.showLoading();
            this.showToast(`正在导出 ${this.accounts.length} 个账户的数据...`, 'info');
    
            const allData = {
                exportDate: new Date().toISOString(),
                scope: 'all-accounts',
                accountCount: this.accounts.length,
                accounts: []
            };
    
            const failed = [];
    
            // 账户之间串行处理，避免触发 Cloudflare API 限流
            for (let i = 0; i < this.accounts.length; i++) {
                const account = this.accounts[i];
                this.showToast(`正在导出 (${i + 1}/${this.accounts.length})：${account.name}`, 'info');
                try {
                    allData.accounts.push(await this.fetchAccountSnapshot(account));
                } catch (error) {
                    console.error(`[ExportAll] 账户「${account.name}」导出失败:`, error);
                    failed.push(account.name);
                    allData.accounts.push({
                        id: account.id,
                        name: account.name,
                        error: error.message,
                        zones: [],
                        dnsRecords: [],
                        workers: [],
                        pages: []
                    });
                }
            }
    
            // 备注为全局共享（不按账户隔离），单独汇总一份
            allData.remarks = Object.entries(this.remarks || {})
                .filter(([_, v]) => v.content)
                .map(([key, value]) => ({ key, ...value }));
    
            // 总计
            allData.summary = allData.accounts.reduce((acc, a) => {
                acc.zones += a.zones?.length || 0;
                acc.dnsRecords += a.dnsRecords?.length || 0;
                acc.workers += a.workers?.length || 0;
                acc.pages += a.pages?.length || 0;
                return acc;
            }, { zones: 0, dnsRecords: 0, workers: 0, pages: 0, remarks: allData.remarks.length });
    
            const now = new Date();
            const dateTime = this.formatExportDateTime(now);
            const filename = `Cloudflare Manager-all-accounts-${dateTime}.json`;
    
            await this.downloadJSON(allData, filename);
            this.hideLoading();
    
            if (failed.length > 0) {
                this.showToast(`导出完成，但 ${failed.length} 个账户失败：${failed.join('、')}`, 'warning');
            } else {
                this.showToast(`已导出 ${this.accounts.length} 个账户的数据`, 'success');
            }
        }
,

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
            const filename = `Cloudflare Manager-workers_${new Date().toISOString().slice(0, 10)}.csv`;
    
            const result = await this.downloadCSV(csv, filename);
        }
,

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
            const filename = `Cloudflare Manager-pages_${new Date().toISOString().slice(0, 10)}.csv`;
    
            const result = await this.downloadCSV(csv, filename);
        }
,

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
            const dateTime = this.formatExportDateTime(now);
    
            const filename = `Cloudflare Manager-${safeAccountName}-remark-${dateTime}.json`;
            const result = await this.downloadJSON(data, filename);
        }
,

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
,

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
,

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
,

        /**
         * 导出账号配置 (包含 Token，需谨慎)
         */
        async exportAccountsConfig() {
            if (!this.accounts || this.accounts.length === 0) {
                this.showToast('没有可导出的账号', 'warning');
                return;
            }
    
            // 获取 GitHub 配置
            let githubConfig = null;
            try {
                const result = await chrome.storage.local.get('githubSyncConfig');
                githubConfig = result.githubSyncConfig;
            } catch (e) {
                console.warn('Failed to fetch github config for export', e);
            }
    
            // Show confirmation dialog due to sensitive data
            const confirmed = confirm('⚠️ 安全警告 ⚠️\n\n导出的文件包含您的：\n1. Cloudflare API Token\n2. GitHub Personal Access Token (如果有)\n\n这些都是敏感信息。导出后请务必妥善保管，不要发送给不可信的人。\n\n是否继续？');
            if (!confirmed) return;
    
            const data = {
                exportDate: new Date().toISOString(),
                isAccountConfig: true, // Marker for validation
                version: '1.1',
                accounts: this.accounts.map(acc => ({
                    id: acc.id, // Usually the email or unique ID
                    name: acc.name,
                    token: acc.token
                    // Do not export color or internal state if not needed, but token is key
                })),
                githubSyncConfig: githubConfig // Include GitHub config
            };
    
            const filename = `Cloudflare Manager-accounts-config-${new Date().toISOString().slice(0, 10)}.json`;
            await this.downloadJSON(data, filename);
            this.showToast(`账号配置已导出至 ${filename}`, 'success');
        }
,

        /**
         * 导入账号配置
         */
        async importAccountsConfig(file) {
            if (!file) return;
    
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const content = e.target.result;
                    const data = JSON.parse(content);
    
                    // Basic validation
                    if (!data.isAccountConfig || !Array.isArray(data.accounts)) {
                        throw new Error('无效的账号配置文件');
                    }
    
                    if (data.accounts.length === 0) {
                        this.showToast('配置文件中没有账号', 'warning');
                        return;
                    }
    
                    // 导入 GitHub 配置
                    if (data.githubSyncConfig) {
                        try {
                            // 验证 token 格式是否基本正确，避免导入损坏的配置
                            if (data.githubSyncConfig.token && data.githubSyncConfig.repo) {
                                await chrome.storage.local.set({ githubSyncConfig: data.githubSyncConfig });
                                // 重新加载配置以更新 UI
                                if (this.githubSync) {
                                    await this.githubSync.loadConfig();
                                }
                                console.log('[Import] GitHub config imported successfully');
                            }
                        } catch (err) {
                            console.error('[Import] Failed to import GitHub config:', err);
                            this.showToast('GitHub 配置导入失败', 'error');
                        }
                    }
    
                    let addedCount = 0;
                    let updatedCount = 0;
    
                    // Merge strategy: Unique by Token
                    const currentTokens = new Set(this.accounts.map(a => a.token));
    
                    // Clone current accounts to avoid mutation issues during loop
                    const newAccounts = [...this.accounts];
    
                    for (const acc of data.accounts) {
                        if (!acc.token || !acc.name) continue; // Skip invalid entries
    
                        if (currentTokens.has(acc.token)) {
                            // Token exists: Update name if changed? Or skip?
                            // Let's skip to be safe, or maybe update the name if the user renamed it externally
                            // For simplicity, let's treat duplicate token as "Already exists"
                            // But we can check if ID matches but token differs (unlikely for simple structure)
                            continue;
                        } else {
                            // New account
                            newAccounts.push({
                                id: acc.id || acc.name, // Fallback ID
                                name: acc.name,
                                token: acc.token
                            });
                            addedCount++;
                        }
                    }
    
                    if (addedCount > 0) {
                        await this.saveAccounts(newAccounts);
                        this.accounts = newAccounts; // Update runtime state
                        this.renderAccountList(); // Refresh UI
                        this.showToast(`成功导入 ${addedCount} 个新账号` + (data.githubSyncConfig ? ' 及 GitHub 配置' : ''), 'success');
                    } else if (data.githubSyncConfig) {
                        this.showToast('已更新 GitHub 配置 (账号未变更)', 'success');
                    } else {
                        this.showToast('没有发现新账号', 'info');
                    }
    
                } catch (error) {
                    console.error('Import error:', error);
                    this.showToast('导入失败: ' + error.message, 'error');
                }
            };
            reader.readAsText(file);
        }
,
});
