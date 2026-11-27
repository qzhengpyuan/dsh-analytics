# 交接说明（换会话接手时先读这一页）

> 面向：接手开发的会话（人或 agent）。读完这一页应当能：跑测试、发一版、知道下一步做什么、不踩已知的坑。
> 项目定位与能力边界在 [SCOPE.md](SCOPE.md)，逐版过程在 [CHANGELOG.md](CHANGELOG.md)，排期在 [PLAN.md](PLAN.md)。

## 1. 现状（交接时的事实，会很快过期 —— 用命令核）

```bash
cd /mnt/E/code/dsh-analytics
git log --oneline -3            # 最新提交
node -e "console.log(require('./package.json').version)"
grep -m1 '^## ' docs/CHANGELOG.md   # CHANGELOG 首段应当等于上面的版本号
npm test > /tmp/full.log 2>&1; echo EXIT=$?   # 约 7 分钟；判据是 EXIT=0，
                                # 条数用 grep -cE '^ok' /tmp/full.log（末行是最后那个套件自己的 summary，不是总数）
```

- 工作树必须干净（`git status --short` 无输出）。**发版前先确认干净**，不要把上一批的残留带进 tag。
- 引擎不在 Git 里（`engine/linux-x64`、`engine/win32-x64`、`engine/darwin-*`）；克隆新副本后若缺，`npm run engine:fetch` 从 `engine-v1` Release 拉。
- 本机已装的插件版本靠热重载跟上（见 §3），**从不重启 dsh web**。

## 2. 一批怎么做完（节奏与判据）

用户定的节奏：**一批 = 一个主题、10 条以上改动、1–3 天**；批内做完跑全量测试与自检，才发一次版；发布后再派**独立子代理**复验（Win10 侧额度已于 2026-11-25 耗尽，改由本机子代理），复验报告回来一次修完 P0–P2，再开下一批。

新功能/修复的验收标准（三条都要满足，缺一条不算做完）：

1. 有断言，且**做过删除式变异验证**（把修复删掉要变红，日志贴进报告）。
2. 真引擎路径有 `test/smoke.mjs` / `test/routes.mjs` 覆盖（纯函数套件不算）。
3. 文档三处同步：`CHANGELOG.md`（新版本段）、`FEATURES.md`（版本戳 + 能力 + 断言计数）、`PLAN.md`（§2 加一行、§3 挪条目）。`test/docs.mjs` 会拦版本戳与链接漂移。

## 3. 发布链（每版照抄，顺序不能改）

```bash
cd /mnt/E/code/dsh-analytics
npm test                                   # 必须 EXIT=0
grep -cE '^ok' /tmp/full.log               # 断言数（口径：只数 ok 行）
# 1) 文档三处 + package.json 版本
git add -A && git commit -q -F /tmp/msg.txt && git tag vX.Y.Z
# 2) push 分两步（一次带 tag 偶发被拒）
env -u https_proxy -u http_proxy -u all_proxy GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 push origin master
env -u https_proxy -u http_proxy -u all_proxy GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 push origin --tags
# 3) 打包并自检产物
npm run pack                                # 产出 dsh-analytics-pspp-X.Y.Z-linux-x64.tgz（约 35 MB）
tar -xzOf dsh-analytics-pspp-X.Y.Z-linux-x64.tgz package/cordis.patch.yml | grep -c "registerTools: false"   # 必须是 1
sha256sum dsh-analytics-pspp-X.Y.Z-linux-x64.tgz | tee SHA256SUMS | tee SHA256SUMS-X.Y.Z >/dev/null
# 4) 建 Release + 传三资产（Clash 未运行时走直连，见下）
```

- **GitHub 调用**：`env -u all_proxy -u ALL_PROXY -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY curl --http1.1 …`（Clash 没在跑时直连可用；跑着就去掉 `-u` 加 `-x http://127.0.0.1:7897`）。上传加 `-H "Expect:" --max-time 300 --retry 2`，否则偶发 408。
- **token**：`grep -oP 'GITHUB_TOKEN:\s*"?\K[A-Za-z0-9_]+' ~/.dsh/.credentials.yaml | head -1 > /tmp/ghtok`（重启即丢）。
- **资产名**：`SHA256SUMS` 与 `SHA256SUMS-<版本>`；建 Release 遇 422 先查 `releases/tags/<tag>` 是不是已经有了。
- **热重载**（替代重启 dsh web）：往 `~/.dsh/profiles/web/cordis.patch.yml` 末尾写一行 `# reload-nudge <版本>`，数秒后生效；确认方式：面板里「帮助 → 关于」看版本号。
- **CI**：`curl … /actions/runs?per_page=2` 看 `head_sha` 前 7 位与 `conclusion`。macOS 腿偶发 `cancelled`，用 `POST /actions/runs/<id>/rerun-failed-jobs` 重跑，不要当代码问题。

## 4. 环境与红线

- 工程根 `/mnt/E/code/dsh-analytics` 是唯一工作树；复验员一律 `git archive <tag>` 到 `/mnt/E/临时文件/verify-*/`，不要在工作树里改。
- **不擅自重启 dsh web**；**不装系统包**；**不动网络/防火墙/代理**（Clash 现在没运行，不要顺手启动）；**不调用比当前会话更贵的模型**（子代理继承当前模型）。
- 写文件位置由用户指定；临时文件放 `/mnt/E/临时文件`；删文件前先移到 `/mnt/E/备份文件`。
- 改 `client.js` / `workspace.js` / `routes.js` / `tools.js` / `dataset.js` 前先 `cp` 到 `/mnt/E/备份文件/<名>.before-<版本>`；每次替换后 `node --check`。
- `??` 与 `||` 不可混用（语法错）；多行提交用 `git commit -F 文件`；python heredoc 用 `PYEOF` 而不是 `EOF`（内容里有引号时）。
- bash 调用约 25 秒会被 SIGTERM：长命令（`npm test`、`npm run pack`、上传）一律 background job + `job_output`。

## 5. 已知的坑（都踩过，别再踩）

- **`test/smoke.mjs` 的变量在块作用域里**：新用例追加到别的块外面会 `ReferenceError`。
- **路由测试只看 200 不够**：标题没落地也返回 200，要断言内容。
- **新增套件要同时改三处**：`package.json` 的 `test` 链、`.github/workflows/test.yml` 的 pure tests、`FEATURES.md` 的套件数与断言数。
- **`locale/en.json` 是两层结构**：新词条进 `strings`，并同步 `meta.count`；`test/i18n.mjs` 会拦死词条（词条必须真的被代码引用）。
- **jsdom 里 React 受控输入**要 `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input, text)` + `new window.Event('input',{bubbles:true})`，直接改 `.value` 无效。
- **`createDataset({variables: […]})` 必须传对象数组**，传字符串数组会退化成 `V1`/`V2`。
- **PSPP 2.1.3 的静默命令**（`REGRESSION.`/`FACTOR.` 不带子命令）退出码 0、输出空 ⇒ 走 `silentCommandProblem()` 点名，不要报成「筛选把个案筛掉了」。
- **`CROSSTABS … RISK` 遇字符串变量会段错误**（Linux 139 / Windows 3）⇒ 已由 `dropRiskOnStrings` 剥掉，别再把字符串直接喂进去。
- **jsdom 不校验 SVG 的数值属性**：`<circle cx="NaN">` 在 jsdom 里只换一条 React warning，真机上 Chromium 判成非法长度、元素根本不画 —— 工具栏图标的点就这么隐身了若干版本。凡是从字符串 `Number()` 出来再喂给 SVG 属性的坐标，都要有「是有限数」的断言（`test/client.mjs` 现在有一条 `apIcon` 的）。0.120.0 起 `lib/charts.js` 有 `assertFiniteNumbers` / `assertFiniteSvg` 两道闸，挂在 `buildChartModel` / `renderSvg` / `composeChartGrid` —— 新画的图从这三处进，别自己拼字符串绕过；它们抓到的第一例是 KM 曲线 S=0 的 `0 × ∞`。
- **`getBoundingClientRect()` 在 jsdom 里恒为 0**：菜单/弹层的位置与裁切只能在真浏览器里验（`npm run e2e`）。纯函数套件里别写「量一下位置」的断言，会永远绿。
- **e2e 的浏览器要走回退链**：本机改写过的 `chromium-1255`（`chrome-linux64/chrome` 是个 276 字节的 bash 包装，禁 fcitx 抢焦点）比 playwright 期望的 1247 新，直接 `chromium.launch()` 会报没装浏览器；`test/e2e.mjs` 已经按「期望版本 → 缓存里版本号最高的 → 系统 chrome」回退，别把那三段删成一段。

## 6. 交接时的具体事实（2026-11-27）

- 最新版本 **0.122.0**（tag `v0.122.0`，Release 三资产齐全，CI 绿，本机已热重载）。
- **没有未修的 P0/P1**。最近一次独立复验（0.117.0，报告 `/mnt/E/临时文件/verify-01170/report.md`）结论是 6 条验收全 PASS、P0=0、P1=0、P2=3 —— 三条 P2 已在 0.118.1 修完并各自补了断言（含变异验证）。
- **真浏览器门禁**：`npm run e2e`（10 条，真 Chromium + 真引擎）。它不是 `npm test` 的一部分：找不到 playwright 就 skip 并 exit 0。本机走的是 `~/.local/bin/playwright-cli` 自带的 playwright；CI 是独立 `e2e` job（`npm install --no-save playwright@1.65.1`）。截图默认落 `<tmp>/dsh-analytics-e2e/panel.png`。
- 复验可复用的脚本在同目录：`guide-api.mjs`（引导整链 113 条）、`dialog.mjs`（功效对话框 27 条）、`indep-power.mjs`（独立复算样本量 8 条）、`i18n.mjs`（23 条）。
- 工作树干净、无草稿分支；`~/.dsh/profiles/web/cordis.patch.yml` 末尾有连续多行 `# reload-nudge <版本>`，那是热重载痕迹，不要删。
- 磁盘：`/mnt/E` 约 95% 已用，工程根累积每版约 35 MB 的 `.tgz` —— 删旧包要先问用户。

## 7. 接手后第一件事



按 [PLAN.md](PLAN.md) §3 的顺序做：§3.3 剩下的「逐列字符串宽度推断 A 格式」（需真引擎用例）→ §3.5 npm 发布（阻塞在用户 `npm login`）。§3.1 最小端到端用例随 0.119.0 落地，§3.2 的边界说明随 0.118.0 落地，§3.4 同类缺陷普查随 0.120.0 落地，§3.3 的两条随 0.121.0 落地（只剩「逐列字符串 A 格式」需真引擎）；0.122.0 落地的是方法建议的一键运行与 APA 写法（PLAN §3 的候选之外、用户点名的 A+B），之后的 §3.3 顺延不变。
