/**
 * dsh-toolbox — Client 半边（Web GUI 面板）。
 *
 * 三块界面：
 *   - 侧栏入口：`sidebar.panellist` 里一个图标，点了切到 `main` 的 toolbox 面板；
 *   - 面板：上面切项目（工作区），左边目录树（目录 + 文件，点文件按扩展名打开），右边工具卡片（按分类分块），最下面是运行中的进程；
 *   - 设置抽屉：项目与工具清单的增删改（改完直接存 Host，不用重启）。
 *
 * 约定：这里没有构建步骤，全靠 shell 给的 `react`；所以
 *   - 不能用 JSX，一律 `h(...)`；
 *   - 不用 CSS 模块，样式全在下面的 CSS 字符串里，颜色只取 `--dsw-alias-*` token。
 */

window.__ModuleLoader__.load({
  id: 'dsh-toolbox',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    /** Host 路由前缀，和 lib/index.js 的 ROUTE_PREFIX 保持一致。 */
    const API = '/api/toolbox';

    /** apply 里拿到的 Client Context，供组件用（目录选择器、主题无关）。 */
    let appCtx = null;

    // ---------------------------------------------------------------- 请求

    async function api(path, options) {
      const { timeout = 20000, ...rest } = options ?? {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(API + path, {
          ...rest,
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const why = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
          throw new Error(why);
        }
        if (body === null) throw new Error('返回值不是 JSON');
        return body;
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（Host 没响应）');
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }

    const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload ?? {}) });

    // ---------------------------------------------------------------- 样式

    const CSS = `
.fm_root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.fm_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.fm_title{font-size:14px;font-weight:600;letter-spacing:.2px;margin-right:2px;white-space:nowrap}
.fm_sub{color:var(--dsw-alias-label-secondary);font-size:12px}
.fm_grow{flex:1 1 auto}
.fm_btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap;transition:border-color .12s,background .12s}
.fm_btn:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.fm_btn:disabled{opacity:.45;cursor:not-allowed}
/* 品牌色只用来描边：有的主题里 brand-primary 本身就接近白色，
   拿它当底色会出现「白底白字」。底色一律取 bg-layer，文字一律取 label。 */
.fm_btnPrimary{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.fm_btnPrimary:hover{background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-brand-primary)}
.fm_btnDanger{color:var(--dsw-alias-state-error-primary)}
.fm_btnDanger:hover{border-color:var(--dsw-alias-state-error-primary)}
.fm_select{height:28px;max-width:260px;padding:0 26px 0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 14px) 12px,calc(100% - 9px) 12px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.fm_input{height:28px;min-width:0;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;outline:none}
.fm_input:focus{border-color:var(--dsw-alias-brand-primary)}
.fm_body{flex:1 1 auto;display:flex;min-height:0}
.fm_side{width:272px;flex:0 0 272px;border-right:1px solid var(--dsw-alias-border-l1);overflow:auto;padding:6px 0 20px}
.fm_sideHead{display:flex;align-items:center;gap:6px;padding:4px 12px 8px;color:var(--dsw-alias-label-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.fm_main{flex:1 1 auto;overflow:auto;padding:12px 16px 40px;min-width:0}
.fm_nodeRow{display:flex;align-items:center;gap:4px;height:24px;padding-right:6px;border-radius:6px;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden}
.fm_nodeRow:hover{background:var(--dsw-alias-bg-layer-2)}
.fm_caret{width:12px;flex:0 0 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:9px}
.fm_dirName{overflow:hidden;text-overflow:ellipsis}
.fm_treeEmpty{padding:8px 14px;color:var(--dsw-alias-label-secondary);font-size:12px}
.fm_filter{height:24px;width:100%;margin:0 0 4px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:11px;outline:none;box-sizing:border-box}
.fm_filter:focus{border-color:var(--dsw-alias-brand-primary)}
.fm_fileRow{display:flex;align-items:center;gap:4px;height:22px;padding-right:6px;border-radius:6px;white-space:nowrap;overflow:hidden}
.fm_fileRow:hover{background:var(--dsw-alias-bg-layer-2)}
.fm_fileIcon{width:8px;flex:0 0 8px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:10px;opacity:.7}
.fm_fileName{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.fm_fileName:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}
.fm_filePick{flex:0 0 auto;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:0 4px;border-radius:4px;opacity:0}
.fm_fileRow:hover .fm_filePick{opacity:1}
.fm_filePick:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-overlay)}
.fm_pickRow{display:flex;flex-wrap:wrap;gap:4px;padding:3px 6px 6px 0}
.fm_pickChip{font-size:11px;padding:2px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}
.fm_pickChip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.fm_pickChipOn{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.fm_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:10px;margin-top:10px}
.fm_card{position:relative;display:flex;flex-direction:column;gap:3px;text-align:left;padding:11px 12px 10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer;transition:border-color .12s,transform .12s,background .12s}
.fm_card:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);transform:translateY(-1px)}
.fm_cardRunning{border-color:var(--dsw-alias-state-success-primary)}
.fm_cardName{font-size:13px;font-weight:600;padding-right:44px}
.fm_cardExts{font-size:11px;color:var(--dsw-alias-label-secondary);min-height:16px;word-break:break-all}
.fm_cardNote{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.82;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fm_cardBadge{position:absolute;top:9px;right:9px;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-state-success-primary);border:1px solid var(--dsw-alias-state-success-primary)}
.fm_cardWeb{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.fm_cardWebIcon{font-size:15px;line-height:1;margin-right:4px;opacity:.9}
.fm_cardUrl{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.fm_cardKill{position:absolute;bottom:8px;right:8px;font-size:10px;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.fm_cardKill:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.fm_section{display:flex;align-items:center;gap:8px;margin:16px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.fm_sectionRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 0}
.fm_chips{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.fm_chip{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}
.fm_chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.fm_chipOn{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.fm_cardGroup{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:400;vertical-align:1px}
.fm_section:after{content:'';flex:1 1 auto;height:1px;background:var(--dsw-alias-border-l1)}
.fm_runner{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1)}
.fm_runItem{display:inline-flex;align-items:center;gap:7px;font-size:12px;padding:2px 8px 2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);max-width:100%}
.fm_runDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:0 0 6px}
.fm_runPath{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px}
.fm_runKill{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:0 2px}
.fm_runKill:hover{color:var(--dsw-alias-state-error-primary)}
.fm_note{margin:10px 0 0;padding:7px 10px;border-radius:8px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.fm_noteErr{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.fm_noteOk{border-color:var(--dsw-alias-state-success-primary)}
.fm_empty{padding:24px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.fm_overlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.42);display:flex;justify-content:flex-end}
.fm_drawer{width:min(760px,94vw);height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2)}
.fm_drawerHead{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.fm_drawerBody{flex:1 1 auto;overflow:auto;padding:10px 16px 40px}
.fm_field{display:flex;flex-direction:column;gap:4px;margin:0 0 8px}
.fm_fieldLabel{font-size:11px;color:var(--dsw-alias-label-secondary)}
.fm_row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.fm_row3{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end}
.fm_itemCard{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;margin:0 0 10px;background:var(--dsw-alias-bg-layer-1)}
.fm_itemHead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.fm_itemName{font-size:12px;font-weight:600;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm_check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.fm_mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.fm_drawerFoot{flex:0 0 auto;display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.fm_drawerTabs{flex:0 0 auto;display:flex;gap:4px;padding:8px 16px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fm_tab{padding:6px 12px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.fm_tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.fm_tabOn{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.fm_catLayout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:12px;align-items:start}
.fm_catList{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.fm_catRow{display:flex;align-items:center;gap:4px;padding:2px;border-radius:6px;border:1px solid transparent}
.fm_catRowOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.fm_catName{flex:1 1 auto;font-size:12px}
.fm_catKill{flex:0 0 auto;width:20px;height:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1;padding:0}
.fm_catKill:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.fm_catKill:disabled{opacity:.3;cursor:not-allowed}
.fm_catBody{min-width:0}
.fm_toolRow{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:0 0 6px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.fm_toolRowOpen{border-color:var(--dsw-alias-brand-primary)}
.fm_toolRowHead{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary)}
.fm_toolRowHead:hover{background:var(--dsw-alias-bg-layer-2)}
.fm_caret{flex:0 0 auto;width:12px;color:var(--dsw-alias-label-secondary)}
.fm_toolRowName{flex:0 0 auto;font-weight:600;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm_toolRowMeta{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm_toolRowBody{padding:8px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.fm_rail{display:flex;flex-direction:column;gap:8px;padding:10px;height:100%;overflow:auto}
.fm_railHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fm_railList{display:flex;flex-direction:column;gap:2px}
.fm_railRow{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px;border:1px solid transparent}
.fm_railRow:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
.fm_railRowOn{background:var(--dsw-alias-bg-layer-2)}
.fm_railName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm_railGo{opacity:0;color:var(--dsw-alias-brand-primary);font-size:11px}
.fm_railRow:hover .fm_railGo{opacity:.9}
.fm_railStop{height:20px;padding:0 8px;font-size:11px;border-radius:5px;border:1px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary);cursor:pointer}
.fm_railFoot{font-size:11px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}
`;

    // ---------------------------------------------------------------- 小工具

    /** 从 Windows 路径里取最后一段名字。 */
    function baseName(path) {
      const text = String(path ?? '');
      const parts = text.split(/[\\/]+/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : text;
    }

    /** 取扩展名（含点，小写）。没有点返回空串。 */
    function extOf(name) {
      const text = String(name ?? '');
      const index = text.lastIndexOf('.');
      return index <= 0 ? '' : text.slice(index).toLowerCase();
    }

    /** 毫秒 → 人类能读的“已经开了多久”。 */
    function sinceText(startedAt) {
      const seconds = Math.max(0, Math.round((Date.now() - Number(startedAt || 0)) / 1000));
      if (seconds < 60) return `${seconds} 秒`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes} 分钟`;
      return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    }

    function cx(...names) {
      return names.filter(Boolean).join(' ');
    }

    // ---------------------------------------------------------------- 侧栏图标

    /** sidebar.panellist 的图标。props: { size, active }。 */
    function PanelIcon(props) {
      const size = Number(props?.size) || 20;
      const active = props?.active === true;
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        // 目录 + 扳手：一眼看出「工具箱对着一个项目目录」
        h('path', {
          d: 'M3.5 7.2c0-.9.7-1.6 1.6-1.6h3.4l1.7 2h7.7c.9 0 1.6.7 1.6 1.6v7.6c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6V7.2Z',
          stroke,
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M14.6 10.1a2.6 2.6 0 0 1 3.3 3.3l-2.9 2.9-1.7-1.7 1.3-1.4-1.4-1.4 1.4-1.7Z',
          fill: stroke,
          opacity: active ? 1 : 0.75,
        }),
      );
    }

    // ---------------------------------------------------------------- 目录树

    /**
     * 一个可折叠的目录节点。子目录按需加载（点开才拉），
     * 因为本机的 MOD 目录动辄上千个文件，一次全列会卡。
     *
     * 子项分两种：目录（点标题展开）和文件（点标题=按扩展名打开）。
     * 文件行右边的「⋯」把工具列表展开成一行小按钮，用来指定用谁打开。
     */
    function DirNode(props) {
      const { path, label, depth, tree, expanded, onToggle, tools, onOpenFile, onLaunchWith, filter } = props;
      const node = tree[path];
      const open = expanded[path] === true;
      const [picking, setPicking] = useState(null);

      const needle = String(filter ?? '').trim().toLowerCase();
      const allFiles = node?.files ?? [];
      const files = needle ? allFiles.filter((f) => f.name.toLowerCase().includes(needle)) : allFiles;
      const indent = `${4 + (depth + 1) * 13}px`;
      const childIndent = `${18 + depth * 13}px`;
      const isEmpty = node && !node.loading && !node.error
        && (node.dirs ?? []).length === 0 && allFiles.length === 0;

      return h(
        'div',
        null,
        h(
          'div',
          {
            className: 'fm_nodeRow',
            style: { paddingLeft: `${4 + depth * 13}px` },
            onClick: () => onToggle(path),
            title: path,
          },
          h('span', { className: 'fm_caret' }, open ? '▾' : '▸'),
          h('span', { className: 'fm_dirName' }, label),
          h('span', { className: 'fm_grow' }),
        ),
        open
          ? h(
              'div',
              null,
              node && node.loading ? h('div', { className: 'fm_treeEmpty' }, '加载中…') : null,
              node && node.error ? h('div', { className: 'fm_treeEmpty', style: { color: 'var(--dsw-alias-state-error-primary)' } }, node.error) : null,
              isEmpty ? h('div', { className: 'fm_treeEmpty', style: { paddingLeft: childIndent } }, '（空目录）') : null,
              (node?.dirs ?? []).map((child) =>
                h(DirNode, {
                  key: child.path,
                  path: child.path,
                  label: child.name,
                  depth: depth + 1,
                  tree,
                  expanded,
                  onToggle,
                  tools,
                  onOpenFile,
                  onLaunchWith,
                  filter,
                }),
              ),
              files.map((file) => {
                const isPicking = picking === file.path;
                return h(
                  React.Fragment,
                  { key: file.path },
                  h(
                    'div',
                    {
                      className: 'fm_fileRow',
                      style: { paddingLeft: childIndent },
                      title: `${file.path}\n点名字 = 按扩展名挑工具打开；右边的「⋯」自己指定`,
                    },
                    h('span', { className: 'fm_fileIcon' }, '·'),
                    h(
                      'span',
                      { className: 'fm_fileName', onClick: () => onOpenFile(file.path) },
                      file.name,
                    ),
                    h(
                      'button',
                      {
                        className: 'fm_filePick',
                        title: '换个工具打开',
                        onClick: (event) => {
                          event.stopPropagation();
                          setPicking(isPicking ? null : file.path);
                        },
                      },
                      '⋯',
                    ),
                  ),
                  isPicking
                    ? h(
                        'div',
                        { className: 'fm_pickRow', style: { paddingLeft: childIndent } },
                        (tools ?? []).map((tool) =>
                          h(
                            'button',
                            {
                              key: tool.id,
                              className: cx(
                                'fm_pickChip',
                                extOf(file.name) && tool.exts?.includes(extOf(file.name)) ? 'fm_pickChipOn' : '',
                              ),
                              title: tool.exe || tool.url,
                              onClick: () => {
                                setPicking(null);
                                onLaunchWith(tool, file.path);
                              },
                            },
                            tool.name,
                          ),
                        ),
                      )
                    : null,
                );
              }),
              node?.more
                ? h(
                    'div',
                    { className: 'fm_treeEmpty', style: { paddingLeft: childIndent } },
                    `（还有 ${node.more.files ?? 0} 个文件 / ${node.more.dirs ?? 0} 个目录没列出来，用过滤框缩小范围）`,
                  )
                : null,
            )
          : null,
      );
    }

    // ---------------------------------------------------------------- 设置抽屉

    /**
     * 设置抽屉。两个页签：
     * - 项目：每个项目是一个根目录，面板左边对它展示目录树。
     * - 工具：先选左边的分类，右边只显示这个分类下的工具（工具多的时候不至于翻半天）。
     * 改动都在本地 draft 上，点保存才回写 Host。
     */
    function SettingsDrawer(props) {
      const { draft, setDraft, onClose, onSave, saving, error } = props;
      const [tab, setTab] = useState('mods');
      const [categoryId, setCategoryId] = useState((draft.categories ?? [])[0]?.id ?? '');
      const [openToolId, setOpenToolId] = useState(null);

      const categories = draft.categories ?? [];
      // 选中的分类可能刚被删掉，随时回落到第一个，避免右侧空白
      const currentCategoryId = categories.some((c) => c.id === categoryId)
        ? categoryId
        : categories[0]?.id ?? '';

      const patchMod = (index, patch) => {
        const mods = draft.mods.slice();
        mods[index] = { ...mods[index], ...patch };
        setDraft({ ...draft, mods });
      };
      const removeMod = (index) => {
        const mods = draft.mods.filter((_, i) => i !== index);
        const activeModId = mods.some((m) => m.id === draft.activeModId) ? draft.activeModId : mods[0]?.id ?? null;
        setDraft({ ...draft, mods, activeModId });
      };
      const addMod = async () => {
        let dir = null;
        try {
          dir = await appCtx?.uiWorkspace?.pickDirectory?.();
        } catch (e) {
          dir = null;
        }
        const mods = draft.mods.slice();
        mods.push({
          id: `mod_${Date.now().toString(36)}`,
          name: dir ? baseName(dir) : `新 MOD ${mods.length + 1}`,
          root: dir ?? '',
        });
        setDraft({ ...draft, mods, activeModId: draft.activeModId ?? mods[mods.length - 1].id });
      };

      /** 给已有的 MOD 换根目录：同样走系统目录选择器。 */
      const pickModRoot = async (index) => {
        let dir = null;
        try {
          dir = await appCtx?.uiWorkspace?.pickDirectory?.();
        } catch (e) {
          dir = null;
        }
        if (!dir) return;
        patchMod(index, { root: dir });
      };

      const patchCategory = (index, patch) => {
        const next = categories.slice();
        next[index] = { ...next[index], ...patch };
        setDraft({ ...draft, categories: next });
      };
      const addCategory = () => {
        const id = `cat_${Date.now().toString(36)}`;
        setDraft({
          ...draft,
          categories: [...categories, { id, name: `新分类 ${categories.length + 1}` }],
        });
        setCategoryId(id);
      };
      /** 删分类：里面的工具不跟着丢，挪到剩下的第一个分类。 */
      const removeCategory = (index) => {
        if (categories.length <= 1) return;
        const target = categories.filter((_, i) => i !== index);
        const goneId = categories[index]?.id;
        const fallbackId = target[0].id;
        setDraft({
          ...draft,
          categories: target,
          tools: draft.tools.map((tool) => (tool.categoryId === goneId ? { ...tool, categoryId: fallbackId } : tool)),
        });
        if (categoryId === goneId) setCategoryId(fallbackId);
      };

      const patchTool = (index, patch) => {
        const tools = draft.tools.slice();
        tools[index] = { ...tools[index], ...patch };
        setDraft({ ...draft, tools });
      };
      const removeTool = (index) => {
        setDraft({ ...draft, tools: draft.tools.filter((_, i) => i !== index) });
      };
      const addTool = () => {
        const id = `tool_${Date.now().toString(36)}`;
        setDraft({
          ...draft,
          tools: [
            ...draft.tools,
            {
              id,
              name: '新工具',
              categoryId: currentCategoryId,
              exe: '',
              url: '',
              args: '',
              cwd: '',
              exts: [],
              openWithFile: true,
              note: '',
            },
          ],
        });
        setOpenToolId(id);
      };
      /** 网页类条目：不填 exe，只填 url，点卡片用默认浏览器打开。 */
      const addWebTool = () => {
        const id = `web_${Date.now().toString(36)}`;
        setDraft({
          ...draft,
          tools: [
            ...draft.tools,
            {
              id,
              name: '新网站',
              categoryId: currentCategoryId,
              exe: '',
              url: 'https://',
              args: '',
              cwd: '',
              exts: [],
              openWithFile: false,
              note: '',
            },
          ],
        });
        setOpenToolId(id);
      };

      // ---------------- 项目页
      const modsPane = h(
        'div',
        null,
        h('div', { className: 'fm_sub' }, '每个项目是一个根目录，面板左边会对它展示目录树。'),
        draft.mods.length === 0
          ? h('div', { className: 'fm_empty' }, '还没有项目，点下面的「+ 添加项目」选一个目录。')
          : draft.mods.map((mod, index) =>
              h(
                'div',
                { className: 'fm_itemCard', key: mod.id || index },
                h(
                  'div',
                  { className: 'fm_itemHead' },
                  h('input', {
                    className: 'fm_input fm_itemName',
                    value: mod.name,
                    placeholder: '项目名',
                    onChange: (e) => patchMod(index, { name: e.target.value }),
                  }),
                  h('button', { className: 'fm_btn fm_btnDanger', onClick: () => removeMod(index) }, '删除'),
                ),
                h(
                  'div',
                  { className: 'fm_field' },
                  h('div', { className: 'fm_fieldLabel' }, '根目录'),
                  h(
                    'div',
                    { className: 'fm_row3' },
                    h('input', {
                      className: 'fm_input fm_mono',
                      value: mod.root,
                      placeholder: '例如 D:\\NightreignMod\\project',
                      onChange: (e) => patchMod(index, { root: e.target.value }),
                    }),
                    h('div', { className: 'fm_sub' }, mod.root ? '（目录会在保存后生效）' : '（还没选目录）'),
                    h(
                      'div',
                      { style: { display: 'flex', gap: '6px' } },
                      h('button', { className: 'fm_btn', onClick: () => pickModRoot(index) }, '选目录'),
                      h('button', { className: 'fm_btn', onClick: () => patchMod(index, { root: '' }) }, '清空'),
                    ),
                  ),
                ),
              ),
            ),
        h(
          'div',
          { style: { marginTop: '8px' } },
          h('button', { className: 'fm_btn fm_btnPrimary', onClick: addMod, type: 'button' }, '+ 添加项目（选目录）'),
        ),
      );

      // ---------------- 工具页
      const rows = draft.tools
        .map((tool, index) => ({ tool, index }))
        .filter(({ tool }) => (tool.categoryId ?? '') === currentCategoryId);

      const toolRows = rows.length
        ? rows.map(({ tool, index }) => {
            const key = tool.id || `idx_${index}`;
            const open = openToolId === key;
            const summary = tool.url ? tool.url : tool.exe ? baseName(tool.exe) : '（还没填 exe）';
            return h(
              'div',
              { className: cx('fm_toolRow', open ? 'fm_toolRowOpen' : ''), key },
              h(
                'div',
                {
                  className: 'fm_toolRowHead',
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => setOpenToolId(open ? null : key),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setOpenToolId(open ? null : key);
                  },
                },
                h('span', { className: 'fm_caret' }, open ? '▾' : '▸'),
                tool.url ? h('span', { className: 'fm_cardWebIcon' }, '🌐') : null,
                h('span', { className: 'fm_toolRowName' }, tool.name || '（未命名）'),
                h('span', { className: 'fm_toolRowMeta', title: summary }, summary),
                h('span', { className: 'fm_grow' }),
                h(
                  'button',
                  {
                    className: 'fm_btn fm_btnDanger',
                    onClick: (event) => {
                      event.stopPropagation();
                      removeTool(index);
                    },
                  },
                  '删除',
                ),
              ),
              open
                ? h(
                    'div',
                    { className: 'fm_toolRowBody' },
                    h(
                      'div',
                      { className: 'fm_row2' },
                      h(
                        'div',
                        { className: 'fm_field' },
                        h('div', { className: 'fm_fieldLabel' }, '名字'),
                        h('input', {
                          className: 'fm_input',
                          value: tool.name,
                          onChange: (e) => patchTool(index, { name: e.target.value }),
                        }),
                      ),
                      h(
                        'div',
                        { className: 'fm_field' },
                        h('div', { className: 'fm_fieldLabel' }, '关联扩展名（空格分隔，最长匹配优先）'),
                        h('input', {
                          className: 'fm_input fm_mono',
                          value: (tool.exts ?? []).join(' '),
                          placeholder: '.hks .txt',
                          onChange: (e) =>
                            patchTool(index, {
                              exts: e.target.value
                                .split(/\s+/)
                                .map((s) => s.trim())
                                .filter(Boolean),
                            }),
                        }),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'fm_field' },
                      h('div', { className: 'fm_fieldLabel' }, tool.url ? 'exe 绝对路径（网页工具不用填）' : 'exe 绝对路径'),
                      h('input', {
                        className: 'fm_input fm_mono',
                        value: tool.exe,
                        placeholder: 'C:\\Program Files\\App\\App.exe',
                        disabled: Boolean(tool.url),
                        onChange: (e) => patchTool(index, { exe: e.target.value }),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'fm_field' },
                      h('div', { className: 'fm_fieldLabel' }, '网站地址（填了就是「网页工具」，点卡片用默认浏览器打开）'),
                      h('input', {
                        className: 'fm_input fm_mono',
                        value: tool.url ?? '',
                        placeholder: 'https://fxr-playground.pages.dev/',
                        onChange: (e) => patchTool(index, { url: e.target.value.trim() }),
                      }),
                    ),
                    h(
                      'div',
                      { className: 'fm_row2' },
                      h(
                        'div',
                        { className: 'fm_field' },
                        h('div', { className: 'fm_fieldLabel' }, '启动参数（可留空）'),
                        h('input', {
                          className: 'fm_input fm_mono',
                          value: tool.args ?? '',
                          onChange: (e) => patchTool(index, { args: e.target.value }),
                        }),
                      ),
                      h(
                        'div',
                        { className: 'fm_field' },
                        h('div', { className: 'fm_fieldLabel' }, '工作目录（可留空）'),
                        h('input', {
                          className: 'fm_input fm_mono',
                          value: tool.cwd ?? '',
                          onChange: (e) => patchTool(index, { cwd: e.target.value }),
                        }),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'fm_field' },
                      h('div', { className: 'fm_fieldLabel' }, '备注（给人和模型看的一句话）'),
                      h('input', {
                        className: 'fm_input',
                        value: tool.note ?? '',
                        onChange: (e) => patchTool(index, { note: e.target.value }),
                      }),
                    ),
                    h(
                      'label',
                      { className: 'fm_check' },
                      h('input', {
                        type: 'checkbox',
                        checked: tool.openWithFile !== false && !tool.url,
                        disabled: Boolean(tool.url),
                        onChange: (e) => patchTool(index, { openWithFile: e.target.checked }),
                      }),
                      '可以从面板带文件启动（纯 GUI 程序不接文件参数，取消勾选）',
                    ),
                  )
                : null,
            );
          })
        : [
            h(
              'div',
              { className: 'fm_empty', key: 'empty' },
              categories.length ? '这个分类下还没有工具，点下面的「+ 添加工具」。' : '还没有分类。',
            ),
          ];

      const toolsPane = h(
        'div',
        { className: 'fm_catLayout' },
        h(
          'div',
          { className: 'fm_catList' },
          h('div', { className: 'fm_fieldLabel' }, `分类（${categories.length}）`),
          categories.map((category, index) =>
            h(
              'div',
              { className: cx('fm_catRow', category.id === currentCategoryId ? 'fm_catRowOn' : ''), key: category.id || index },
              h('input', {
                className: 'fm_input fm_catName',
                value: category.name,
                title: category.id,
                onFocus: () => setCategoryId(category.id),
                onChange: (e) => patchCategory(index, { name: e.target.value }),
              }),
              h(
                'button',
                {
                  className: 'fm_catKill',
                  title: categories.length <= 1 ? '至少留一个分类' : '删掉这个分类（里面的工具会挪到第一个分类）',
                  disabled: categories.length <= 1,
                  onClick: () => removeCategory(index),
                },
                '×',
              ),
            ),
          ),
          h(
            'button',
            { className: 'fm_btn', type: 'button', style: { marginTop: '6px' }, onClick: addCategory },
            '+ 新建分类',
          ),
        ),
        h(
          'div',
          { className: 'fm_catBody' },
          h(
            'div',
            { className: 'fm_sub', style: { marginBottom: '6px' } },
            '点一行展开细项。「扩展名」决定打开某个文件时用谁（最长匹配优先，例如 .emevd.js 会压过 .js）。',
          ),
          toolRows,
          h(
            'div',
            { style: { marginTop: '8px' } },
            h('button', { className: 'fm_btn fm_btnPrimary', onClick: addTool, type: 'button' }, '+ 添加工具'),
            h(
              'button',
              { className: 'fm_btn', type: 'button', style: { marginLeft: '8px' }, onClick: addWebTool },
              '+ 添加网站',
            ),
          ),
        ),
      );

      return h(
        'div',
        { className: 'fm_overlay', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          'div',
          { className: 'fm_drawer', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'fm_drawerHead' },
            h('div', { className: 'fm_title' }, '工具箱设置'),
            h('div', { className: 'fm_grow' }),
            h('button', { className: 'fm_btn', onClick: onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'fm_drawerTabs' },
            h(
              'button',
              { className: cx('fm_tab', tab === 'mods' ? 'fm_tabOn' : ''), onClick: () => setTab('mods') },
              `项目（${draft.mods.length}）`,
            ),
            h(
              'button',
              { className: cx('fm_tab', tab === 'tools' ? 'fm_tabOn' : ''), onClick: () => setTab('tools') },
              `工具（${draft.tools.length}）`,
            ),
          ),
          h(
            'div',
            { className: 'fm_drawerBody' },
            error ? h('div', { className: 'fm_note fm_noteErr' }, error) : null,
            tab === 'mods' ? modsPane : toolsPane,
          ),
          h(
            'div',
            { className: 'fm_drawerFoot' },
            h('button', { className: 'fm_btn', onClick: onClose, disabled: saving }, '取消'),
            h('button', { className: 'fm_btn fm_btnPrimary', onClick: onSave, disabled: saving }, saving ? '保存中…' : '保存'),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------- 主面板

    /** 按分类聚合工具（保持分类列表顺序，分类已被删掉的落到「未分类」）。 */
    function groupToolsList(categories, tools) {
      const order = [];
      const buckets = new Map();
      for (const category of categories ?? []) {
        const name = String(category?.name ?? '').trim();
        if (!name || buckets.has(name)) continue;
        buckets.set(name, []);
        order.push(name);
      }
      const byId = new Map((categories ?? []).map((c) => [c.id, String(c?.name ?? '').trim()]));
      const orphans = [];
      for (const tool of tools ?? []) {
        const name = byId.get(tool.categoryId);
        if (!name || !buckets.has(name)) {
          orphans.push(tool);
          continue;
        }
        buckets.get(name).push(tool);
      }
      const result = order
        .filter((name) => buckets.get(name).length)
        .map((name) => ({ name, tools: buckets.get(name) }));
      if (orphans.length) result.push({ name: '未分类', tools: orphans });
      return result;
    }

    /** 一张工具卡片。网页条目带 🌐 与网址，其余显示它能吃哪些扩展名。 */
    function ToolCard(props) {
      const { tool, runs, busy, onLaunch, onStop, categoryName } = props;
      const isWeb = Boolean(tool.url);
      return h(
        // 用 div 而不是 button：卡片里还有一个「关闭」按钮，
        // <button> 里嵌 <button> 是非法 HTML，点击行为会飘。
        'div',
        {
          className: cx('fm_card', runs.length ? 'fm_cardRunning' : '', isWeb ? 'fm_cardWeb' : ''),
          role: 'button',
          tabIndex: 0,
          onClick: () => { if (!busy) onLaunch(tool); },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (!busy) onLaunch(tool);
          },
          title: isWeb ? tool.url : tool.exe,
          style: busy ? { opacity: 0.55, cursor: 'progress' } : null,
        },
        h(
          'div',
          { className: 'fm_cardName' },
          isWeb ? h('span', { className: 'fm_cardWebIcon' }, '🌐') : null,
          tool.name,
          categoryName ? h('span', { className: 'fm_cardGroup' }, categoryName) : null,
        ),
        isWeb
          ? h('div', { className: 'fm_cardUrl' }, tool.url)
          : h('div', { className: 'fm_cardExts' }, tool.exts?.length ? tool.exts.join('  ') : '（无关联扩展名）'),
        tool.note ? h('div', { className: 'fm_cardNote' }, tool.note) : null,
        runs.length ? h('span', { className: 'fm_cardBadge' }, runs.length > 1 ? `${runs.length} 个` : '运行中') : null,
        runs.length
          ? h(
              'button',
              {
                className: 'fm_cardKill',
                title: `关掉 ${tool.name}`,
                onClick: (event) => {
                  event.stopPropagation();
                  onStop(tool);
                },
              },
              '关闭',
            )
          : null,
      );
    }

    /**
     * 右侧栏「开始」页点进来的紧凑工具箱：分类 chips + 一行一个工具。
     * 点整行 = 启动；运行中的行右边是「停止」。窄栏里不放目录树和设置。
     */
    function RailPanel() {
      const [snap, setSnap] = useState(null);
      const [error, setError] = useState(null);
      const [note, setNote] = useState(null);
      const [busy, setBusy] = useState(false);
      const [groupFilter, setGroupFilter] = useState('全部');

      const config = snap?.config ?? null;
      const running = snap?.running ?? [];

      const runningByTool = new Map();
      for (const item of running) {
        const list = runningByTool.get(item.toolId) ?? [];
        list.push(item);
        runningByTool.set(item.toolId, list);
      }

      const groups = groupToolsList(config?.categories ?? [], config?.tools ?? []);
      const shown = groupFilter !== '全部' && groups.some((g) => g.name === groupFilter) ? groupFilter : '全部';
      const tools = shown === '全部' ? config?.tools ?? [] : groups.find((g) => g.name === shown)?.tools ?? [];

      const refresh = useCallback(async () => {
        try {
          setSnap(await api('/state'));
          setError(null);
        } catch (e) {
          setError(String(e?.message ?? e));
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const launch = useCallback(async (tool) => {
        setBusy(true);
        setNote(null);
        try {
          const res = await post('/launch', { toolId: tool.id });
          setSnap((prev) => ({ ...(prev ?? {}), running: res.running ?? [] }));
        } catch (e) {
          setNote(`启动失败：${e?.message ?? e}`);
        } finally {
          setBusy(false);
        }
      }, []);

      const stop = useCallback(async (tool) => {
        setBusy(true);
        setNote(null);
        try {
          const res = await post('/stop', { tool: tool.id });
          setSnap((prev) => ({ ...(prev ?? {}), running: res.running ?? [] }));
        } catch (e) {
          setNote(`关闭失败：${e?.message ?? e}`);
        } finally {
          setBusy(false);
        }
      }, []);

      if (error) {
        return h('div', { className: 'fm_rail' },
          h('div', { className: 'fm_note fm_noteErr' }, error),
          h('button', { className: 'fm_btn', onClick: () => refresh() }, '重试'),
        );
      }
      if (!config) return h('div', { className: 'fm_rail' }, h('div', { className: 'fm_sub' }, '正在读取…'));

      return h(
        'div',
        { className: 'fm_rail' },
        h('div', { className: 'fm_railHead' },
          groups.length > 1
            ? h('div', { className: 'fm_chips' },
                ['全部', ...groups.map((g) => g.name)].map((name) =>
                  h('button', {
                    key: name,
                    className: cx('fm_chip', shown === name ? 'fm_chipOn' : ''),
                    onClick: () => setGroupFilter(name),
                  }, name),
                ),
              )
            : h('span', { className: 'fm_sub' }, `${config.tools.length} 个工具`),
          h('span', { className: 'fm_grow' }),
          h('button', { className: 'fm_btn', title: '重新读一遍配置和运行状态', onClick: () => refresh() }, '⟳'),
        ),
        note ? h('div', { className: 'fm_note fm_noteErr' }, note) : null,
        tools.length === 0
          ? h('div', { className: 'fm_empty' }, '还没有工具。到「工具箱」面板的设置里加。')
          : h('div', { className: 'fm_railList' },
              tools.map((tool) => {
                const runs = runningByTool.get(tool.id) ?? [];
                const isWeb = Boolean(tool.url);
                return h('div', {
                  key: tool.id,
                  className: cx('fm_railRow', runs.length ? 'fm_railRowOn' : ''),
                  role: 'button',
                  tabIndex: 0,
                  title: isWeb ? tool.url : tool.exe,
                  onClick: () => { if (!busy) launch(tool); },
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    if (!busy) launch(tool);
                  },
                },
                  h('span', { className: 'fm_railName' }, isWeb ? '🌐 ' : '', tool.name),
                  h('span', { className: 'fm_grow' }),
                  runs.length
                    ? h('button', {
                        className: 'fm_railStop',
                        title: `关掉 ${tool.name}`,
                        onClick: (event) => {
                          event.stopPropagation();
                          stop(tool);
                        },
                      }, '停止')
                    : h('span', { className: 'fm_railGo' }, '启动'),
                );
              }),
            ),
        h('div', { className: 'fm_railFoot' },
          running.length
            ? `运行中 ${running.length}：${running.map((item) => item.toolName).join('、')}`
            : '没有工具在运行',
        ),
      );
    }

    function WorkbenchPanel() {
      const [snap, setSnap] = useState(null);
      const [error, setError] = useState(null);
      const [note, setNote] = useState(null);
      const [noteKind, setNoteKind] = useState('ok');
      const [busy, setBusy] = useState(false);
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [saveError, setSaveError] = useState(null);

      // 目录树：path -> {dirs, loading, error}；expanded：path -> true
      const [tree, setTree] = useState({});
      const [expanded, setExpanded] = useState({});
      const [filter, setFilter] = useState('');
      const [groupFilter, setGroupFilter] = useState('全部');
      const [tick, setTick] = useState(0);

      const config = snap?.config ?? null;
      const running = snap?.running ?? [];
      const activeMod = config?.mods?.find((m) => m.id === config.activeModId) ?? config?.mods?.[0] ?? null;

      const toolGroups = groupToolsList(config?.categories ?? [], config?.tools ?? []);
      const shownGroup =
        groupFilter !== '全部' && toolGroups.some((g) => g.name === groupFilter) ? groupFilter : '全部';
      const visibleTools =
        shownGroup === '全部' ? config?.tools ?? [] : toolGroups.find((g) => g.name === shownGroup)?.tools ?? [];
      const categoryNameOf = new Map((config?.categories ?? []).map((c) => [c.id, c.name]));

      const say = useCallback((text, kind = 'ok') => {
        setNote(text);
        setNoteKind(kind);
      }, []);

      const refresh = useCallback(async () => {
        try {
          const data = await api('/state');
          setSnap(data);
          setError(null);
        } catch (e) {
          setError(String(e?.message ?? e));
        }
      }, []);

      useEffect(() => {
        refresh();
      }, [refresh]);

      // 「已经开了多久」需要自己走表，不然停在打开那一刻
      useEffect(() => {
        if (!running.length) return undefined;
        const timer = setInterval(() => setTick((n) => n + 1), 15000);
        return () => clearInterval(timer);
      }, [running.length]);

      /** 把整份配置存回 Host，并用返回值刷新面板。 */
      const persist = useCallback(async (nextConfig) => {
        const res = await post('/config', { config: nextConfig });
        setSnap((prev) => ({
          ...(prev ?? {}),
          config: res.config,
          running: res.running ?? prev?.running ?? [],
          configPath: res.configPath,
        }));
        return res.config;
      }, []);

      const toggleDir = useCallback(async (path) => {
        setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
        if (expanded[path]) return;
        if (tree[path] && !tree[path].error) return;
        setTree((prev) => ({ ...prev, [path]: { dirs: [], files: [], loading: true } }));
        try {
          const res = await api(`/dirs?path=${encodeURIComponent(path)}`);
          setTree((prev) => ({
            ...prev,
            [path]: { dirs: res.dirs ?? [], files: res.files ?? [], more: res.more ?? null },
          }));
        } catch (e) {
          setTree((prev) => ({ ...prev, [path]: { dirs: [], files: [], error: String(e?.message ?? e) } }));
        }
      }, [expanded, tree]);

      /** 切换项目后，旧树的缓存全部作废。 */
      const switchMod = useCallback(async (id) => {
        setTree({});
        setExpanded({});
        try {
          await persist({ ...config, activeModId: id });
        } catch (e) {
          say(`切换失败：${e?.message ?? e}`, 'err');
        }
      }, [config, persist, say]);

      const launchTool = useCallback(async (tool, file) => {
        setBusy(true);
        setNote(null);
        try {
          const res = await post('/launch', { toolId: tool.id, file: file || undefined });
          setSnap((prev) => ({ ...(prev ?? {}), running: res.running ?? [] }));
          say(`已启动「${tool.name}」${file ? ` → ${baseName(file)}` : ''}`, 'ok');
        } catch (e) {
          say(`启动失败：${e?.message ?? e}`, 'err');
        } finally {
          setBusy(false);
        }
      }, [say]);

      const stopSomething = useCallback(async (payload, describe) => {
        setBusy(true);
        try {
          const res = await post('/stop', payload);
          setSnap((prev) => ({ ...(prev ?? {}), running: res.running ?? [] }));
          speakNote(res.note ?? `已关闭 ${describe ?? ''}`);
        } catch (e) {
          say(`关闭失败：${e?.message ?? e}`, 'err');
        } finally {
          setBusy(false);
        }
        function speakNote(text) {
          say(text, 'ok');
        }
      }, [say]);

      /**
       * 目录树里点文件走这里：先让 Host 算该用谁，再启动。
       * rawFile 必传（原来还可以省略、读输入框，输入框已经删掉）。
       */
      const openFileWith = useCallback(async (rawFile) => {
        const file = String(rawFile ?? '').trim().replace(/^"|"$/g, '');
        if (!file) return;
        setBusy(true);
        try {
          const pick = await post('/pick-tool', { file });
          if (!pick.tool) {
            say(`没有工具认领「${baseName(file)}」这个扩展名。到设置里给某个工具加上它。`, 'err');
            return;
          }
          const tool = config?.tools?.find((t) => t.id === pick.tool.id);
          if (!tool) throw new Error('工具清单刚被改过，刷新一下再试');
          await launchTool(tool, file);
        } catch (e) {
          say(`打开失败：${e?.message ?? e}`, 'err');
        } finally {
          setBusy(false);
        }
      }, [config, launchTool, say]);

      const openInExplorer = useCallback(async (path) => {
        try {
          await post('/reveal', { path });
        } catch (e) {
          say(`打开目录失败：${e?.message ?? e}`, 'err');
        }
      }, [say]);

      const saveDraft = useCallback(async () => {
        setSaving(true);
        setSaveError(null);
        try {
          const saved = await persist(draft);
          setDraft(null);
          setTree({});
          setExpanded({});
          say(`设置已保存（${saved.tools.length} 个工具 / ${saved.mods.length} 个 MOD）`, 'ok');
        } catch (e) {
          setSaveError(String(e?.message ?? e));
        } finally {
          setSaving(false);
        }
      }, [draft, persist, say]);

      if (error) {
        return h(
          'div',
          { className: 'fm_root' },
          h('div', { className: 'fm_head' }, h('div', { className: 'fm_title' }, '工具箱')),
          h('div', { className: 'fm_main' },
            h('div', { className: 'fm_note fm_noteErr' }, `连不上 Host 半边：${error}`),
            h('div', { style: { marginTop: '10px' } },
              h('button', { className: 'fm_btn', onClick: () => refresh() }, '重试'),
            ),
          ),
        );
      }

      if (!snap) {
        return h('div', { className: 'fm_root' },
          h('div', { className: 'fm_head' }, h('div', { className: 'fm_title' }, '工具箱')),
          h('div', { className: 'fm_empty' }, '正在读取配置…'),
        );
      }

      // 运行中按工具 id 归组，卡片上要显示「运行中」
      const runningByTool = new Map();
      for (const item of running) {
        const list = runningByTool.get(item.toolId) ?? [];
        list.push(item);
        runningByTool.set(item.toolId, list);
      }

      const sideTree = activeMod && activeMod.root
        ? h(
            'div',
            { className: 'fm_side' },
            h(
              'div',
              { className: 'fm_sideHead' },
              h('span', null, '目录'),
              h('span', { className: 'fm_grow' }),
              h(
                'button',
                {
                  className: 'fm_filePick',
                  style: { opacity: 1, fontSize: '11px' },
                  title: '清掉已加载的目录缓存，重新拉一次',
                  onClick: () => { setTree({}); setExpanded({}); },
                },
                '⟳',
              ),
            ),
            h('input', {
              className: 'fm_filter',
              value: filter,
              placeholder: '过滤文件名，例如 .hks',
              title: '只影响已加载的目录里的文件显示',
              onChange: (e) => setFilter(e.target.value),
            }),
            h(DirNode, {
              path: activeMod.root,
              label: baseName(activeMod.root) || activeMod.root,
              depth: 0,
              tree,
              expanded,
              onToggle: toggleDir,
              tools: (config.tools ?? []).filter((t) => !t.url),
              onOpenFile: openFileWith,
              onLaunchWith: (tool, file) => launchTool(tool, file),
              filter,
            }),
          )
        : h('div', { className: 'fm_side' },
            h('div', { className: 'fm_sideHead' }, '目录'),
            h('div', { className: 'fm_treeEmpty' }, '还没有 项目。点右上角「设置」加一个。'),
          );

      return h(
        'div',
        { className: 'fm_root' },
        // ---------- 顶栏
        h(
          'div',
          { className: 'fm_head' },
          h('div', { className: 'fm_title' }, '工具箱'),
          config.mods.length
            ? h(
                'select',
                {
                  className: 'fm_select',
                  value: activeMod?.id ?? '',
                  onChange: (e) => switchMod(e.target.value),
                  title: '切换项目（工作区）',
                },
                config.mods.map((mod) => h('option', { key: mod.id, value: mod.id }, mod.name)),
              )
            : h('span', { className: 'fm_sub' }, '还没有 项目'),
          activeMod ? h('button', {
            className: 'fm_btn',
            title: activeMod.root,
            onClick: () => openInExplorer(activeMod.root),
          }, '打开目录') : null,
          h('div', { className: 'fm_grow' }),
          h(
            'button',
            { className: 'fm_btn', onClick: () => { setSaveError(null); setDraft(JSON.parse(JSON.stringify(config))); } },
            '设置',
          ),
          h('button', { className: 'fm_btn', onClick: () => refresh(), title: '重新读一遍配置和运行状态' }, '刷新'),
        ),

        // ---------- 主体
        h(
          'div',
          { className: 'fm_body' },
          sideTree,
          h(
            'div',
            { className: 'fm_main' },
            note ? h('div', { className: cx('fm_note', noteKind === 'err' ? 'fm_noteErr' : 'fm_noteOk') }, note) : null,

            h('div', { className: 'fm_sectionRow' },
              h('div', { className: 'fm_section', style: { margin: '0 0 8px' } }, `工具（${config.tools.length}）`),
              groupToolsList(config.categories, config.tools).length > 1
                ? h('div', { className: 'fm_chips' },
                    ['全部', ...groupToolsList(config.categories, config.tools).map((g) => g.name)].map((name) =>
                      h('button', {
                        key: name,
                        className: cx('fm_chip', shownGroup === name ? 'fm_chipOn' : ''),
                        onClick: () => setGroupFilter(name),
                      }, name),
                    ),
                  )
                : null,
            ),
            config.tools.length === 0
              ? h('div', { className: 'fm_empty' }, '还没有工具。点右上角「设置」加一个。')
              : visibleTools.length === 0
                ? h('div', { className: 'fm_empty' }, `「${shownGroup}」组里没有工具。`)
                : h(
                    'div',
                    { className: 'fm_grid' },
                    visibleTools.map((tool) =>
                      h(ToolCard, {
                        key: tool.id,
                        tool,
                        categoryName: shownGroup === '全部' ? categoryNameOf.get(tool.categoryId) : null,
                        runs: runningByTool.get(tool.id) ?? [],
                        busy,
                        onLaunch: launchTool,
                        onStop: (t) => stopSomething({ tool: t.id }, t.name),
                      }),
                    ),
                  ),

          ),
        ),

        // ---------- 运行中
        h(
          'div',
          { className: 'fm_runner' },
          running.length
            ? [
                h('span', { key: 'label', className: 'fm_sub' }, `运行中 ${running.length}`),
                ...running.map((item) =>
                  h(
                    'span',
                    { key: item.pid, className: 'fm_runItem' },
                    h('span', { className: 'fm_runDot' }),
                    h('span', null, item.toolName),
                    item.file ? h('span', { className: 'fm_runPath fm_mono', title: item.file }, baseName(item.file)) : null,
                    h('span', { className: 'fm_sub' }, `pid ${item.pid} · ${sinceText(item.startedAt)}`),
                    h(
                      'button',
                      {
                        className: 'fm_runKill',
                        title: '结束这个进程（连子进程一起）',
                        onClick: () => stopSomething({ pid: item.pid }, item.toolName),
                      },
                      '×',
                    ),
                  ),
                ),
              ]
            : h('span', { className: 'fm_sub' }, '没有工具箱启动的工具在运行'),
        ),

        // ---------- 设置抽屉
        draft ? h(SettingsDrawer, {
          draft,
          setDraft,
          saving,
          error: saveError,
          onClose: () => setDraft(null),
          onSave: saveDraft,
        }) : null,
      );
    }

    // ---------------------------------------------------------------- 入口

    function apply(ctx) {
      appCtx = ctx;

      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-toolbox');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-toolbox: styles');

      // 侧栏面板列表里的入口（点了会 ctx.layout.selectPanel('toolbox')）
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'toolbox',
            order: 50,
            label: '工具箱',
          },
          PanelIcon,
        ),
      );

      // 中央面板本体。key 必须和上面 sidebar 入口的 id 一致。
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'toolbox',
          },
          WorkbenchPanel,
        ),
      );

      // ---------- 右侧边栏「开始」页里的入口
      // 开始页的卡片来自 tab type definition 里的 guide 数组，所以要先注册一个 tab 类型。
      // sidebarRightTabs 是 ui-sidebar-right 用 ctx.reflect.provide 挂上去的服务，
      // 它可能比本插件晚初始化，也不在 inspect 目录里 —— 拿不到就只是少一个入口，不影响面板。
      const registerRailTab = (tabs) => {
        if (!tabs || typeof tabs.register !== 'function') return;
        tabs.register({
          id: 'toolbox',
          kind: 'toolbox',
          title: () => '工具箱',
          guide: [
            {
              id: 'toolbox',
              order: 30,
              title: () => '工具箱',
              description: () => '一键启动 / 关闭本机工具，点一下就用',
            },
          ],
        });
      };

      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sidebarRightTabs'], (scoped) => registerRailTab(scoped.sidebarRightTabs));
        } else {
          registerRailTab(ctx.get('sidebarRightTabs'));
        }
      } catch (error) {
        console.warn('[dsh-toolbox] 右侧栏入口注册失败', error);
      }

      // 右侧栏 tab 的内容与标题：这两个 slot 是 keyed，key 用的是 tab definition 的 id。
      // 标题不注册也行（会退回 registry 的 title(address)），这里注册是为了始终显示中文名。
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'toolbox' }, RailPanel),
      );
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'toolbox' }, () =>
          h('span', null, '工具箱'),
        ),
      );
    }

    exports.apply = apply;
    // uiWorkspace 提供原生目录选择器（设置里「选目录」用）；slots 是本体的必需项。
    exports.inject = ['slots', 'uiWorkspace'];
    exports.name = 'dsh-toolbox';

    return module.exports;
  },
});
