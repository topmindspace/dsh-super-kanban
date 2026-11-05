# 安装、验证、更新与卸载

本文说明如何把 **Super Kanban** 装进 DeepSeek Harness（DSH），以及**如何正确更新**、验证版本、回滚和卸载。

- 插件名：`dsh-super-kanban`
- 仓库：<https://github.com/topmindspace/dsh-super-kanban>
- 市场索引：<https://topmindspace.github.io/dsh-super-kanban/index.json>
- 许可证：[MIT](../LICENSE)

> 文档按 **0.4.x** 系列编写；具体可用版本以 DSH 插件页显示与 npm latest 为准。遇到问题请先看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.1-rc.5 < 0.3.0`（桌面版） |
| Node.js | `>= 22.19.0`（DSH 已自带，无需单独安装） |
| 账号 | 可选。不登录也能用本地规则分析；登录后可启用 AI 联网研判 |
| 本机 DSH Home | 至少打开过一次 DSH（存在 `~/.dsh/profiles/desktop`） |

> Windows 用户如遇到 `~` 路径问题，请在 Git Bash 或 WSL 中执行命令；DSH 桌面版的插件页安装本身不需要命令行。

## 1. 安装（四种方式）

### 方式 A：插件市场索引（推荐）

> 「发现（Discover）」来自 DSH 的实验性插件市场能力：先在 **插件 → 实验性插件** 中启用 **插件市场 / Plugin market** 并按提示重载 DSH。若你的 DSH 版本暂无该能力，请使用方式 B/C/D。

1. DSH → **插件** → **发现（Discover）**；
2. **添加索引源**，粘贴：

   ```
   https://topmindspace.github.io/dsh-super-kanban/index.json
   ```

3. 打开 **Super Kanban** 的详情页：这里会列出该插件在索引中的**全部可用版本**；
4. 选择要安装的版本 → **安装** → **启用**；
5. 回到主窗口按 `Cmd+R` 刷新。左侧栏出现「任务看板」即安装成功。

> 市场索引来自第三方（本仓库 `docs/`）。DSH 会在安装前提示信任风险，请确认来源为本仓库后再继续。
> 若索引 URL 暂时无法访问，说明对应版本尚未发布到 GitHub Pages，请改用方式 B/C/D。

### 方式 B：npm 包名

1. DSH → 插件 → **添加插件**；
2. 输入包名：
   - 不带版本：`dsh-super-kanban`（安装 npm latest）；
   - 带版本：`dsh-super-kanban@0.4.1`（**推荐写精确版本**，见第 3 节）；
3. 安装 → 启用 → 刷新窗口。

适合能访问 npm registry 的用户。插件无第三方运行时依赖。

### 方式 C：Git 仓库

1. DSH → 插件 → **添加插件**；
2. 粘贴仓库地址：`https://github.com/topmindspace/dsh-super-kanban`；
3. 安装（DSH 会把来源 pin 到具体 commit）→ 启用 → 刷新窗口。

适合想跟踪最新代码、或所在团队自建 Git 镜像的用户。

### 方式 D：本地目录 / 源码脚本

适合开发者和离线环境。

**D1. 插件页选择本地目录**：DSH → 插件 → 添加插件 → 选择本仓库根目录 → 安装 → 启用 → 刷新。

**D2. 命令行安装**（把工作区链接进 DSH profile）：

```bash
git clone https://github.com/topmindspace/dsh-super-kanban.git
cd dsh-super-kanban
./install.sh -y            # 交互式运行可去掉 -y
```

脚本会：

1. 把本目录链接到 `~/.dsh/profiles/desktop/node_modules/dsh-super-kanban`；
2. 在 profile 的 `package.json` 中登记依赖（`link:/path/to/checkout`）与 bundle；
3. 首次安装时备份原 profile 清单到 `super-kanban-profile-backup.json`。

源码安装链接的是工作区本身，**代码改动刷新后即生效**，不需要重新安装。

> 想安装到其他 profile 或隔离 home：
>
> ```bash
> DSH_PROFILE=my-profile ./install.sh -y
> DSH_HOME="$HOME/.dsh-dev" ./install.sh -y
> ```

### 安装后写的依赖长什么样？

DSH 插件页安装 **npm/市场来源** 的包时，会把**精确版本**写入 profile 依赖；源码/本地目录安装写的是 `link:` 路径。两者升级方式不同（见第 3 节）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": {
  "dsh-super-kanban": "0.4.1",                    // 插件页/npm 安装：精确版本
  // 或
  "dsh-super-kanban": "link:/path/to/checkout"    // 源码/本地目录安装
}
```

## 2. 验证安装与版本

### 2.1 界面验证（v0.4 特征）

安装/更新成功后，看板应具备以下 v0.4 特征：

- 看板页头常驻：**搜索、扫描、设置齿轮、在右侧栏打开、新建**；
- 页头「⋯」菜单**只有「导出 JSON」**；
- 卡片有状态点、克制的优先级颜色、问题/产物/子任务计数与进度线；
- 右侧栏形态页头同样常驻扫描、设置等图标按钮。

如果「⋯」里还能看到「设置」「在右侧栏打开」，或卡片没有状态点，说明加载的仍是 **0.3 的旧 bundle**，按第 3.5 节处理。

### 2.2 插件页查看版本

DSH → 插件 → **已安装** → 找到 **Super Kanban**：卡片/详情里会显示当前版本（「当前版本」字段或版本标签）。市场（发现）页也会标记「当前已安装 X.Y.Z」。

### 2.3 命令行查看实际安装版本

插件实际运行的是 profile 的 `node_modules` 里的文件，以它为准（把 `desktop` 换成你的 profile 名）：

```bash
# macOS / Linux / Git Bash（跨平台写法）
node -p "require(require('os').homedir() + '/.dsh/profiles/desktop/node_modules/dsh-super-kanban/package.json').version"

# Windows PowerShell
node -p "require(process.env.USERPROFILE + '\\.dsh\\profiles\\desktop\\node_modules\\dsh-super-kanban\\package.json').version"
```

再查看 profile 记录的依赖规格（是精确版本、范围还是源码链接）：

```bash
node -p "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.dsh/profiles/desktop/package.json', 'utf8')).dependencies['dsh-super-kanban']"
```

输出含义：

| 输出 | 含义 |
| --- | --- |
| `0.4.1` | 精确版本（插件页/npm 安装的典型结果） |
| `^0.4.0` | 范围依赖，可解析到 0.4.x 的补丁版本（0.4.1、0.4.2…），**不会**到 0.5.x |
| `^0.3.0` | 范围依赖，只会解析 0.3.x，**永远不会**到 0.4.x（本次“更新后仍是旧界面”的根因） |
| `link:/path/to/checkout` | 源码安装，版本跟随该目录，无需按版本升级 |

### 2.4 npm 安装路径与 `^0.4.0` 范围行为

- 插件页从 npm / 市场安装时使用 `pnpm add --save-exact`，profile 里记录的是**精确版本**（如 `0.4.1`）。
- 如果依赖被写成 **`^0.4.0`**：重新执行安装或 `pnpm install` 时，npm 会把 **0.4.x 的补丁版本**（0.4.1、0.4.2…）视为可解析，因此 0.4.x 内可以正常更新。
- 如果依赖仍是 **`^0.3.0`**：语义化版本只允许 `<0.4.0`，**0.4.x 不会被解析**。无论插件页怎么“更新”、怎么刷新，磁盘上仍然是 0.3.x。
- **跨 minor**（0.3 → 0.4、0.4 → 0.5）必须显式安装**精确版本**（如 `dsh-super-kanban@0.4.1`）或手动把依赖范围改到新的 minor，再重新安装。

## 3. 更新插件（升级）

### 3.1 先理解升级模型（重要）

1. **第三方插件没有“自动升级”**。市场/索引只负责列出可用版本并执行**安装**动作；不会在后台自动替换已安装版本。
2. DSH 插件页只对**按需安装的官方插件**提供「更新」按钮；对第三方插件，界面会提示：**“其他插件请先卸载再安装新版”**。
3. 通过插件页/npm 安装的依赖是**精确版本**，所以升级 = **卸载旧版 → 安装目标版本**（不会只改个 `package.json` 就自动生效）。
4. 更新完成后：**先按 `Cmd+R` 刷新窗口**；如果界面没变，**完全退出 DSH 再重新打开**（客户端 bundle 有缓存）。
5. 跨 minor 升级必须用**精确版本**（见 3.3）；`^0.3.0` 这类旧范围不会升级到 0.4.x。

### 3.2 推荐升级步骤（所有安装方式通用）

1. **记录当前版本**（第 2 节），并确认目标版本（插件页 / npm / GitHub Releases / 市场索引）。
2. 可选：备份看板数据（升级通常不删数据，但跨大版本前建议备份）：

   ```bash
   cp -R ~/.dsh/storages/super-kanban ~/.dsh/storages/super-kanban.backup
   ```

3. **完全退出 DSH**（不是只关窗口）。插件文件被占用时安装可能失败或残留旧文件。
4. 按安装来源升级：

   **A. 市场（发现）**：插件 → 已安装 → Super Kanban → **卸载** → 插件 → 发现 → 打开 Super Kanban 详情 → 在版本列表里**选择目标版本**（如 `0.4.1`）→ **安装** → **启用**。

   **B. npm**：插件 → 已安装 → Super Kanban → **卸载** → 添加插件 → 输入**精确版本** `dsh-super-kanban@0.4.1` → 安装 → 启用。

   **C. Git**：插件 → 已安装 → 卸载 → 添加插件 → 重新粘贴仓库地址（DSH 会 pin 到当前 commit）→ 安装 → 启用。

   **D. 源码 / 本地目录**：

   ```bash
   cd /path/to/dsh-super-kanban
   git fetch --tags
   git checkout v0.4.1     # 用目标 Release 的 tag；跟随 main 则用 git pull
   ./install.sh -y         # 重新链接（首次安装已 link 的可省略，但仍建议刷新 profile）
   ```

5. 重新打开 DSH → 按 `Cmd+R` → 按第 2 节验证版本与界面。

### 3.3 跨 minor 必须用精确版本（`^0.3.0` 陷阱）

语义化版本的范围规则：

```
^0.3.0  →  >=0.3.0 <0.4.0   只收 0.3.x，永远到不了 0.4.0
^0.4.0  →  >=0.4.0 <0.5.0   收 0.4.x（0.4.1、0.4.2…），到不了 0.5.0
0.4.1   →  精确版本          只装 0.4.1
```

因此：

- **0.3.x → 0.4.x**：必须安装精确版本（`dsh-super-kanban@0.4.1`）或按来源重装；只点“更新”不会跨 minor。
- **0.4.0 → 0.4.1**：如果依赖是精确版本 `0.4.0`，同样要卸载后安装 `0.4.1`；如果依赖被写成 `^0.4.0`，重新安装/`pnpm install` 即可拿到 0.4.x 补丁。
- 排查“更新后界面仍旧”时，先按 2.3 节确认 **node_modules 里的实际版本** 与 **profile 里的依赖规格**，不要只看插件页提示。

### 3.4 高级：命令行升级（可选）

适合熟悉终端的用户。**先完全退出 DSH**（桌面版 profile 被占用时命令会失败）：

```bash
# 安装/升级到精确版本（dsh plugin 会把参数转发给 profile 里的 pnpm）
dsh plugin --profile desktop add dsh-super-kanban@0.4.1

# 卸载
dsh plugin --profile desktop remove dsh-super-kanban
```

- `dsh plugin …` 需要终端里能使用 `dsh` CLI；若没有，请优先使用插件页。
- 想临时让 `^0.4.x` 自动收补丁：把 profile `package.json` 里的依赖改成 `"^0.4.0"`，再执行一次 `dsh plugin --profile desktop install`（或插件页重新安装一次），之后 0.4.x 补丁版可被解析。**跨 minor 仍需精确版本。**

### 3.5 更新后界面仍旧？（4 步快速排查）

1. **刷新窗口**：`Cmd+R`（Windows/Linux 用 DSH 的重新加载入口）。
2. **完全退出 DSH 再打开**：只关窗口不够，插件/客户端 bundle 可能仍被旧进程持有。
3. **验证版本与依赖规格**：执行 2.3 节的两条命令。
   - node_modules 版本已是新版、但界面仍旧 → 多半是多 profile / 多窗口 / 旧进程问题：确认打开的 DSH 使用 `desktop` profile，关闭其他 DSH 实例后重开；
   - node_modules 版本仍是旧版 → 依赖规格问题（见 2.4 / 3.3），按 3.2 卸载重装精确版本。
4. **仍然不行** → 卸载后重新安装目标精确版本；再看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 的「更新后 UI 未变」一节收集诊断信息。

## 4. 回滚到旧版本

升级后如遇问题，可以回滚。看板数据与插件版本解耦（当前存储格式版本为 2，0.3.x/0.4.x 通用），回滚一般不会丢看板数据，但**跨存储格式版本回滚前务必备份**。

1. 备份数据：

   ```bash
   cp -R ~/.dsh/storages/super-kanban ~/.dsh/storages/super-kanban.backup
   ```

2. 完全退出 DSH；
3. 卸载当前版本（插件页或 `dsh plugin --profile desktop remove dsh-super-kanban`）；
4. 安装目标旧版本的**精确版本**：
   - 插件页：市场详情页的版本列表里选择旧版本（如 `0.3.0`）安装；或添加插件时输入 `dsh-super-kanban@0.3.0`；
   - 源码：`git checkout v0.3.0 && ./install.sh -y`。
5. 启用 → 刷新窗口 → 按第 2 节验证。

> 回滚后如果插件报告数据文件损坏：插件会自动把损坏文件移到 `~/.dsh/storages/super-kanban/backups/` 并重建。也可以手动恢复备份目录，或删除 `state.json` 让看板重新扫描生成。

## 5. 卸载

- **插件页**：找到 Super Kanban → 禁用 / 卸载 → 刷新窗口。
- **源码脚本**：

  ```bash
  cd /path/to/dsh-super-kanban
  ./uninstall.sh -y
  ```

卸载逻辑：恢复安装前的 profile 清单（若有备份）并移除链接/依赖。**看板数据保留**，删除插件不会删除你的任务。

彻底清空数据请手动删除：

```bash
rm -rf ~/.dsh/storages/super-kanban
```

## 6. 数据位置

| 内容 | 路径 |
| --- | --- |
| 看板状态（任务 / 设置 / 扫描状态） | `~/.dsh/storages/super-kanban/state.json` |
| 会话分析缓存 | `~/.dsh/storages/super-kanban/sessions-cache.json` |
| 损坏文件备份 | `~/.dsh/storages/super-kanban/backups/` |
| 导出 | 看板页头「⋯」→ 导出 JSON（或设置弹窗里的「导出 JSON」）：`super-kanban-YYYYMMDD.json` |

只读的数据源（插件不会修改）：`~/.dsh/storages/workspace.json`、`~/.dsh/sessions/**`、`~/.dsh/storages/session_projcache/**`。

## 7. 排障

常见问题的完整排查手册见 **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**。下面是最常见的几条：

| 现象 | 先做什么 |
| --- | --- |
| 更新后界面仍旧 / 看不到新功能 | 第 3.5 节：刷新 → 完全退出重开 → 检查版本与依赖规格 → 精确版本重装 |
| 左侧栏没有「任务看板」 | 刷新窗口 / 重启 DSH；仍没有见 [TROUBLESHOOTING](TROUBLESHOOTING.md#入口缺失) |
| 有入口但面板空白 / 一直加载 | 见 [TROUBLESHOOTING](TROUBLESHOOTING.md#看板空白或加载失败) |
| 扫描不跑 / 卡片不更新 | 手动点扫描；检查设置里「自动扫描」；见 [TROUBLESHOOTING](TROUBLESHOOTING.md#扫描不跑卡片不更新) |
| AI 一直不生效 | 设置里确认 AI 开启、DSH 已登录；见 [TROUBLESHOOTING](TROUBLESHOOTING.md#ai-不生效或一直等待) |
| 升级 DSH 后插件失效 | DSH 大版本可能变更插件接口；先重装与当前 DSH 兼容的版本，数据不会丢 |

更多安全与隐私说明见 README 的「AI 与隐私」一节；安全问题请按 [SECURITY.md](../SECURITY.md) 私下报告。

## 8. 开发者：隔离环境安装与升级验证

不污染真实 `~/.dsh` 的推荐流程：

```bash
export DSH_HOME="$HOME/.dsh-dev"
dsh web --port 56790          # 首次运行会创建隔离 profile
./install.sh -y               # 当前 check-out 会被链接进该 profile
```

打开 `http://127.0.0.1:56790`，刷新窗口后从左侧栏打开「任务看板」。源码改动（host 半与 `client.js`）在刷新后生效。详见 [DEVELOPMENT.md](DEVELOPMENT.md)。

**复现/验证升级行为**（开发文档常用）：

```bash
# 1) 在隔离 profile 里安装一个旧范围，观察它不会跨 minor
dsh plugin --profile web add dsh-super-kanban@^0.3.0

# 2) 查看 profile 记录的依赖规格与 node_modules 实际版本（替换 profile 名/home）
node -p "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.dsh-dev/profiles/web/package.json', 'utf8')).dependencies['dsh-super-kanban']"
node -p "require(require('os').homedir() + '/.dsh-dev/profiles/web/node_modules/dsh-super-kanban/package.json').version"

# 3) 换成精确版本重装，确认界面换成 v0.4
dsh plugin --profile web add dsh-super-kanban@0.4.1
```

> 桌面版 profile（`desktop`）由桌面 App 持有：命令行操作前**完全退出 DSH**，否则会提示 profile 被占用或安装失败。
