/**
 * Cloudflare Manager - 备注编辑器
 *
 * 负责备注编辑弹窗、Markdown 工具栏、预览切换、本地图片上传，
 * 以及列表中的备注按钮与悬浮提示。
 * 备注数据本身见 js/remarks-data.js。
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
