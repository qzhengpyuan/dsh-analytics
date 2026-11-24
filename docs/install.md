# 安装与依赖

本插件自带 PSPP 引擎，**不需要**在系统里安装 PSPP；安装的是「插件包 + 引擎二进制」。

## 依赖矩阵

| 依赖 | 要求 | 是否必装 | 说明 |
| --- | --- | --- | --- |
| DeepSeek Harness | 0.2.x（core 0.2.1-rc 起验证） | 是 | 提供 Loader / 插件运行时 / Web GUI |
| `dsh-better-sidebar` | ^0.28.0 | 侧栏必装 | 只提供 `registerTab`；不装时面板页签不出现，`pspp_*` 工具仍可用 |
| Node.js | ≥ 20（实测 24.x） | 是 | host 半只用内置模块；client 半 `require('react')` 由 DSH 提供 |
| 平台 | Linux x64 · Windows x64（实测）；Linux arm64 · macOS arm64/x64（未验证构建） | 是 | Release 的 .tgz 带 `engine/linux-x64/` 与 `engine/win32-x64/`；其余平台用 `npm run engine:fetch` 从 `engine-v1` 拉 `engine-<platform>.tgz`，或按「引擎重建」自己编 |
| glibc | ≥ 2.28 | 是 | 引擎在 AlmaLinux 8（glibc 2.28）上编译，见「引擎重建」 |
| 磁盘 | 约 26 MB | 是 | `engine/linux-x64/` 23 MB + 代码与文档（portable 包 3 MB，装完再取引擎） |
| 系统 PSPP | — | **否** | 插件优先用包内 `engine/<平台>-<架构>/bin/pspp` |

npm 依赖：**无运行时 npm 依赖**。peer 只有 `@deepseek-ai/cordis` 与 `dsh-better-sidebar`（后者标 optional）。

## 安装（从 Release 的 .tgz 手工装）

每个版本都按平台挂 `dsh-analytics-pspp-<版本>-<平台>.tgz`（如 `-linux-x64`、`-win32-x64`，各自带对应平台的引擎，约 34 MB）；0.49.0 之前叫 `dsh-analytics-<版本>-<平台>.tgz`，0.31.5 及更早只有一个不带平台后缀的 `dsh-analytics-<版本>.tgz`：

```bash
# 1. 下载：到 releases/latest 页拿 dsh-analytics-<版本>-<平台>.tgz（下文以 0.32.0 的 linux-x64 为例）
curl -L -O https://github.com/qzhengpyuan/dsh-analytics/releases/download/v0.26.5/dsh-analytics-0.26.5.tgz

# 2. 装进目标 profile（<profile> = web / desktop …）
dsh plugin --profile <profile> add file:$PWD/dsh-analytics-<版本>-linux-x64.tgz

# 3. 让 profile 把这个包当成 bundle，它的 cordis.patch.yml 才会被读入：
#    编辑 ~/.dsh/profiles/<profile>/package.json，把 "dsh-analytics" 加进 dsh.profile.bundles
#    或者用 plugin_manager install_bundle 指向同一个 .tgz

# 4. 重载：设置 → 插件 → dsh-analytics 关一次再开（host 半重载；面板里已打开的数据集会清空）
```

校验：`sha256sum dsh-analytics-0.26.5.tgz` 应为 `1d03d471a91f4e5faebdff8252b1d86df39b0f9dc393b9c45fd4b339ce50651e`（每个版本的校验和写在它的 Release 说明里）。

这个 .tgz 已经在临时目录里 `pnpm add file:…` 验过：宿主半 `import('dsh-analytics')` 与预设半 `import('dsh-analytics/tools')` 都能解析，`engine/linux-x64/bin/pspp --version` 打印 `pspp (GNU PSPP) 2.1.3`。客户端半是浏览器模块（`window.__ModuleLoader__`），在 Node 里 import 会报 `window is not defined`，属正常。

**平台承诺**：`linux-x64` 与 `win32-x64` 是实测过的（本仓库全部测试 + Windows 10 独立复验）；`linux-arm64`、`darwin-arm64`、`darwin-x64` 的引擎在 `engine-v1` 里有产物（CI 构建成功），但**没有真机验证**，按「未验证构建」理解。

## 安装（一条命令，0.27.0 起）

Release 现在同时挂平台 tarball 与 `SHA256SUMS`（脚本会挑当前平台的包，没有就退到唯一那个）。仓库里的安装脚本把「下载 → 校验 → 装包 → 登记 bundle」串起来：

```bash
git clone https://github.com/qzhengpyuan/dsh-analytics.git && cd dsh-analytics
node scripts/install.mjs web                    # 干跑：下载、比对 SHA256SUMS、打印下面两步
node scripts/install.mjs web --apply            # 真的装进 profile「web」
node scripts/install.mjs desktop --apply        # 换 profile 就把第一个参数换掉
node scripts/install.mjs --offline /path/to/dsh-analytics-pspp-<版本>.tgz   # 不联网
```

要点：

- **token（可选）**：仓库 2026-11-18 起已公开，匿名即可下载；脚本仍按 `GITHUB_TOKEN` / `GH_TOKEN` → `~/.dsh/.credentials.yaml` 的 `refs.GITHUB_TOKEN` 顺序找，找到就带上（匿名限流时更稳），找不到也照常下载。
- **profile 名**：不写就用唯一的那个；机器上有多个 profile 时脚本会报错并列出名字（以前写死 `web`，在只有 `desktop` 的机器上会装进不存在的 profile）。
- **代理**：Node 的 `fetch` 默认不读代理变量，走代理要 `NODE_USE_ENV_PROXY=1 https_proxy=… node scripts/install.mjs`。
- **按最新发布取版本号**：脚本读 `releases/latest` 的 tag，不写死版本；`SHA256SUMS` 里有这个资产就比对，没有就打印校验和并提示「未能自动比对」（0.27.0 起的发布都有）。
- **改 profile 前先备份**：往 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 里加 `dsh-analytics` 之前，会先写一份 `package.json.before-dsh-analytics`。
- 装完仍要**停→启一次插件**（设置 → 插件 → dsh-analytics）让宿主半换到新代码；面板里已打开的数据集会清空。

## 安装（目录直装，已验证）

```bash
# 1. 把包放到任意目录，例如
<项目目录>

# 2. 在 DSH 里安装（会写 profile 的 cordis.patch.yml）
#    —— 走插件管理器 UI 或对话里的 plugin_manager 工具：
plugin_manager install_bundle <项目目录>
```

装完检查：

- Loader 里出现 entry `include:analytics`（`plugin_manager list_plugins` 可见 `dsh-analytics`）
- 新建会话时预设选择器里出现 **统计分析**（`preset-analytics`）；选中它之后对话里出现 32 个工具：`pspp_status` `pspp_open` `pspp_new` `pspp_variables` `pspp_data` `pspp_run` `pspp_run_file` `pspp_analyze` `pspp_transform` `pspp_chart` `pspp_edit_chart` `pspp_export_chart` `pspp_save` `pspp_convert` `pspp_export` `pspp_export_document` `pspp_export_office` `pspp_merge` `pspp_add_variable` `pspp_append_cases` `pspp_publication_table` `pspp_pairwise` `pspp_partial` `pspp_cox` `pspp_discriminant` `pspp_cluster` `pspp_timeseries` `pspp_multinomial` `pspp_ordinal` `pspp_poisson` `pspp_wls` `pspp_twostage`
- 别的预设（standard / Blender / 逆向渗透 / 小说…）的会话里**没有**任何 `pspp_*` 工具——这是刻意的，见 README「Agent 工具」
- 调用 `pspp_status` 应返回 `engine.source: "bundled"`、`engine.version: "pspp (GNU PSPP) 2.1.3"`，`engine.binary` 指向 `engine/linux-x64/bin/pspp`
- 刷新页面后，右侧栏页签条出现 **PSPP**

## 分发（打 tgz）

两种包，用同一个脚本产出，文件名带后缀区分：

```bash
cd <项目目录>
npm run pack            # → dsh-analytics-<版本>-<平台>-<架构>.tgz（自带引擎，实测 13 MB）
npm run pack:portable   # → dsh-analytics-<版本>-portable.tgz（不含引擎，实测 3.0 MB）
```

- **自带引擎版**：解包即用，只能给同一平台（`engine/<平台>-<架构>/`）。本机这份压缩后 13 MB。
- **通用版**：装完在插件目录跑一次 `npm run engine:fetch` 取回本机平台的引擎（9.8 MB）。仓库已公开，匿名即可；有 `GITHUB_TOKEN` 或 `~/.dsh/.credentials.yaml` 里的 `refs.GITHUB_TOKEN` 时脚本会自动带上。

安装（两种包一样，用一个空目录当宿主）：

```bash
mkdir -p ~/dsh-plugins && cd ~/dsh-plugins
npm init -y
npm install ./dsh-analytics-pspp-<版本>-linux-x64.tgz     # 或 portable 版
# 通用版再补引擎：
(cd node_modules/dsh-analytics && npm run engine:fetch)
```

然后在 DSH 里 `plugin_manager install_bundle ~/dsh-plugins/node_modules/dsh-analytics`。

已验证（2026-11-04）：两种 tgz 都能 `npm install` 进空项目；`import('.../dsh-analytics-pspp/index.js')` 导出 `apply/inject/name`；自带引擎版直接 `pspp --version` → `pspp (GNU PSPP) 2.1.3`；通用版 `engine:fetch` 后同样可跑，可执行位保留。

tgz 里带着 GPLv3 引擎，分发时务必保留 `engine/<平台>/COPYING` 与 `NOTICE`。

## 卸载

```bash
# 在 DSH 里
plugin_manager remove_bundle dsh-analytics
```

会话数据（数据集、语法、输出、图表）在 `~/.dsh/analytics/<sessionId>/`，卸载不会自动删；确认不需要后手工删。

## 引擎重建

引擎目录按平台分：`engine/<process.platform>-<process.arch>/{bin,libexec,lib}`。`bin/` 里是启动器（设置动态库搜索路径后 exec `libexec/` 的真二进制），`lib/` 是随包的全部共享库（不含 glibc 本体）。

### 路线一：从系统 PSPP 直接抓（最快，可移植性 = 本机 glibc）

```bash
sudo dnf install pspp                       # 其他发行版对应包名
cd <项目目录>
npm run bundle-engine                        # 写 engine/<本机平台>-<架构>/
node scripts/bundle-engine.mjs --from /usr/bin/pspp   # 指定别的二进制
```

### 路线二：在旧发行版容器里编译（发布用，glibc 门槛低）

随包这份就是这么来的，一条命令可重现（需要 podman 或 docker）：

```bash
bash scripts/build-engine-almalinux8.sh                    # linux-x64
bash scripts/build-engine-almalinux8.sh --engine-arch arm64 --platform linux-arm64
```

脚本内部在 AlmaLinux 8 里 `./configure --prefix=/work/out && make install`，把 libtool 塞进 `lib/pspp/` 的私有库拍平、按 `ldd` 收集依赖、strip，再用 `--from-prefix` 导入。容器脚本本体是 `scripts/build-pspp-inner.sh`，CI 也复用它。

手动分两步也行（容器里编 prefix，宿主侧导入）：

```bash
podman run --rm -v "$PWD/build/engine-prefix:/work/out:Z" \
  -v "$PWD/scripts/build-pspp-inner.sh:/build/build-pspp.sh:ro,Z" \
  docker.io/library/almalinux:8 bash /build/build-pspp.sh
node scripts/bundle-engine.mjs --from-prefix build/engine-prefix --platform linux-x64
```

> `MAKEINFO=true` 是躲开 `makeinfo does not support @clicksequence`；`--without-perl-module` 是躲开 `Config::Perl::V`。AlmaLinux 8 的默认仓库没有 `texinfo` 包，所以不能靠装它解决。
>
> 两个坑：libtool 把 PSPP 自己的库装进 `lib/pspp/` 并把该路径写死成 RPATH，必须拍平否则启动器找不到；glibc 家族**绝不能**跟着复制（宿主 glibc 版本不同会直接段错误），脚本里有排除名单。

### 自检

```bash
engine/linux-x64/bin/pspp --version
objdump -T engine/linux-x64/lib/*.so* | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1   # 应为 GLIBC_2.28
npm test
sudo unshare -m sh -c 'mount -t tmpfs none /usr/lib64/pspp; mount -t tmpfs none /usr/share/pspp; cd /tmp && env -i <项目目录>/engine/linux-x64/bin/pspp -o /tmp/u.html /tmp/t.sps'
```

打包脚本会跳过 glibc 家族（libc/libm/libpthread/libdl/librt/libresolv/libcrypt 等），改用宿主 glibc —— 把发行版 glibc 塞进 `LD_LIBRARY_PATH` 在别的系统上必然出问题。

**可移植性**：引擎能跑的最低 glibc = **构建机**的 glibc。当前随包产物在 AlmaLinux 8 上编译，`GLIBC_2.28`，覆盖 RHEL/Alma/Rocky 8+、Ubuntu 18.10+/20.04+、Debian 10+、openSUSE Leap 15+。要更旧（CentOS 7 = 2.17、Ubuntu 18.04 = 2.27）就换更老的基线镜像重跑上面的流程。

### macOS / Windows

仓库里只带 `linux-x64`，另四份由 CI 产出（`.github/workflows/build-engine.yml`，三个平台并行的预编译产物矩阵，tag `engine-v*` 时自动挂到 Release）：

| 平台 | 怎么编 | 脚本 |
| --- | --- | --- |
| `linux-x64` / `linux-arm64` | AlmaLinux 8 容器（glibc 2.28）；arm64 走 binfmt 模拟 | `scripts/build-engine-almalinux8.sh --engine-arch arm64` |
| `darwin-arm64` / `darwin-x64` | 在 macOS 上从源码编（Homebrew 无 pspp formula），依赖用 `install_name_tool` 全改成 `@loader_path` | `scripts/build-engine-macos.sh` |
| `win32-x64` | MSYS2 MINGW64 从源码编（MSYS2 无 pspp 包、上游不发 Windows 二进制），DLL 收到 `lib/`，启动器是 `bin/pspp.cmd`（把 `lib/` 前置进 `PATH`） | `scripts/build-engine-windows.sh` |

装到别的机器上，不用自己编，从 Release 拉对应平台的那份即可：

```bash
npm run engine:fetch                      # 本机平台
node scripts/fetch-engine.mjs --platform darwin-arm64   # 指定平台
node scripts/fetch-engine.mjs --tag engine-v2 --force   # 换 Release / 覆盖已有引擎
```

脚本按 `engine-v*` tag 找到 Release、下载 `engine-<platform>.tgz`、先解到临时目录验证 `bin/pspp` 存在再替换 `engine/<platform>/` —— 下载失败不会把现有引擎删掉。私有仓库需要 token：环境变量 `GITHUB_TOKEN`，或 `~/.dsh/.credentials.yaml` 的 `refs.GITHUB_TOKEN`（本机已有），公开仓库可匿名。

手动安装等价于：把 `engine-<platform>.tgz` 解到插件目录，使 `engine/<platform>-<arch>/` 存在，`lib/engine.js` 按 `process.platform-process.arch` 自动选中。

发版流程：`git tag engine-v1 && git push origin engine-v1` → CI 五条腿全跑 → 自动建 Release 并挂上 `dist/*.tgz`。macOS / Windows 三条腿目前标了 `continue-on-error`（首次跑通前算实验性），Linux 两条是稳定的。

## 规模与性能

实测（Fedora 44 x86-64、单会话）：1 万例 × 7 变量 CSV 导入 473 ms；5 万例 1400 ms；5 万例另存 .sav 1108 ms（2.6 MB）、重开 709 ms；27 张表 + 2 张图导出 docx 573 ms（10.9 MB）/ xlsx 591 ms（8.5 MB）；3 个会话并发各跑一次回归互不干扰。

配置项（`cordis.patch.yml` 的 `analytics.config`）：

```yaml
maxRows: 200000      # 导入上限，超过截断并在状态里标 truncated
timeoutMs: 120000    # 单个引擎进程超时
evictIdle: true      # 释放空闲会话的数据集（默认开）
maxIdleMs: 1800000   # 空闲多久释放（默认 30 分钟）
```

空闲回收只清内存里的数据行，`~/.dsh/analytics/<session>/work.sav` 与用户保存的文件都不动；下次请求自动重开。跑过 5 万例的会话如果一直留着，会持续占用几十 MB。

矩阵超过 500 行的表会自动附注（多半是连续变量放进了频率表）；这类表导出 Word 会很大，请改用描述统计。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 侧栏没有「统计分析」页签 | 没装 `dsh-better-sidebar`，或页面没刷新 | 装 better-sidebar；刷新页面（client 走 combo 的 rev 缓存） |
| 面板空白 / 请求 401 | 浏览器认证围栏，页面请求必须带宿主 cookie | 从 DSH 页面内打开；curl 直连需要宿主 cookie |
| `pspp_status` 报引擎不存在 | `engine/<平台>-<架构>/bin/pspp` 丢失或平台目录不存在 | 先 `npm run engine:fetch` 拉对应平台产物；仍不行再在本机重建，或配置 `engineDir` 指向可用引擎 |
| 引擎报 `GLIBC_2.xx not found` | 宿主 glibc 比构建机更旧 | 换更老的基线镜像重建引擎 |
| 改 host 代码不生效 | 插件已加载进内存 | `plugin_manager` 先禁用再启用 `include:analytics` |

## 维护者发版（实测经验）

```bash
npm test && npm run pack                 # pack 才带引擎；npm run pack --with-engine 会报 Unknown cli flag
sha256sum dsh-analytics-<版本>-linux-x64.tgz | tee SHA256SUMS
git tag v<版本> && git push origin master v<版本>
gh release create v<版本> --title … --notes-file …
# 资产用 REST 传（/tmp 下的文件 gh 会报文件系统边界）；大文件必须关掉 Expect，
# 否则经代理会 0 字节发出、GitHub 回 408 "Upload body timed out due to inactivity"
curl -H "Expect:" -X POST -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/octet-stream" \
     --data-binary @dsh-analytics-<版本>-linux-x64.tgz \
     "https://uploads.github.com/repos/<owner>/<repo>/releases/<releaseId>/assets?name=…"
```

- Release 资产名必须是 `SHA256SUMS`（`scripts/install.mjs` 按这个名字比对）。
- 传之前先解包自查 `package/cordis.patch.yml` 里 `registerTools` 仍为 `false`（`scripts/pack.mjs` 也会查，但产物要自己再确认一次）。
- 仓库已公开，Release 资产匿名可下；网络受限的机器仍可把 tgz 放到共享目录让它 `dsh plugin add file:…`。

## 许可

- 插件 JavaScript：MIT（`LICENSE`）
- 随包引擎 `engine/<平台>/`：GNU PSPP 2.1.3，GPLv3+（`engine/<平台>/COPYING`），源码获取方式见 `NOTICE`

两者是独立进程关系（插件 spawn 系统外部的 pspp 二进制），但**再分发整个包**时要一并满足 GPLv3 的源码提供义务。
