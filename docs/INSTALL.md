# 安装、升级与卸载

本文面向普通用户，说明如何把 **Super Kanban** 装进 DeepSeek Harness（DSH），以及升级、卸载和排障。

- 插件名：`dsh-super-kanban`
- 仓库：<https://github.com/topmindspace/dsh-super-kanban>
- 市场索引：<https://topmindspace.github.io/dsh-super-kanban/index.json>
- 许可证：[MIT](../LICENSE)

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| DeepSeek Harness | `>= 0.2.1-rc.5 < 0.3.0`（桌面版） |
| Node.js | `>= 22.19.0`（DSH 已自带，无需单独安装） |
| 账号 | 可选。不登录也能用本地规则分析；登录后可启用 AI 联网研判 |
| 本机 DSH Home | 至少打开过一次 DSH（存在 `~/.dsh/profiles/desktop`） |

> Windows 用户如遇到 `~` 路径问题，请在 Git Bash 或 WSL 中执行命令；DSH 桌面版本身的插件页安装不需要命令行。

## 1. 四种安装方式

### 方式 A：插件市场索引（推荐）

1. 打开 DSH → 左侧栏 **插件** → 顶部 **发现（Discover）**；
2. 点击 **添加索引源**，粘贴市场索引 URL：

   ```
   https://topmindspace.github.io/dsh-super-kanban/index.json
   ```

3. 在插件列表中找到 **Super Kanban**，查看版本、来源与作者；
4. 点击 **安装** → **启用**；
5. 回到主窗口按 `Cmd+R` 刷新。左侧栏出现「任务看板」即安装成功。

> 市场索引来自第三方（本仓库 `docs/`）。DSH 会在安装前提示信任风险，请确认来源为本仓库后再继续。
> 若索引 URL 暂时无法访问，说明首个版本尚未发布到 GitHub Pages，请改用方式 B/C/D。

### 方式 B：npm 包名

1. DSH → 插件 → **添加插件**；
2. 输入包名：`dsh-super-kanban`（可指定版本，如 `dsh-super-kanban@0.3.0`）；
3. 安装 → 启用 → 刷新窗口。

适合网络可以访问 npm registry 的用户。插件无第三方运行时依赖。

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
2. 在 profile 的 `package.json` 中登记依赖与 bundle；
3. 首次安装时备份原 profile 清单到 `super-kanban-profile-backup.json`。

安装完回到 DSH 窗口按 `Cmd+R`。若入口未出现，彻底退出并重启 DSH 一次。

> 想安装到其他 profile 或隔离 home：
>
> ```bash
> DSH_PROFILE=my-profile ./install.sh -y
> DSH_HOME="$HOME/.dsh-dev" ./install.sh -y
> ```

## 2. 验证安装

1. 左侧栏出现 **任务看板**（带看板图标）；
2. 点开后能看到看板标题、统计行与四列；
3. 在任意会话右上角出现看板小图标（右侧栏形态入口）；
4. DSH 插件页中 `dsh-super-kanban` 状态为已启用。

首次打开会触发一次增量扫描（约数秒）。扫描状态与结果可在看板右上角看到。

## 3. 升级

| 安装方式 | 升级方法 |
| --- | --- |
| 市场索引 | 插件页检查更新 → 更新 → 刷新窗口 |
| npm | 插件页重新安装目标版本（如 `dsh-super-kanban@0.3.1`） |
| Git | 插件页重新添加仓库，或让 DSH 拉取新 commit |
| 源码 | `cd dsh-super-kanban && git pull`，然后刷新窗口 |

升级不会清除看板数据。数据格式带版本号，旧版本数据会自动迁移（迁移失败会备份损坏文件并从空状态重建，不会阻塞插件启动）。

## 4. 卸载

- **插件页**：找到 Super Kanban → 禁用 / 卸载 → 刷新窗口。
- **源码脚本**：

  ```bash
  cd dsh-super-kanban
  ./uninstall.sh -y
  ```

卸载逻辑：恢复安装前的 profile 清单（若有备份）并移除链接。**看板数据保留**。

彻底清空请手动删除：

```bash
rm -rf ~/.dsh/storages/super-kanban
```

## 5. 数据位置

| 内容 | 路径 |
| --- | --- |
| 看板状态（任务 / 设置 / 扫描状态） | `~/.dsh/storages/super-kanban/state.json` |
| 会话分析缓存 | `~/.dsh/storages/super-kanban/sessions-cache.json` |
| 损坏文件备份 | `~/.dsh/storages/super-kanban/backups/` |
| 导出 | 看板设置 → 导出 JSON（`super-kanban-YYYYMMDD.json`） |

只读的数据源（插件不会修改）：`~/.dsh/storages/workspace.json`、`~/.dsh/sessions/**`、`~/.dsh/storages/session_projcache/**`。

## 6. 排障

| 现象 | 处理 |
| --- | --- |
| 左侧栏没有「任务看板」 | `Cmd+R` 刷新；仍没有则重启 DSH；再没有则到插件页看加载失败原因（版本不兼容、profile 清单错误等） |
| 有入口但面板空白 / 一直加载 | 确认 DSH 版本在兼容范围内；刷新一次；检查是否有其他插件冲突；查看 DSH 开发者控制台（如有）中的 `/super-kanban/api` 报错 |
| 卡片一直不更新 | 点扫描按钮手动触发；检查设置里「自动扫描」是否开启；确认会话在初始扫描天数内 |
| AI 一直不生效 | 设置里确认「AI 联网研判」开启；确认 DSH 已登录；未登录会提示「使用规则引擎分析」 |
| AI 调用失败 / 超时 | 插件会自动降级规则引擎，不会阻塞看板；恢复网络后下次扫描会重试 |
| 市场索引安装失败 | 确认索引 URL 可访问；或改用 npm / Git / 本地目录安装 |
| 升级 DSH 后插件失效 | DSH 大版本可能变更插件接口；先重装插件，仍不行请等待适配（数据不会丢） |
| 数据异常 / 想重来 | 备份并删除 `~/.dsh/storages/super-kanban/state.json`，重启后看板会重新扫描生成 |

更多安全与隐私说明见 README 的「AI 与隐私」一节；安全问题请按 [SECURITY.md](../SECURITY.md) 私下报告。

## 7. 开发者：隔离环境安装

不污染真实 `~/.dsh` 的推荐流程：

```bash
export DSH_HOME="$HOME/.dsh-dev"
dsh web --port 56790          # 首次运行会创建隔离 profile
./install.sh -y               # 当前 check-out 会被链接进该 profile
```

打开 `http://127.0.0.1:56790`，刷新窗口后从左侧栏打开「任务看板」。源码改动（host 半与 `client.js`）在刷新后生效。详见 [DEVELOPMENT.md](DEVELOPMENT.md)。
