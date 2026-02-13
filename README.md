# Cloudflare Manager

专业的 Cloudflare 资源管理工具（浏览器扩展）。旨在为您提供比官方控制台更高效、更直观的 DNS 记录管理、Workers/Pages 运维及资源标注体验。

## 🚀 主要功能

-   **多账户管理**：支持保存多个 Cloudflare API Token，一键切换不同账户，无需反复登录。
-   **全能 DNS 记录管理**：
    -   一键展开/折叠所有域名的 DNS 记录。
    -   支持 A、AAAA、CNAME、MX、TXT、SRV、NS 等多种常用记录类型的增加、删除、修改。
    -   内置强大的实时搜索与域名过滤功能。
-   **一站式运维**：
    -   **Workers**：查看项目状态、快速部署脚本、导出配置。
    -   **Pages**：监控构建进度、一键触发生产环境部署。
-   **增强型资源备注**：
    -   为域名、DNS 记录、Workers、Pages 添加详细备注。
    -   **Markdown 支持**：支持加粗、列表、链接、表格甚至本地图片上传。
    -   **项目别名**：支持为资源设置本地显示别名，方便直观识别。
-   **GitHub 云端同步**：通过 GitHub 仓库备份账号备注与配置数据，支持跨设备自动/手动同步。
-   **数据导入导出**：支持将所有统计数据、DNS 记录、备注信息及 **账号配置**（含 API Token，需谨慎）导出为 JSON。

## 🛠️ 技术特点

-   **轻量且安全**：基于 Chrome **Manifest V3** 标准开发，性能卓越且符合现代安全规范。
-   **无后端的隐私保护**：所有请求直接通过您的浏览器发往 Cloudflare 官方 API，不经过任何第三方中转服务器，确保 API Token 安全。
-   **高效 UI 交互**：采用现代化前端设计，提供 Toast 消息提示、模态框交互及响应式布局。
-   **自动化增强**：内置 Content Script，支持从扩展内一键跳转至官网并自动聚焦重命名输入框等自动化操作。

## 📖 使用指南

### 1. 安装扩展
1. 将本项目代码下载至本地。
2. 打开 Chrome 浏览器，进入 `chrome://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本项目根目录。

### 2. 配置 Cloudflare 账户
您需要一个具有相应权限的 API Token 才能使用：
1. **获取 Token**：登录 Cloudflare 官网 -> My Profile -> API Tokens -> Create Token。
2. **建议权限配置**：
    - `Zone - Zone:Read`
    - `Zone - DNS:Edit`
    - `Account - Workers Scripts:Edit`
    - `Account - Cloudflare Pages:Edit`
3. **添加账户**：在扩展侧边栏点击“添加账户”，输入账户名称和 Token 即可。

### 3. GitHub 数据同步（可选）
1. 创建一个私有 GitHub 仓库（建议）。
2. 生成具有 `repo` 权限的 GitHub Personal Access Token。
     GitHub Token 生成步骤（修复权限不足问题）

     您的私有仓库只能通过Classic Token访问，且必须勾选repo权限。步骤如下：

     登录 GitHub，点击右上角头像 -> Settings。
     左侧菜单拉到底，选择 Developer settings。
     点击 Personal access tokens -> Tokens (classic)。
     (注意：不要选 Fine-grained tokens，选 Classic 更稳妥)
     点击 Generate new token -> Generate new token (classic)。
     Note: 随便填，如 Cloudflare Extension。
     Expiration: 建议选 No expiration (永不过期)。
     Select scopes (关键步骤):
     必须勾选第一个复选框：repo (Full control of private repositories)。
     如果没勾这个，扩展程序就看不到您的私有仓库，从而报错 404。
     点击底部 Generate token。
     复制显示出来的 Token（以 ghp_ 开头）。
     最后一步： 回到扩展程序 -> Settings -> 将新的 Token 粘贴进去 -> Save Settings -> 点击 "从 GitHub 拉取"。
3. 在侧边栏“GitHub 同步”区域配置 Token、仓库路径（用户名/仓库名）及分支。
4. 开启“定时同步”可确保本地备注与配置定期备份到云端。



## 📝 贡献与反馈
如果您在使用过程中遇到任何问题或有功能建议，欢迎提交 Issue。
