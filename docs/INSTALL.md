# 安装、验证、更新与卸载

本文说明如何把 **Super Kanban** 装进 DeepSeek Harness（DSH），以及**如何正确更新**、验证版本、回滚和卸载。

- 插件名：`dsh-super-kanban`
- 仓库：<https://github.com/topmindspace/dsh-super-kanban>
- 市场索引：<https://topmindspace.github.io/dsh-super-kanban/index.json>
- 许可证：[MIT](../LICENSE)

> 文档按 **0.8.x** 系列编写；具体可用版本以 DSH 插件页显示与 npm latest 为准。遇到问题请先看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.1-rc.5 < 0.3.0`（桌面版） |
| Node.js | `>= 22.19.0`（DSH 已自带，无需单独安装） |
| 模型服务 | 可选。DSH 未提供模型服务（旧版本/极简组合）时用本地规则分析；DSH 提供原生模型服务后，可跟随 DSH 默认模型或选择第三方模型启用 AI 研判 |
| 本机 DSH Home | 至少打开过一次 DSH（存在 `~/.dsh/profiles/desktop`） |
| `bash` + `python3` | 仅源码脚本（方式 D2）与卸载脚本需要：`install.sh` / `uninstall.sh` 用 python3 读写 profile 清单；用插件页安装则不需要 |

> Windows 用户如遇到 `~` 路径问题，请在 Git Bash 或 WSL 中执行命令；DSH 桌面版的插件页安装本身不需要命令行。

## 1. 安装（四种方式）

> 每种方式都支持**安装特定版本**；下例用当前版本 `0.8.0`，换成你的目标版本号即可。
> 安装后可用 [2.3 节](#23-命令行查看实际安装版本)的命令验证实际版本。

### 方式 A：插件市场索引（推荐）

> 「发现（Discover）」来自 DSH 的实验性插件市场能力：先在 **插件 → 实验性插件** 中启用 **插件市场 / Plugin market** 并按提示重载 DSH。若你的 DSH 版本暂无该能力，请使用方式 B/C/D。

1. DSH → **插件** → **发现（Discover）**；
2. **添加索引源**，粘贴：

   ```
   https://topmindspace.github.io/dsh-super-kanban/index.json
   ```

3. 打开 **Super Kanban** 的详情页：这里会列出该插件在索引中的**全部可用版本**（按新→旧排列）；
4. **安装特定版本**：在版本列表里选择精确版本（如 `0.8.0`）→ **安装** → **启用**；选定哪个就安装哪个，第三方插件不会自动升级；
5. 回到主窗口按 `Cmd+R` 刷新。左侧栏出现「任务看板」即安装成功。

> 市场索引来自第三方（本仓库 `docs/`）。DSH 会在安装前提示信任风险，请确认来源为本仓库后再继续。
> 若索引 URL 暂时无法访问，说明对应版本尚未发布到 GitHub Pages，请改用方式 B/C/D。

### 方式 B：npm 包名

1. DSH → 插件 → **添加插件**；
2. 输入包名：
   - 不带版本：`dsh-super-kanban`（安装 npm latest）；
   - 带版本：`dsh-super-kanban@0.8.0`（**推荐写精确版本**，见第 3 节）；
3. 安装 → 启用 → 刷新窗口。

适合能访问 npm registry 的用户。插件无第三方运行时依赖。

**安装特定版本**（命令行等价写法，先完全退出 DSH）：

```bash
dsh plugin --profile desktop add dsh-super-kanban@0.8.0
```

### 方式 C：Git 仓库

1. DSH → 插件 → **添加插件**；
2. 粘贴仓库地址：`https://github.com/topmindspace/dsh-super-kanban`；
3. 安装（DSH 会把来源 pin 到具体 commit）→ 启用 → 刷新窗口。

适合想跟踪最新代码、或所在团队自建 Git 镜像的用户。

> **安装特定版本**：在 DSH 插件页直接添加仓库地址会 pin 到当时的 commit，不能直接指定 tag。
> 要固定到某个 Release，请克隆后 checkout 对应 tag，再按方式 D 安装：
>
> ```bash
> git clone https://github.com/topmindspace/dsh-super-kanban.git
> cd dsh-super-kanban
> git checkout v0.8.0        # 换成目标 Release 的 tag
> ./install.sh -y
> ```

### 方式 D：本地目录（源码脚本）

适合开发者和离线环境。

**D1. 插件页选择本地目录**：DSH → 插件 → 添加插件 → 选择本仓库根目录 → 安装 → 启用 → 刷新。

**安装特定版本**：先在克隆目录 `git checkout v0.8.0`（换成目标 tag），再在插件页选择该目录安装。

**D2. 命令行安装**（把工作区链接进 DSH profile）：

```bash
git clone https://github.com/topmindspace/dsh-super-kanban.git
cd dsh-super-kanban
git checkout v0.8.0        # 安装特定版本：固定到目标 Release；跟随 main 则省略此行
./install.sh -y            # 交互式运行可去掉 -y
```

脚本会：

1. 把本目录链接到 `~/.dsh/profiles/desktop/node_modules/dsh-super-kanban`；
2. 在 profile 的 `package.json` 中登记依赖（`link:/path/to/checkout`）与 bundle；
3. 首次安装时把原 profile 清单快照到 `super-kanban-profile-backup.json`；该文件**仅作快照保留**，卸载时不会用它整体覆盖 profile（见第 5 节）。

源码安装链接的是工作区本身：`client.js` 改动刷新窗口即生效；host 半（`index.mjs` / `server/**`）改动需重载 profile
或重启 DSH 后生效，**无需重新安装**。

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
  "dsh-super-kanban": "0.8.0",                    // 插件页/npm 安装：精确版本
  // 或
  "dsh-super-kanban": "link:/path/to/checkout"    // 源码/本地目录安装
}
```

## 2. 验证安装与版本

### 2.1 界面验证

安装或更新后，启用插件并刷新 DSH，再按以下步骤检查：

1. 从左侧栏打开「任务看板」，确认可以切换到「项目」和「日程」。如果只启用了会话右侧栏入口，请从会话右上角的看板图标打开。
2. 检查工具栏是否显示当前模型。打开「选择模型」，可跟随 DSH 默认或选定具体模型。点「应用模型」后，快聊和后续 AI 研判共用此选择。
3. 打开「快聊」，确认可在快速问答和中英翻译之间切换。有可用模型时，发送一条问答并尝试追问。

对照[界面截图](SCREENSHOTS.md)。入口缺失或界面仍是旧版时，先[核对实际安装版本](#23-命令行查看实际安装版本)，再按[刷新步骤](#35-更新后界面仍旧4-步快速排查)排查。

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
| `0.8.0` | 精确版本（插件页/npm 安装的典型结果） |
| `^0.8.0` | 可安装 0.8.x 补丁版本 |
| `^0.7.0` | 可安装 0.7.x 补丁版本 |
| `link:/path/to/checkout` | 源码安装，版本跟随该目录，无需按版本升级 |

## 3. 更新插件（升级）

### 3.1 先理解升级模型（重要）

1. **第三方插件没有“自动升级”**。市场/索引只负责列出可用版本并执行**安装**动作；不会在后台自动替换已安装版本。
2. DSH 插件页只对**按需安装的官方插件**提供「更新」按钮；对第三方插件，界面会提示：**“其他插件请先卸载再安装新版”**。
3. 通过插件页/npm 安装的依赖是**精确版本**，所以升级 = **卸载旧版 → 安装目标版本**（不会只改个 `package.json` 就自动生效）。
4. 更新完成后：**先按 `Cmd+R` 刷新窗口**；如果界面没变，**完全退出 DSH 再重新打开**（客户端 bundle 有缓存）。
5. 跨 minor 升级必须用**精确版本**（见 3.3）；`^0.7.0` 只解析 0.7.x。
6. **升级到 0.8.0** 后会保留已选模型。若跟随 DSH 默认但 DSH 尚未配置模型，可从看板工具栏选一个模型。扫描在无模型时仍可使用本地规则。

### 3.2 推荐升级步骤（所有安装方式通用）

1. **记录当前版本**（第 2 节），并确认目标版本（插件页 / npm / GitHub Releases / 市场索引）。
2. 可选：备份看板数据（升级通常不删数据，但跨大版本前建议备份）：

   ```bash
   cp -R ~/.dsh/storages/super-kanban ~/.dsh/storages/super-kanban.backup
   ```

3. **完全退出 DSH**（不是只关窗口）。插件文件被占用时安装可能失败或残留旧文件。
4. 按安装来源升级：

   **A. 市场（发现）**：插件 → 已安装 → Super Kanban → **卸载** → 插件 → 发现 → 打开 Super Kanban 详情 → 在版本列表里**选择目标版本**（如 `0.8.0`）→ **安装** → **启用**。

   **B. npm**：插件 → 已安装 → Super Kanban → **卸载** → 添加插件 → 输入**精确版本** `dsh-super-kanban@0.8.0` → 安装 → 启用。

   **C. Git**：插件 → 已安装 → 卸载 → 添加插件 → 重新粘贴仓库地址（DSH 会 pin 到当前 commit）→ 安装 → 启用。要**指定版本**，先按方式 C 的 tag 流程 `git checkout v0.8.0`，再用方式 D 的本地目录安装。

   **D. 源码 / 本地目录**：

   ```bash
   cd /path/to/dsh-super-kanban
   git fetch --tags
   git checkout v0.8.0     # 用目标 Release 的 tag；跟随 main 则用 git pull
   ./install.sh -y         # 重新链接（首次安装已 link 的可省略，但仍建议刷新 profile）
   ```

5. 重新打开 DSH → 按 `Cmd+R` → 按第 2 节验证版本与界面。

### 3.3 跨 minor 必须用精确版本

| 当前依赖规格 | 可安装版本 |
| --- | --- |
| `^0.7.0` | `>=0.7.0 <0.8.0` |
| `^0.8.0` | `>=0.8.0 <0.9.0` |
| `0.8.0` | 仅 `0.8.0` |

从旧版升级时，卸载后安装目标精确版本，例如 `dsh-super-kanban@0.8.0`。刷新窗口后按第 2 节核对实际运行版本。

### 3.4 高级：命令行升级（可选）

适合熟悉终端的用户。**先完全退出 DSH**（桌面版 profile 被占用时命令会失败）：

```bash
# 安装/升级到精确版本（dsh plugin 会把参数转发给 profile 里的 pnpm）
dsh plugin --profile desktop add dsh-super-kanban@0.8.0

# 卸载
dsh plugin --profile desktop remove dsh-super-kanban
```

- `dsh plugin …` 需要终端里能使用 `dsh` CLI；若没有，请优先使用插件页。

### 3.5 更新后界面仍旧？（4 步快速排查）

1. **刷新窗口**：`Cmd+R`（Windows/Linux 用 DSH 的重新加载入口）。
2. **完全退出 DSH 再打开**：只关窗口不够，插件/客户端 bundle 可能仍被旧进程持有。
3. **验证版本与依赖规格**：执行 2.3 节的两条命令。
   - node_modules 版本已是新版、但界面仍旧 → 多半是多 profile / 多窗口 / 旧进程问题：确认打开的 DSH 使用 `desktop` profile，关闭其他 DSH 实例后重开；
   - node_modules 版本仍是旧版 → 依赖规格问题（见 2.4 / 3.3），按 3.2 卸载重装精确版本。
4. **仍然不行** → 卸载后重新安装目标精确版本；再看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 的「更新后 UI 未变」一节收集诊断信息。

## 4. 回滚到旧版本

回滚前在 **维护 → 导出备份** 保存 0.8.x 的完整数据。回退至 0.6.x 或更早时，旧版可能在写入时丢弃项目、任务备注和到期日。重新安装 0.8.x 后，可在维护视图恢复这份备份。

1. 备份数据：

   ```bash
   cp -R ~/.dsh/storages/super-kanban ~/.dsh/storages/super-kanban.backup
   ```

2. 完全退出 DSH；
3. 卸载当前版本（插件页或 `dsh plugin --profile desktop remove dsh-super-kanban`）；
4. 安装目标旧版本的**精确版本**（例如从 `0.8.0` 回滚到 `0.7.0`）：
   - 插件页：在市场详情页选择 `0.7.0`，或添加 `dsh-super-kanban@0.7.0`。
   - 源码：`git checkout v0.7.0 && ./install.sh -y`。
5. 启用 → 刷新窗口 → 按第 2 节验证。

> 回滚后如果插件报告数据文件损坏：插件会自动把损坏文件移到 `~/.dsh/storages/super-kanban/backups/` 并重建。也可以手动恢复备份目录，或删除 `state.json` 让看板重新扫描生成。

## 5. 卸载

- **插件页**：找到 Super Kanban → 禁用 / 卸载 → 刷新窗口。
- **源码脚本**：

  ```bash
  cd /path/to/dsh-super-kanban
  ./uninstall.sh -y
  ```

卸载逻辑：**定向移除**本插件在 profile 中的依赖项与 bundle 条目，并删除 `node_modules` 里的链接；**不会**用安装前的
`super-kanban-profile-backup.json` 整体覆盖 profile——避免丢掉首次安装之后其他插件 / 配置的改动。该备份文件仅作
首次安装前的快照保留，需要完全还原 profile 时可手动使用。**看板数据保留**，删除插件不会删除你的任务。

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
| 导出 | 看板页头「⋯」→ 导出 JSON（或设置弹窗里的「导出 JSON」）：`super-kanban-YYYY-MM-DD.json`（如 `super-kanban-2026-11-05.json`） |

只读的数据源（插件不会修改）：`~/.dsh/storages/workspace.json`、`~/.dsh/sessions/**`、`~/.dsh/storages/session_projcache/**`。

## 7. 排障

常见问题的完整排查手册见 **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**。下面是最常见的几条：

| 现象 | 先做什么 |
| --- | --- |
| 更新后界面仍旧 / 看不到新功能 | 第 3.5 节：刷新 → 完全退出重开 → 检查版本与依赖规格 → 精确版本重装 |
| 左侧栏没有「任务看板」 | 刷新窗口 / 重启 DSH；仍没有见 [TROUBLESHOOTING](TROUBLESHOOTING.md#入口缺失) |
| 有入口但面板空白 / 一直加载 | 见 [TROUBLESHOOTING](TROUBLESHOOTING.md#看板空白或加载失败) |
| 扫描不跑 / 卡片不更新 | 手动点扫描；检查设置里「自动扫描」；见 [TROUBLESHOOTING](TROUBLESHOOTING.md#扫描不跑卡片不更新) |
| AI 一直不生效 / 模型不可用 | 检查「AI 联网研判」和工具栏的模型选择；见 [TROUBLESHOOTING](TROUBLESHOOTING.md#ai-不生效或一直等待) |
| 升级 DSH 后插件失效 | DSH 大版本可能变更插件接口；先重装与当前 DSH 兼容的版本，数据不会丢 |

更多安全与隐私说明见 README 的「AI 与模型」一节与 [SECURITY.md](../SECURITY.md)；安全问题请按 SECURITY.md 私下报告。

## 8. 开发者：隔离环境安装与升级验证

不污染真实 `~/.dsh` 的推荐流程：

```bash
export DSH_HOME="$HOME/.dsh-dev"
dsh web --port 56790          # 首次运行会创建隔离 profile
./install.sh -y               # 当前 check-out 会被链接进该 profile
```

打开 `http://127.0.0.1:56790`，刷新窗口后从左侧栏打开「任务看板」。`client.js` 改动刷新窗口即生效；host 半（`index.mjs` / `server/**`）改动需重载 profile（或重启该 DSH 实例）后生效。详见 [DEVELOPMENT.md](DEVELOPMENT.md)。

**复现/验证升级行为**（开发文档常用）：

```bash
# 1) 在隔离 profile 里安装一个旧范围，观察它不会跨 minor
dsh plugin --profile web add dsh-super-kanban@^0.4.0

# 2) 查看 profile 记录的依赖规格与 node_modules 实际版本（替换 profile 名/home）
node -p "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.dsh-dev/profiles/web/package.json', 'utf8')).dependencies['dsh-super-kanban']"
node -p "require(require('os').homedir() + '/.dsh-dev/profiles/web/node_modules/dsh-super-kanban/package.json').version"

# 3) 换成精确版本重装，确认界面换成 v0.8.0
dsh plugin --profile web add dsh-super-kanban@0.8.0
```

> 桌面版 profile（`desktop`）由桌面 App 持有：命令行操作前**完全退出 DSH**，否则会提示 profile 被占用或安装失败。
