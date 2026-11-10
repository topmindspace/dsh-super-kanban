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
| npm 包 | `dsh-super-kanban`（npm latest） | 由 GitHub Actions 在打 tag 时自动发布（需仓库 Secret `NPM_TOKEN`） |
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

仓库 Settings → Pages 使用 **Deploy from a branch**（`main` / `/docs`），页面地址为 `https://topmindspace.github.io/dsh-super-kanban/`。

- `docs/index.html` 是真实对外落地页，`docs/index.json` 是被 Discover 拉取的索引；
- `docs/.nojekyll` 关闭 Jekyll 处理，保证 `index.json` 与静态资源按原样发布；
- 市场索引在推送 tag 前生成并与版本一起提交，Pages 随 `main` 自动更新；
- CI 的 `npm run check:docs` 会校验落地页（`lang`、`<title>`、指向 `./index.json` 的链接、
  `.nojekyll`、无硬编码版本号、本地资源存在），防止页面提前失效。

> 落地页显示的"当前版本"由页面在运行时 `fetch("./index.json")` 读取，不在 HTML 里写死，
> 因此版本升级不需要改 `docs/index.html`。

### 方式 B：npm 包名

DSH → 插件 → 添加插件 → 输入包名：`dsh-super-kanban`（安装 npm latest），或写**精确版本**（如 `dsh-super-kanban@0.6.1`，升级时推荐）→ 安装 → 启用 → 刷新。

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
- 手动使用范围依赖时，`^0.5.0` 只解析 0.5.x。升级到 0.6.x 请安装目标精确版本。
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
      // 也可选填 "defaultVersion": "0.5.2" 指定默认版本。
      "versions": [                              // 索引中的全部可用版本（新版本由维护者生成）
        {
          "version": "0.5.2",
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

维护者按仓库保护规则向 main 提交发布版本。普通改动通过 PR，并由 Node 22.19、Node 24 的 CI 和审批把关。

1. 同步远端 main，更新 package.json、CHANGELOG.md、支持版本与安装示例。提交版本代码，保持工作区干净。
2. 运行 npm run release。辅助脚本生成索引，指向已提交的版本代码，并执行仓库检查。
3. 提交生成的 docs/index.json 与 docs/icon.svg，打版本 tag。一次推送 main 和本次 tag。
4. 发布工作流检查 tag、包版本和索引指向，发布 npm 包，使用 CHANGELOG 对应版本内容创建 GitHub Release。
5. 核对 Release、npm 精确版本和公开市场索引。工作流保留最近三个 Release 页面，历史版本 tag 继续保留。

```bash
npm run release
git add docs/index.json docs/icon.svg
git commit -m "chore: refresh market index"
release_version=$(node -p "require('./package.json').version")
git tag -a "v$release_version" -m "v$release_version"
git push --atomic origin HEAD:refs/heads/main "refs/tags/v$release_version"
npm view "dsh-super-kanban@$release_version" version
```

发布步骤通过仓库 Secret `NPM_TOKEN` 读取有发布权限的 npm 细粒度访问令牌。重跑时若 npm 精确版本已存在，工作流先核对它的 Git commit。

### 索引提交与校验

索引可指向 tag 之前的版本代码提交。工作流检查该提交属于 tag 的历史，且包版本一致。若需更正索引，用目标版本代码的 SHA 运行 `npm run market:index -- --commit=<sha>`，按仓库保护规则更新 `main`。

### npm staged release 批准

常规工作流运行 `npm publish`。若维护者另行使用 staged publishing，需在 npm 的 Staged Packages 页面审核并用 2FA 批准。也可用 npm CLI 11.15.0 及以上的 `npm stage approve <stage-id>`。见 [npm staged publishing](https://docs.npmjs.com/staged-publishing/)。

## 6. 索引来源

Super Kanban 的索引由本仓库维护，通过 GitHub Pages 提供。DSH 的发现页读取添加的索引并展示版本，Git 安装使用索引记录的提交。

## 7. 安全与信任

- 市场索引内容来自第三方，DSH 会在安装前提示信任风险；用户应自行确认来源（本仓库）。
- 看板只读本机会话并在本地保存任务。AI 研判和主动触发的草稿润色经 DSH 发给配置的模型服务。数据范围见 [SECURITY.md](../SECURITY.md)。
- 发布物不包含任何凭证；仓库 CI 会运行隐私扫描（`scripts/check-privacy.mjs`）阻止个人路径/密钥进入 Git。
