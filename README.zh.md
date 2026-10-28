# dsh-plugin-onenote

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里读取**你亲自勾选**的
Microsoft OneNote 笔记本。

登录一次，勾选允许本助手读取的笔记本，其余笔记本对它完全不可见。白名单在插件内部、在发出任何
Microsoft Graph 请求之前强制校验，所以即使某篇笔记试图诱导模型去读别的笔记本，它也没有可用的接口。

> English: [README.md](./README.md)

## 界面

设置卡片（设置 → 插件 → OneNote）是唯一可以登录、修改可读笔记本的地方：

```
┌ OneNote ──────────────────────────────────────────────┐
│ 已连接                                                │
│ 已登录：you@example.com                [ 退出登录 ]    │
├───────────────────────────────────────────────────────┤
│ 可读笔记本                        [ 刷新列表 ]         │
│ 只有勾选的笔记本可以被列出、搜索和读取。               │
│   [x] 工作                             默认            │
│   [ ] 团队 wiki                        共享            │
│   [ ] 日记                                            │
│                          已授权 1 / 3   [ 全部取消 ]  │
│                                                [保存] │
└───────────────────────────────────────────────────────┘
```

## 工具

助手只能使用 4 个**只读**工具。它们都无法登录、登出或修改白名单——那些是设置卡片里的用户操作。

| 工具 | 作用 |
| --- | --- |
| `onenote_status` | 报告登录账号与当前可读的笔记本。 |
| `onenote_list_pages` | 浏览已授权笔记本 → 分区 → 页面。 |
| `onenote_search` | 先匹配页面标题，再匹配最近页面的开头正文。 |
| `onenote_read_page` | 把一页读成 Markdown（标题、列表、表格、链接、代码）。 |

## 安装

```bash
# 通过插件管理器（推荐）
dsh plugin install hestudio-community/dsh-plugin-onenote

# 或从 npm 安装
dsh plugin install dsh-plugin-onenote
```

安装后打开 **设置 → 插件 → OneNote** 登录。

## Azure 应用注册

插件内置了一个公共 Client ID，开箱即可使用。如果要用自己的应用注册（除个人使用外建议这样做），
大约两分钟即可完成，无需付费订阅：

1. 打开 [应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
   → **新注册**。
2. **名称**：任意，例如 `DSH-OneNote`。
3. **受支持的账户类型**：选择 *任何组织目录中的帐户和个人 Microsoft 帐户*。如果所有用户都在同一租户，
   可以选单租户。
4. **重定向 URI**：留空——设备码流程不需要。
5. 点击 **注册**，复制 **应用程序(客户端) ID**。
6. **身份验证 → 高级设置 → 允许公共客户端流** = **是**，然后 **保存**。不做这一步会报
   `unauthorized_client`。
7. **API 权限 → 添加权限 → Microsoft Graph → 委托的权限**：
   - `Notes.Read` —— 读取用户的笔记本
   - `offline_access` —— 让会话在轮次之间保持有效
   - `User.Read` —— 显示登录账号名
8. 个人账户不需要客户端密码，也不需要管理员同意。工作账户可能需要管理员授权一次。

然后在自己的 patch 层里指向你的应用：

```yaml
# ~/.dsh/cordis.patch.yml（对所有 profile 生效）或某个 profile 的 cordis.patch.yml
- id: onenote
  name: 'dsh-plugin-onenote'
  config:
    clientId: 00000000-0000-0000-0000-000000000000
    tenant: common
```

`config` 会整体替换该行的配置，所以要把需要的字段全部写全。

## 配置项

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `clientId` | 内置公共应用 | Azure 应用程序(客户端) ID。 |
| `tenant` | `common` | 租户 ID 或域名。`common` 同时接受工作与个人账户。 |
| `maxPagesPerList` | `100` | `onenote_list_pages` 的默认页面上限。 |
| `maxPageChars` | `60000` | `onenote_read_page` 的默认 Markdown 上限。 |

## 状态存放位置

`$DSH_HOME/onenote/`（通常是 `~/.dsh/onenote/`），权限 `0600`：

| 文件 | 内容 |
| --- | --- |
| `tokens.json` | 访问令牌与刷新令牌。 |
| `signin.json` | 进行中的设备码尝试，刷新页面后可以接着等同一个码。 |
| `settings.json` | 笔记本白名单。 |

删除整个目录即可重置。不会往你的工作区写任何文件。

## 隐私边界如何实现

1. 白名单就是 `settings.json` 里的一组笔记本 ID。
2. 每次读取都**先解析所属笔记本**——从页面、分区或笔记本本身取——再校验白名单，最后才取正文。
   猜一个分区 ID 无法绕过。
3. 助手工具无法写白名单。只有设置卡片能写，且只通过 `POST /api/onenote/notebooks`。
4. 系统提示会告诉模型哪些笔记本可读，并说明其余笔记本按设计不可读。

## 关于 Graph API 的说明

- OneNote 不支持仅应用身份认证，因此必须有登录用户；`Notes.Read` 属于委托权限。
- `GET /me/onenote/pages?$search=` 已于 2024 年下线
  （[官方公告](https://devblogs.microsoft.com/microsoft365dev/onenote-get-pagessearch-api-deprecation)），
  所以搜索改为：按已授权笔记本列出页面元数据、本地匹配标题，再读取最近修改页面的开头正文。
  这样开销可控，且永远不会越出白名单。
- 页面正文是 OneNote 特有的 HTML；`src/parser.js` 不依赖第三方库把它转成 Markdown，且从不下载媒体文件。

## 开发

```bash
npm test          # 97 个测试，不需要网络，也不需要宿主
npm run pack:check
```

测试通过 Node 模块钩子替换了 `@deepseek-ai/dsh-tools`（由宿主提供的 peer），所以裸仓库即可运行。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
