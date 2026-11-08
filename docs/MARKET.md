# 发布与分发（Marketplace & Distribution）

本文说明 **Super Kanban 如何分发给其他 DSH 用户**，以及维护者的发布流程。

## 1. DSH 的插件分发机制（事实说明）

DSH 当前**没有内置的公共插件商店**。它的插件分发有四种官方支持的路径：

| 路径 | 说明 | 适合 |
| --- | --- | --- |
| **插件市场索引（Discover）** | DSH「插件 → 发现」支持添加第三方 **市场索引 URL**（一个 format 1 的 JSON），用户可浏览、查看版本与来源、一键安装 | 普通用户（推荐） |
| **npm 包名** | 「插件 → 添加插件」输入 npm 包名（及版本），要求包内声明 `dsh.bundle` / `dsh.client` | 已发布 npm 的插件 |
| **Git 仓库** | 输入 Git 地址（提交被 pin 到 commit），要求仓库根目录是插件包 | 未发布 npm / 想跟进 main |
| **本地目录** | 输入本机插件包目录，适合开发与内部安装 | 开发者 |

> 官方随 DSH 安装附带的插件（`@deepseek-ai/*`）属于内置 on-demand 目录，第三方插件目前**不能直接提交进该目录**；第三方分发实际走上面的索引 / npm / Git / 本地目录四条路径。

## 2. 我们提供的分发物

| 分发物 | 地址 / 名称 | 状态 |
| --- | --- | --- |
| 市场索引（Discover 用） | `https://topmindspace.github.io/dsh-super-kanban/index.json` | 已上线（GitHub Pages，经典「从分支部署」：`main` 分支 `/docs`；Release 后由 workflow 自动更新索引并提交） |
| npm 包 | `dsh-super-kanban`（npm latest） | 由 GitHub Actions 在打 tag 时自动发布（需仓库 Secret `NPM_TOKEN`）；发布可能进入 staged 待批准 |
| Git 仓库 | `https://github.com/topmindspace/dsh-super-kanban` | 公开 |
| 本地/手动安装 | 仓库内 `./install.sh` | 可用 |

## 3. 用户怎么安装（给其他用户）

### 方式 A：市场索引（Discover，推荐）

> Discover 来自 DSH 的**实验性插件市场**，部分发行版默认关闭。先在「插件 → 实验性插件」中启用 **插件市场 / Plugin market**，按提示重载 DSH；「插件」页出现 **发现（Discover）** 标签即可继续。

1. DSH → **插件** → **发现（Discover）**
2. **添加索引源**，粘贴：`https://topmindspace.github.io/dsh-super-kanban/index.json`
3. 在列表中选中 **Super Kanban** → 打开详情页（`versions` 里会列出索引中的全部可用版本）→ **安装** 目标版本 → 启用 → 刷新窗口（`Cmd+R`）

> 如果你的 DSH 版本还没有 Discover 能力，直接使用方式 B（npm）或方式 C（Git 仓库）。

### GitHub Pages 发布路径（维护者事实）

落地页与索引**不是**用 GitHub Actions 部署的：仓库 Settings → Pages 使用经典模式
**Deploy from a branch**（`main` / `/docs`），页面地址为
`https://topmindspace.github.io/dsh-super-kanban/`。因此：

- `docs/index.html` 是真实对外落地页，`docs/index.json` 是被 Discover 拉取的索引；
- `docs/.nojekyll` 关闭 Jekyll 处理，保证 `index.json` 与静态资源按原样发布；
- **不需要也不应添加** `.github/workflows/pages.yml`：改为 Actions 部署会改变 Pages 的发布来源
  （需要仓库设置切换为 GitHub Actions），与现有经典部署冲突，且对"几 KB 静态文件"没有收益；
- Release workflow 的 `market-index` job 在发布成功后重新生成 `docs/index.json` 并提交到 `main`，
  Pages 会随 `main` 的新 commit 自动重建；
- CI 的 `npm run check:docs` 会校验落地页（`lang`、`<title>`、指向 `./index.json` 的链接、
  `.nojekyll`、无硬编码版本号、本地资源存在），防止页面提前失效。

> 落地页显示的"当前版本"由页面在运行时 `fetch("./index.json")` 读取，不在 HTML 里写死，
> 因此版本升级不需要改 `docs/index.html`。

### 方式 B：npm 包名

DSH → 插件 → 添加插件 → 输入包名：`dsh-super-kanban`（安装 npm latest），或写**精确版本**（如 `dsh-super-kanban@0.5.1`，升级时推荐）→ 安装 → 启用 → 刷新。

### 方式 C：Git 仓库

插件 → 添加插件 → 粘贴 `https://github.com/topmindspace/dsh-super-kanban` → 安装（DSH 会 pin 到具体 commit）→ 启用 → 刷新。

### 方式 D：本地目录

插件 → 添加插件 → 选择本地目录（本仓库根目录）→ 安装 → 启用 → 刷新；或直接运行仓库内 `./install.sh`。

安装完成后：左侧栏出现「任务看板」；会话右上角出现看板图标（右侧栏形态）。

### 从市场升级（用户视角）

市场（Discover）只负责**展示版本并执行安装**，**没有自动升级动作**：不会在后台替换已安装版本。第三方插件也没有插件页的「更新」按钮（该按钮只给按需安装的官方插件），DSH 对第三方插件的提示是「其他插件请先卸载再安装新版」。

因此从市场升级的流程是：

1. 插件 → 已安装 → Super Kanban → **卸载**；
2. 插件 → 发现 → 打开 Super Kanban 详情页：`versions` 会列出索引里的全部可用版本（新版本随每次 Release 更新索引后出现）；
3. 在版本列表里**选择目标版本** → **安装** → **启用** → 刷新窗口（必要时完全退出 DSH 再打开）。

注意：

- 插件页安装 npm/市场来源会用 `pnpm add --save-exact`，把**精确版本**写入 profile 依赖；所以升级需要重新安装目标版本，而不是只点一下刷新。
- 若 profile 里被人为改成**范围依赖**：`^0.5.0` 可自然解析到 0.5.x 补丁版（0.5.1…），但 `^0.4.0` 永远不会解析到 0.5.x —— 跨 minor 升级必须安装**精确版本**（如 `dsh-super-kanban@0.5.1`）。
- 市场索引由 Release workflow 在发布成功后自动重新生成并提交 `docs/index.json`（维护者也可手动 `npm run market:index`）；索引未刷新时，详情页看不到新版本。

更完整的用户升级/验证/回滚步骤见 [INSTALL.md](INSTALL.md#3-更新插件升级)。

## 4. 市场索引格式（format 1）

索引是单个 JSON 文件，由 DSH 的 `@deepseek-ai/dsh-plugin-market-index` 校验。核心结构：

```jsonc
{
  "format": 1,
  "title": { "en": "Super Kanban Market", "zh": "Super Kanban 市场" },
  "description": { "en": "…", "zh": "…" },
  "metadata": {
    "categories": { "productivity": { "title": { "en": "Productivity", "zh": "效率" } } },
    "labels": { "kanban": { "title": { "en": "Kanban", "zh": "看板" } } },
    "sortKeys": {}
  },
  "plugins": [
    {
      "name": "dsh-super-kanban",
      "title": { "en": "Super Kanban", "zh": "Super Kanban 任务指挥台" },
      "description": { "en": "…", "zh": "…" },
      "icon": "./icon.svg",                       // 相对索引 URL 解析
      "author": "topmindspace",
      "homepage": "https://github.com/topmindspace/dsh-super-kanban#readme",
      "repository": { "url": "https://github.com/topmindspace/dsh-super-kanban" },
      "metadata": { "category": "productivity", "labels": ["kanban"], "keywords": ["dsh", "kanban"] },
      // 详情页默认展示 versions 中的第一个（按版本号从新到旧排列）；
      // 也可选填 "defaultVersion": "0.5.1" 指定默认版本。
      "versions": [                              // 索引中的全部可用版本（新版本由维护者生成）
        {
          "version": "0.5.1",
          "publishTimestamp": 1794000000,          // Unix 秒
          "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0" },
          "source": { "type": "npm" }              // 或 { "type": "git", "url": "...", "commit": "<40位 SHA>" }
        },
        {
          "version": "0.4.1",                    // 历史版本保留，便于回滚/固定版本安装
          "publishTimestamp": 1793700000,
          "engines": { "dsh": ">=0.2.1-rc.5 <0.3.0" },
          "source": { "type": "git", "url": "...", "commit": "<40位 SHA>" }
        }
      ]
    }
  ]
}
```

维护者更新索引：`npm run market:index`（脚本读取 `package.json` 与 git HEAD 生成 `docs/index.json`；`--source=npm` 切到 npm 源），提交后 GitHub Pages 自动更新。

## 5. 发布流程（维护者）

`main` 分支已启用 **branch protection**：

- 禁止 force push，禁止删除 `main`；
- PR 必须通过 CI 状态检查（`Node 22.19` 与 `Node 24` 两个矩阵 job）并至少获得 **1 个 approving review** 才能合并（仅具备 write 权限的人可审批/合并；当前只有维护者）；
- 管理员 / 维护者可按本流程直接向 `main` 提交发版 commit 并推送 tag（tag 必须与 `package.json` 版本一致）；
- 发布后只保留最近 **3 个 GitHub Release 页面**（由 release workflow 自动清理，tag 与 commit 保留，历史版本 pin 与旧 CHANGELOG 链接仍可用）。

发布分「本地准备」与「GitHub Actions 发布」两段：

1. **版本变更**：`package.json` + `CHANGELOG.md` 同步，提交到 `main`，保持工作区干净。
2. **本地发布辅助**：`node scripts/release.mjs`（或 `npm run release`）。脚本要求工作区干净，会重新生成
   `docs/index.json`，依次运行 test / validate / check:privacy / check:docs / check:version，并打印下一步命令。
3. **提交索引**：若脚本提示索引有变化，`git add docs/index.json docs/icon.svg && git commit -m "chore: refresh market index for vX.Y.Z"`。
4. **打 tag 并推送**：`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main --tags`。
5. **release workflow**：`.github/workflows/release.yml` 由 tag 触发，校验 tag 与 `package.json` / `CHANGELOG` 版本，
   依次运行各单项检查，`npm publish`（带 provenance），创建 GitHub Release，并把概览页清理到最近 3 个 Release；
   发布成功后由 `market-index` job 重新生成索引并回写 `main`。

> 前置条件：仓库 Secret `NPM_TOKEN` 已配置（npm automation token，具备 `dsh-super-kanban` 发布权限）；
> 缺失时 workflow 的 publish job 会显式失败，而不是静默跳过发布。

```bash
# 0. 版本变更（package.json + CHANGELOG.md 必须同步）
npm version 0.5.1 --no-git-tag-version   # 只改 package.json 的版本号（版本号以本次发布为准）
#   - 在 CHANGELOG.md 顶部添加 "## [0.5.1] - YYYY-MM-DD" 与底部 tag 链接
#   - 提交这一步，使工作区保持干净
git add package.json CHANGELOG.md && git commit -m "chore: release v0.5.1"

# 1. 本地发布辅助：重新生成索引 + 全量检查（要求工作区干净）
node scripts/release.mjs

# 2. 提交索引（若 release.mjs 提示有变化）
git add docs/index.json docs/icon.svg && git commit -m "chore: refresh market index for v0.5.1"

# 3. 打 tag 并推送 → 触发 release workflow
git tag -a v0.5.1 -m "v0.5.1"
git push origin main --tags
```

> 脚本支持 `--dry-run`：只做检查与索引 schema 校验（不比对已提交索引的 commit pin），不写文件。
> **不要** force push 或删除 `main`；tag 必须与 `package.json` 版本一致，否则 release workflow 会在 verify 阶段失败。
> 本地直接 `npm publish` 仍可作为应急手段（需要 npm 登录），但推荐走 CI 以保留 provenance 与 GitHub Release。

### 保护分支下的索引回写

`market-index` job 需要在 `main` 上提交一次索引更新。若 branch protection 阻止 GitHub Actions bot 推送
（例如要求所有提交走 PR，或禁止 bot 直推），该 job 会失败但被 `continue-on-error: true` 跳过，npm 发布与
GitHub Release 不受影响。此时手动补索引：

```bash
npm run market:index
git add docs/index.json docs/icon.svg
git commit -m "chore: update plugin market index for v0.5.1"
git push origin main
```

推送同样受保护规则约束：管理员可直接推送；普通贡献者需通过 PR（由维护者合并后索引才算刷新）。

### npm staged release 批准（首次发布/开启 staged publishing 时）

GitHub Actions 的 `npm publish` 成功后，npm 可能先把该版本置为 **staged release**（registry 暂时显示 `0.0.0-stage` 占位、包不可安装），需要包所有者用 2FA 批准后才会上线（通常几分钟内自动放行；若未放行按下面步骤手动批准）。批准需要 npm CLI v11+ 与已登录的维护者账号：

```bash
npx npm@11 login                       # 使用包所有者账号（需 2FA）
npx npm@11 stage list                  # 列出 staged 包，找到 dsh-super-kanban@<version> 的 stage-id
npx npm@11 stage approve <stage-id>    # 输入 OTP 完成审批，版本即刻上线
```

批准后验证：`npm view dsh-super-kanban version` 返回本次发布的版本号。若不需要人工审批，可在 npm 包设置中关闭 staged publishing（或改用 trust relationship + `allow-publish`）。在上述批准完成前，市场索引使用 **Git source** 安装，不受影响。

发布后检查：

1. npm：`npm view dsh-super-kanban version`；
2. Release：GitHub Releases 出现对应 tag；
3. 市场：`https://topmindspace.github.io/dsh-super-kanban/index.json` 可访问且 `parseMarketIndex` 校验通过；
4. 用一个干净的 DSH 环境按「方式 A」安装一次验证。

## 6. 关于「进入官方推荐 / 收录」

- 当前 DSH 没有面向第三方插件的官方公共索引；官方内置的是随安装附带的插件目录。
- 若后续官方开放收录入口，可用下面的材料提交（issue / 官方渠道）：
  - 名称：Super Kanban（`dsh-super-kanban`）
  - 仓库：https://github.com/topmindspace/dsh-super-kanban
  - 索引：https://topmindspace.github.io/dsh-super-kanban/index.json
  - 兼容：DSH `>=0.2.1-rc.5 <0.3.0`（在 0.2.1-rc.5 桌面版验证）
  - 许可证：MIT
  - 功能一句话：从 DSH 会话自动研判任务目标/进度/完成与问题，支持会话联动、子任务与产物追溯。
- 请在官方仓库的 issue / 社区渠道说明你的插件与索引地址；**不要伪造官方背书**（市场索引本身是第三方内容，DSH 会有信任提示）。

## 7. 安全与信任

- 市场索引内容来自第三方，DSH 会在安装前提示信任风险；用户应自行确认来源（本仓库）。
- 插件只读本机 DSH 会话；AI 研判请求经 **DSH 原生模型服务**发出，目标是你在 DSH 中配置的模型服务商（官方账号 / API Key / 第三方 provider），凭证由 DSH 管理、插件不读取不保存。看板自身无遥测；除发往该模型服务商的 AI 请求外，不向其它服务器发送数据。选择第三方模型时压缩会话摘要会发送给该服务商，数据内容与边界见 [SECURITY.md](../SECURITY.md)。
- 发布物不包含任何凭证；仓库 CI 会运行隐私扫描（`scripts/check-privacy.mjs`）阻止个人路径/密钥进入 Git。
