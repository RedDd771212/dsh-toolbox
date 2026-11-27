# 工具箱 · 实现细节

## 结构

```
dsh-toolbox/
├─ package.json           # dsh.bundle.patch → cordis.patch.yml；dsh.client.platform = web
├─ cordis.patch.yml       # 只负责把插件插进宿主，不写配置
├─ icon.svg
├─ locale/{zh,en}.json    # 插件市场卡片用的标题/描述
├─ lib/index.js           # Host 半边：配置、目录、进程、HTTP 路由、agent 工具
├─ lib/define-tool.js     # defineTool 的兜底实现（宿主包在 app.asar 里，插件解析不到）
└─ lib/client.js          # Client 半边：面板 UI（手写，无构建）
```

## 通信：HTTP 路由，不是 @Remote

Host 侧的 `@Remote` 依赖 typert 代码生成产物，手写 JS 插件接不进去。所以：

- Host：`ctx.inject(['webServer'], scoped => scoped.effect(() => scoped.webServer.register({ kind:'prefix', path:'/api/toolbox', auth:'required', handler }), '...: routes'))`
  - **`webServer` 不能写进 `export const inject`** —— 它是可选能力，写进去会让没有 webServer 的部署整个插件起不来；而且宿主可能比插件晚挂载，必须在 `ctx.inject` 回调里注册。
- Client：同源 `fetch('/api/toolbox' + path)`，鉴权由内核在 handler 之前完成，不用自己带 token。

路由表：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 配置 + 运行中进程 + 配置文件路径 |
| GET | `/dirs?path=` | 列一层子目录与文件（各最多 400 条，超出在 `more` 里报数量） |
| POST | `/config` | 整份配置替换（会 sanitize） |
| POST | `/launch` | `{toolId, file?, cwd?, extraArgs?}` |
| POST | `/stop` | `{toolId?}` / `{name?}` / `{pid?}` |
| POST | `/pick-tool` | `{file}` → 该用哪个工具（最长扩展名匹配） |
| POST | `/reveal` | 用资源管理器打开路径 |

## 进程模型

- `spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })` + `unref()`：
  工具是独立进程，宿主重启/面板关掉都不会把它带走。
- 工具箱只登记**自己启动的** pid（`spawned: Map<pid, record>`），`exit` 时自动清理；
  另外用 `process.kill(pid, 0)` 判断存活，防止僵尸条目。
- 关闭走 `taskkill /PID <pid> /T /F`（连子进程一起收）。
- 按名字关闭：先 `tasklist /FI "IMAGENAME eq <exe>" /FO CSV /NH` 拿 pid，再逐个杀。
  **只允许配置里登记过的 exe 名** —— 模型乱传一个名字不能杀掉无关进程。
- 按 pid 关闭：**只接受工具箱登记过的 pid**；手动开的进程要走 `name`。这两条是防误杀的唯一闸门。

## 配置

`%USERPROFILE%\.dsh\toolbox.json`（`$DSH_HOME` 优先）。

读：文件不存在 / 坏掉 → 退回默认值（空白工具清单 + 一个「通用」分类），面板不白屏。
写：先写 `.tmp` 再覆盖，避免写一半留下半个 JSON。
`sanitizeConfig` 会丢掉没有 `root` 的项目、没有 `exe`/`url`/`name` 的工具，保证 id 唯一、分类名唯一；工具的 `categoryId` 找不到对应分类时落到最后一个分类。
迁移：`migrateConfig` 只**补**结构，不动用户改过的字段。v1→v2 曾补过网页内置条目（0.5.0 起内置清单清空，这段空转）；v3 曾引入字符串 group；v4 把 group 升级成 `categories` 实体（老的自定义组名会变成新分类）；改名前叫 `dsh-fsmod-workbench`，配置文件 `fsmod-workbench.json` 会被自动搬成 `toolbox.json`（旧文件留 `.bak`）。

字段：

```jsonc
{
  "version": 4,
  "activeModId": "mod_x",
  "mods": [{ "id": "mod_x", "name": "我的项目", "root": "D:\\work\\project" }],
  "categories": [{ "id": "cat-general", "name": "通用" }],
  "tools": [{
    "id": "notepadpp",
    "name": "Notepad++",
    "categoryId": "cat-general",
    "exe": "C:\\Program Files\\Notepad++\\notepad++.exe",
    "url": "",               // 非空 = 网页条目，点一下用默认浏览器打开（此时忽略 exe/exts/openWithFile）
    "args": "",              // 额外参数，支持引号
    "cwd": "",               // 留空 = exe 所在目录（带文件时 = 文件所在目录）
    "exts": [".txt", ".hks"],
    "openWithFile": true,    // false = 纯 GUI，不接受文件参数
    "note": "兜底编辑器"
  }]
}
```

## 扩展名路由

`pickToolForFile` 取「后缀最长的那个」。所以 `.emevd.js` 会赢过 `.js`，
不然专门工具永远抢不过兜底的文本编辑器。想改优先级，改扩展名列表即可（不用改代码）。

## 侧栏入口是怎么出现的

`sidebar.panellist` 是 UI 自己用 `registerFactory` 声明的动态 children（不是静态 Slot 树里的项）。
往里 `register({ name:'sidebar.panellist', id:'toolbox', order, label }, IconComponent)` 之后，
ui-sidebar 会 `entriesOfSlot` 把它变成一个面板按钮，点击 → `ctx.layout.selectPanel(id)`。
`main` 那个 keyed Slot 用同名的 `key` 注册，两边对上就成。

图标组件收到的 props 只有 `{ size, active }`。

## 右侧栏「开始」页入口

「开始」页的卡片不是 Slot，而是**右侧栏 tab type definition 里的 `guide` 数组**：

```js
ctx.get('sidebarRightTabs').register({
  id: 'toolbox', kind: 'toolbox', title: () => '工具箱',
  guide: [{ id: 'toolbox', order: 30, title: () => '工具箱', description: () => '…' }],
});
```

- `sidebarRightTabs` 是 `ctx.reflect.provide` 出来的服务，**不在 inspect 的 Service 目录里**，只能 `ctx.get` 或 `ctx.inject(['sidebarRightTabs'], …)` 拿；
- 点卡片时 owner 会 `openTab(kind)`，于是要再注册 `sidebar.right.pane.tab`（body）与 `sidebar.right.pane.tab.title`；
- 这两个是 **keyed slot**，注册字段是 `key`，而 key 的语义是「tab type definition 的 **id**」——写成别的 id 会静默不生效（inspect 里看不到 occupant）。

## 样式

只用 `--dsw-alias-*` token（`bg-base/bg-layer-1/bg-layer-2/bg-overlay`、`border-l1/l2`、
`label-primary/secondary`、`brand-primary`、`state-*`）。所有颜色 token 都同时定义了亮/暗两套，
所以面板自动跟随主题，不要写死颜色。

## 排错

- 面板点了没反应 → 打开 DevTools 看 `dsh-toolbox` 是否有 `loaded without registering`（说明 client.js 的 `id` 和包名不一致）。
- 面板能开但一直「正在读取配置…」→ Host 半边没挂上：看 `plugin-error.log`，常见原因是 `apply` 抛错。
- 工具点了不启动 → 先看卡片 hover 出来的标题（就是配置里的 exe 路径），确认文件存在；再看失败提示里的 `启动后立刻退出（exit N）`。
- 关不掉 → 提示「不在配置的工具清单里」说明名字没登记；把手动开的那个 exe 加进工具清单即可。
