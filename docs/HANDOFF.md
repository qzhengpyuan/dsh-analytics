# 交接说明（换会话接手时先读这一页）

> 面向：接手开发的会话（人或 agent）。读完这一页应当能：跑测试、发一版、知道下一步做什么、不踩已知的坑。
> 项目定位与能力边界在 [SCOPE.md](SCOPE.md)，逐版过程在 [CHANGELOG.md](CHANGELOG.md)，排期在 [PLAN.md](PLAN.md)。

## 1. 现状（交接时的事实，会很快过期 —— 用命令核）

```bash
cd <仓库根>
git log --oneline -3            # 最新提交
node -e "console.log(require('./package.json').version)"
grep -m1 '^## ' docs/CHANGELOG.md   # CHANGELOG 首段应当等于上面的版本号
npm test > /tmp/full.log 2>&1; echo EXIT=$?   # 约 7 分钟；判据是 EXIT=0，
                                # 条数用 grep -cE '^ok' /tmp/full.log（末行是最后那个套件自己的 summary，不是总数）
```

- 工作树必须干净（`git status --short` 无输出）。**发版前先确认干净**，不要把上一批的残留带进 tag。
- 引擎不在 Git 里（`engine/linux-x64`、`engine/win32-x64`、`engine/darwin-*`）；克隆新副本后若缺，`npm run engine:fetch` 从 `engine-v1` Release 拉。
- 用磁盘挂载或开发模式安装时，刷新页面即可加载新版本（热重载见 §3），**不要重启宿主进程**。

## 2. 一批怎么做完（节奏与判据）

节奏：**一批 = 一个主题、10 条以上改动、1–3 天**；批内做完跑全量测试与自检，才发一次版；发布后再做一轮独立复验（另一个会话或子代理按判据取证），报告回来一次修完 P0–P2，再开下一批。

新功能/修复的验收标准（三条都要满足，缺一条不算做完）：

1. 有断言，且**做过删除式变异验证**（把修复删掉要变红，日志贴进报告）。
2. 真引擎路径有 `test/smoke.mjs` / `test/routes.mjs` 覆盖（纯函数套件不算）。
3. 文档三处同步：`CHANGELOG.md`（新版本段）、`FEATURES.md`（版本戳 + 能力 + 断言计数）、`PLAN.md`（§2 加一行、§3 挪条目）。`test/docs.mjs` 会拦版本戳与链接漂移。

## 3. 发布链（每版照抄，顺序不能改）

```bash
cd <仓库根>
npm test                                   # 必须 EXIT=0
grep -cE '^ok' /tmp/full.log               # 断言数（口径：只数 ok 行）
# 1) 文档三处 + package.json 版本
git add -A && git commit -q -F /tmp/msg.txt && git tag vX.Y.Z
# 2) push 分两步（一次带 tag 偶发被拒）
git push origin master
git push origin --tags
# 3) 打包并自检产物
npm run pack                                # 产出 dsh-analytics-pspp-X.Y.Z-linux-x64.tgz（约 35 MB）
tar -xzOf dsh-analytics-pspp-X.Y.Z-linux-x64.tgz package/cordis.patch.yml | grep -c "registerTools: false"   # 必须是 1
sha256sum dsh-analytics-pspp-X.Y.Z-linux-x64.tgz | tee SHA256SUMS | tee SHA256SUMS-X.Y.Z >/dev/null
# 4) 建 Release + 传三资产（tgz、SHA256SUMS、SHA256SUMS-X.Y.Z）
```

- **GitHub 调用**：优先 `gh`（已认证时）；没有就走 `git push` 与 REST。上传大文件时保持 HTTP/1.1 并加 `--retry`，偶发 408 重试一次即可。
- **凭据**：任何 token 都不写进仓库与文档；用 `GH_TOKEN` 环境变量或 `gh auth login`，用完即弃。
- **资产名**：`SHA256SUMS` 与 `SHA256SUMS-<版本>`；建 Release 遇 422 先查 `releases/tags/<tag>` 是不是已经有了。
- **热重载**（替代重启宿主）：往 profile 的 `cordis.patch.yml` 末尾写一行 `# reload-nudge <版本>`，数秒后生效；确认方式：面板里「帮助 → 关于」看版本号。
- **CI**：`gh run list` 看 `head_sha` 与 `conclusion`。macOS 腿偶发 `cancelled`，用 `gh run rerun <id> --failed` 重跑，不要当代码问题。

## 4. 环境与红线

- 唯一工作树 = 本仓库；复验一律 `git archive <tag>` 到临时目录，不要在工作树里改。
- **不擅自重启宿主进程**；**不装系统包**；**不动网络/防火墙/代理**；**不调用比当前会话更贵的模型**（子代理继承当前模型）。
- 写文件位置按用户要求；临时文件放临时目录；删文件前先备份。
- 改 `client.js` / `workspace.js` / `routes.js` / `tools.js` / `dataset.js` 前先 `cp` 一份带版本号的后备；每次替换后 `node --check`。
- `??` 与 `||` 不可混用（语法错）；多行提交用 `git commit -F 文件`。
- 耗时命令（`npm test`、`npm run pack`、上传）放后台任务并轮询结果，不要在一次调用里干等。

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
- **e2e 的浏览器要走回退链**：本机 Chromium 的版本未必是 playwright 期望的那个，直接 `chromium.launch()` 会报没装浏览器；`test/e2e.mjs` 已经按「期望版本 → 缓存里版本号最高的 → 系统 chrome」回退，别把那三段删成一段。

## 6. 交接时的具体事实（2026-11-27）

- 最新版本 **0.122.1**（tag `v0.122.1`，Release 三资产齐全，CI 绿）。
- **没有未修的 P0/P1**。最近一次独立复验（0.117.0）结论是 6 条验收全 PASS、P0=0、P1=0、P2=3 —— 三条 P2 已在 0.118.1 修完并各自补了断言（含变异验证）。
- **真浏览器门禁**：`npm run e2e`（10 条，真 Chromium + 真引擎）。它不是 `npm test` 的一部分：找不到 playwright 就 skip 并 exit 0。CI 是独立 `e2e` job（`npm install --no-save playwright@1.65.1`）。截图默认落 `<tmp>/dsh-analytics-e2e/panel.png`。
- 工作树干净、无草稿分支；profile 的 `cordis.patch.yml` 末尾可能有连续多行 `# reload-nudge <版本>`，那是热重载痕迹，不要删。
- 每版在仓库根留下约 35 MB 的 `.tgz`；删旧包前先确认没有引用它的 Release 或文档。

## 7. 接手后第一件事



按 [PLAN.md](PLAN.md) §3 的顺序做：§3.5 npm 发布（需要仓库所有者的 npm 凭据）。§3.1 最小端到端用例随 0.119.0 落地，§3.2 的边界说明随 0.118.0 落地，§3.4 同类缺陷普查随 0.120.0 落地，§3.3 随 0.121.0 与 0.122.1 全部落地（最后一条是强制字符串列的 A 格式宽度真引擎往返）；0.122.0 落地的是方法建议的一键运行与 APA 写法。
