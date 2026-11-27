/**
 * dsh-toolbox — Host 半边。
 *
 * 只做四件事：
 *   1. 在 `$DSH_HOME/toolbox.json` 存一份「项目（工作区）+ 工具清单」配置；
 *   2. 列目录（面板的树列目录 + 文件，点文件按扩展名挑工具打开）；
 *   3. 启动 / 关闭工具进程（关闭是本插件存在的核心原因：很多编辑器开着文件就会自动保存）；
 *   4. 把这四件事暴露成 HTTP 路由（面板用）+ 一个 agent 工具（模型用）。
 *
 * 为什么是 HTTP 路由而不是 `@Remote`：Host 侧的 typert 体系要靠代码生成产物，
 * 手写 JS 插件接不进去；`webServer.register` + 同源 `fetch` 是宿主自带能力，
 * 也能跟着 GUI 的端口走（不用另外开端口）。
 *
 * 两条必须守住的纪律：
 *   - `webServer` 是可选能力，**不能写进 `export const inject`**，只能 `ctx.inject([...])` 按需取，
 *     否则没有 webServer 的部署里整个插件都起不来；
 *   - 按进程名关工具时，只允许关**配置里登记过的 exe**，避免模型（或误操作）去杀别的东西。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// `@deepseek-ai/dsh-tools` 被打包进宿主的 app.asar，插件从自己的 node_modules 解析不到，
// `import()` 会抛 → 整条工具注册链会静默断掉。兜底版把 author spec 编译成宿主认的 JSON Schema
// （只少运行时参数校验），见 define-tool.js 的说明。
import { defineToolCompat } from './define-tool.js';

/** 插件标识（和 package.json 的 name 一致）。 */
const PLUGIN_ID = 'dsh-toolbox';
/** 面板和 Host 之间的接口前缀。Client 半边写的是同一串。 */
const ROUTE_PREFIX = '/api/toolbox';
/** 配置文件名（放在 DSH_HOME 下，profile 无关）。 */
const CONFIG_FILENAME = 'toolbox.json';
/** agent 工具名。 */
const TOOL_NAME = 'toolbox';

const VERSION = '0.5.0';

/**
 * 配置结构版本。
 * 1：只有本地工具（exe）。
 * 2：多了一类「网页工具」（url）。
 * 3：工具带分组标签（字符串）。
 * 4：分组升级成 categories 实体（tools[].categoryId）。
 * 读到旧版本时会在 loadConfig 里迁移，只补结构、不动用户已经改过的工具。
 */
const CONFIG_VERSION = 4;

/** 日志。宿主没有统一 logger 时用 console；前缀保证能在日志里一眼挑出来。 */
function log(...args) {
  try {
    console.log(`[${PLUGIN_ID}]`, ...args);
  } catch {
    /* 日志不能把插件弄挂 */
  }
}

/** DSH_HOME：优先环境变量，退回 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return join(homedir(), '.dsh');
}

function configPath() {
  return join(dshHome(), CONFIG_FILENAME);
}

/** 改名前叫 dsh-fsmod-workbench，配置文件在 ~/.dsh/fsmod-workbench.json；见到就搬过来。 */
const LEGACY_CONFIG_FILENAME = 'fsmod-workbench.json';

/**
 * 把旧配置文件搬到新名字：只搬一次，旧文件留一份 .bak。
 * 返回搬完后的路径（没得搬就返回 null）。
 */
function adoptLegacyConfig() {
  const next = configPath();
  if (existsSync(next)) return null;
  const legacy = join(dshHome(), LEGACY_CONFIG_FILENAME);
  if (!existsSync(legacy)) return null;
  try {
    const text = readFileSync(legacy, 'utf8');
    writeFileSync(next, text, 'utf8');
    writeFileSync(`${legacy}.bak`, text, 'utf8');
    rmSync(legacy, { force: true });
    log(`已把旧配置 ${LEGACY_CONFIG_FILENAME} 搬成 ${CONFIG_FILENAME}（旧文件留了 .bak）`);
    return next;
  } catch (e) {
    log(`搬旧配置失败（继续用默认值）：${e?.message ?? e}`);
    return null;
  }
}

/** 随机 id（够用即可，不需要密码学强度）。 */
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- 默认配置 ----------

/**
 * 内置工具清单 —— 故意留空。
 *
 * 工具是「这台机器上装了什么」的私事，插件不预置任何一条：新装打开就是空白，
 * 到面板的「设置 → 工具」里自己登记（先建分类，再把工具加进分类）。
 * 想让某个配置文件带上现成一套，就按下面的字段往 tools 数组里写：
 *
 *   id      稳定标识，用过之后别改（关进程、按扩展名找工具都靠它）
 *   name    显示名
 *   categoryId  挂在哪个分类下（分类见 builtinCategories / config.categories）
 *   exe     可执行文件绝对路径（网页类留空）
 *   url     非空 = 网页条目，点一下用默认浏览器打开（此时忽略 exe/exts/openWithFile）
 *   args    启动参数（追加在**文件参数之前**）；支持引号
 *   cwd     工作目录；留空则用 exe 所在目录（带文件时用文件所在目录）
 *   exts    关联扩展名（小写带点），用于「打开某个文件时该用谁」
 *   openWithFile  是否接受「文件路径」作为最后一个参数（纯 GUI 程序不吃这个）
 *   note    给人和模型看的一句话说明（例如「改 bin 前先关掉它」）
 */
function builtinTools() {
  return [];
}

/** 内置分类。id 固定，工具靠 id 挂上去；改名不会搬家。 */
function builtinCategories() {
  return [{ id: 'cat-general', name: '通用' }];
}

/** 按分类聚合工具（保持分类列表顺序，categoryId 失效的落到「未分类」）。 */
function groupTools(categories, tools) {
  const known = new Map((categories ?? []).map((c) => [c.id, c.name]));
  const buckets = new Map();
  for (const category of categories ?? []) buckets.set(category.name, []);
  const orphan = [];
  for (const tool of tools ?? []) {
    const name = known.get(tool.categoryId);
    if (name === undefined) {
      orphan.push(tool);
      continue;
    }
    buckets.get(name).push(tool);
  }
  const result = [];
  for (const [name, list] of buckets) {
    if (list.length) result.push([name, list]);
  }
  if (orphan.length) result.push(['未分类', orphan]);
  return result;
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    activeModId: null,
    mods: [],
    categories: builtinCategories(),
    tools: builtinTools(),
  };
}

// ---------- 配置读写 ----------

/** 把任意输入洗成一份合法配置（宁可丢字段，也不要让面板读到半截数据）。 */
function sanitizeConfig(raw) {
  const base = defaultConfig();
  const input = raw && typeof raw === 'object' ? raw : {};

  const mods = Array.isArray(input.mods) ? input.mods : [];
  const cleanMods = [];
  const seenModIds = new Set();
  for (const item of mods) {
    if (!item || typeof item !== 'object') continue;
    const root = typeof item.root === 'string' ? item.root.trim() : '';
    if (!root) continue;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : newId('mod');
    while (seenModIds.has(id)) id = newId('mod');
    seenModIds.add(id);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : basename(root) || '未命名 MOD';
    cleanMods.push({ id, name, root });
  }

  // 分类：id 唯一、名字唯一（同名会让人分不清），工具只能挂在存在的分类上。
  const rawCategories = Array.isArray(input.categories) && input.categories.length
    ? input.categories
    : base.categories;
  const cleanCategories = [];
  const seenCategoryIds = new Set();
  const seenCategoryNames = new Set();
  for (const item of rawCategories) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    if (seenCategoryNames.has(name)) continue;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : newId('cat');
    while (seenCategoryIds.has(id)) id = newId('cat');
    seenCategoryIds.add(id);
    seenCategoryNames.add(name);
    cleanCategories.push({ id, name });
  }
  // 一个分类都不剩的话，至少留一个，不然工具没地方挂。
  if (!cleanCategories.length) cleanCategories.push({ id: newId('cat'), name: '未分类' });
  const categoryIds = new Set(cleanCategories.map((c) => c.id));

  const tools = Array.isArray(input.tools) ? input.tools : base.tools;
  const cleanTools = [];
  const seenToolIds = new Set();
  for (const item of tools) {
    if (!item || typeof item !== 'object') continue;
    const exe = typeof item.exe === 'string' ? item.exe.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
    // 一条工具要么有 exe（本地程序），要么有 url（网页）；两样都没有就没意义。
    if (!name || (!exe && !url)) continue;
    let id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : newId('tool');
    while (seenToolIds.has(id)) id = newId('tool');
    seenToolIds.add(id);
    const exts = Array.isArray(item.exts)
      ? item.exts
          .map((e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''))
          .filter((e) => e.startsWith('.'))
      : [];
    const categoryId =
      typeof item.categoryId === 'string' && categoryIds.has(item.categoryId.trim())
        ? item.categoryId.trim()
        : cleanCategories[cleanCategories.length - 1].id;
    cleanTools.push({
      id,
      name,
      categoryId,
      exe: url ? '' : exe,
      url,
      args: typeof item.args === 'string' ? item.args : '',
      cwd: typeof item.cwd === 'string' ? item.cwd.trim() : '',
      exts: url ? [] : exts,
      openWithFile: url ? false : item.openWithFile !== false,
      note: typeof item.note === 'string' ? item.note : '',
    });
  }

  const activeModId =
    typeof input.activeModId === 'string' && cleanMods.some((m) => m.id === input.activeModId)
      ? input.activeModId
      : cleanMods[0]?.id ?? null;

  // 版本号照原样带出去（不能在这里直接标成最新版），
  // 否则 migrateConfig 会以为已经迁移过，新增的内置条目就永远补不进来。
  const fromVersion = Number(input.version) || 1;

  return {
    version: Math.min(fromVersion, CONFIG_VERSION),
    activeModId,
    mods: cleanMods,
    categories: cleanCategories,
    tools: cleanTools,
  };
}

/**
 * 把旧配置升到当前版本：只**补**新增的结构，不动用户已经改过的工具。
 * 迁移后立刻落盘一次，免得每次都要重算。
 */
function migrateConfig(config) {
  const from = Number(config.version) || 1;
  if (from >= CONFIG_VERSION) return config;
  const next = { ...config, tools: config.tools.slice() };

  if (from < 2) {
    // v2 时这里补过内置网页条目；0.5.0 起内置清单清空，这段只保留语义（循环空转）。
    const haveIds = new Set(next.tools.map((t) => t.id));
    for (const builtin of builtinTools()) {
      if (!builtin.url) continue;
      if (haveIds.has(builtin.id)) continue;
      next.tools.push(builtin);
      haveIds.add(builtin.id);
    }
  }

  if (from < 3) {
    // v3：工具加分组标签。内置工具按内置分类名填，自定义工具保留自己的组名。
    // （这一版还是字符串，v4 才会转成 categories 实体。）
    const builtinCategoryOf = new Map(builtinTools().map((t) => [t.id, t.categoryId]));
    const categoryNameOf = new Map(builtinCategories().map((c) => [c.id, c.name]));
    next.tools = next.tools.map((tool) => ({
      ...tool,
      group:
        categoryNameOf.get(builtinCategoryOf.get(tool.id)) ??
        (tool.group && tool.group !== '通用' ? tool.group : '通用'),
    }));
  }

  if (from < 4) {
    // v4：分组名升级成真正的分类实体（categories + tools[].categoryId）。
    // 老配置里 group 是个自由字符串：先按内置分类打底，再把自定义组名补成新分类。
    const categories = builtinCategories();
    const nameToId = new Map(categories.map((c) => [c.name, c.id]));
    const builtinCategoryOf = new Map(builtinTools().map((t) => [t.id, t.categoryId]));
    const legacyGroupOf = new Map((config.tools ?? []).map((t) => [t.id, t.group]));
    for (const tool of next.tools) {
      const groupName = String(legacyGroupOf.get(tool.id) ?? '').trim();
      if (!groupName || nameToId.has(groupName)) continue;
      const id = `cat-${categories.length + 1}-${groupName.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'x'}`;
      categories.push({ id, name: groupName });
      nameToId.set(groupName, id);
    }
    next.categories = categories;
    next.tools = next.tools.map((tool) => {
      const legacyGroup = String(legacyGroupOf.get(tool.id) ?? '').trim();
      const categoryId =
        (legacyGroup && nameToId.get(legacyGroup)) ||
        builtinCategoryOf.get(tool.id) ||
        nameToId.get('通用') ||
        categories[0].id;
      const { group: _drop, ...rest } = tool;
      return { ...rest, categoryId };
    });
    delete next.recentFiles;
  }

  next.version = CONFIG_VERSION;
  return next;
}

/** 读配置。文件不存在 / 坏掉都退回默认值（不让面板白屏）。 */
function loadConfig() {
  adoptLegacyConfig();
  const path = configPath();
  try {
    if (!existsSync(path)) return defaultConfig();
    const text = readFileSync(path, 'utf8');
    const clean = sanitizeConfig(JSON.parse(text));
    const migrated = migrateConfig(clean);
    if (migrated !== clean) {
      // 迁移是幂等的：写不进去也不算错，下次读还会再补。
      try {
        writeFileSync(path, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8');
      } catch (e) {
        log(`迁移后写配置失败（不影响使用）：${e?.message ?? e}`);
      }
    }
    return migrated;
  } catch (e) {
    log(`读取配置失败，退回默认值：${e?.message ?? e}`);
    return defaultConfig();
  }
}

/** 写配置。先写临时文件再改名，避免写一半断电留下半个 JSON。 */
function saveConfig(config) {
  const path = configPath();
  const clean = sanitizeConfig(config);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    writeFileSync(path, readFileSync(tmp, 'utf8'), 'utf8');
  } catch (e) {
    throw new Error(`保存配置失败：${e?.message ?? e}`);
  }
  return clean;
}

// ---------- 目录列举 ----------

/** 不参与展示的目录名：系统重建的、以及各种隐藏缓存。 */
const SKIP_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git']);

/**
 * 列一个目录下的**子目录和文件**。
 * 文件也列出来，点一下就能按扩展名挑工具打开（比手动粘路径快）。
 * 单层最多各 400 条，超出的只在 `more` 里报个数——MOD 目录动辄几千个文件，
 * 全列出来面板会卡、也会把配置请求撑爆。
 */
const MAX_ENTRIES_PER_DIR = 400;

function listDirs(rawPath) {
  const target = typeof rawPath === 'string' && rawPath.trim() ? rawPath.trim() : '';
  if (!target) throw new Error('缺少 path 参数');
  let st;
  try {
    st = statSync(target);
  } catch (e) {
    throw new Error(`目录不存在或无法访问（${e?.code ?? 'stat 失败'}）：${target}`);
  }
  if (!st.isDirectory()) throw new Error(`不是一个目录：${target}`);

  let entries;
  try {
    entries = readdirSync(resolve(target), { withFileTypes: true });
  } catch (e) {
    throw new Error(`读取目录失败（${e?.code ?? 'readdir 失败'}）：${target}`);
  }

  const base = resolve(target);
  const dirs = [];
  const files = [];
  let moreDirs = 0;
  let moreFiles = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(base, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (dirs.length >= MAX_ENTRIES_PER_DIR) {
        moreDirs += 1;
        continue;
      }
      dirs.push({ name: entry.name, path: full });
    } else if (entry.isFile()) {
      if (files.length >= MAX_ENTRIES_PER_DIR) {
        moreFiles += 1;
        continue;
      }
      files.push({ name: entry.name, path: full, ext: extname(entry.name).toLowerCase() });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return {
    path: base,
    parent: dirname(base),
    dirs,
    files,
    more: moreDirs || moreFiles ? { dirs: moreDirs, files: moreFiles } : null,
  };
}

// ---------- 进程管理 ----------

/**
 * 工具箱自己启动的进程登记表：pid → 记录。
 * 只登记我们拉起来的，关的时候可以连子进程一起收（taskkill /T）。
 */
const spawned = new Map();

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在，只是不归我们管
    return e?.code === 'EPERM';
  }
}

/** 把「参数文本」拆成数组，支持单双引号（路径里有空格时必须靠引号）。 */
function parseArgs(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** 跑一个短命命令并收输出（tasklist / taskkill 用）。 */
function runCapture(command, args) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code, stdout, stderr });
    };
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (e) {
      resolvePromise({ code: -1, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      stderr += String(e?.message ?? e);
      done(-1);
    });
    child.on('close', (code) => done(code ?? 0));
  });
}

/** 按镜像名查当前所有 pid（手动开的工具也能抓到）。 */
async function pidsOfImage(imageName) {
  const name = String(imageName ?? '').trim();
  if (!name) return [];
  const { code, stdout } = await runCapture('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH']);
  if (code !== 0) return [];
  const pids = [];
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('"')) continue;
    const cells = text.split('","').map((c) => c.replace(/^"|"$/g, ''));
    // 列：Image Name, PID, Session Name, Session#, Mem Usage
    const pid = Number.parseInt(cells[1] ?? '', 10);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/** 强杀一棵进程树（/T 连子进程，/F 不商量）。 */
async function killTree(pid) {
  const { code, stderr } = await runCapture('taskkill', ['/PID', String(pid), '/T', '/F']);
  return { pid, ok: code === 0, detail: code === 0 ? '已结束' : stderr.trim() || `taskkill 退出码 ${code}` };
}

function findConfigTool(config, key) {
  if (!key) return undefined;
  const wanted = String(key).trim().toLowerCase();
  if (!wanted) return undefined;
  return (
    config.tools.find((t) => t.id.toLowerCase() === wanted)
    ?? config.tools.find((t) => t.name.toLowerCase() === wanted)
    ?? config.tools.find((t) => basename(t.exe).toLowerCase() === wanted)
    ?? config.tools.find((t) => basename(t.exe, extname(t.exe)).toLowerCase() === wanted)
    ?? config.tools.find((t) => t.name.toLowerCase().includes(wanted))
  );
}

/** 「这个文件该用哪个工具打开」：最长匹配的扩展名赢（.emevd.js 会压过 .js）。 */
function pickToolForFile(config, filePath) {
  const lower = String(filePath ?? '').toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const tool of config.tools) {
    if (!tool.openWithFile) continue;
    for (const ext of tool.exts) {
      if (lower.endsWith(ext) && ext.length > bestLen) {
        best = tool;
        bestLen = ext.length;
      }
    }
  }
  return best;
}

function runningList() {
  const items = [];
  for (const [pid, record] of spawned) {
    if (!isAlive(pid)) {
      spawned.delete(pid);
      continue;
    }
    items.push({ ...record, pid });
  }
  items.sort((a, b) => a.startedAt - b.startedAt);
  return items;
}

/**
 * 启动一个工具。
 * @param {{toolId?: string, tool?: string, file?: string, cwd?: string, extraArgs?: string}} input
 */
/**
 * 用系统默认浏览器打开一个网址。
 * 走 rundll32 的 url 协议处理器：不依赖 shell、不开控制台窗口，
 * 也不会像 `cmd /c start` 那样被引号吃出多余窗口。
 */
function openUrl(tool) {
  const url = tool.url.trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`「${tool.name}」的网址不合法：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`「${tool.name}」只支持 http / https 链接，当前是 ${parsed.protocol}`);
  }
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  log(`打开网页 ${tool.name} → ${parsed.href}`);
  return { kind: 'web', toolId: tool.id, toolName: tool.name, url: parsed.href, pid: null };
}

async function launchTool(config, input) {
  const key = input.toolId ?? input.tool ?? input.name;
  const tool = findConfigTool(config, key);
  if (!tool) throw new Error(`找不到工具「${key ?? ''}」。可用的工具：${config.tools.map((t) => t.name).join('、') || '（空）'}`);

  // 网页类：没有进程可管，直接交给默认浏览器。
  if (tool.url) {
    const opened = openUrl(tool);
    return { ...opened, startedAt: Date.now(), isWeb: true };
  }

  const exe = tool.exe;
  if (!existsSync(exe)) throw new Error(`工具「${tool.name}」的 exe 不存在：${exe}（在面板设置里改一下路径）`);
  try {
    if (!statSync(exe).isFile()) throw new Error(`不是一个文件：${exe}`);
  } catch (e) {
    throw new Error(`无法访问工具「${tool.name}」的 exe：${e?.message ?? e}`);
  }

  const file = typeof input.file === 'string' && input.file.trim() ? input.file.trim() : '';
  if (file) {
    if (!tool.openWithFile) throw new Error(`工具「${tool.name}」不接受文件参数（openWithFile=false），要么先启动它，要么换个工具。`);
    if (!existsSync(file)) throw new Error(`文件不存在：${file}`);
    try {
      if (!statSync(file).isFile()) throw new Error(`不是一个文件：${file}`);
    } catch (e) {
      throw new Error(`无法访问文件：${e?.message ?? e}`);
    }
  }

  const args = parseArgs(tool.args);
  if (typeof input.extraArgs === 'string' && input.extraArgs.trim()) args.push(...parseArgs(input.extraArgs));
  if (file) args.push(file);

  const cwd = tool.cwd || (file ? dirname(file) : dirname(exe));
  if (!existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`);

  let child;
  try {
    // detached + stdio ignore：宿主退出/重启不会连带把工具关掉。
    child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  } catch (e) {
    throw new Error(`启动失败：${e?.message ?? e}`);
  }
  // spawn 的失败有一半是异步报的（ENOENT / EACCES），等一个微任务再看
  await new Promise((r) => setTimeout(r, 120));
  if (child.exitCode !== null && child.exitCode !== 0) {
    throw new Error(`启动后立刻退出（exit ${child.exitCode}）：${exe}`);
  }
  child.unref?.();

  const pid = child.pid;
  if (!pid) throw new Error(`启动失败：拿不到进程号（${exe}）`);

  const record = {
    toolId: tool.id,
    toolName: tool.name,
    exe,
    image: basename(exe),
    file: file || null,
    cwd,
    startedAt: Date.now(),
  };
  spawned.set(pid, record);
  child.once('exit', () => {
    spawned.delete(pid);
  });
  log(`启动 ${tool.name}（pid ${pid}）${file ? ` → ${file}` : ''}`);

  return { pid, ...record, args };
}

/**
 * 关闭工具。
 * 三种指认方式，优先级：pid > name/image > tool。
 * `pid` 只接受工具箱登记过的（防误杀）；`name` 必须是配置里某个工具的 exe 名（防乱杀）。
 */
async function stopTool(config, input) {
  const results = [];

  // 1) 明确给了 pid
  if (input.pid !== undefined && input.pid !== null && input.pid !== '') {
    const pid = Number.parseInt(String(input.pid), 10);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid 不合法：${input.pid}`);
    const known = spawned.get(pid);
    const guard = config.tools.some((t) => known && basename(t.exe).toLowerCase() === basename(known.exe).toLowerCase());
    if (!known && !guard) {
      throw new Error(`pid ${pid} 不是工具箱启动的进程，拒绝按 pid 关闭（要关手动开的工具请用 name，例如 "notepad++.exe"）。`);
    }
    results.push(await killTree(pid));
    spawned.delete(pid);
    return { stopped: results, note: `已结束 pid ${pid}` };
  }

  // 2) 按镜像名（手动开的也能关）
  const imageInput = input.name ?? input.image;
  if (typeof imageInput === 'string' && imageInput.trim()) {
    const wanted = basename(imageInput.trim());
    const knownImages = config.tools.map((t) => basename(t.exe).toLowerCase());
    if (!knownImages.includes(wanted.toLowerCase())) {
      throw new Error(`「${wanted}」不在配置的工具清单里，拒绝按名字关闭。先到面板设置里登记这个工具。`);
    }
    const pids = await pidsOfImage(wanted);
    if (!pids.length) return { stopped: [], note: `没有正在运行的 ${wanted}` };
    for (const pid of pids) results.push(await killTree(pid));
    for (const pid of pids) spawned.delete(pid);
    return { stopped: results, note: `已结束 ${wanted} 的 ${results.length} 个进程` };
  }

  // 3) 按工具（关掉这个工具的所有运行中实例）
  const tool = findConfigTool(config, input.toolId ?? input.tool);
  if (!tool) throw new Error(`找不到工具「${input.toolId ?? input.tool ?? ''}」，也没给 pid / name。`);
  const image = basename(tool.exe);
  const pids = await pidsOfImage(image);
  if (!pids.length) return { stopped: [], note: `「${tool.name}」当前没有在运行` };
  for (const pid of pids) {
    results.push(await killTree(pid));
    spawned.delete(pid);
  }
  return { stopped: results, note: `已结束「${tool.name}」的 ${results.length} 个进程` };
}

// ---------- HTTP 路由 ----------

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体过大（>4MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e?.message ?? e}`));
      }
    });
    req.on('error', (e) => reject(e));
  });
}

/** state 载荷：面板每次操作后都用它回填，保证 UI 和 Host 配置不会漂。 */
function buildState() {
  const config = loadConfig();
  return {
    version: VERSION,
    config,
    running: runningList(),
    configPath: configPath(),
    platform: process.platform,
  };
}

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let route = url.pathname;
  if (route.startsWith(ROUTE_PREFIX)) route = route.slice(ROUTE_PREFIX.length);
  if (!route.startsWith('/')) route = `/${route}`;
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    if (method === 'GET' && (route === '/' || route === '/state')) {
      send(res, 200, buildState());
      return;
    }
    if (method === 'GET' && route === '/dirs') {
      send(res, 200, listDirs(url.searchParams.get('path') ?? ''));
      return;
    }
    if (method === 'POST' && route === '/config') {
      const body = await readJsonBody(req);
      const saved = saveConfig(body.config ?? body);
      send(res, 200, { config: saved, running: runningList(), configPath: configPath(), platform: process.platform, version: VERSION });
      return;
    }
    if (method === 'POST' && route === '/launch') {
      const body = await readJsonBody(req);
      const config = loadConfig();
      const started = await launchTool(config, body);
      send(res, 200, { started, running: runningList() });
      return;
    }
    if (method === 'POST' && route === '/stop') {
      const body = await readJsonBody(req);
      const config = loadConfig();
      const result = await stopTool(config, body);
      send(res, 200, { ...result, running: runningList() });
      return;
    }
    if (method === 'POST' && route === '/pick-tool') {
      // 「打开文件」路由：只算该用谁，不启动（面板先预览再点确认）
      const body = await readJsonBody(req);
      const config = loadConfig();
      const tool = pickToolForFile(config, body.file);
      send(res, 200, { tool: tool ? { id: tool.id, name: tool.name, exe: tool.exe } : null, file: body.file ?? null });
      return;
    }
    if (method === 'POST' && route === '/reveal') {
      const body = await readJsonBody(req);
      const target = typeof body.path === 'string' ? body.path.trim() : '';
      if (!target || !existsSync(target)) throw new Error(`路径不存在：${target}`);
      const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref?.();
      send(res, 200, { ok: true, path: target });
      return;
    }
    send(res, 404, { error: `未知接口 ${method} ${route}` });
  } catch (e) {
    send(res, 400, { error: String(e?.message ?? e) });
  }
}

// ---------- agent 工具 ----------

/** 工具的常驻说明。写清楚「什么时候该用我」，而不是罗列字段。 */
const TOOL_DESCRIPTION = [
  '工具箱：启动 / 关闭本机上登记过的工具程序（exe 或网页），并查看已登记的项目（工作区）目录。工具清单由用户在面板的「设置 → 工具」里自己登记，装好是空白的。',
  '',
  '**改文件前先关工具**：会自己盯着文件、自动保存的程序（比如各种编辑器 / 参数工具）开着时，直接改它占着的文件会被覆盖。',
  '所以「要改 regulation / param / bin」这类文件前，先 `action:"stop"` 把占着它的工具关掉，改完再 `action:"launch"` 叫回来。',
  '',
  'action 说明：',
  '- `status`（默认）：列出项目（工作区）、按分类分组的工具清单、当前正在运行的工具进程。',
  '- `launch`：启动工具。`tool` 填工具名或 id，可选 `file` 让工具直接打开这个文件（会校验扩展名是否归它），可选 `cwd`。清单里的**网页类条目**，`launch` 就是用默认浏览器打开那个站点。',
  '- `stop`：关闭工具。给 `name`（exe 名，例如 "notepad++.exe"）可以关掉**你手动开的**那个；给 `tool` 关掉该工具的所有进程；给 `pid` 关掉工具箱启动的某个进程。',
  '- `tools`：只看工具清单（分类 / 名字 / exe 或网址 / 关联扩展名）。',
  '- `mods`：只看项目（工作区）目录。',
  '- `open_dir`：在资源管理器里打开某个项目的根目录。',
].join('\n');

function toolSpec() {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    // 注意：parameters 是「属性名 → 值 schema」的映射，不是完整 JSON Schema。
    parameters: {
      action: {
        type: 'string',
        description: 'status（默认）| launch | stop | tools | mods | open_dir',
      },
      tool: {
        type: 'string',
        description: '工具名或 id（面板里登记时填的名字）。launch / stop 用。',
      },
      file: {
        type: 'string',
        description: 'launch 用：要工具直接打开的文件绝对路径（例如某个 .hks）。必须存在，且该工具要能吃文件。',
      },
      cwd: {
        type: 'string',
        description: 'launch 用：工作目录。省略时带文件则用文件所在目录，否则用 exe 所在目录。',
      },
      name: {
        type: 'string',
        description: 'stop 用：exe 文件名（例如 "notepad++.exe"），可以关掉手动启动的同类进程。',
      },
      pid: {
        type: 'number',
        description: 'stop 用：工具箱启动的进程号（status 里能看到）。',
      },
      mod: {
        type: 'string',
        description: 'open_dir 用：MOD 项目名字或 id。省略则用当前选中的那个。',
      },
    },
    // output 是必填的：defineTool 要靠它编译返回值 schema，并给宿主一个 render。
    // 只给模型看 text，结构化细节塞 meta。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          meta: { type: 'json' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }];
      },
    },
  };
}

/** 把任意返回值洗成 lossless JSON（宿主对 undefined / NaN / BigInt 零容忍）。 */
function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toLosslessJson(v);
  return out;
}

/** 三跳取 defineTool：宿主包 → 环境变量指定的路径 → 内置兜底。 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch {
    /* asar 里经常解析不到，继续下一跳 */
  }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(override).href);
      if (mod?.defineTool) return mod.defineTool;
    } catch {
      /* 路径写错不该让插件废掉 */
    }
  }
  return defineToolCompat;
}

/** 工具的 action 分发。UI 和模型走的是同一套 launchTool / stopTool，行为不会漂。 */
async function runToolAction(args) {
  const action = String(args?.action ?? 'status').toLowerCase();
  const config = loadConfig();

  if (action === 'status') {
    const running = runningList();
    return {
      text: [
        `项目（工作区）：${config.mods.length} 个${config.activeModId ? `（当前：${config.mods.find((m) => m.id === config.activeModId)?.name ?? config.activeModId}）` : ''}`,
        ...config.mods.map((m) => `  · ${m.name} → ${m.root}`),
        `工具：${config.tools.length} 个${config.tools.length ? '' : '（还没登记，去面板「设置 → 工具」里加：先建分类，再把 exe 或网址填进去）'}`,
        ...groupTools(config.categories, config.tools).flatMap(([group, tools]) => [
          `  [${group}]`,
          ...tools.map(
            (t) =>
              `    · ${t.name}（${t.url ? '网页' : basename(t.exe)}）${t.url ? ` → ${t.url}` : ''}${t.exts.length ? ` ← ${t.exts.join(' ')}` : ''}`,
          ),
        ]),
        `运行中：${running.length} 个`,
        ...running.map((p) => `  · pid ${p.pid} ${p.toolName}${p.file ? ` → ${p.file}` : ''}`),
      ].join('\n'),
      meta: { config, running },
    };
  }

  if (action === 'tools') {
    const lines = groupTools(config.categories, config.tools).flatMap(([group, tools]) =>
      tools.map(
        (t) =>
          `[${group}] ${t.name}\t${t.url || t.exe}\t${t.exts.join(',') || '（无）'}\t${t.url ? '网页' : t.openWithFile ? '可带文件' : '仅启动'}`,
      ),
    );
    return {
      text: lines.join('\n') || '（没有登记工具）',
      meta: { tools: config.tools },
    };
  }

  if (action === 'mods') {
    return {
      text: config.mods.map((m) => `${m.name}\t${m.root}${m.id === config.activeModId ? '\t（当前）' : ''}`).join('\n') || '（没有登记项目，到面板里添加）',
      meta: { mods: config.mods, activeModId: config.activeModId },
    };
  }

  if (action === 'launch') {
    const started = await launchTool(config, { tool: args.tool ?? args.toolId, file: args.file, cwd: args.cwd, extraArgs: args.args });
    if (started.isWeb) {
      return { text: `已用默认浏览器打开「${started.toolName}」：${started.url}`, meta: { started } };
    }
    return {
      text: `已启动「${started.toolName}」（pid ${started.pid}）${started.file ? `，打开文件 ${started.file}` : ''}。`,
      meta: { started, running: runningList() },
    };
  }

  if (action === 'stop') {
    const result = await stopTool(config, { tool: args.tool ?? args.toolId, name: args.name, pid: args.pid });
    return {
      text: `${result.note}${result.stopped.length ? `\n${result.stopped.map((r) => `  · pid ${r.pid} ${r.ok ? '已结束' : `失败：${r.detail}`}`).join('\n')}` : ''}`,
      meta: { ...result, running: runningList() },
    };
  }

  if (action === 'open_dir') {
    const wanted = args.mod ? String(args.mod) : config.activeModId;
    const mod = config.mods.find((m) => m.id === wanted || m.name === wanted) ?? config.mods[0];
    if (!mod) throw new Error('还没有登记任何项目');
    if (!existsSync(mod.root)) throw new Error(`MOD 目录不存在：${mod.root}`);
    const child = spawn('explorer.exe', [mod.root], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref?.();
    return { text: `已在资源管理器打开：${mod.root}`, meta: { mod } };
  }

  throw new Error(`未知 action: ${action}（可用 status / launch / stop / tools / mods / open_dir）`);
}

// ---------- 插件入口 ----------

/** cordis 入口。 */
export function apply(ctx) {
  const disposers = [];

  // 1) HTTP 路由（面板用）。webServer 是可选能力，必须按需 inject。
  try {
    ctx.inject(['webServer'], (scoped) => {
      scoped.effect(
        () =>
          scoped.webServer.register({
            kind: 'prefix',
            path: ROUTE_PREFIX,
            auth: 'required',
            handler: (req, res, peer) => handleRequest(req, res, peer),
          }),
        `${PLUGIN_ID}: routes`,
      );
    });
  } catch (e) {
    log(`注册 HTTP 路由失败：${e?.message ?? e}`);
  }

  // 2) agent 工具
  const registerTool = async () => {
    // 可选服务：ctx.get 在没声明 inject 时会 throw，属性访问在服务缺席时也会 throw，两边都包住。
    let tools = null;
    try {
      tools = ctx.get('tools');
    } catch { /* 落到属性访问 */ }
    if (!tools) {
      try {
        tools = ctx.tools ?? null;
      } catch { /* 没有这个服务 */ }
    }
    if (!tools || typeof tools.register !== 'function') {
      log('拿不到 tools 服务，跳过 agent 工具注册');
      return;
    }
    const defineTool = await loadDefineTool();
    const spec = toolSpec();
    const toolObj = {
      ...spec,
      async execute(args = {}, run = {}) {
        try {
          return toLosslessJson(await runToolAction(args ?? {}));
        } catch (e) {
          // 工具报错也让模型看到原因，而不是抛成一次失败的工具调用
          return toLosslessJson({ text: `操作失败：${String(e?.message ?? e)}`, meta: { ok: false } });
        }
      },
    };
    try {
      disposers.push(tools.register(defineTool(toolObj)));
      log(`已注册工具 ${TOOL_NAME}（v${VERSION}）`);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/already registered/i.test(msg)) throw e;
      log(`工具 ${TOOL_NAME} 已经注册过（${msg}），这一份不再重复注册`);
    }
  };

  registerTool().catch((e) => log(`注册工具失败：${e?.message ?? e}`));

  // 3) 卸载时收拾干净（工具进程**不**关：用户可能还想继续用）
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* 收不干净也不该炸 */
      }
    }
  };
}

export const name = PLUGIN_ID;
export const version = VERSION;
