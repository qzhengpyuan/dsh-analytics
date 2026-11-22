<!-- 计数口径（0.54.98 起）：各段写的「全量 N 条 ok」= `grep -cE '^ok\b'` 的总和，**Linux 与 Windows 相同**（0.54.97 阶段我曾以为 Windows 少 1，Win10 用逐套件表否掉了：Windows 上 568 与 Linux 无 poppler 的 568 相等）。唯一已知偏差：装了 poppler 会多跑 `pdf-notes` 1 条。 -->

历史小节保留当时的文本，包括后来被改掉的措辞；判断某句话现在是否还在用，看最新小节与 `docs/FEATURES.md`。

## 0.56.5

文档与可发现性这一批（不改计算行为）：

- 新增 `.github/ISSUE_TEMPLATE/`：`bug_report.yml`（版本、平台、发生了什么、触发语法、数据形状、与 SPSS 对照）、`feature_request.yml`（先问「在 SPSS 里的位置」与「你要解决什么问题」，因为不少需求可以用另一条路径达到）、`config.yml`（安装/平台问题指向 `docs/install.md`）。
- `docs/FEATURES.md` 的界面语言一节写清覆盖边界：翻外壳（菜单/对话框/表头/按钮/错误横幅/导出标题与注文前缀），**不翻**变量名与数据值、表注正文、引擎自己的英文；并记下**已知缺口**：宿主侧仍是 `${}` 拼接的 93 条中文报错文案在英文界面显示为中文，附各文件计数与复核方法（`lib/workspace.js` 33 条最多）。
- `docs/ROADMAP.md`：M9 的 `${}` 漏翻族勾掉（0.56.0/0.56.2/0.56.4 三处收口），93 条报错文案转成一条「按需补、不阻塞」项；M11 的 issue 模板勾掉，截图一项写明缺有认证的浏览器会话。

计数不变：**35** 套件 / **584** 条 ok。

## 0.56.4

- **引擎崩溃那段话现在翻译得出来**（此前英文界面整段是中文）。根因同 0.56.0 那一族：句子是用 `${exit}`/`${reason}` 拼好的，而词典只能匹配**未填值**的模板。改成 `引擎崩溃{0}：…原因：{1}…` 形态，并补三条词条（`处理 {0} 时引擎崩溃{1}：…`、`（退出码 {0}）`、`没有给出原因`）。崩溃模板加进 `RECURSIVE_TEMPLATES`，`（退出码 139）` 这个捕获位才会跟着翻；`test/crash.mjs` 新增一条断言英文整段无汉字、括号形态正确。
- **序次关联量补真引擎覆盖**：`CROSSTABS /STATISTICS=CHISQ GAMMA BTAU CTAU D ETA` 由 PSPP 自己算（Kendall's tau-b/tau-c、Gamma、Somers' d、Eta），插件只做呈现；但此前没有任何用例证明这些表真的回得来。`test/smoke.mjs` 新增一段，断言 `Symmetric Measures` 有 tau-b/tau-c/Gamma、`Directional Measures` 有 Somers' d 与 Eta。

计数：**35** 套件 / **584** 条 ok（Linux、无 poppler；装 poppler 585）—— crash 7 → 8；词典 1294 条。

## 0.56.3

- **新增「帮助 → 检查更新…」**：`GET api/update` 读公开仓库的 `releases/latest`，返回 `{current, latest, newer, url, publishedAt, notes}`。三种结局都可见：有新版本（报版本号与 Release 链接）、已是最新、**检查失败**（带原因）—— 失败被缓存成「已是最新」是最容易骗人的实现，这里刻意不缓存失败、下次点击重试。GitHub 未认证额度 60 次/小时，因此答案缓存十分钟，并发请求合并成一次。新增 `lib/update.js`（`createUpdateCheck`、`compare`）与套件 `test/update.mjs`（6 条：逐段比版本、新版带链接、同版不算新、缓存与失败不缓存、非 200 报错、并发合并）。
- **方差齐性注文说清用的是哪个 Levene 变体**：SPSS 自己的帮助让读「Based on Mean」，而 PSPP 在组内个案很少时会把那一行留空、只填「Based on Median / Trimmed Mean」。现在注文按实际取数的行写「方差齐性检验（基于中位数）的 p = 0.031」，默认的均值行不加修饰词。`test/regression.mjs` 新增一条（100 条）。
- `docs/ROADMAP.md` 的 M10「检查更新」勾掉。

计数：**35** 套件 / **583** 条 ok（Linux、无 poppler；装 poppler 584）—— regression 99 → 100、新增 update 6。

## 0.56.2

外部复验 0560 报告的 **P1（新回归）+ P2 + P3×3** 全部处理：

- **P1 修法 1：只有「捕获位装的是我们自己写的句子」的模板才递归**。0.56.0 修漏翻时对**每个**模板的捕获位都递归，而捕获位多数装的是用户数据：`{0} 的直方图` 里是变量名、`新建数据集（{0}）` 里是数据集名，而词典里有大量 1–4 字常用词键（保存、总计、名称）。结果英文界面把变量 `保存` 显示成 `Save`、数据集 `总计` 显示成 `Total`，同一份 docx 里数据集名一处中文一处英文。现在 `lib/i18n.js` 与 `client.js` 各有一个 `RECURSIVE_TEMPLATES` 白名单（当前只有 `{0}：不可估（{1}）` 一条）—— 那一族的漏翻仍然修好，数据值不再被动。
- **P1 修法 2：导出侧把前缀与正文分开翻译**。`lib/office.js` 原来是 `localize(`注：${note}`)`，于是递归钻进了由数字与变量名拼出来的注文正文，导出里出现 `Note: 分层变量：甲 (共 3 层: 0.013)` 这种半角化、甚至半英半中的句子；面板侧本来就是 `tr('注：')` + 正文，两边行为不一致。docx 与 xlsx 都改成 `localize('注：', lang) + note`，与面板对齐。
- **P2 死键判据：收紧的方案测过后否掉了**。按建议改成「两段命中，或片段 ≥ 6 字」后，实测把 **21 条真片段**（`· 打开于`、`右轴`、`，超时`、`（环形）` 等，都是长句的一部分）判成死键，白名单会比它防住的漂移更长；因此保留「任一段命中」的判据，把理由写进 `test/i18n.mjs` 的注释与本节。这条 P2 按「有成本证据的不采纳」处理，不是漏改。
- **P3-① 数字过期**：FEATURES 的词典条数 1292 → **1285**、断言 572 → **576**；ROADMAP 的 M6 1283 → 1285、M7 571 → 576、M8 死键行 1283 → 1285。
- **P3-② 失败文案**：全部 29 个会打失败行的套件统一成 `FAIL  <用例名>`（带异常文案时 `FAIL  <用例名>: …`），FEATURES 措辞改成不夸大。
- **P3-③ 白名单重复条目**已删。

用例：`test/i18n.mjs` 新增「a capture that is user data keeps its name」（6 条数据捕获 + 1 条仍然整句翻译）、`test/client.mjs` 在真词典块里加三条（变量名 / 数据集名 / 注文正文不被翻）、`test/office.mjs` 新增「an exported note keeps its body, only the prefix is translated」与「a long xlsx note grows its row instead of hiding lines」。

计数：34 套件 / **576** 条 ok（Linux、无 poppler；装 poppler 577）—— i18n 10 → 11、office 56 → 58。

## 0.56.1

- **P1 级：ICC 一直算不出来**。`annotateReliabilityIcc()` 用 `DATA_CHANGING` 判断「这段语法会不会改数据」，但它拿到的是**插件自己拼好的脚本**——每次运行都以 `GET FILE='…/work.sav'.` 开头，正则里的 `GET\s+(?:FILE|DATA)` 必然命中，于是只要数据集存在就永远走「这段语法里有会改数据或换数据的命令」那条分支，ICC 表一行都出不来。改成传用户原文 `requested`；跨轮重放的 `WEIGHT BY`/`FILTER BY` 由函数内部「引擎有效个案 vs 插件重算个案」的比较兜住，那条文案比「没算」有用。真引擎验证：12 例两评分者的 `RELIABILITY /VARIABLES=a b.` 现在末尾多出「组内相关系数 ICC（插件计算）」，ICC(2,1) 0.918（95% CI 0.554–0.979）、ICC(2,2) 0.957，四段注文齐全。
- 四条注文补真引擎覆盖（此前只有纯函数用例，靠手写的表结构与真引擎的 caption 对不上）：`EXAMINE … /PLOT=NPPLOT` 的正态性注文、2×2 的连续性校正注文、常数预测变量的「系数里有 NaN」注文、`RELIABILITY` 的 ICC 块。`test/smoke.mjs` 各加一段，跑真引擎。
- `docs/ROADMAP.md` 的 M8 勾掉这四项。

计数：34 套件 / **572** 条 ok（Linux、无 poppler；装 poppler 573）不变，`smoke` 的断言 4 → 8 条 —— `smoke` 打的是自己的 `real engine: …` 行，不进 `^ok` 计数，所以总数不变。

## 0.56.0

一批收尾（外部复验 0.55.0 报告的 P1/P2 + 之前欠的三件工程事）：

- **P1-① `${}` 拼装句子的漏翻**：`translateText()`（宿主）与 `translateOne()`（面板）在命中 `{n}` 模板后，对**捕获到的片段再做一次翻译**（深度上限 3，片段严格更短所以必然收敛）。这一族此前栽过三次（`Source:` 行、chip tooltip、`不可估` 注文），根因就是「外层模板匹配成功、内层句子原样放回」。同时补三条词条：`{0}：不可估（{1}）` → `{0}: not estimable ({1})`、原因句 `该对比在数据里没有对应的自由度，通常是某一格没有观测` → `the data leaves this contrast with no degrees of freedom, usually because a cell has no observations`，以及整句形态一条兜底。英文面板现在整句都是英文。
- **P2-① 死键清零**：删掉最后一条碎片键 `" 必须是 "`（碎片拼接时代的残留），`strings` 1286 → **1285**；`test/i18n.mjs` 的死键断言保持常设，白名单里新增两条并注明「由 `${head}：不可估（${reason}）` 套住」。
- **P2-② 失败文案统一**：`messages`/`order`/`raster`/`stage` 四个套件的 `not ok  …` / `not ok - …` 统一成 `FAIL  <用例名>`（外部复验确认不破坏它的 TAP 解析）。文档同步：FEATURES 里那句「三种并存」改成「已统一」。
- **P3-①** `docs/FEATURES.md` 的「受引擎限制的功能」补一条语法层限制：`REGRESSION` 只认 `/METHOD=ENTER`，`STEPWISE`/`BACKWARD`/`FORWARD`/`REMOVE`/`TEST`/`PIN`/`POUT`/`CRITERIA`/`SINGLE` 与 SPSS 的独立 `/ENTER=` 全部被 PSPP 2.1.3 拒（0.55.2 的真引擎断言在守）。
- 新增 `docs/ROADMAP.md`：里程碑 M1–M11 的状态、M8/M9/M10/M11 的剩余清单、以及「按里程碑成批交付、送验按里程碑算」的节奏说明。

用例：`test/client.mjs` 加「a note composed around a value translates both halves」（载真词典后断言 `A − B：不可估（…）` → `A − B: not estimable (` 开头且无汉字，连译两次结果相同）。

计数：34 套件 / **572** 条 ok（Linux、无 poppler；装 poppler 573）—— client 30 → 31。

## 0.55.2

钉住 `/ENTER=` 这条死路（0.55.0 给它加了分支，但没验过引擎到底认不认）：

- 用真引擎实测 PSPP 2.1.3 的 `REGRESSION` 子命令：`/METHOD=ENTER a b.` 正常给出 `Coefficients`（`(Constant)`、`a`、`b`）；`/ENTER=a c.`、`/METHOD=ENTER a b /ENTER=c.`、`/METHOD=ENTER /ENTER=a c.`、`/METHOD=TEST(a) /METHOD=ENTER a c.` 全部报 `Syntax error expecting VARIABLES, DEPENDENT, … METHOD …` 或 `expecting ENTER`/`expecting variable name`。结论：PSPP 2.1.3 **没有** `/ENTER=`、`/TEST=` 这两个子命令，只认 `/METHOD=ENTER` 后面直接跟变量名 —— SPSS 那种写法在这里是语法错。
- `test/smoke.mjs` 加一条真引擎断言：`REGRESSION /DEPENDENT=y /ENTER=x.` 必须抛错且文案是中文的那句「语法错误：这里的写法不被接受…」，防止以后升级 PSPP 时这条悄悄变成「接受」而没人知道。
- `requestedRegression` 里 `/ENTER=` 分支保留：引擎在它之前就报错、不会产出表，所以那段解析不会影响任何注文；留着是为了语法高亮与「帮助 → 预览语法」不把它当未知子命令。

计数：34 套件 / **571** 条 ok（Linux、无 poppler；装 poppler 572）。

## 0.55.1

把「死词条」变成常设断言（上一条里手工删了四条，这次让积累不起来）：

- `test/i18n.mjs` 新增 `check('every dictionary entry is still referenced by shipped code')`：扫 `client.js`、`index.js`、`tools-entry.js` 与 `lib/*.js`（**不扫 `test/`**，测试里的中文是期望值），把 `locale/en.json` 每条键按 `{0}`/`{1}` 切成字面段，任一段在源码里出现即算活着。比较前两侧都做转义还原（`\n`、`\'`、`\"`、`\\`）并按空白折叠，否则换行包装的模板字符串与 `Fisher\'s` 这类转义会假报死键 —— 第一版就是这样误报了 14 条。
- 运行时拼出来的四条列进白名单并注明出处：`不可估（该对比…）`（`lib/contrasts.js`/`lib/workspace.js` 拼在 `` `${head}：不可估（${reason}）` `` 里）、`工具挂载（registerTools）：开/关`（`client.js` 的 `` tr(`工具挂载（registerTools）：${…}`) ``）、`{0} 的构成（环形）`（`lib/charts.js` 的 `` `${name} 的构成${donut ? '（环形）' : ''}` ``）。它们不在源码里字面出现，但运行时产出的串正好等于键。
- 又删四条确实没引用的：`· 未保存`、` · 未保存`（现在都走 `（{0}，未保存）`/`（未保存）`）、`已保存。表格样式、…`（现在是 `已保存。界面语言、表格样式、…`）、`引擎没有产出任何表：引擎没有给出原因`（源码注释也写着「old text also repeated its own prefix」）。词典 1288 → **1284**。
- 变异：往词典里塞一条没人引用的 `这是一条没人引用的测试词条` → `rc=1`、红在这条 check 上。
- 顺手清掉工程根一个 83 MB 的 `.tmpv550/`（早期装包验证留下的整树副本），已移出到备份目录。

计数：34 套件 / **570** 条 ok（Linux、无 poppler；装 poppler 571）—— i18n 9 → 10。

## 0.55.0

自查（起因是给 0.54.97 的 `requestedRegression` 补针对性用例时发现的解析缺陷）：

- **`/METHOD=STEPWISE PIN(0.05) POUT(0.10) a b.` 把子选项当预测变量**：token 化只按空白切、再剥非字母数字，于是 `PIN(0.05)` 变成 `PIN0.05`、`POUT(0.10)` 变成 `POUT0.10`，被当成两个预测变量多算进去 —— 样本量注文因此会说「20 例对 4 个预测变量偏少」。改成先删掉括号组（`replace(/\([^)]*\)/g, ' ')`）再切词，并把 `PIN|POUT|CRITERIA|SINGLE` 加进子选项关键词表。
- **`/METHOD=TEST(a) /ENTER=a.` 一个预测变量都取不到**：`TEST(...)` 的括号被删后 `/METHOD=` 那一段只剩子选项，真正的名字在独立的 `/ENTER=` 子命令里。新增 `/ENTER\s*=\s*…` 分支，与 `/METHOD=`、`/VARIABLES=` 一起收集。
- 附带的清理：删掉 `locale/en.json` 里四条**已经没有任何代码引用**的碎片词条（`" 之间的整数，收到 "`、`" 必须是字符串"`、`" 行，文档里只放了前"`、`" 行；完整数据请用「导出为 CSV」。"`），词典 1292 → **1288**。它们是早期把长句拆成碎片拼接时留下的，后来长句改成整句模板后就成了死键。
- 用例：`test/regression.mjs` 的 `requestedRegression` 那条 check 里加两条断言（子选项不进预测变量、独立 `/ENTER=` 也认）。变异：把括号剥离那一行删掉 → `rc=1`、红在 `a hand-written regression hands over its predictors`。

计数：34 套件 / **569** 条 ok（Linux、无 poppler；装 poppler 570）—— 新增的两条断言在既有 check 内，条数不变。

## 0.54.99

Win10 0.54.98 报告的 P2×2 + P3×3，全是文档数字与措辞（无代码改动）：

- **P2-①** `docs/FEATURES.md:720` 还写 568 / 装 poppler 569 —— 0.54.98 把 office 拆出独立 check（54 → 55）后实测是 569 / 570，改到位。
- **P2-②** 0.54.98 段写「`smoke` 只贡献 3 条 `^ok`」，Win10 的 TAP 实测是 4 条（那三版新增的三条 + `a real ONEWAY says how many pairwise comparisons it made`）。改；结论本身（core-dump 那条不打 `ok` 行）不变。
- **P3-①** 0.54.96 段的「Windows 少 1 / Windows 567」原样挂着，既没删也没加更正标记。按 `docs/CHANGELOG.md` 头部的「历史小节保留当时文本」约定，在句后补一句「该判断已被 0.54.98 段 P2-① 推翻」。
- **P3-②** 0.54.98 段的计数行「569（Linux，装了 poppler 一例…）」读起来像 569 已含 poppler 那一条。改成「（Linux、无 poppler；装 poppler 为 570；拆出独立 check 后 office 54→55）」。
- **P3-③** 失败文案三种并存（`FAIL`、`not ok  `、`not ok - `），`messages`/`stage` 另有自定义 summary。这一版先在 `docs/FEATURES.md` 的「退出码纪律」一段写清楚，不做批量改写 —— 改 34 个套件的输出格式会动到 Win10 每轮的 TAP 解析口径，收益不抵风险。

这一版把 Win10 的两轮普查结论也写进了 `docs/FEATURES.md`：34 个套件注入 `throw` 后全部 `rc=1`（没有第二个静默失败），但 `client`/`smoke`/`routes`/`exact`/`pdf-notes` 是崩溃型（失败时不打 `ok` 行），所以版本对照要看 `rc` 不看 `^ok` 基数；`pdf-notes` 在无 `pdftotext` 的机器上永远 skip，是唯一本机不可证伪的断言。

计数：34 套件 / **569** 条 ok（Linux、无 poppler；装 poppler 570）。

## 0.54.98

Win10 0.54.97 报告的 P1×1 + P2×1 + P3×3：

- **P1-① `test/regression.mjs` 的退出码判定落在第 56 条断言之前**（长期存在）：`process.exitCode = 1` 写在文件中间（`test/regression.mjs:863`），那之后的 1000 多行里任何失败都只打印 `FAIL`、退出码仍是 0。把赋值挪进 `check()` 的 catch（与 `build`/`office`/`tables` 等 27 个套件同形），并在文件末尾再补一次。Win10 用 `mut/` 里的 TAP 证明了盲区；我现在用「把断言改错」实测 `rc=1`、`regression: 97 checks passed (with 2 failures)`。这条直接削弱了之前所有「regression 红了」的证据，属于地基问题。
- **P2-① 计数口径的根因判错**：「Windows 少 1 因为 smoke 的 core-dump 用例被平台跳过」不成立 —— Win10 逐套件表显示 `smoke` 只贡献 4 条 `^ok`，那一条本来就不打 `ok` 行（它在 `Promise` 里打印正文）。改成「Windows 与 Linux 相同」，头部注释与 0.54.97 段一并改正。
- **P2-② 「原先那条断言等于没有断言」结论不成立**：`buildDocx()` 返回 Buffer，`assert.match(Buffer, …)` 会抛 `ERR_ASSERTION`，所以真有那么一条断言时它**必然红**，不可能长期绿着。我上一版那句「顺带修了一处假断言」撤掉；实际发生的是「无名分支此前没有断言，我新增时第一版写错了对象」。
- **P3-① `## 0.54.97` 段没有计数行**：补 `34 套件 / 568 条 ok`。
- **P3-② `test/regression.mjs` 的 `check()` 与其它套件不同形**：已按 P1-① 统一（catch 里设退出码 + 末尾兜底）。
- **P3-③ 无名断言嵌在「英文外壳」大 check 里**：拆成独立的 `check('an unnamed built dataset keeps its template in English')`，失败时能点名。变异：词典改回 `New dataset (unsaved)` 实测 `rc=1`、红在 `FAIL an unnamed built dataset keeps its template in English`。

计数口径：34 套件 / **569** 条 ok（Linux、无 poppler；装 poppler 为 570；拆出独立 check 后 office 54→55）。

## 0.54.97

Win10 0.54.96 报告的 P2×2 + P3×2（外加计数口径的最终裁定）：

- **P2-① `requestedRegression()` 会读进注释与别的命令**：原实现扫整段文本，`* REGRESSION … a b c.` 这种注释里的名字被算成预测变量（20 例 3 个预测变量，误报「约 6.7」），`TITLE '…'`、`FREQUENCIES /VARIABLES=` 也能撞进来。改成先 `splitStatements(syntax)`（它已经处理注释行、引号、内联数据），再按 `/^\s*REGRESSION/i` 过滤，取**最后**一条 —— 引擎最后跑的那条才是屏幕上这些表的主人。
- **P2-② 手写 `REGRESSION` 少了插件自算的两张表**：`pspp_run` 出 3 张、`pspp_analyze` 出 5 张，差额是 `Durbin-Watson（插件计算）` 与 `共线性诊断（插件计算）`，因为 `runSyntax` 里那段的条件只看 `options.regression`。改成同一个 `requestedModel`（显式列表优先，否则从语法解析）既喂 `annotateSampleSize` 也喂 `collinearityTable`/`durbinWatsonTable`。
- **P3-① 无名新建数据集没有测试守护**：`test/office.mjs` 之前只断言带名字的 `Source: New dataset(d.sav)`，无名分支改回带空格四个套件全绿。补一条 `sources: [{ origin: 'new', name: null, sourcePath: null, … }]` 的断言；把词典改回 `New dataset (unsaved)` 实测 `rc=1`。
- **P3-② 返回形状不一致**：`requestedRegression` 早已返回 `{ dependent, independents }`（与 `analysisExtras('regression', …)` 同形），报告里那句 `dependents` 数组是 0.54.96 之前的旧形状，此处只补一条注释把约定写死。
- 计数口径：Win10 连续三版判我「多写 1」。当时判成「Windows 跳过一条 smoke 用例」，写成了「Linux 无 poppler N（Windows N−1）」；0.54.98 用逐套件表推翻了这条判断，**Windows 与 Linux 相同**，见 0.54.98 段 P2-①。
- 计数：34 套件 / 568 条 ok（Linux 无 poppler；装了 poppler 569）。

## 0.54.96

Win10 0.54.94 报告的 P2×2 + P3×1（另一条 P3 是它自己撤回的扫描口径问题）：

- **P2-① 手写 `REGRESSION` 拿不到样本量注文**：`annotateSampleSize` 只吃 `options.regression`，而它只由 `pspp_analyze` 的 `analysisExtras()` 与面板 `api/run` 的 `body.regression` 填；语法编辑器里手打 `REGRESSION …` 与 `pspp_run` 都不带 ⇒ 那条主路径永远没有注文。新增 `export function requestedRegression(syntax)`（从 `/DEPENDENT=` 与 `/METHOD=ENTER …` 或 `/VARIABLES=` 解析预测变量、剔除因变量、词尾句点剥掉），`runSyntax` 改 `options.regression ?? requestedRegression(script)`。这是与既有 `requestedCrosstabStatistics` 同族的做法。
- **P2-② `MEANS … BY` 全缺失时印 `NaN` 却零注文**：`NaN` 是 PSPP 自己打的，不假；但 `annotateZeroCases` 的 `SUMMARY_ONLY` 正则把 `report`/`summary` 一起跳过了，而这两张正是「没有可算个案」时会出现的表。正则收窄成 `/^(case processing summary|model summary)/i`。
- **P3-①** `locale/en.json` 的 `新建数据集（未保存）` → `New dataset(unsaved)`（无名的新建数据集在 Word/Excel 里还差一个空格）。
- **P3-②** 0.54.94 段自称的 `grep -c "点两个菜单"` = 2 改成实测 3（重复 bullet 确实删了，只是自述没把自己那句算进去）。

变异验证：`SUMMARY_ONLY` 加回 `report|summary` 实测 `rc=1`（红在 `an all-missing means table explains itself`）；`options.regression ?? requestedRegression(script)` 去掉后半段实测 `rc=1`（红在 `a typed regression reads its own predictors`）。

计数口径（这轮定为最终口径）：文档里的 `^ok` 写 **Linux 无 poppler** 的数，并在括号里给出 Windows 数（Windows 少 1，因为 smoke 的 core-dump 用例被 `process.platform !== 'win32'` 跳过；装了 poppler 则多 1 条 pdf-notes）。0.54.92 及以前 563、0.54.93/0.54.94 为 564、0.54.95 为 565、本版 **568**（Linux 装 poppler 569）。（更正：本段原先还说「Windows 少 1、Windows 567」，该判断已被 0.54.98 段 P2-① 推翻 —— Windows 与 Linux 相同。）

## 0.54.95

`annotateSampleSize` 之前只有纯函数用例（自造 `Model Summary` 表、自造 `regression` 参数），真引擎那条路从来没走过。补一条：4 例、1 个预测变量的 `REGRESSION`，断言 `Model Summary (y)` 上出现「样本量 4 对 1 个预测变量偏少」。顺带钉住一个接口约定 —— 提示要靠调用方传 `{ regression: { independents: ['x'] } }`，引擎的表里没有这个信息，光传 `regression: true` 什么都不会发生。

变异验证：把 `runSyntax` 里的 `annotateSampleSize(items, this.dataset, options.regression)` 换成 `void options.regression` 实测 `rc=1`，红在 `the small-sample warning reaches the panel`。

测试数：34 套件 / **566** 条 ok（装了 poppler 的机器 567）。

## 0.54.94

Win10 0.54.92 报告的 P3×4，逐条落实：

- **P3-①** `pspp_export` 的描述补上第三个出口：`Use pspp_export_office for Word/Excel, pspp_export_document for the tables and charts of a run, and pspp_export_chart for a single chart as .png or .svg.`（来函说三句、文件里只有两句，是我 0.54.89 写漏了 `export_chart`）。
- **P3-②** 0.54.87 段那两条重复 bullet 真的删了 —— 0.54.92 段声称「已合并」但文件里两条都还在，是上一版只改了说明没改正文。现在 `grep -c "点两个菜单"` = 2（0.54.92 段的自述 + 保留的那一条）。
- **P3-③** `translateOne()` 的前缀规则扩成 `/^([✓▸▾]\s*)(.*)$/`（`▸` 与 `▾` 是一对，只认一半以后做展开态标签会原样复发），并加断言 `hooks.tr('▾ 表格') === '▾ Table'`。当前生产不可达，属预防性。
- **P3-④** 「新建数据集」在三个出口的空格统一成**无空格**：`locale/en.json` 的 `新建数据集（{0}）` 与 `新建数据集（{0}，未保存）` 改成 `New dataset({0})` / `New dataset({0}, unsaved)`（面板与 HTML 早就用 `新建数据集{0}` + `（{0}）` 拼出无空格形式，只有 Word/Excel 走整句模板带空格）。`test/office.mjs` 的断言同步成 `/Source: New dataset\(d\.sav\)/`。
- 变异验证：`[✓▸▾]` 改回 `[✓▸]` 实测 `rc=1`；把 `lib/office.js` 那处 `localize(..., lang)` 写成 `'zh'` 实测 `rc=1`。
- 测试数不变：34 套件 / **565** 条 ok（装了 poppler 的机器 566）。

## 0.54.93

`annotateComparisons` 之前只有纯函数用例（自造一张 caption `Multiple Comparisons` 的表），真引擎那张的 caption 其实是 `Multiple Comparisons (score)` —— 带变量名。补一条真引擎用例：3 组 LSD，断言落在那张表上的注文含「3 次两两比较」与「14%」。

变异验证：把 `runSyntax` 里的 `annotateComparisons(items)` 换成 `void items` 实测 `rc=1`，红在 `the comparisons count reaches the panel`。

测试数：34 套件 / **565** 条 ok（装了 poppler 的机器 566）。

## 0.54.92

Win10 0.54.90 报告的一条 P1 与三条 P2 全是同一个机制的余波：**`tr()` 只填外层模板，从不看插值进来的内容；`translate: false` 连 `title` 一起冻结**。

- **P1-① HTML 导出的来源行**：`client.js:6583` 单表戳与 `:6621` 底栏的 `which` 是裸模板（`` `新建数据集${from.name ? `（${from.name}）` : ''}` ``、`?? '未命名数据'`），外面那层 `tr('来源：{0} …')` 只替 `{0}`，于是英文文件里出现 `Source: 新建数据集（d） · 5 cases`，而同一份数据走 Word/Excel 是全英文。改成先把部件翻好再拼（`tr('新建数据集{0}', from.name ? tr('（{0}）', from.name) : '')`、`?? tr('未命名数据')`）。用例里给英文面板的数据集加上 `origin: 'new'` 的 provenance，断言导出的 `<p class="ap-export-source">` 里有 `New dataset` 且全文无 `新建数据集`；还原修复实测 `rc=1`（`Source: 新建数据集（d） · 12 cases`）。
- **P2-① 来源 chip 的 tooltip**：`client.js:4855-4859` 三条裸串（「这份数据没有对应的磁盘文件（在面板里新建的）」等）包上 `tr()`。用例新增一条扫描：英文面板里所有 `[title]`（排除 `.ap-note`）不得含汉字。还原修复实测 `rc=1`（`Chinese tooltips: 这份数据没有对应的磁盘文件 / 在面板里新建的`）。
- **P2-② 状态栏 tooltip 的「未命名数据集」**：`describeSource()` 最后一条分支是裸串；改成 `tr('未命名数据集')`（词条本来就在词典里）。拼进 `title` 的整串既无精确键也不匹配模板，所以 `h()` 的后备翻译救不了它。
- **P2-③ 变量视图里变量名的 tooltip**：`title: '单击改名'` 与 `translate: false` 挂在同一个元素上，后者把 `TRANSLATED_PROPS` 一起冻结。改成 `title: tr('单击改名')`。用例切到变量视图断言 `Click to rename`；还原实测 `rc=1`。
- **P3-① 折叠标记**：`translateOne()` 只认 `✓ ` 前缀，`▸ 表格` 这种「标记 + 词」整串查不到键；前缀规则扩成 `/^([✓▸]\s*)(.*)$/`。用例断言 `hooks.tr('▸ 表格') === '▸ Table'`；还原实测 `rc=1`。
- **P3-②**：0.54.87 段里重复的两条「测试从点两个菜单扩到…」合并成一条。
- 文档：`docs/FEATURES.md` 补一句虚拟窗口是怎么画的（spacer 撑高、DOM 里只留一屏加 overscan、量不到高度退回整表）。
- 测试数不变：34 套件 / **563** 条 ok（装了 poppler 的机器 564）。

## 0.54.91

Win10 在 0.54.88 报告里判断「虚拟化路径完全没有测试覆盖，jsdom 里 `box.height > 0` 恒假」。查证下来这条**不成立**：`test/client.mjs` 的 3000 行用例本来就把 `Element.prototype.getBoundingClientRect` 打桩成「`.ap-tbl-vscroll` 返回 600×560」，于是窗口化分支会真的跑起来，并断言了滚动容器、`maxHeight: 520px`、两条 spacer 的高度相加等于 `3000 × 26`、滚动后窗口平移、第一行离开 DOM、复制的 CSV 仍是 3001 行。把 `measure` 里的高度强改成 0 实测 `rc=1`（红在 `a measurable long table gets a scroller of its own`）—— 说明它是活的。

真正松的是**行数**：原来只断言「画出来的行数 `< 200`」，一个写死 12 行的窗口也能过。这一版把它收紧成「第一屏画出的正文行数 === `virtualWindow(3000, 0, 520, 26, 10)` 的结果」（40 行）；把渲染改成写死 12 行实测 `rc=1`（`drawn 12, expected 40`）。统计时排除 spacer 行与表头行。

顺带删掉一个没必要的改动：先前为这条覆盖加的 `globalThis.__AP_TEST_BOX__` 注入钩子（`VirtualTable` 的惰性 `useState` 与 `measure` 里的强制高度）已回滚 —— 打桩 `getBoundingClientRect` 已经够用，多一条只给测试用的生产分支不值得。

测试数不变：34 套件 / **563** 条 ok（装了 poppler 的机器 564）。

## 0.54.90

Win10 0.54.88 报告的两条 P2 + 两条 P3，全部落在「测试绿着但守不住东西」这一族：

- **P2-① 全角标点扫不到**：0.54.87 新加的菜单扫描只匹配 `[\u4e00-\u9fff]`，而真正坏掉的是全角括号（U+FF08/U+FF09，不在 CJK 统一表意文字区间）。⇒ 字符类扩成 `[\u4e00-\u9fff\uFF00-\uFFEF\u3000-\u303F]`，并显式断言 `Follow settings \(Three-line\)`。把子菜单那行还原成裸全角括号实测 rc=1（红在「the View menu still shows Chinese」）。
- **P2-① 附带**：`ticked()` 被证实冗余（`translateOne()` 自 0.54.60 起就有 `/^(✓\s*)(.*)$/` 的勾号规则），删掉，菜单标签回到直接写「`✓ ` + 标签」。CHANGELOG 0.54.87 段按实测重写：真正修的是子菜单的括号与「已选 N 个变量」，另两处（视图勾选标签、来源 chip）本来就译得出，不是本版功劳。
- **P2-② 缺 `sessionId` 的 provenance 会印出 `{0}`**：`tr()` 对 `undefined` 参数保留占位符字面量，而来源 chip 的「会话：{0}」没做存在性判断（邻居几行都判断了）。改成 `from.sessionId ? tr('会话：{0}', from.sessionId) : null`；用例里补一条不含 `sessionId` 的 provenance，断言第二个 chip 的 title 里没有 `{0}`（删掉守卫实测 rc=1）。
- **P3-① / P3-②**：CHANGELOG 0.54.87 的「另外三处同类漏改」按实测改成「一处真改、两处核实无需改动」；0.54.88 段那句「全量 34 个套件一条都不红」改成「除这两个套件本身，其余 33 个一条都不红」，避免读成「跑全量也不红」。
- 测试：34 套件 / **563** 条 ok（装了 poppler 的机器 564）。

## 0.54.89

小改（等 Win10 报告时顺手）：`pspp_export` 的描述只有一句「导出 CSV」，而模型手里同时有 `pspp_export_office`（Word/Excel）、`pspp_export_document`（表格与图）、`pspp_export_chart`（单图）三个出口 —— 说明补上是哪种 CSV（UTF-8、带表头、不带值标签）以及另外三个出口该什么时候用。

## 0.54.88

Win10 0.54.86 报告的两条 P2 是同一族：0.54.84 让面板与导出「给出同一个时间串」，但**没有任何断言校值**，只有形状（`YYYY-MM-DD HH:MM`）。把任一侧改成 `getUTC*`，除了 `client` / `office` 这两个套件本身，其余 33 个一条都不红（两个套件里也只有形状断言，所以照旧全绿），而真渲染下面板与导出差 8 小时。

- **面板侧（P2-①）**：`test/client.mjs` 里那条 `assert.match(..., /打开于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?!:)/)` 换成值断言 —— 用同一个 `openedAt`（`1794740000000`）按本地时间手工算出 `YYYY-MM-DD HH:MM`，再 `assert.ok(title.includes(\`打开于 ${expectedWhen}\`))`。把 `client.js` 的 `formatWhen` 换成 `getUTC*` 版本实测 rc=1，红在 `the panel writes the export's local timestamp`。
- **导出侧（P2-②）**：`lib/office.js` 的 `readableTime(ms)` 改成导出符号；`test/office.mjs` 的「each table carries its own source line」用例里断言导出的 XML 含 `打开于 ${readableTime(1794804225859)}`，并断言 `readableTime` 的返回值等于按本地时间手工拼出的串。换成 `getUTC*` 实测 rc=1，红在 `readableTime is local time, to the minute`。
- **P3-①**：0.54.86 段补上「`translateOne()` 判据按原样保留」的决策与理由（0.54.86 的改动本身没问题，只是当时没把理由写进文件）。
- **P3-②**：词典条数。0.54.83 净减 1 条（加两个整句模板、删三条死碎片键）时没同步 `docs/FEATURES.md`，而 0.54.87 又净加 1 条 —— 现测 `strings` 恰为 **1292** 条 / 160 条模板，与 FEATURES 的写法一致，故不需改数字；`docs/CHANGELOG.md` 的 0.54.69 段写的是当时的事实，按文件头约定保留。
- 测试：34 套件 / **563** 条 ok（装了 poppler 的机器 564）。

## 0.54.87

自查（等 Win10 报告时扫面板的裸模板，与 0.54.83 的 P2-① 同族）：**视图/数据/输出那几个菜单在英文界面下仍混着中文**，因为勾选状态的标签是「把 `✓ ` 拼在中文串前面」再交给 `menuLabel()` 整串查词典 —— 整串 `✓ 显示值标签` 永远查不到。

- **真正坏掉的地方是「输出表格样式」子项**：标签的两个部分各自都翻了，但中间的括号是拼在 `tr()` 之外的裸全角字符，于是英文界面里剩 `Follow settings（Three-line）`。改成 `tr('{0}（{1}）', tr('跟随设置'), tr('三线表'))`（词典补 `{0}（{1}）`），括号跟着语言走。
- 变量选择提示「已选 N 个变量」原来是裸模板，改成 `tr('已选 {0} 个变量', picked.size)`。
- **两处核实后无需改动**：视图菜单 9 个勾选标签（`✓ 显示值标签` 等）从 0.54.60 起就由 `translateOne()` 的勾号规则处理（`/^(✓\s*)(.*)$/` 先剥勾再翻），本来就译得出；来源 chip 的 `名称 · N 例 · M 变量` 由 `h()` 的第二遍翻译兜住，也本来就译得出。这一版一度加了个 `ticked()` 包装器，实测是冗余的，0.54.90 已删。
- **测试从「点两个菜单」扩到「点全部菜单」**：英文面板用例遍历所有顶层菜单按钮，逐个打开并断言菜单里没有任何汉字（`View` 另外断言 `Show value labels`）。这条能同时挡住「勾号破坏词典」和以后新增菜单忘记翻译。
- 测试：34 套件 / **563** 条 ok（装了 poppler 的机器 564）。

## 0.54.86

Win10 0.54.83 报告的唯一 P1：功能三项全 PASS，但我这版新加的两条断言都不守目标行为（两个变异都不变红）。另外按它的 P2-① 修了英文面板用例的自相矛盾处。

- **变异 A（`translate: false` 被删）不变红**：`translateOne()` 有 `if (!/[\u4e00-\u9fff]/.test(text) || text.length > 600) return text` 的提前返回，而 fixture 里那条注文 `Levene test：variances differ` 一个汉字都没有（全角 `：` 是 U+FF1A，不在 `\u4e00-\u9fff` 里）⇒ 二次翻译根本不会触发。现在 fixture 加一条真中文注文 `方差齐性检验：各组方差不等` 并断言它渲染成 `Note: 方差齐性检验：各组方差不等`；删掉 `translate: false` 后这条立刻红（实测 `Note: 方差齐性检验: 各组方差不等`）。
- **变异 B（注文归因传回 `requested`）不变红**：没有任何用例走「跨两次 `runSyntax` 的 `WEIGHT BY` 重放」，`test/regression.mjs` 里 8 条 `annotateZeroCases` 用例都是单次纯函数调用、自己传脚本，绕过了 preamble 注入。新增 `test/weight.mjs`（需要引擎）：同一个工作区先 `WEIGHT BY w.`（w 全 0）再 `DESCRIPTIVES score.`，断言注文匹配 `/加权后有效个案是 0/` 且不匹配 `/不是权重的问题/`；把两个参数改回 `requested` 后这条红。套件已接进 `npm test` 与 CI 的两个引擎作业。
- **P2-① 英文面板的「无汉字」断言与设计互斥**：它对整个面板扫汉字，而注文正文按设计就是中文 ⇒ 任何人想加一条真中文注文都会先被它打红，而这正是上一个洞藏住的原因。改成只扫 chrome（跳过 `.ap-note` 子树），注文正文单独断言。
- **P2-② 文档里的 CI 作业名**：0.54.82 段把作业写成「`engine` 与 `engine-cross`」，实际是 `pdf-notes` 与 `engine-cross`（后者矩阵展开成三条 `engine (<platform>)`），已改正。
- **`translateOne()` 的汉字判据按原样保留**（决策，非缺陷）：判据是 `/[\u4e00-\u9fff]/`，全角标点（`：` 是 U+FF1A）不在其中。放宽成「含全角标点也算中文」会让「拉丁字母 + 全角标点」的串开始走模板匹配，而这类串现在一律原样返回；插件自己写的句子都含汉字，不放宽也不会漏翻，风险大于收益。
- 测试：34 套件 / **563** 条 ok（装了 poppler 的机器 564）。

## 0.54.85

Win10 0.54.81 报告 P3-④ 的建议：先把大表那套「先画 200 行 + 显示全部 → 滚动窗口」的边界写成纯函数用例，再谈实机验收。

- `virtualWindow(total, scrollTop, viewport, rowHeight, overscan)` 补 7 组边界：`total=0`、`total=1`、滚动位置超过表尾（`26×3000`）、负的滚动位置、`viewport=0`（面板隐藏或 jsdom 无布局）、`viewport` 只有一行高。断言窗口恒落在 `[0, total]` 内，且只有 `total=0` 时窗口才允许为空 —— 这条把「量不到高度就画 0 行」的老坑钉住了。
- 现有的两条（3000 行顶部与 2500 行处）与鼠标操作路径（点「显示全部」后变滚动窗口、退回整表）都保留。
- 测试数不变：33 套件 / **562** 条 ok（装了 poppler 的机器 563）。

## 0.54.84

Win10 0.54.81 报告的 P3-①，加一条它建议的用例：

- **时间戳只有一个格式**：面板四处（来源 chip、来源面板的打开/修改时间、HTML 导出两处）原来用 `new Date(x).toLocaleString('zh-CN', { hour12: false })`，同一份数据在面板里是 `2026/1/2 03:44:05`、在 Word/Excel/HTML 导出里是 `2026-01-02 03:44`，而且英文面板仍是 `zh-CN` 的排法。新增 `formatWhen(ms)`（`YYYY-MM-DD HH:MM`，本地时间，无效值给 `null`），四处都改走它 —— 与 `lib/office.js` 的 `readableTime()` 逐字一致，两个出口从此同一个串。
- **同表多条注文的渲染有了用例**：一张表挂三条注文（第一条与第三条带全角冒号、中间一条不带），断言渲染顺序等于加入顺序、每条前缀只出现一次（`注：甲：第一` / `注：乙条不含冒号` / `注：丙：第三`）。此前只有单条注文的用例。
- 测试数不变：33 套件 / **562** 条 ok（装了 poppler 的机器 563）。

## 0.54.83

Win10 0.54.81 报告的两条面板 P2（都是既有问题，V1–V3 仍然全 PASS）：

- **大表截断提示条整句中文漏翻**（P2-①）：`client.js` 里那两条是裸模板字符串，没有走 `tr()`，英文界面下提示条是中文、同一条上的按钮却是英文。改成 `tr('这张表共 {0} 行，面板先画前 {1} 行（复制 CSV 与导出仍是全部）', drawn.total, drawn.shown)` 与 `tr('正在显示全部 {0} 行', drawn.total)`，词典补两个整句模板键，删掉三条从未被任何 `tr()` 用过的碎片键（`这张表共`、`行，面板先画前`、`正在显示全部`）。
- **表注正文被二次翻译**（P2-②）：`h('li', …)` 里先 `tr('注：{0}', text)`，随后 `h()` 对字符串子节点又跑一遍 `tr()`，第二次命中通用模板 `"{0}：{1}"`，把注文里的全角冒号换成半角 —— `lib/workspace.js` 的 31 处 `pushNote` 里有 20 处含 `：`，而且因为 `translateOne()` 对超过 600 字的串提前返回，这条 bug 只挑短注文中招。给 `li` 加 `translate: false`（与 0.54.60 修数据格用的是同一个开关）。
- **测试也补了**（这是漏翻没被发现的原因）：英文面板用例的 fixture 原来只有一张 1 行表，截断条根本不出现，所以「面板无汉字」那条断言形同虚设。现在 fixture 多一张 250 行的表并断言提示条是英文，另加一条带全角冒号的注文（`Levene test：variances differ`）断言正文标点原样保留。
- **注文归因改用引擎实际运行的脚本**（P3-②）：`annotateWeightedEmpty` 与 `annotateZeroCases` 原来收的是用户这次输入的 `requested`，而上一轮的 `WEIGHT BY` 会被前置进 `script`；于是「先 `WEIGHT BY w.`、再 `DESCRIPTIVES score.`」时得到的是「这几列全是缺失值（不是权重的问题）」这种把最关键的排除说反的归因。两处都改成传 `script`。
- 测试数不变：33 套件 / **562** 条 ok（装了 poppler 的机器 563）。

## 0.54.82

自查（不是 Win10 报的，是我在等报告时翻 CI 配置发现的）：

- **新套件根本没进 CI**：`test/tools.mjs` 需要引擎，而 `.github/workflows/test.yml` 里真正跑引擎的那两个作业（`pdf-notes`，以及矩阵展开成三条 `engine (<platform>)` 的 `engine-cross`）的命令列表里都没有它 —— 0.54.78 加的 20 条断言只在本地跑过。两个作业都补上（engine-cross 覆盖 linux-x64 / win32-x64 / darwin-arm64），并更新两处注释。
- **`docs/FEATURES.md` 的版本戳还停在 0.54.68**：0.54.69–0.54.81 十几版都在改计数、忘了改文件头。现在写 0.54.82。
- 顺带修正它对 CI 的描述：原文写「Node 20/22 跑 `node --check` + 纯函数测试」，实际矩阵是 **20/22/24**，且需要引擎的 `smoke`/`routes`/`flow`/`tools` 会在 Linux 与 win32-x64、darwin-arm64 上各跑一遍（`pdf-notes` 只在装 poppler 的作业里跑）。
- 测试数不变：33 套件 / **562** 条 ok（tools 20；装了 poppler 的机器 563）。

## 0.54.81

Win10 0.54.80 报告的三条 P3 都做了，另按它的建议给文件头补一句约定：

- **导出加魔数断言**（P3-①）：`pspp_export_chart` 的 png 断言前四字节是 `\x89PNG`、`pspp_export_document` 的 pdf 断言前五字节匹配 `^%PDF-` —— 原来只查「文件存在且非空」，写一个字节垃圾也能过。
- **导出用编辑后的 runId**（P3-②）：`pspp_edit_chart` 返回自己的 `runId`，用例改成 `edited.runId ?? drawn.runId`，落盘的才是改过标题的那张图。
- **文件头补约定**（P3-③ 的引申）：`docs/CHANGELOG.md` 开头写明「历史小节保留当时的文本，包括后来被改掉的措辞；判断某句话现在是否还在用，看最新小节与 `docs/FEATURES.md`」—— 这样 `grep` 到 0.54.77 段的旧引述不会被误读成「这句还在代码里」。
- 测试数不变：33 套件 / **562** 条 ok（tools 20；装了 poppler 的机器 563）。

## 0.54.80

Win10 0.54.79 报告的 P2-① 与 P3-①/②（都在测试强度上，代码没动）：

- **`pspp_merge` 的断言收紧**（P2-①）：原来只断言 `total` 没变小，空实现也绿。现在要求精确 `before.total + 9`（`more.csv` 九行）并且变量里真的多了 `extra` —— Win10 用它自己的探针证实正确实现给 `8 → 17`、变量 `score/group/grp/extra`。
- **`pspp_edit_chart` 加实据**（P3-①）：除新标题外，断言 `kind` 与 `bins` 与原图逐项相同（只回显参数的实现会红），并且改完后用同一个 `runId` 导出 png、文件非空（编辑要落到图上，不能只改返回值）。
- **`pspp_export_document` 不再依赖前一条用例**（P3-②）：用例内先跑一次 `FREQUENCIES`，`export_document` 渲染的就是这一轮的输出，顺序无关。
- 测试数不变：33 套件 / **562** 条 ok（tools 20；装了 poppler 的机器 563）。

## 0.54.79

Win10 0.54.78 报告的 P2-①（这条说得对：0.54.78 段自称覆盖全部工具，实际有 5 个从未调用）：

- **补齐 5 个工具的 happy path**，`test/tools.mjs` 从 14 条到 **20** 条：`pspp_append_cases`（追加 1 行后 `total` +1）、`pspp_run_file` 成功路径（真写一个 `.sps` 再跑，`tables.length ≥ 1`）、`pspp_edit_chart`（拿绘图返回的 `runId` 改标题并断言新标题）、`pspp_export_chart` + `pspp_export_document`（png 与 pdf 都写出非空文件）、`pspp_merge`（另存一个 `.sav` 后 `kind: 'add'` 合并，`total` 不减）。
- **加一条自检**：套件内部记录实际调过的工具名，最后一条断言「23 个工具全部被跑过」（`never called: …`），以后新增工具忘了加用例会直接红。
- 按 Win10 P3 修：`await await check(...)` 的双 await、用例名 `pspp_run returns tables with html` → `… with rows and provenance`（断言一直是 `rows`/`provenance`，名字误导）。
- 测试数：33 套件 / **562** 条 ok（tools 20；装了 poppler 的机器 563）。

## 0.54.78

两件事，都不改引擎行为：

- **工具层第一次有了测试**：新增 `test/tools.mjs`（14 条断言，接进 `npm test`）。此前 `build`/`smoke`/`routes` 覆盖了语法构造、工作区与 HTTP 路由，但**没有任何用例调用过 23 个 `pspp_*` 工具的 `execute()`** —— 工具本体全坏也能全绿。现在按宿主的方式逐个跑：`pspp_status`（引擎版本 + 插件版本 + capabilities）、`pspp_open`（8 例）、`pspp_variables`、`pspp_data`（`limit`）、`pspp_run`（表有 `rows` 与 `provenance`）、`pspp_analyze` 十种过程（含 `crosstabs`/`ctables` 用 `row`/`column`、`regression` 用 `dependent`/`independents`）、未知过程名报错、`pspp_transform`（compute 长出 `twice`、sort）、`pspp_chart`（直方图与条形图都写出真 svg 文件）、`pspp_publication_table`/`pspp_pairwise`/`pspp_partial` 的矩阵、五个导出工具都写出非空文件、`pspp_run_file` 缺文件报错、`pspp_new` + `pspp_add_variable`。顺带确认：工具返回给模型的是 `rows` 矩阵而不是 HTML，且带 `provenance`。
- **0.54.77 报告里的可选润色**：`docs/CHANGELOG.md` 口径那句的括号「（注释本身既不算紧邻，也不会挡住剥离）」删掉，主句已完整。
- 测试数：33 套件 / **556** 条 ok（regression 98、tools 14；装了 poppler 的机器 557）。

## 0.54.77

Win10 0.54.76 报告的唯一一条 P3（只关措辞）：

- **口径那句改写**（P3-①）：0.54.76 段里「注释行不算 —— 所以实际效果是注释也不挡住剥离」前后相反。改成「只有空白能让 `MATRIX.` 与数据组分开；注释行会被 `stripCommentLines()` 先删掉，因此带注释的写法与带空行的写法等价（注释本身既不算紧邻，也不会挡住剥离）」。
- **把注释形态钉进用例**（Win10 提醒这一格目前没有断言，若将来 `stripCommentLines()` 挪到切分之后行为会变）：新增「a comment line before the matrix data group does not keep it」，断言 `MATRIX.` + `* note` + `BEGIN DATA` + `1` + `END DATA.` + `DESCRIPTIVES x.` → `["DESCRIPTIVES x."]`。regression 98、全量 **542**（装了 poppler 的机器 543）。

## 0.54.76

Win10 0.54.75 报告的一条 P3：

- **空行也算「紧邻」**（P3-①）：0.54.75 的邻接判断只放行一个换行（`(?:\r?\n[ \t]*)?`），`MATRIX.` 与 `BEGIN DATA` 之间有空行、或只有制表符的一个空行时剥不掉数据组，退回到「多留一个数据块、`definesData` 假变真」的形态。现在改成 `/^[ \t\r\n]*BEGIN\s+DATA\b/i`：空行与缩进都算空白，注释行由 `stripCommentLines()` 先删掉，因此也照剥。实测一个空行、两个空行、只有制表符的行、CRLF 空行都得到 `["DESCRIPTIVES x."]`、`definesData:false`；不紧邻的数据组（`MATRIX.` 后面先有别的命令）不受影响。
- 测试：新增「blank lines do not separate MATRIX. from its data group」（四种空行形态一起断言），regression 97、全量 **541**（装了 poppler 的机器 542）。
- 顺带明确口径（写进本段）：只有空白（空行、缩进、制表符）能让 `MATRIX.` 与数据组分开；注释行会被 `stripCommentLines()` 先删掉，因此带注释的写法与带空行的写法等价。

## 0.54.75

Win10 0.54.74 报告的两条 P3（都只在「未闭合 `MATRIX`」这类畸形脚本上出现，只影响分类文本，不影响引擎与出表）：

- **只剥紧邻 `MATRIX.` 的数据组**（P3-①）：0.54.74 的剥离正则 `^[ \s]*BEGIN` 在 `m` 模式下能命中尾巴里任意行首，把「跟 `DATA LIST` 走的数据块」也当矩阵数据剥掉了，`DATA LIST FREE /x.` 于是成了没有数据块的孤命令。现在改成显式判断「`MATRIX.` 之后只有空白就接 `BEGIN DATA`」才剥：`MATRIX.` + `DESCRIPTIVES y.` + `DATA LIST FREE /x.` + 数据块 + `DESCRIPTIVES x.` 切出四条，数据块仍在。
- **`END DATA` 带杂物也收尾**（P3-②）：新增 `END_DATA_ANY = /^[ \t]*END\s+DATA\b[^\n]*$/im`，只在矩阵代数里用它认块尾。`MATRIX.` + `BEGIN DATA` + `1` + `END DATA 5` + `DESCRIPTIVES x.` 以前整段粘成一条（`asksForResults:false`），现在只剩 `["DESCRIPTIVES x."]`。PSPP 自己会对 `END DATA 5` 报 `Syntax error expecting end of command.`，插件只负责不把后面的命令埋进去。
- 测试：新增「a data group far from MATRIX. is not the matrix group」「junk after END DATA still ends the matrix data group」，regression 96、全量 **540**（装了 poppler 的机器 541）。

## 0.54.74

Win10 0.54.73 报告的三条 P3：

- **死变量去掉**（P3-①）：`splitStatements()` 里 `const rest = statements.splice(...)[0]` 的 `rest` 从未使用，改回直接 `splice`。
- **畸形矩阵块里的数据组跟着矩阵一起走**（P3-②）：未闭合 `MATRIX.` 后紧跟的 `BEGIN DATA … END DATA.` 现在先剥掉再重新切分尾巴，`MATRIX.` + `BEGIN DATA` + `1` + `END DATA.` + `DESCRIPTIVES x.` 回到 `["DESCRIPTIVES x."]`（0.54.73 会多留一个数据块，让分类文本误报 `definesData:true`）；对应用例从 `assert.ok(parts.some(...))` 收紧成 `assert.deepEqual(parts, ['DESCRIPTIVES x.'])`。
- **措辞统一**（P3-③）：0.54.69 段的「（不含 pdftotext 的 skip 行）」改成「（装了 poppler 的机器 534）」，与 0.54.71 起各段一致；数字 533 本就正确。
- 全量 **538 条 ok**（装了 poppler 的机器 539），regression 94。

## 0.54.73

Win10 0.54.72 报告的 P2 一条 + P3 两条：

- **计数口径终于自洽**（P2-① / P3-①）：文首声明改成「按没装 pdftotext 的机器计」，0.54.72 段 537 → **536**（装了 poppler 的机器 537），`docs/FEATURES.md` 那句自相矛盾的括注也改对了。前几版每版多 1 的根因就是「本机与 CI 都有 poppler，却把含 pdf-notes 的数字当成不含 skip 的口径写下来」。
- **合并循环的判据与切分器对齐**（P3-②）：丢弃矩阵代数时只认「行首 `MATRIX` + 句点」，`MATRIX DATA VARIABLES=x y.` 因此不再从分类文本里消失；带 `BEGIN DATA … END DATA.` 的 `MATRIX DATA` 脚本现在切出 `["MATRIX DATA VARIABLES=x y.", "BEGIN DATA\n1 2\n3 4\nEND DATA.", "DESCRIPTIVES x."]`。
- **未闭合的 `MATRIX` 只丢自己**（P3-③）：`MATRIX.` + `COMPUTE x = 1.` + `DESCRIPTIVES x.`（既无 `END MATRIX` 也无 `END DATA`）以前整段粘成一条语句、然后被整体丢弃，现在把 `MATRIX.` 之后的部分重新切分，得到 `["COMPUTE x = 1.", "DESCRIPTIVES x."]`。
- 测试：新增「MATRIX DATA is a command, not algebra」与「an unterminated MATRIX drops only itself」，regression 94、全量 **538**（装了 poppler 的机器 539）。

## 0.54.72

Win10 0.54.71 报告的 P2 一条 + P3 三条：

- **`MATRIX DATA …` 不再被当成矩阵代数**（P3-③ 之一）：`splitStatements()` 与 `stripCommentLines()` 的入口判据从「行首是 `MATRIX`」收紧成「行首是 `MATRIX` + 句点」（`/^[ \t]*MATRIX[ \t]*\./i`）。原来 `MATRIX DATA VARIABLES=x.` 会把状态置真，后面普通数据块里读作 `END MATRIX.` 的数据值就把块提前收掉、下一行 `* 7` 被当注释剥掉。
- **矩阵状态在块收尾时无条件复位**（P3-③ 之二）：原来只在 `end === matrixEnd` 时复位，畸形脚本（`MATRIX.` 后由 `END DATA` 收尾）会让状态挂到下一次 `END MATRIX`。现在两种收尾都清。
- **未闭合的 `MATRIX` 只丢它自己那条语句**：合并循环以前从 `MATRIX` 一路丢到文件结尾的 `END MATRIX`，找不到就把后面所有命令一起丢掉，于是 `MATRIX.` + `BEGIN DATA` + `END DATA.` + `DESCRIPTIVES x.` 切出来是空数组（等于让用户以为脚本是空的）。现在没有结束标记时只丢该语句，块后的命令照常保留。
- 测试：新增「matrix data does not look like matrix algebra」「a matrix block that ends at END DATA still clears the flag」两条，regression 92、全量 **536**（装了 poppler 的机器 537）。
- 文档口径（P2-① / P3-① / P3-②）：本段起在文件头加一段计数口径说明；0.54.71 段的「全量 535」按新口径改为 **534**（并注明有 pdftotext 的机器是 535）；0.54.68 段补上「（不含 pdftotext 的 skip 行）」的括注。0.54.57 及更早的数字保持原样（旧口径，见文首说明）。

## 0.54.71

Win10 0.54.70 报告的 P2 两条 + P3 一条：

- **`splitStatements()` 认得自己在不在 `MATRIX` 块里**（P2-①）：新增一遍行首状态机（`MATRIX` 置真、`END MATRIX` 置假），于是①普通数据块只由 `END DATA` 收尾 —— 数据值恰为 `END MATRIX.`/`END MATRIX` 时该块的行结构不再被合并丢掉（0.54.69「取先出现者」的副作用）；②`MATRIX` 块里的句点不再切开语句，矩阵组整块丢弃时不会留下 `1.5\nEND MATRIX.` 这种残句（P3-①）。
- 测试：「a data value that reads END MATRIX does not close the inline block」的断言从「块里含 `* 7`」改成正整数块字符串（`BEGIN DATA\nEND MATRIX.\n* 7\nEND DATA.`），另加「matrix algebra is dropped whole, with its data group」（矩阵数据组与纯代数两种形态都只剩块后的命令），regression 90、全量 534（有 pdftotext 的机器是 535）。
- **CHANGELOG 计数统一口径**（P2-②）：全篇一律写本机实测的 `^ok` 行数（不含 `pdf-notes` 那条 skip），0.54.68 段 533 → 532、0.54.69 段 534 → 533；`docs/FEATURES.md` 的 535 同样注明「没有 pdftotext 的机器少 1 条」。

## 0.54.70

- 文档口径（Win10 0.54.68 报告 P2 / P3-③）：0.54.67 段的总数按实测改回 531（532 是 0.54.68 的数），0.54.59 段改回 525，0.54.58 段改回 524，并给 0.54.60 段补上缺失的计数行 527（regression 85）。三段数字现在是各自 tag 树的实测值。
- 关于 P3-①（中文导出的 `变量，12 B` 变成 `变量 · 12 B`）：`describeSources()` 那一行在中文里本来就全程用 ` · ` 分隔（`来源 · 3 例 · 1 变量`），大小跟着用同一个分隔符是刻意的，不再单独为中文切回全角逗号；英文侧因此也没有残留中文标点。

## 0.54.69

- **`MATRIX … END MATRIX` 不再吞掉它后面的数据块**：`splitStatements()` 在 `BEGIN DATA` 处同时算出 `END DATA` 与 `END MATRIX` 的位置、取**先出现**的那个收尾。原来先用 `END DATA` 试探，于是矩阵数据组一直吞到文件后半段那个 `END DATA`，中间的 `DATA LIST`、数据块和整段分析全都不见了（`classifyScript()` 连 `definesData` 都报假，0.54.58–0.54.68 同现）。Win10 0.54.68 报告 V9-P1。
- `test/regression.mjs` 新增「a matrix data group does not swallow the data block after it」（切分结果必须是 `["DATA LIST FREE /x.", "BEGIN DATA\n1\nEND DATA.", "DESCRIPTIVES x."]`，`definesData`/`asksForResults` 都为真）。全套 533 条 ok（装了 poppler 的机器 534）。
- 文档：`docs/FEATURES.md` 的界面语言一节按现状重写（1292 条词条、`{0}` 模板按字面长度降序、导出外壳与表注前缀跟随语言、表注正文仍中文）。

## 0.54.68

- `MATRIX … END MATRIX` 里的内联数据组不再被句点切开：这类块没有自己的 `END DATA`，`splitStatements()` 现在把 `END MATRIX` 也当块尾，矩阵代数里的 `1.5 2.25` 不会被当成两条命令交给分类器（这条与 0.54.67 的 P3 同源，方向相反：块内的 `END MATRIX` 收尾，块外的值不收尾）。
- `test/regression.mjs` 加一条（矩阵内联块切分结果必须正好是块后的两条命令），regression 88、总数 532（不含 pdftotext 的 skip 行）。

## 0.54.67

Win10 0.54.64 报告的五条，全部采纳：

- Excel 的工作表名与占位文字也跟界面语言：`图表` / `数据` 两个页签在英文导出里是 `Charts` / `Data`，`（图表见上方）` 有词条了（`(charts above)`），空工作簿的默认页签也不再写死 `Sheet1`（Win10 P1-①）。
- Word 导出的兜底标题同一处漏翻：数据集没有名字时，正文标题与 `docProps/core.xml` 的 `dc:title` 仍拼中文 `统计输出`；改成走同一套 `localize()`，英文导出是 `Statistical output · PSPP Output`（P1-②）。
- `（图表缺失）` 的占位原来有词条却没用：图片取不到时 Word 文档里仍是中文，现在跟语言走（P2-①）。
- CHANGELOG 的结构理顺：0.54.59 的小节标题在整理时丢了，它的正文（`inlineCommandProblem`）被并进 0.54.60 段，现在拆回独立小节；同时按实测改正两处计数（0.54.59 段 526 → 527、0.54.58 段 525 → 524），这是 Win10 连着两轮指出的同一类偏差（P2-②）。
- 内联数据块只有 `END DATA` 能收尾：数据值恰好是 `END MATRIX.` / `END MATRIX` 独占一行时，以前也会把块关掉，紧随其后的 `* 7` 被当注释剔；现在 `END MATRIX` 只在 MATRIX 块内部（它自己那套 `BEGIN DATA` 没有 `END DATA`）才结束内联数据（P3-①）。

测试：`test/office.mjs` 加一条「sheet names, chart placeholders and the title fallback are translated too」（英文工作簿的页签名、图表页、`charts above`、`chart missing`、`Statistical output`）；`test/regression.mjs` 加一条「a data value that reads END MATRIX does not close the inline block」，并在 MATRIX 内联块那条用例上补注释说明两种块的区别。

32 套件 / 531 条 ok（regression 87、office 54）。

## 0.54.66

- 英文导出的来源行里，文件大小前面原本是中文逗号（`… · 2 variables，32 B`），在 `docProps/core.xml` 里留下一个汉字；改成语言中立的分隔符 ` · `，英文文档的属性里不再有中文。
- `test/office.mjs` 跟着改断言，另加一条英文面板表注前缀的断言（`Note: `）。

## 0.54.65

- 面板上的表注前缀也跟界面语言：英文界面显示 `Note: …`，不再在英文结果里出现 `注：`（0.54.26 加渲染时把前缀写死了）。
- Excel 导出里「（图表见上方）」的占位文字跟随语言（`localize('（图表见上方）', lang)` → `(chart above)`）。

## 0.54.64

- Word/Excel 导出的**文字外壳**跟随界面语言：表注前缀、来源戳、文档属性（`dc:title`/`dc:subject`/`dc:description`）、空表占位、表太长提示都走 `localize()`，`buildDocx`/`buildXlsx` 接 `lang`，`exportOffice` 传 `uiLanguage`。数据值（`甲`/`乙`、变量名、值标签）照旧原样（Win10 0.54.60 报告 P1-①）。
- HTML 导出的底栏不再残留 `打开于`：来源行改成 `tr('{0} · {1} 例 · {2} 变量{3}{4}', …)` 一次插值，` · 打开于 {0}` 单独走模板（Win10 0.54.60 报告 P1-②）。
- 「有表、但语法里有命令被引擎拒绝」时，第一张表上出一条注文「引擎对这段语法报了 N 处错误…下面这些结果只是它能算出来的那部分」，不再让半成功的运行看起来像整段跑通（Win10 0.54.60 报告 P2-②；`diagnostics` 面板不显示，只有工具结果看得到）。
- `END MATRIX` 只在**独占一行**时才清内联数据标记，数据值 `END MATRIX 5` 不再让紧随的 `* 7` 被当注释删掉（Win10 0.54.60 报告 P3）。
- 修正文档口径：断言数按 `grep -cE '^ok\b'` 实测写（0.54.60 那段当时是 527，不是 526）。

## 0.54.63

- 「一条命令要另起一行」不再误伤内联数据：`BEGIN DATA … END DATA` 之间的行不参与句点扫描，字符串列里的 `Mr. Smith` 这类值不会被当成两条命令（块外的真同行命令仍然会拦）。

## 0.54.62

- 值标签也不进翻译：分析对话框里 `1 = 男` 这种选项按原样显示，`translate: false` 现在连 `title` 一类的属性一起跳过（英文界面不会再把值标签换成 `Male`）。

## 0.54.61

- 对话框里的变量列表也不再被翻译：变量选择、分组/控制变量、值标签目标、图表变量等下拉与 chip 都标了 `translate: false`，名字叫 `保存`、标签叫 `缺失` 的变量在英文界面里仍显示原名（与 0.54.60 的网格/表头一致）。

## 0.54.60

- 英文界面不再翻译数据：数据网格的单元格、表头里的变量名与标签、变量视图的名称都标了 `translate: false`，`总计`/`缺失`/`保存` 这类值不会被字典换成 `Total`/`Missing`/`Save`（Win10 0.54.57 报告 §6.1）。
- 内联数据块里以 `*` 开头的数据值从第二行起不再被当注释删掉：块尾判据只对当前行生效（`END_DATA_ONE`/`END_MATRIX_ONE`），不再让文件后面出现的 `END DATA.` 在第一个数据行就把标记清掉（Win10 0.54.57 报告 §6.2，0.54.52 引入的回归）。

32 套件 / 527 条 ok（regression 85）。

## 0.54.59

真引擎电池（40 段常见语法）里发现一条真实的手感问题：**两条命令写在同一行**。PSPP 只在行首开始读命令，`DESCRIPTIVES a. DESCRIPTIVES b.` 会被当成一条命令、`DESCRIPTIVES` 变成变量名，引擎回的是「`a.` is not a variable name」——一句完全指错方向的话。粘贴一行合成语法的人最容易踩到这个。

- 新增 `export function inlineCommandProblem(script)`：引号感知地扫每条命令结尾的句点，若同一行后面还有内容就报「一条命令要另起一行：「…」后面紧跟着「…」…」；第二段像命令时说明「会被读成一条命令、第二段被当成变量名」，不像命令时（例如 `* note`）说明「PSPP 读到这一行就停，后面的内容不算注释也不会执行」。
- 数字里的句点不算边界（`1.5`、`1. 5`、`.05` 都不误报），字符串里的句点也不算（`TITLE 'Step 1. Descriptives'.`、`'it''s. DESCRIPTIVES'`）。
- `runSyntax` 在引擎错误分支之前调用它（与 `END DATA` 同行提示同一个位置）。
- `test/regression.mjs` 加一条九断言；`test/smoke.mjs` 加真引擎用例（同一行必须给中文提示且不含 `is not a variable name`，换行后仍出两张表）。

32 套件 / 525 条 ok（regression 84）。

## 0.54.58

英文界面最后一块没翻的地方：**HTML 导出的文件外壳**。面板里已经是英文，导出的 `pspp-output.html` 里 `<title>` 还是 `PSPP 输出`、表注前缀是 `注：`、来源行从 `来源：… 例 … 打开于 …` 拼起 —— 这份文件是要发给别人的，半汉半英比全中文更难读。Win10 05448 报告把这批列为「不在面板界面里，故不翻」，但导出文件同样属于用户看到的东西，本版一并处理。

- `<title>` 走 `tr('PSPP 输出')`（新增键 → `PSPP Output`）、表注前缀 `tr('注：')`（`Note: `）。
- 表太长提示改成模板 `tr('表太长：这张表共 {0} 行，这个文件里只放了前 {1} 行；完整数据请用「导出表格为 CSV」。', total, shown)`（原来把数字插进中文再翻，命中不了模板）。
- 来源行改成模板 `tr('来源：{0} · {1} 例{2}{3}{4}{5}', …)`，`运行 #`、`数据指纹`、`打开于` 各自成键（相邻占位符不能用插值形式，正则分不清边界）。
- 词典 1270 → 1276 条。
- `test/client.mjs` 英文面板用例补一段：点「File → HTML 导出」，断言导出的 `<title>` 是 `PSPP Output` 且文件里不再出现 `PSPP 输出`。

32 套件 / 524 条 ok（client 29）。

## 0.54.57

Win10 0.54.51 报告 §6 的三条，全部采纳：

- §6.4-P1 **文案按有没有 `WEIGHT BY` 分流**：`annotateZeroCases(items, dataset, script)` 现在读语句判断本次运行是否带权重 —— 带权重才说「权重列在每一行上都是 0，先跑一次 WEIGHT OFF」，不带权重直接说「参与分析的列在这 N 例上全是缺失值（不是权重的问题）」。原来一律先怪权重，对全缺失数据是错误引导。
- §6.4-P2 **跳过自解释的汇总表**：`Case Processing Summary`/`Report`/`Summary`/`Model Summary` 已经写明 Included/Excluded/Total，不再挂注文。
- §6.4-P2 **每个 run 只挂一次**：`MEANS`/`EXAMINE` 会打印多张同样为空的表，六段同义注文读起来像六个 bug；加注后 `break`。
- `test/regression.mjs` 该用例改成带脚本参数并补一条（无权重 → 说缺失值且不提 WEIGHT OFF；有 `WEIGHT BY` → 提 WEIGHT OFF；汇总表不挂；两张空表只挂一条）。

32 套件 / 524 条 ok（regression 83）。

## 0.54.56

Win10 0.54.49 报告 §6 与 0.54.52 报告 §6.2 的三条，加一轮英文界面残留清扫：

- **`annotateZeroCases` 的判据**（05449 §6）：原来只看「`N` 列里任意一行是不是 0」，`DESCRIPTIVES` 的 `Missing N (listwise) = 0` 行、`T-TEST` 的空组行都会误命中（0.54.51 用「所有 N 都为 0」压住误报，但会漏掉多变量表里只有一个变量全缺失的情形）。改成**只数点名了东西的行**：第一列非空、且不是 `Valid`/`Missing`/`Total`/`Sum` 这类汇总行。
- **`END DATA` 判据统一**（05452 §6.2）：三处判据合成常量 `const END_DATA_LINE = /^[ \t]*END\s+DATA[ \t]*(?:\.[ \t]*.*)?$/im`（`END MATRIX` 同理 `END_MATRIX_LINE`），合并循环不再用非锚定的 `/END\s+DATA\b/` —— 数据值 `END DATA now` 不再被当块尾。
- **英文界面残留清零**：`client.js` 42 处中文模板改 `tr('…{0}…', 参数)`，`locale/en.json` 1207 → 1270 条（+63）。覆盖请求超时、批量导入值标签、多选题定义、分析对话框报错（对比系数 / 百分位）、编辑表格与值标签标题、未保存关闭确认、输出筛选与报告卡、数据集来源 tooltip、变量视图 11 个列名与 tooltip、编辑菜单与撤销标签、状态条 chips、31 处通知条、页签标题模板；toast 里的运算名改 `tr(title ?? '运行')`（原来出现 `频率 finished: 1 tables`）。jsdom 扫 109 个表面 + 84 个对话框后为 `0 distinct CJK strings`。

测试：`test/regression.mjs` 加两条（带 `Missing N (listwise) = 0` 的正常表不出注文、`END DATA now` 留在块内）；`test/client.mjs` 29、`test/i18n.mjs` 9。32 套件 / 524 条 ok。

## 0.54.55

Win10 0.54.49 报告 V3 的 FAIL：`END DATA` 同行命令的中文提示是**死代码**。`inlineDataTailProblem(requested)` 的检查写在「引擎退出码非 0 且没有任何表」那个分支**之后**，而 PSPP 对这类脚本必定 exit 1 且零表，所以永远先抛出英文原文 `Missing END DATA while reading inline data.`（`lib/workspace.js` 里那段检查在 `parsed.length === 0` 分支内，走不到）。

- 把检查提到 `(result.code !== 0 || result.signal) && parsed.length === 0` 分支的**最前面**，命中就抛中文。
- 报告 §4/§6 的误报（`DESCRIPTIVES` 的 `Missing N (listwise) = 0` 行、`T-TEST` 空组）在 0.54.51 已因「所有 N 都为 0」判据修好，本包复核覆盖：12 例普通数据 `DESCRIPTIVES score.` 不再挂权重注文。
- `test/smoke.mjs` 加真引擎用例（`END DATA. DESCRIPTIVES …` 必须报「必须独占一行」且不含 `Missing END DATA`）。

32 套件 / 523 条 ok（smoke 套件只打印不计数）。

## 0.54.54

Win10 0.54.48 报告 V6 的 7 处英文残留，根因是同一个：**模板按「key 长度」排序**，通用键 `{0}：{1}` 比 `拆分：{0}` 长，于是任何「前缀：后缀」都被它吃掉，只把全角冒号换半角 —— 产出 `拆分: grp`、`删除第 1 cases`、`Histogram of 画 score` 这种半汉半英。

- 排序改成按**字面文本长度**（把占位符去掉再比），客户端 `client.js` 的 `setDictionary()` 与宿主 `lib/i18n.js` 的 `templatesOf()` 两处都改。`拆分：{0}`、`会话：{0}`、`新标签页：{0}` 三条被遮蔽的键恢复正常。
- 数据网格右键菜单 5 项 + 标题改模板（`{0} · 第 {1} 行`、`第 {0} 行（还没有变量）`、`在第 {0} 行前插入个案`、`删除第 {0} 个个案`、`整表按 {0} 升序/降序`、`画 {0} 的直方图`）。
- 多选题详情行改模板（`{0} · {1} 个变量：{2}`，`二分法`/`多分类` 各自翻译）。
- `拆分：` 挂件把插值挪进参数位（原来先插值再 `tr()`，被通用键命中）。

词典 1199 → 1207 条；`test/i18n.mjs` 加一条八断言。32 套件 / 523 条 ok（i18n 9）。

## 0.54.53

Win10 0.54.47 报告 §6.1 与 §6.2 两条 P1：

- §6.1 PSPP 的最短缩写是**三个字母**（`des`、`fre`、`cro`、`correl`、`exa`、`mea`、`lis`、`com`、`sel`、`fil`、`wei`、`sor`），我按「四字母」设的缩略表仍漏掉一整段 —— 0 行数据集上跑 `des x.` 一句话都没有。改成**反向前缀匹配**：看语句头是不是某个命令名的前缀（命令名去空格比较），`DES`/`DESC`/`DESCRIPTIVES` 都能命中，`CORRELATIONS` 也补进表里。
- §6.2 正向前缀会命中不是命令的词首（`docount`、`description`、`selector`、`filtered`、裸 `DO`），把用户变量名当数据步。反向匹配天然解决：`DOCUMENT` 不是任何命令名的前缀，`SELECTOR` 也不是 `SELECT IF` 的前缀。`DO REPEAT` 只算改数据、`DO IF` 才算筛选；`FIL`/`FILT`/`FILTER` 仍要求后面跟 `BY`。
- §6.3 的 `END DATA.` 后跟注释在 0.54.52 已修，本包复核覆盖。

`test/regression.mjs` 加一条（十种三字母缩写 + 四个假命令词）：81 条；32 套件 / 522 条 ok。

## 0.54.52

Win10 0.54.46 报告 §6.1 抓到 0.54.46 **自己引入**的回归：`stripCommentLines()` 里清 `inInlineData` 的正则漏了 `m` 标志（同一文件里 `splitStatements()` 的对应正则是有 `/im` 的）。后果是 `END DATA.` 后面只要跟一行注释，标记就永不清除，块后所有命令被并进那条注释：

- 空内联块 + 注释 + `DESCRIPTIVES` ⇒ `asks=false`，0 行数据集上是**静默空白**；
- 同样形态 + `SELECT IF` 筛光 ⇒ 提示说「导入的那份数据是空的」，归因错。

修法：该正则补 `m` 与行首缩进（`/^[ \t]*END\s+DATA[ \t]*(?:\.[ \t]*.*)?$/im`），`END MATRIX` 那条也补 `m`。用例两条（块后注释不吞命令、筛光仍说筛掉）：80 条；32 套件 / 521 条 ok。

## 0.54.51

`annotateZeroCases` 在真引擎上复查时发现会误命中：`T-TEST` 的 `Group Statistics` 里只**一个**分组是空的时候（另一组有 2 例），表里出现 `N = 0` 但数据完全正常，注文却指向「数据文件里存着权重」。改成要求表里**所有** `N` 都是 0 才算（空组是正常的数据缺口）。

真引擎复核：`WEIGHT BY` 全 0 时 5 张表各一条注文；正常交叉表不误报。

`test/regression.mjs` 加「一个空分组不算权重的证据」：79 条；32 套件 / 520 条 ok。

## 0.54.50

Win10 0.54.45 报告 §6 的两条建议：

- §6.1 `SAMPLE` / `SAMPL` 抽光个案时被归到「筛选」，提示让用户「把筛选条件放宽」——方向指错。`classifyScript()` 新增 `samplesData`，`runSyntax` 在筛选那句之前单列一条：「这段语法里的 SAMPLE 没有抽到任何个案（抽样比例太小，或者数据本来就少）。把比例放宽，或者去掉 SAMPLE 再跑一次」。
- §6.2 权重注文原来只挂在第一张表，后面的表只剩 `N = .00` / `NaN` 没人解释。`annotateWeightedEmpty` 改为给本次运行里每一张表都挂（已有同一条注文的表跳过），返回值改成加了几条。
- §6.3（`GET FILE` 读回带权重的 `.sav`）与 §6.4（`END MATRIX` 非行首锚定）在 0.54.49 与 0.54.46 已修，本轮复核覆盖。

`test/regression.mjs` 加一条（`SAMPLE` 归抽样、`SAMPLE 50 FROM 1000` 同样）：79 条；32 套件 / 520 条 ok。

## 0.54.49

Win10 0.54.43 报告 §4 与 §5 各一条：

- §4.1 权重会随 `SAVE OUTFILE` 存进 `.sav`，之后 `GET FILE` 跑分析，表里 `N = .00` 而语法里没有 `WEIGHT BY`，旧实现完全不解释 —— 正是这条注文想消灭的情形。新增 `annotateZeroCases(items, dataset)`：内存里有 N 例、而某张表的 `N` 列有 0 时给注文「这张表的有效个案是 0，可内存里这份数据有 N 例：最可能是数据文件里存着权重…先跑一次 WEIGHT OFF」。已有「加权后有效个案是 0」的表不重复加。
- §5 D `END DATA` 与命令同一行时 PSPP 报 `END DATA must appear by itself on a single line`，直译英文对用户没帮助。新增 `inlineDataTailProblem(script)`：跑引擎之前就报「END DATA 必须独占一行：它后面还有「…」。PSPP 读到这一行就停，把后面的命令挪到下一行再跑」。

`test/regression.mjs` 加两条（零个案注文四种情形、同行命令检查三种情形）：78 条；32 套件 / 519 条 ok。

## 0.54.48

Win10 0.54.42 报告 V2 判 FAIL，三条残留都在「参数没翻」这个家族里：

- 图表标题由宿主按变量名拼（`score 的直方图`），前端 `tr()` 只做整串命中，`Score 的直方图` 依然不命中。改成标题也在宿主侧 `localize()`：`lib/workspace.js` 的 `addChart()` 与已存图表的重绘都过一遍 `localize(chart.title, lang)`，词典补五个模板（`{0} 的直方图`、`{0} 与 {1} 的散点图`、`{0} 按 {1} 的箱线图`、`{0} 的箱线图`、`{0} 的构成（环形）`）。
- 右键插入/删除个案提示是拼串（`'已在第 ' + n + ' 行插入个案'`）⇒ 改模板 `tr('已在第 {0} 行插入个案', row + 1)`、`tr('已删除第 {0} 行', row + 1)`。
- 撤销/重做的标签为空时拼出 `已撤销：` ⇒ 标签为空时只用动词本身；顺带补 `{0}：{1}` 键。

词典 1190 → 1199 条；`test/i18n.mjs` 加一条七断言（标题模板、插入/删除提示）。

32 个套件 / 517 条 ok（i18n 8）。

## 0.54.47

PSPP 接受四个字母以上的命令缩写（它自带的例子就用 `descript`、`freq`），旧的正则只认全名，于是 `descript all/stat=all.` 被归成「没有分析」—— 0 结果时那句解释就不会出现。

`classifyScript()` 增加 `head()` / `abbreviated()` 两个小工具，`asksForResults`、`changesData`、`filtersData` 都能识别缩写（`descript`、`freq`、`crossta`、`comp`、`reco`、`sort`、`weig`、`selec`…）。`filt` 只在后面跟 `BY` 时才算筛选，`filt off` 不算。

用 `/usr/share/pspp/examples/*.sps` 复核：`descript` / `regress` / `regress_categorical` / `t-test` 都判成有分析，`grid` 是纯建数据（正确）。

32 个套件 / 516 条 ok（regression 76）。

## 0.54.46

Win10 0.54.41 报告 §5 的两条 P2：

- `MATRIX` 的结束判据改回行首锚定（`/^[ \t]*END\s+MATRIX\b/im`）：矩阵字符串里写 `'END MATRIX here'` 不再提前收尾，块内的 `COMPUTE` 也就不会留下来当数据步（0 行数据集上那句「这段语法先改了数据」是错误归因）。
- `END DATA` 的块尾判据收紧：后面只允许空白与一个可选句点（`/^[ \t]*END\s+DATA[ \t]*(?:\.[ \t]*.*)?$/im`）。数据值恰好以 `END DATA` 开头（`END DATA DESCRIPTIVES VARIABLES=s`）时不再被当成块尾 —— PSPP 自己也不认这种行。
- `stripCommentLines()` 的块尾判断同步收紧，数据值开头的 `END DATA …` 不会提前清掉 `inInlineData`。

用例：矩阵字符串含 `END MATRIX` 时整块丢弃、只留 `DESCRIPTIVES`；`END DATA DESCRIPTIVES …` 留在数据区且 `asksForResults=false`。

32 个套件 / 515 条 ok（regression 75）。

## 0.54.45

`annotateWeightedEmpty` 改为读语句而不是整段文本：`* WEIGHT BY w.` 这种注释、以及 `TITLE 'WEIGHT BY w'.` 里的字符串都不算加权；出现两次 `WEIGHT BY` 时取最后一条（与引擎一致）。以前注释里提到权重也会给表加注文。

用例三条（注释、标题字符串、真加权）+ 原来的全 0 / 非全 0 两条。

32 个套件 / 513 条 ok（regression 73）。

## 0.54.44

Win10 0.54.39 报告 V5-④：`MATRIX` 块里的 `BEGIN DATA` 没有自己的 `END DATA`，`stripCommentLines()` 的 `inInlineData` 标记会一直开着，导致后面整份文件都不再剔除注释（低危，但会改变分类结果）。`END MATRIX` 现在也清这个标记。

用例：`MATRIX. / BEGIN DATA / END MATRIX. / * a note / DESCRIPTIVES v.` 的 `asksForResults` 必须仍为 true。

32 个套件 / 512 条 ok（regression 72）。

## 0.54.43

Win10 0.54.38 报告 §6 的两条：

- `FILTER OFF` 不再算筛选：`filtersData` 的正则从 `FILTER` 收成 `FILTER\s+BY`。取消筛选被当成筛选时，一个空文件会被说成「筛选把个案筛光了」。
- 新增 `annotateWeightedEmpty(items, dataset, script)`：语法里有 `WEIGHT BY x` 且 `x` 这一列全是 0 时，给第一张表加注文「加权后有效个案是 0：…PSPP 会把权重为 0 的个案整条排除。把权重改成 1 以上的值，或者先 WEIGHT OFF 再跑一次」。以前这种情况引擎照常出表（N = .00），用户看数据明明有 4 例却没有任何解释。
- 踩坑：变量名的字符类里不能带 `.`，否则 `WEIGHT BY w.` 会把 `w.` 当成名字，列查找失败、注文静默不出现。

32 个套件 / 511 条 ok（regression 71）。

## 0.54.42

英文界面最后一类残留：提示条（toast）。`notify(\`…\`)` 里 34 处带插值的模板没有词典键，`tr()` 只认整串与 `{0}` 模板，所以整句保持中文（Win10 0.54.37 报告 V2 列的 8 个实测例子全属这一类）。

- 34 处全部改成 `tr('…{0}…', args)`，嵌套片段（`（新增 N 列）`、`；已新增 …`、`（N 条提示）`、` 等 N 条…`）各自有键并传**已翻片段**。
- 词典 1155 → 1190 条。
- `grep -c "notify(\`"` 归零；`node -e` 扫 `tr('…')` 里含汉字但无键的字面量 = 0。

32 个套件 / 510 条 ok。

## 0.54.41

`END DATA` 必须是行首的命令才算块结束：数据值里出现 `1 END DATA 2` 时，0.54.40 会把它当成块尾，把后面的 `2` 与真正的 `END DATA.` 拆成另一条语句（分类仍对，但块的形状是错的）。改成 `/^[ \t]*END\s+DATA\b/im`。

用例：该脚本必须切成两条且第一块以 `END DATA.` 结尾；`TITLE 'BEGIN DATA'. DESCRIPTIVES v.` 必须切成两条（引号里的 `BEGIN DATA` 不触发跳过分支）。

32 个套件 / 510 条 ok（regression 70）。

## 0.54.40

Win10 0.54.35 报告 V5 的 B 项：内联数据里的撇号会开出一个不闭合的字符串。

`BEGIN DATA` 之后到 `END DATA` 之前整块交给「数据」，引号状态机完全不参与（`splitStatements()` 在 `quote === ''` 且看到 `BEGIN DATA` 时直接跳到 `END DATA` 之后）。以前 `BEGIN DATA / Bob's data / END DATA. / SELECT IF … / DESCRIPTIVES …` 会被切成**一条**语句，`asks=false`、`filters=false` —— 0.54.34 的注释剔除让它变成静默的空输出。

回归用例：该脚本必须切成三条，且 `asksForResults`/`filtersData` 都为 true。

32 个套件 / 509 条 ok（regression 69）。

## 0.54.39

Win10 0.54.34 报告 V5 的两条静态意见：

- ② `BEGIN DATA … END DATA` 之间的数据行现在整行保留：以前按行首 `*`/`COMMENT` 剔除注释时会连数据值一起删（`BEGIN DATA / * 7 / 1 / …` 变成空行），分类器于是读到有洞的数据块。`stripCommentLines()` 新增 `inInlineData` 状态，进块后到 `END DATA` 之前不做注释剔除。
- ③ 报告里的「合并循环回归」在 0.54.36 已修：现在按语句自身是否含 `END DATA` 判断，实测 `DATA LIST` + 内联数据 + `SELECT IF` + `DESCRIPTIVES` 的 `asks/filters/loads` 全部正确，会正常给出「筛选把个案全部筛掉了」。本轮补两条用例把这两种形态钉住。

32 个套件 / 508 条 ok（regression 68）。

## 0.54.38

Win10 0.54.33 报告 V5：0.54.33 的置顶分支只问「有没有改数据」，把 `COMPUTE`/`SORT` 也当成筛选，于是「导入空文件 + 任意数据步」被说成「筛选把个案筛光了」——正好是 0.54.29 那次错误的镜像。

- `classifyScript()` 新增 `filtersData`（`SELECT IF|FILTER|DO IF|IF`），与 `changesData` 分开。
- 分支改序：`loadsData && filtersData` → 「筛掉」（导入后被筛光）；`loadsData` → 「导入的那份数据是空的」（空文件 + COMPUTE/SORT 也走这里）；空数据集两条不变；最后 `cases > 0` → 「筛掉」。
- 用例：`GET DATA(空文件) + COMPUTE + DESCRIPTIVES` 必须说「导入的那份数据是空的」且不得出现「筛」；`GET FILE + SELECT IF + DESCRIPTIVES` 仍说「筛掉」。

32 个套件 / 506 条 ok（regression 66）。

## 0.54.37

Win10 0.54.32 报告 V2 的 7 处对话框残留（0.54.27 删掉短键替换后，凡是在调用点拼好的复合串都必须有模板键）：

- `Go to Case` 的 `个案编号（1–N）`、`Bulk Import Value Labels` 的「同时套用到另外 N 个同类型变量（…）」、`Merge Files by Key Variables` 的「键变量（空格分隔，可选：…）」三句改成 `tr(模板, args)`。
- `Pairwise comparisons` / `Table 1` / `Table 2` 的 `0 selected（不选则用…）` 半混排：`{1}` 现在传**已经翻过的片段**（`tr('（不选则用除分组外的全部变量）')`）。
- `Partial Correlations` 的「已选 N 个分析变量、M 个控制变量（至少选两个分析变量）」改成模板。
- 词典 1155 条。`tr` 的空串/undefined 实参保持原占位（Win10 V5 的四条边角，#2/#3/#6 已按建议在调用点处理）。

32 个套件 / 505 条 ok。

## 0.54.36

Win10 0.54.31 报告 V2/V5：`BEGIN DATA … END DATA` 的合并循环只检查「下一条语句是否以 END DATA 开头」，而切分器经常已经把 `END DATA.` 落在当前这条语句里，于是**块后面所有命令被整段吞掉**（`BEGIN DATA / 1 2 / END DATA. / DESCRIPTIVES x.` 的 `asks` 从 true 掉成 false）。改成看去重后的最后一块，块后命令不再丢。

32 个套件 / 505 条 ok。

## 0.54.35

0.54.34 的注释剔除是按行过滤，会把**跨行字符串里**以 `*` 开头的一行一起删掉（`TITLE 'a\n* b\nc'.` 中间那行消失，命令被切成两半）。改成引号感知的一遍扫描：只在「行首、引号外」把 `*` / `COMMENT` 到行尾的内容当注释，字符串里的星号原样保留。

32 个套件 / 505 条 ok（regression 65）。

## 0.54.34

Win10 0.54.30 报告 V2/V5 抓到的三类：

- **注释行被当成命令**：`* note. DESCRIPTIVES x.` 让 `asks=true`，一段只有注释的语法在 6 例数据上抛假错误；`COMMENT … . DESCRIPTIVES x.` 同理。PSPP 对 `*` 与 `COMMENT` 都是「忽略到行尾」，`splitStatements()` 现在先整行剔掉这两种注释再看引号。
- **注释里的撇号会开一个不闭合的串**：`* it's a note` 之后整段被吞，该出现的「0 行」提示变成静默。整行剔除后不再发生。
- **双引号字符串**：状态机原来只认单引号，`TITLE "Step 1. Descriptives by group".` 会从字符串中间切开。现在单/双引号各自成对（同种字符连写两次是转义），`"it's. FREQUENCIES g"` 与 `'a"b. DESCRIPTIVES x'` 都不再切错。

32 个套件 / 504 条 ok（regression 64）。

## 0.54.33

Win10 0.54.29 报告 V4-① 指出我在 0.54.29 引入了一处归因退化：「`GET FILE` 导入 + `SELECT IF` 筛光 + 分析」落到了「导入的那份数据是空的」，而文件其实有 12 例，真正的原因是用户自己的筛选。

- 分支顺序改动：`asksForResults && cases > 0 && changesData` 提到最前（同一次运行里既改了数据又有内存里的行，最可能是筛选/写错变量名），其后才是「导入了数据」「空数据集」「先改数据」。
- 真引擎用例：`GET FILE='full.sav'`（3 例）+ `SELECT IF score > 999.` + `DESCRIPTIVES` → 必须说「筛掉了」且不得说「导入的那份数据是空的」。
- V4-②：`MATRIX … END MATRIX` 的剔除从整段正则改成在 `splitStatements()` 里按语句块剥，修掉「`END MATRIX. DESCRIPTIVES score.` 同行时把后一条命令一起吃掉」的边界（已加断言）。

32 个套件 / 502 条 ok。

## 0.54.32

Win10 0.54.27 报告 V2 的残留清单（整串没译，不再有半汉半英）：

- 菜单 6 项：`menuLabel` 先拿**整串**查词典（`撤销（Ctrl+Z）` 本来就是一个键），查不到再翻词、最后拼快捷键；`跟随设置（三线表/全框线）` 改成 `tr('跟随设置')` + `tr(样式名)`。
- 对话框 6 个节标题按钮：`${group.title}…` → `${tr(group.title)}…`（`统计量…`/`单元格…`/`图表…`/`绘图…`/`事后检验…`/`输出…` 现在都跟着走）。
- 状态栏唯一一处真混排：`9 个个案+` —— 截断时尾部多一个 `+`，模板键匹配不上。改成 `tr('{0} 个个案', n)` 再拼 `+`。
- `tr(text, ...args)` 现在自己填 `{0}` 占位：中文模式下模板原文直接填值（`导入说明 1`），英文模式用词典里的模板。
- 挂件与 tooltip 的复合串补模板键：截断显示 / 导入说明 / `引擎：{0}（{1}）` / 冲突次数 / 插件版本 / `设置文件：{0}{1}` / `计算时 {0} 个个案、{1} 个变量` / `会话：{0}` / `新建数据集{0} · {1} 例 · {2} 变量`。`locale/en.json` 1151 条。
- `test/client.mjs` 新增：英文模式下点开 Edit 菜单，断言 `Undo (Ctrl+Z)` 与 `Copy (Ctrl+C)` 都带快捷键。

32 个套件 / 502 条 ok。

## 0.54.31

`BEGIN DATA … END DATA` 之间的内联数据也交给引号状态机了，但数据行本身不是语法：一行 `1 'Bob. DESCRIPTIVES x'` 里的 `. DESCRIPTIVES` 仍会被当成一条分析命令。`splitStatements()` 现在把整块数据并成一条语句，分类只看 `BEGIN DATA`（导入）。

32 个套件 / 502 条 ok（regression 62）。

## 0.54.30

Win10 0.54.24 报告 V4-②：`classifyScript()` 的语句切分不认引号。`/(?<=\.)\s+/` 会把 `TITLE 'Step 1. Descriptives by group'.` 从字符串中间切开，于是：

- 一段只有标题的语法被判成「有分析」，6 例数据上抛假错误「这次运行没有产出任何表…筛选把个案全部筛掉了」；
- `TITLE 'run 1. COMPUTE z = 2'.` + `DESCRIPTIVES` 被判成「先改了数据」，0 行数据集上**静默**，把本该出现的「0 行」提示吞掉；
- `TITLE 'run 2. GET FILE'.` 被判成「导入了数据」，报错因成「导入的那份数据是空的」。

新增 `export function splitStatements(text)`：按引号状态机走一遍，单引号字符串整段跳过（`''` 是转义引号），只把「引号外且后面是空白或行尾」的句点当语句边界；`classifyScript()` 改用它。

另有 V4-① 的漏项（`RANK`/`LIST`/`DISPLAY`/`SHOW` 会产表却不在名单里）已在 0.54.29 补上。名单里 `TABLES`/`SUMMARIZE`/`PARTIAL` 这类 PSPP 2.1.3 不接受的名字保留作 SPSS 语法兼容，加了注释说明。

32 个套件 / 501 条 ok（regression 61）。

## 0.54.29

Win10 0.54.23 报告 V5 的两条真问题（其余都是观察）：

- **只改数据 + 分析 + 0 行仍静默**：`COMPUTE x = score + 1. EXECUTE. DESCRIPTIVES x.` 在 0 行数据集上，`COMPUTE` 合法且引擎不报错，四条分支一条都不命中，输出树空白。加第四条：`asksForResults && cases === 0 && changesData` → 「这份数据集还没有个案（0 行）：这段语法先改了数据、再在上面跑分析…」。
- **归因错**：「内存有 3 例 + 导入空文件 + 分析」以前落到「筛选把个案筛光了」。分支顺序改成互斥的四条：导入了数据 → 空数据集 → 只改了数据 → 有数据但被筛光。第一条不再要求 `cases === 0`，因为内存里有旧数据正是这个组合的常态。
- `classifyScript()`：`MATRIX … END MATRIX` 整块先剔掉（矩阵的 `COMPUTE` 不是数据步），`RANK`/`LIST`/`DISPLAY`/`SHOW` 补进「会产出结果」（它们总是打印东西，但一旦空产出就要有话说）。
- 新增 2 条 regression（矩阵块、listing）与 2 条真引擎 smoke（先改数据再分析、空导入不怪筛选）。

32 个套件 / 500 条 ok。

## 0.54.28

Win10 0.54.18 / 0.54.20 两份报告都点到的两件事：

- `test/contrasts.mjs`（21 条断言）从来没进 `npm test`，所以「本机多少条」一直少算 21 条。已接进脚本：32 个套件 / 498 条 ok；`test/zip.mjs` 是测试用的 ZIP 写入辅助模块，不是套件，留在原处。
- `pspp_status` 的 `engine.source` 会随来源变 `bundled` / `configured`，工具描述里写明了。

## 0.54.27

Win10 0.54.12 报告的 V5（英文界面 FAIL）。根因是翻译器本身，不是缺词条：

- `tr()` / `translateText()` 原来在整串没命中时，会把「字典里所有出现在句子里的短键」挨个替换掉。长句因此被切碎：`Homogeneity of variance test的 p < 0.001…`、`这份Dataset还没有cases（0）…`。现在只认**整串命中**与**显式模板**（`{0}`、`{1}`…，按整个句子锚定后回填），查不到就保持中文原文 —— 半汉半英比全中文更难读。
- 菜单标签改成「先翻译、再拆快捷键」：`撤销（Ctrl+Z）` 以前被拆成两段，键永远不命中，于是英文界面里 `编辑` 菜单的前四项一直是中文。
- 状态栏、`拆分：`、`冲突 N`、`工具挂载（registerTools）：`、表头 tooltip、`均值=…` 这些拼接出来的文字改成按片段翻译并新增模板词条。
- `✓` 勾选前缀单独处理，`✓显示值标签` → `✓ Show value labels`。
- 词条 1109 → 1135（含 26 条模板）。

32 个套件 / 477 条 ok。

## 0.54.26

面板从来不画表注。引擎表的「方差不齐 / 期望频数偏小 / 没有 Pearson 行」这些句子，加上 0.54.x 这一串过程前提提示，只出现在工具结果与导出的文件里，`state()` 的 `notes` 在界面上没有任何一处渲染 —— 也就是说，一个在侧栏里看结果的人看到的永远是没有注文的表。

- `client.js` 在每张表下面画 `ul.ap-notes`，一条 `li.ap-note` 一个「注：…」。原文照排、不经过界面字典（表注里带变量名和数字，逐词替换会拼出中英混排）。
- `test/client.mjs` 的轮询夹具带一条注文，断言面板真的画出 `1` 条且文字没被改写。

32 个套件 / 477 条 ok（client 套件里多一条断言）。

## 0.54.25

SPSS 用户最常撞上的「这条命令 PSPP 没有」，原来只回一句「检查命令拼写」，让人去找一个不存在的错别字：

- `CODEBOOK` → 指向「频率」与「描述」。
- `TABLES` / `CTABLES` → 指向「交叉表」与「均值」。
- `UNIANOVA` / `GLM` → 说明 PSPP 的 GLM 只做单因子，多因子与协方差分析要在别处做。
- `MIXED` / `GENLIN` / `SURVIVAL` / `COXREG` / `TREE` / `CHAID` → 说明这些超出内置引擎范围。
- 真正拼错的命令（`FREQUENCIS`）仍然回「检查命令拼写」。

`annotateComparisons` 里「没有 (I) 列时按有 p 值的行数计 N」这一点补了注释（PSPP 总带 (I) 列，这条路径属防御；若将来引擎每对打两行，N 会翻倍）。

32 个套件 / 477 条 ok（messages 从 9 加到 10）。

## 0.54.24

Win10 0.54.10 报告的五条：

- 带分组的正态性表里，第二组那行第 0 列是空的，注文就写成「变量（p < 0.001）」。现在记住同表上一条非空变量名，并在有多行时把分组值带上：`x（分组 2.00）（p < 0.001）`。
- 补两条 regression 用例守着 0.54.10 的改动：空计数不得当成 0 去算 CMH（应该明说「有层缺格…所以没有算」）、空 p 行不得算进「N 次两两比较」。
- `Chi-Square Tests` 缺 Pearson 行时给一句话：2×2 小样本 PSPP 只打 Fisher 与连续性校正，不是跑错了，这种样本量就该看 Fisher 的 p。
- Windows 上 `test/smoke.mjs` 现在会打印「Windows has no core dumps: the ulimit and argv checks are skipped there」，不再是一条永远不出现、每次复验都要解释的日志。
- `annotateComparisons` 的「没有 (I) 列时按行数计 N」补了注释说明这个假设（PSPP 总是带 (I) 列，这条路径属防御）。

32 个套件 / 477 条 ok（regression 58）。

## 0.54.23

Win10 0.54.9 报告的 P1（行序边界）：方差齐性注文取数据行时，「标签带值但 p 为空」的行会排在「真有 p 值」的行之前，结果整条注文被跳过。

- 选择顺序改成：`Equal variances assumed` 且 p 是有限数 → 任意 p 是有限数的行 → `Equal variances assumed` → 任意已标注行。空白行再也挡不住后面的真数字。
- 夹具补 SPSS 风格三行（`Based on Mean` 空、`Based on Median` .048、trimmed .025）与「空行在前、真值在后」两种排列。
- 文档里两处 `pspp_explore` 改成实际入口 `pspp_analyze` 的 `examine`（没有过这个工具名，别让人去找）。

PSPP 2.1.3 的 `ONEWAY /STATISTICS=HOMOGENEITY` 只打一行且标签为空，所以线上不会触发这个排列；修的是纯函数在其他输出形状下的正确性。

32 个套件 / 472 条 ok（regression 53）。

## 0.54.22

Win10 0.54.7 报告的 P1-1 / P1-2 是同一个根因：判断「这次没出表」靠一条正则**整段扫** `GET DATA`，于是

- `GET DATA`（读到空文件）+ `DESCRIPTIVES` 被当成「数据步」跳过，静默回 0 张表；
- 反过来 `GET FILE`、`SAVE`、`SORT CASES`、`COMPUTE` 不在白名单里，在 0 行数据集上被报「这份数据集还没有个案（0 行）」，而用户正要用 `GET FILE` 载入数据。

现在改成先分类再判断（`classifyScript()`）：

- 只看**调用者自己写的语法**，不看插件前置的 `GET FILE` 头（之前正是那个头让每一条空数据运行都带上了「载入数据」的标签）；
- `loadsData` = `GET DATA / GET FILE / DATA LIST / INPUT PROGRAM / BEGIN DATA / IMPORT`；
- `changesData` = `SAVE OUTFILE / SAVE TRANSLATE / SORT CASES / COMPUTE / RECODE / AUTORECODE / AGGREGATE / FLIP / IF / DO IF / SELECT IF / FILTER / WEIGHT / MISSING VALUES / VARIABLE / RENAME / DELETE / MATCH FILES / ADD FILES`；
- 三种结局各说各话：只载入或只改数据 → 不报错；载入数据**又**要结果但一条表都没有 → 「这次运行既导入/载入了数据又跑了分析，但引擎一条结果都没有产出：导入的那份数据是空的（0 例），或者路径没指到有内容的文件…」；没载入数据、内存就是 0 例 → 「这份数据集还没有个案（0 行）…」；有数据但被筛光 → 原来那条「筛选把个案全部筛掉了」。

32 个套件 / 471 条 ok。

## 0.54.21

macOS 的 CI 腿在 `test/routes.mjs` 里抓到一次 `SyntaxError: Unexpected end of JSON input`：读 `dataset.json` 时读到空文件。原因不是测试不稳，是写入不是原子的 —— 另一个面板、启动器或重启后的 `restore()` 都可能正好读到写了一半的内容，那不只是解析失败，还会把「这些数字是从哪份数据来的」整条记录丢掉。

- `rememberDataset()` 改成先写 `dataset.json.tmp` 再 `rename`，读的一侧只会看到旧的或新的完整文件。
- `recordConflict()` 现在把落盘 promise 记在 `pendingConflictWrite`，routes 在回 409 之前 `await settled()` —— 冲突记录本来就要能被面板与下一个会话从 `dataset.json` 读到，409 抢在记录落地前返回等于没记。
- smoke 加断言：`dataset.json` 是完整 JSON，且 rename 之后不留 staging 副本。

32 个套件 / 471 条 ok。

## 0.54.20

- 写 `.sav` 超时的时候报的是「保存数据失败：打不开 work.sav：引擎没有给出原因」——超时根本没有 stderr，这句话把人指向一个并不存在的坏文件。现在直接说超时，并指出可以在「设置 → 选项」里把超时调大。
- 事后检验的夹具补一条：方法名写在标题里（`Multiple Comparisons (Tukey HSD)`）时仍算已校正、`Multiple Comparisons (LSD)` 仍要提醒 —— Win10 0.54.6 报告 P2-3 指出的形状，之前只有「标题带 Bonferroni」那一种。

32 个套件 / 471 条 ok（regression 52、messages 9）。

## 0.54.19

分析失败时的报错一直只有引擎原文（`FREQUENCIES: nosuchvar is not a variable name.`），中文解释只挂在「转换文件」那条路径上。现在运行失败也接上同一套解释，并且变量名写错时直接给最接近的那个：

- `FREQUENCIES nosuchvar.` → 「引擎没有产出任何表（退出码 1：FREQUENCIES: nosuchvar is not a variable name.） —— 数据集里没有叫 nosuchvar 的变量」
- `DESCRIPTIVES scroe.` → 「… —— 数据集里没有叫 scroe 的变量，最接近的是 score」（编辑距离，容差随名字长度放宽，差太远就只说没有）
- 语法错误与文件打不开也补齐了规则（`Syntax error expecting …`、`Could not open … for reading` 以前匹配不到，只回引擎原文）

32 个套件 / 470 条 ok（regression 51、messages 9）。

## 0.54.18

- `api/version` 之前回 `{"version": null}`：给路由传的是 `settings`（只有用户偏好），没带 `pluginVersion`。现在宿主侧把 `pluginInfo().version` 一并传下去。
- 顺带把这条路由的实际边界写清：插件自己在鉴权之前处理它，但整台 DSH 的 `/api` 围栏在更外层，所以**不带 cookie 的请求仍然会被宿主挡成 401**（实测 `curl http://127.0.0.1:3080/analytics/api/version` → 401 `unauthorized`）；带 cookie 时 200 且只回版本号。它现在的用处是宿主内排查与带 cookie 的脚本，不再声称「免鉴权」。

32 个套件 / 469 条 ok。

## 0.54.17

Win10 0.54.5 报告里的 P1-1 与 P2-2：

- 共线性注文原来固定说「先看『共线性诊断』表」，但完全共线时 PSPP 在打印那张表之前就停了，读者按提示去找会找不到。现在先看这一轮里到底有没有那张表：有就照旧指过去（并说明看条件指数与方差比例），没有就说「这次没有生成『共线性诊断』表…先看清楚哪几个自变量是同一个东西的线性组合」。
- 新增 `GET /analytics/api/version`：这是唯一不需要宿主 cookie 的只读路由，只回 `{ok, plugin, version}`，方便安装脚本与本机排查确认「装的是哪个版本」；其余路由仍然一律 401 失败关闭（有测试守着，顺带断言它不泄漏别的东西）。
- 仓库清理：`.tmp054xrun/`（Win10 复验时抽出来的源码副本）被 `git add -A` 带进了仓库，共 232 个文件 ⇒ 从索引里移除并加进 `.gitignore` 的 `.tmp*/`。

32 个套件 / 469 条 ok（regression 50）。

## 0.54.16

同族最后一处（`lib/tables.js` 的 `chiSquareFromTable`）：`Chi-Square Tests` 的 `Value` 列空白时 `Number('')` 是 0，插件会把它当成 χ² = 0 去算 Cramér's V，也就是「完全无关联」——一个引擎没给的数字被算成了结论。现在空白直接当作「没有这个数」，V 改由逐格计数自己算（那条路径本来就有合计校验）。

31 个套件 / 467 条 ok。

## 0.54.15

「空白格不是 0」这一族再查一遍，还有四处（都是引擎没打印数字时会变成确定结论的地方）：

- `Symmetric Measures` 里的 Cramér's V / Phi 为空时，`Number('')` 是 0，会报「V = 0」= 没有关联；现在读不到数字就不出这一行，改由插件按交叉表自己算。
- Kappa 那一行数值为空时会写成「Kappa = 0.000」（等于说完全没一致性）；现在显示「—」并仍然给出形状说明。
- 个案处理摘要的「有效」行计数为空时会被读成 0 例，让 ICC 那边误判「引擎的有效个案是 0 例」；现在跳过空单元格继续找。

31 个套件 / 467 条 ok（regression 49）。

## 0.54.14

Win10 复验抓到的空结果第二种形态：**同一段语法里的筛选把个案全筛掉了**（`SELECT IF score > 999.` + `EXECUTE.` + `DESCRIPTIVES`）。0.54.5 的「没有个案（0 行）」只看内存里那份数据，而筛选发生在引擎侧、跑完才回写，所以当时仍会静默返回 0 张表。现在区分两种情形：

- 内存里 0 例、且这段语法要产出结果 ⇒ 仍是「这份数据集还没有个案（0 行）」；
- 内存里有 N 例、引擎却一张表都没有 ⇒ 「这次运行没有产出任何表：内存里这份数据有 N 例，但引擎那边没有可分析的个案」，并点明常见原因是 `SELECT IF`/`FILTER`/条件 `EXECUTE` 把个案筛光，或变量名写错让命令被跳过。

纯数据步（`SORT`、`COMPUTE`、`SAVE`、`GET DATA`）照旧不报错。smoke 加一条筛选断言。

31 个套件 / 466 条 ok。

## 0.54.13

方差齐性注文取哪一行：PSPP 的 `Test of Homogeneity of Variances` 会打 `Based on Mean` 与 `Based on Median` 两行，翻版本或换变量后行序会变。0.54.9 起空白格不再被读成 0，但「先遇到一行空白」时会在 `continue` 处无声结束，把后面那行的真 p 值也一起丢掉。现在优先挑**带真数字的已标注行**，只有全都空白时才退回第一行（此时确实没有可说的显著性）。

31 个套件 / 466 条 ok（regression 48）。

## 0.54.12

英文界面补完最后一轮：`locale/en.json` 从 955 条增到 1109 条，`client.js` 里所有纯中文文案（对话框标题、字段标签、提示语、通知、引擎能力说明）现在都有英文对照，术语按 IBM SPSS Statistics 的界面用语（Descriptive Statistics / Crosstabs / Post Hoc Tests / Case / Variable / Value Labels / three-line table）。含数字插值的句子仍走「最长子串替换」，不必为每种数字组合建 key。

剩下一处故意不翻：`client.js` 里按 `[aria-label*="关闭"]` 找关闭按钮的 CSS 选择器 —— 它是选择器，不是文案，翻译了反而匹配不到中文 aria-label（末尾的 `button` 兜底已覆盖两种界面）。

31 个套件 / 466 条 ok。

## 0.54.11

0.54.9 只把 `state()` 里的 `notes` 补齐了，`api/run` 的响应还是原样透传（没有提示的表仍是缺键）。现在两条路径同一形状，`pspp_run` 之外的直接调用者也不用再写 `item.notes ?? []`。

31 个套件 / 466 条 ok（smoke 加一条响应结构断言）。

## 0.54.10

0.54.9 修的是「空白格被当成 0」这一类里的第一处，同一族还有三处，一并处理：

- 正态性注文：`Sig.` 列空白时 `Number('')` 为 0，会被说成「偏离正态（p < 0.001）」；现在空白不参与判断，同一表里有真 p 值的行仍然报。
- 分层卡方（CMH）计数：空白计数会被读成 0（凭空多出一个空层）；现在遇到空白整张表放弃重算，不用假数字。
- 多重比较的次数：`p` 列为空的行以前也算作一次比较，现在不计。

README 补一条已知限制：面板 HTTP 接口继承宿主鉴权，手敲地址会 401。

31 个套件 / 466 条 ok（regression 48）。

## 0.54.9

两处「读起来像确定结论、其实没有依据」的地方：

- 方差齐性注文把**空白格读成 `p = 0`**：`Number('')` 是 0，而 `p === 0` 这个分支本来只为 PSPP 把 `.000` 下溢写成「p < 0.001」。于是 Levene 列没有数字的表格也会触发插件语气最强的告警「各组方差不等，p < 0.001」。现在先看文本是否为空，空格不再参与判断；同一表里后面有真 p 值的行仍然算数。
- 没有提示的表对象**不带 `notes` 键**（`undefined` 而不是 `[]`）：`state()` 与 `pspp_*` 工具结果都改成总是给数组，二次开发不必再写 `item.notes ?? []`。

31 个套件 / 465 条 ok（regression 47；smoke 新增一条 notes 结构断言）。

## 0.54.8

探索（EXAMINE）一次列多个变量时，PSPP 2.1.3 的 `Tests of Normality` 只给**第一个**变量一行，其余变量连正态性检验都不打印——面板与工具此前都是把变量塞进同一条命令，于是多变量探索里只有第一个变量有正态性结论。现在按变量拆成多条 `EXAMINE`（每个变量各自一套描述统计、图与正态性检验），面板与 `pspp_analyze` 的 `examine` 同步改。实测三个变量拆开后三行都有、注文只点偏离的那个。

31 个套件 / 464 条 ok（build 92、client 28）。

## 0.54.7

0.54.5 那句「数据集还没有个案」补一个例外：`GET DATA` / `DATA LIST` / `INPUT PROGRAM` / `BEGIN DATA` / `IMPORT` 这类**自己带数据**的语法在空数据集上是正常用法（插件内存里的表不会因为引擎侧导入而更新），不能反过来被报成「没有个案」。只有真正的分析语法在 0 行数据上跑出空结果时才说那句话。

31 个套件 / 463 条 ok（smoke 新增一条数据步断言）。

## 0.54.6

多重比较那条注文看错了地方：PSPP 把方法名写在表格最左列的第一行数据里，标题只有 `Multiple Comparisons (score)`——Bonferroni、Tukey、LSD 三种的标题一模一样。此前只读标题，于是 Bonferroni 与 Tukey（p 值已经校正过）也被提醒「引擎给的是未校正的 p 值」，属反向误导。现在按首列方法名判断，只有 LSD 这类未校正的才提醒；同时把「次数」改按 `(I)` 列计数，不再把「I 对 J」与「J 对 I」两行算成两次（3 组时是 3 次，不是 7 次）。

31 个套件 / 463 条 ok（含 smoke 的空数据集断言）。

## 0.54.5

对 0 行的数据集跑 `DESCRIPTIVES` / `FREQUENCIES`，PSPP 退出码 0、没有任何表、也没有任何诊断：面板上表现为「点了运行什么都没有」，读起来像「没有显著结果」。现在这种空结果会直接说清楚：`这份数据集还没有个案（0 行）：引擎这次一条结果都没有产出。先在数据视图里录入数据或重新导入文件，再跑分析`。

31 个套件 / 462 条 ok（另有 smoke 里的一条空数据集断言）。

## 0.54.4

两条注文在错误的表上说话：

- 方差齐性那条按**被注释的那张表自己的标题**选措辞。此前只要同一轮语法里出现过 `Independent Samples`（t 检验的结果表），单因素方差分析里的 Levene 表也会被建议「读「不假定等方差 / Welch」那一行」——而 ONEWAY 根本没有那一行。现在 t 检验仍指向它自己表里的那一行，Levene 单独成表的（ONEWAY）仍说「PSPP 的单因素方差分析没有 Welch 行」。
- 共线性那条只在**回归系数表**（标题含 `Coefficients` / `系数`）上说话。此前 t 检验的 `Independent Samples Test` 表也有 `t` 与 `Sig.` 两列，若某组只有 1 例或全为缺失、t 打成 `NaN`，用户会看到「系数里有 NaN…看共线性诊断」，与 t 检验毫无关系。

31 个套件 / 462 条 ok。

## 0.54.3

- **RISK 注文把两件事分开说**：表里既有真字符串变量、又有查不到类型的名字时，以前会把它们并成
  「对字符串变量（G、TMP）算风险估计会直接崩溃」——TMP 并不是字符串，只是查不到。现在两句话分别说：
  字符串变量点名，未知名字另起一句（「；同时 …」）。

## 0.54.2

- **两两比较的假阳性提示**：`Multiple Comparisons` / 事后检验那张表里如果没写校正方法（Bonferroni、Tukey 等），
  按表里实际的比较次数 N 说明「每次拿 0.05 当阈值时，至少撞上一次假阳性的概率约 1 − 0.95^N」（3 次约 14%，
  6 次约 26%），并给出 Bonferroni（p × N）这条退路。已经标了校正方法的表不再提醒，只比一次的两两比较也不提醒。

## 0.54.1

- **RISK 守卫改成「不确定就剥」**：PSPP 2.1.3 在交叉表里对字符串变量算风险估计会直接段错误（整次运行一个字都不输出）。
  以前只在 `/TABLES=` 的名字能在数据集里查到、且确实是字符串时才剥掉 `RISK`；`RECODE`/临时变量、内联表达式出来的名字查不到，
  就被当成安全放过去了。现在查不到类型的名字同样算危险，一并剥掉并在表注里说明是哪个名字、为什么。
- **引擎子进程不再产 core dump**：`runProcess` 在 POSIX 上用 `sh -c 'ulimit -c 0; exec "$0" "$@"'` 起引擎，
  argv 原样透传（空格与非 ASCII 都不受影响）、exec 保持同一个 pid。崩溃仍按退出码与 stderr 判断，横幅文案不变。
  一次崩溃原本会在 `/var/lib/systemd/coredump` 留 400 KB 左右的文件，纯属噪音。

## 0.54.0

- **三条过程前提提示**（复验提的，都是「引擎已经打了表、但没人告诉你该读哪一行」）：
  - **正态性**：`EXAMINE … /PLOT=NPPLOT` 的 `Tests of Normality` 表里 Shapiro-Wilk 的 p < 0.05 时，点名是哪个变量
    （`p < 0.001` 这种打不出来的一律这么写），并说明样本不大时 t 检验/方差分析的 p 值不准；
    分布正常的变量一个字都不加，避免每次描述统计都刷一条。
  - **2×2 的连续性校正**：`Chi-Square Tests` 里引擎自己给了 `Continuity Correction` 行时，指向那一行；
    期望频数不足时「看 Fisher」那条注文已经把话说全，不重复第二遍。
  - **回归的样本量**：个案数不到「预测变量数 × 10」时，在 ANOVA / 模型摘要上给出实际比例（如 12 例 / 2 个预测变量 = 6.0）
    和建议，而不是只丢一句「样本偏少」。
- 表头都按 PSPP 的真实两行形状取值（组标签一行、`Statistic | df | Sig.` 一行），并取最后一个 `Sig.` 列 —— 同时打
  Kolmogorov-Smirnov 与 Shapiro-Wilk 时，右边那列才是 Shapiro-Wilk 的。

`npm test`：31 个套件 / 458 条 ok。

## 0.53.4

- **t 检验的方差齐性注文一直没出现**：PSPP 的 `Independent Samples Test` 是两行表头（上面一行写
  `Levene's Test for Equality of Variances`，下面一行才是 `F | Sig. | t | df | Sig. (2-tailed)`）。
  0.53.3 在含 “Levene” 的那一行里找 “Sig.” 列，找不到就跳过了 —— 所以只有单因素方差分析那条路会提示。
  现在扫整个表头块找真正写着 `Sig.` 的那一行取列号，并且优先取 `Equal variances assumed` 那一行
  （`not assumed` 一行把 Levene 列留空，读出来会被当成缺值）。
- 回归用例换成 PSPP 的两行表头形状（含 `not assumed` 空行），旧的简化夹具正是漏掉这个 bug 的原因。

`npm test`：31 个套件 / 455 条 ok。

## 0.53.3

- **方差齐性提示在 p 打不出来时才会失效**：PSPP 把小于 0.0005 的 p 打成 `.000`，原来把它当 0 滤掉了 ——
  正好是方差差距最大、最该提示的情形。现在按表头 `Sig.` 那一列读（t 检验同一行里还有 t 检验自己的 p，
  不能取「最后一个数」），`.000` 写成 `p < 0.001` 并照常提示。
- **提示按过程分文案**：单因素方差分析（ONEWAY）不输出 Welch 行，不再让用户去找一行不存在的行；t 检验才说
  「读「不假定等方差 / Welch」那一行」。
- **冲突对话框的措辞**：「关闭」就是「放弃这次修改」（页脚写明），覆盖按钮标红并说明会盖掉对方刚写的内容；
  去掉与页脚重复的第三个按钮。
- 文件查看器页签的图标也换成 16×16 线稿（之前只有面板行与页签改了）。
- 措辞统一：期望频数提示里的「格子」改成「单元格」（与交叉表一致）。

`npm test`：31 个套件 / 455 条 ok。

## 0.53.2

- 仓库公开后的清理：把两篇内部计划文档（`plan-0.27.md` / `plan-0.28.md`）移出仓库并加进 `.gitignore`；
  把开发机相关的示例路径换成通用写法（`Z:\work\…`、`/mnt/data/…`、`D:\data`），界面里的示例同样处理。
  行为没有任何变化。

`npm test`：31 个套件 / 454 条 ok。

## 0.53.1

- 期望频数的提示只出现一次：0.53.0 里它既挂在交叉表上、又挂在卡方表上（后者是本来就有的
  「引擎没打精确检验」注文），同一件事说两遍。现在同一张交叉表只留一处。

`npm test`：31 个套件 / 454 条 ok。

## 0.53.0

- **被拒的写入变成一道选择题**：以前冲突只弹一条提示、把数据重载、你这回的输入就没了；现在弹
  「这次修改没有写入」对话框，三个答案各做各的 —— **覆盖**带 `force` 重发刚才那次请求（`api()`
  把 409 的请求体挂在 `error.retry` 上，不是重放一份抄下来的值）、**重载**丢掉这次修改读回磁盘上
  那一版、**取消**什么都不做。三态都有测试钉着。
- **过程前提提示**：交叉表里有格子期望频数 < 5 时，注文点名「有几个格子、最小期望频数是多少、
  该看 Fisher 还是勾精确卡方」；方差齐性检验 p < 0.05 时，注文指出该读「不假定等方差 / Welch」
  那一行。以前这两件事都埋在引擎自己的表里，不懂 SPSS 的人照样读等方差那一行。
- **侧栏页签换成同一套简笔画字形**（`ICON_LINE`），描述里写明「与左侧统计分析面板是同一份数据、
  同一个引擎」；数据文档条悬停时标出来源是「面板默认文档（可能来自上一轮）」还是某个会话。
- **`GET api/workspaces` 支持 `?limit=`**，回答里带 `total` / `truncated`，面板不再只认 20 条上限。
- 说明：安装包仍然不含 `test/`（测试要 jsdom 等 devDependencies，装到用户机器上也跑不起来），
  自检请在工作树上跑 `npm test`。

`npm test`：31 个套件 / 454 条 ok。

## 0.52.1

- **设置对话框的「保存」搬到页脚**：表单有十来个字段，在 800 px 高的窗口里最后一排按钮掉到
  可视区外面 —— 打开设置只看到字段、看不到能按的按钮。现在页脚是「保存 / 取消」，表单内部只留
  「重新读取」；用的是对话框自己的按钮位，不额外画一套。

`npm test`：31 个套件 / 452 条 ok。

## 0.52.0

三件来自用户的要求，加一件顺手补上的一致性问题。

- **冲突留痕**：写被 409 拒掉时，`workspace.recordConflict()` 把这次拒绝记进受影响的
  `dataset.json`（`conflicts`，最多 50 条，含 `expected` / `actual` / `lastWriter` / `writer` /
  `route` / 时间），`state` 带 `conflictCount` 与 `lastConflict`，导出的每张表在来源行里印
  「冲突记录 N 次」。提示条五秒就消失，而「刚才是不是有人想覆盖我的数据」是几小时后才问的问题。
  记一笔**不算一次写**（`rememberDataset({ bumpRevision: false })`）—— 否则拒绝本身会让 revision 前进，
  调用方紧接着的重试会被自己刚才的失败判成过期。
- **左栏图标改成简笔画**：全局面板里其它行都是 harness 图标集里的描边字形（16×16 视图框、
  `fill="none"`、`stroke` 用 `currentColor`、圆头圆角、线宽 1 或 1.3），我们原来是 64×64 蓝底徽章 +
  白色方块，一眼看得出不是同一套。新增 `ICON_LINE()` 按同一套词汇画（坐标轴 + 三根柱 + 折线），
  左栏行改用它；**蓝色徽章保留**作为产品图标（文件查看器页签等处仍用 `ICON()`）。
  因为描边取 `currentColor`，**不需要一份黑色一份白色** —— 亮色与暗色主题各自继承文字颜色。
- **设置搬进面板菜单**：去掉 `settings.section` 的注册，新增顶层菜单「设置」→「选项…」，
  在对话框里渲染同一个表单（保存 / 重新读取 / 取消），DSH 总设置里不再有「统计分析」一栏。
  `设置` 的助记键是 `Alt+S`。
- **状态栏冲突角标**：`conflictCount > 0` 时状态栏显示「冲突 N」（悬停说明这些是**没有写入**的
  拒绝次数、详情在 设置 → 选项 → 冲突记录、导出的表会带次数）。数据一换（重新打开文件）就归零。

`npm test`：31 个套件 / 452 条 ok。

## 0.51.1

- **导出的每张表都能追溯到「哪一次运行、哪一份字节」**（Windows 端复验 0.50.1 的第三条建议）：
  Word/Excel/HTML 导出中每张表下面那行来源，除了「来源 · 例数 · 文件大小 · 打开于」，现在还带
  `运行 #N` 与 `数据指纹 xxxxxxxx`。指纹是对变量表 + 行数 + 首尾各 20 行取值做 FNV-1a 得到的
  8 位十六进制（`dataDigest()`），同一份文件重新保存、改了一个格子都会变 —— 只靠文件名与例数
  区分不了「上一次跑的那份」和「刚改过的那份」。docx 的 `docProps` 与 xlsx 的表头说明不变。

`npm test`：31 个套件 / 452 条 ok。
## 0.51.0

Windows 端复验 0.50.2 时抓到三个真问题，这一版都处理了。

- **提示条被自己吃掉**：`notify()` 的 4.2 秒定时器既没保存句柄也没 `clearTimeout`，连续两条提示时，
  前一条的定时器会在后一条刚出现约一秒时把它清掉 —— 复验员连续取样十几次都没抓到提示，就是这个
  原因。现在只有一条在跑，后来的提示赢，显示时间放宽到 5 秒。
- **「工具写」被记成「另一个面板写」**：没有 `writer` 的请求（对话里 agent 调 `pspp_*`）以前沿用
  上一次写入者的名字，客户端于是把它当成另一个窗口。现在无主写入一律记 `lastWriter = null`，面板
  给出另一句话：「数据已被对话里的分析改写：已载入最新内容」。
- **冲突从「告知」升级为「拒绝」**：面板每次写（改单元格、粘贴、增删个案、改变量、跑语法、排序、
  重构、合并、缺失值、替换等）带上自己最后读到的 `revision`；宿主发现它已经不是当前版本就回 **409**，
  附上 `{expected, actual, lastWriter}` 和真正的状态 ——**这次修改不写进数据**，面板提示「另一个窗口
  已经改过这份数据（最后写入：另一个窗口/对话里的分析）：这次修改没有写入，已载入最新内容」并刷
  新网格。真的需要覆盖时可以显式带 `force: true`。
- 写入者身份改成 `localStorage['ap.writerBase']` 里持久化的基础名 + 每个窗口的短后缀：同一个浏览器
  刷新后还是同一个名字，两个窗口仍然能区分。

`npm test`：31 个套件 / 450 条 ok。
## 0.50.3

- **预设改名**：插件自带的 Agent 预设从「数据分析」改为「统计分析」，和左栏那行同名 ——
  此前两个名字并存（左栏「统计分析」、预设「数据分析」），用户要在两者之间翻译，也容易被
  当成两件不同的东西。只改显示名：预设 id 仍是 `analytics`，工具清单与 persona 一字未动，
  选中它的会话照旧拿到 23 个 `pspp_*` 工具。面板顶部「本会话没有启用……预设」那条提示、
  英文词典里对应的一条、README / 安装说明 / 功能清单的措辞一并跟上。

## 0.50.2

- 左栏面板列数据集时不再只看内存：`WorkspaceRegistry.recent()` 改为逐个问工作区
  （`Workspace.summary()`），被空闲回收的（`dataset.evicted`，`rows` 已清空）改从
  `dataset.json` + `work.sav` 描述，例数由 sidecar 里新增的 `caseCount` 提供。
  之前这类数据集会从列表里消失 —— 面板看起来「数据没了」，而文件其实还在盘上。
- 仍需知道：宿主重启后、且没有任何请求碰过某份数据集时，它不在列表里（工作区对象
  只在第一次被访问时重建）；这不是丢数据，只是列表暂时看不到。
- **多窗口写冲突**：同一份数据可以被两个窗口同时打开（左栏那行与某个会话的页签指向
  同一个 `docId`），两边各有一份行数据与撤销栈，后写覆盖先写且没人知道 —— 这是唯一
  会让人在不知情时拿到错数的路径。现在工作区记 `revision` 与 `lastWriter`（`noteWrite()`
  在 `pushHistory`/`pushCellHistory`/`rememberDataset` 里调用），面板每个请求带自己的
  `writer` id；心跳签名也带 `revision`，所以别人的一格改动会让这一边重新读状态、重载
  当前页的行，并提示「数据已被另一个窗口修改：已载入最新内容，正在编辑的格子请重新
  确认」。自己的写、以及面板第一次读到的状态都不提示。

## 0.50.1

- 左栏的全局面板（root scope）拿不到会话，于是它一直停在一个空的 `default` 文档上：会话里
  明明有 24 例数据，旁边的面板却说「尚未打开数据集」，两处看起来像两套数据。现在面板
  打开时先问宿主 `GET api/workspaces`（新接口，按最后使用时间倒序），采用最近用过的那份
  数据集，其余列进文档条可切换。
- 修：`WorkspaceRegistry.recent()` 的默认上限被算了两次 —— `Number(options.limit ?? 20)`
  判断为真后取的是 `Number(options.limit)`，无参调用得到 `NaN`，`slice(0, NaN)` 永远返回空
  列表。真机表现就是「面板还是空文档」，`test/routes.mjs` 现在把列表非空、倒序、含多个
  工作区都作为硬断言。

## 0.50.0

- 修：左侧「全局面板」列表里没有「统计分析」。工作台原本只注册到 better-sidebar 的
  右栏页签，而右栏可能整块收着、底部面板也可能收着 —— 两处都收着时，界面上没有任何
  入口能打开它（重启后用户看到的就是「统计分析标签页不见了」）。现在同时注册
  `sidebar.panellist` 的一行（和「免费搜索」「SSH」同一处）与 `main` 的
  `analytics` 页，点左栏那一行就在中间栏打开工作台。`test/client.mjs` 钉住这两处
  注册的 id / order / label 必须自洽（左栏 id 与 main key 必须相同）。

## 0.49.2

- 修：面板打不开数据 —— 宿主半在 `webServer` 就绪时抓了一次 `connection`
  （浏览器会话校验服务），而它可能比 `webServer` 晚到，于是抓到的永远是空槽，
  每个请求都被 `authorize()` 以 401 挡掉（`/analytics/api/settings` 在真浏览器里
  就是 401）。改成每次请求现取，`test/routes.mjs` 加一条「连接晚到也要能用」的用例。

## 0.49.1

- 修：改名到 `dsh-analytics-pspp` 后侧栏「统计分析」页签消失。客户端包在
  `__ModuleLoader__.load({ id })` 里写死了旧的包名 `dsh-analytics`，而页面按
  包名查找模块，于是浏览器报
  `dsh-analytics-pspp: import failed: … loaded without registering` —— 包加载了、
  却按旧名字注册，页签的 `registerTab` 从未执行。改成跟 `package.json` 一致，
  并把这条钉进 `test/build.mjs`（包名一改，id 必须跟着改）。

## 0.49.0

改名：npm 上的 `dsh-analytics` 是别人的包（rainfun 的 FinOps / token 统计插件，0.4.0，
2026-08-14），我们发布时用它会被 403 拒绝，用户也会装错东西。包名、bundle 名、预设里挂的
工具模块名一并改成 `dsh-analytics-pspp`，插件 id 仍是 `analytics`、路由仍是 `/analytics`、
数据目录仍是 `~/.dsh/analytics`、面板页签与设置项都不变，已有的数据集与设置不用迁移。

一次改名牵连到的面：`package.json` 的 `name`、`cordis.patch.yml` 里宿主行与预设里的
`dsh-analytics-pspp/tools`、`index.js` / `tools-entry.js` 的插件名、`scripts/install.mjs`
（资产名匹配、写进 `dsh.profile.bundles` 的名字、备份文件名）、以及钉住这些名字的测试。

升级注意：profile 里旧包的依赖与 bundle 条目要一起换成 `dsh-analytics-pspp`；本地开发用的
`link:` 也要改键名，否则 DSH 按旧名找不到模块。

## 0.48.1

- **值标签在英文 Windows 上读不回来（真 bug）**：`DISPLAY DICTIONARY` 的值标签表用「变量
  标签」当行标识（没有标签才用变量名），而英文 Windows 的输出代码页是 cp1252，汉字标签
  全被打成 `??????` —— 三个变量的标签于是撞成同一串文本，旧代码用 `Map` 后写覆盖前写，
  标签全挂到最后一个变量上，其余变量读回来是空的。现在按「文本 → 变量列表（字典顺序）」
  存，逐个消费：撞车时第一个还没被用掉的变量拿走这组标签，名字仍然优先匹配（名字是
  ASCII，不会撞）。`test/build.mjs` 用一份 cp1252 形态的假字典把它钉住。
- `test/smoke.mjs` 的值标签往返改成按平台选标签：PSPP 打印值标签的**文字**时也按 locale
  编码（实测 Windows 上中文一律变 `?`，变量标签反而不受影响），所以英文 Windows 用
  `Female`/`Male`，其他平台仍用中文，两边都还能验到「写盘 → 重开 → 标签还在」。

## 0.48.0

三件「引擎没有、只能自己算」的事，加一条把整条用户路径走一遍的测试。

- **分层卡方 CMH（插件计算）**：PSPP 2.1.3 把 `CROSSTABS /STATISTICS=CMH` 当语法错误，
  带它的语法一行输出都没有。宿主在发车前把关键字剥掉，再用每层的 2×2 计数自己算
  Cochran–Mantel–Haenszel χ²、共同优势比与 Robins–Breslow–Greenland 区间，并给
  Breslow–Day 同质性检验；注文写清共几层、有效几层。与 R `mantelhaen.test` 逐位对过账
  （UCBAdmissions χ² 1.524606660443、OR 0.904696828259、CI 0.771907361759~1.060329764437）。
  只对带层变量的交叉表有效，每层必须 2×2，否则表下写明为什么没算。
- **双因子 GLM 的自定义对比（插件计算）**：`GLM` 不接受 `/CONTRAST`，单因子可以改走
  `ONEWAY`，两个因子就没有引擎通路了。新增 `lib/contrasts.js` 在设计矩阵上做 `Lβ` 与
  `L(X'X)⁻¹L'`（MGS 二次重正交，不求逆），输出「自定义对比（插件计算）」表；主效应按等权
  组合，与 SPSS 的 Type III 一致。系数向量不在行空间里时判「不可估」并说明原因，不给假数。
  与 R `car::linearHypothesis` 对账：7 条假设 38 个数最大偏差 5.3e-10；等权对比能精确复现
  引擎 `GLM` 的 Type III 行。面板的「对比系数」在勾了第二因子时写成 `a = 2 -1 -1; b = 0 0 1`。
- **大表行窗口化**：点开「显示全部」后不再一次性铺满 3 000 行 DOM，而是随滚动渲染窗口
  （上下各留 10 行缓冲，用 spacer 行撑出真实滚动条长度）；≤ 200 行仍整表渲染，复制/下载
  CSV、导出 HTML 仍取原始数据。jsdom 量不到高度时退回整表，不会按 0 像素画一行。
- **`test/flow.mjs`（新的端到端测试，12 条断言）**：导入 CSV → 看变量与指纹 → 分页 → t 检验 →
  交叉表（精确检验 + 风险差）→ 出图并经 HTTP 读回 → 导出 docx（查 `word/document.xml` 与
  内嵌图）→ 导出 pdf（查 `%PDF-`）→ 保存/关闭/重开（查 provenance）→ 导出 CSV → 合并第二个
  文件。它当场抓到两个真 bug：导出重放 `lastScript` 时不走字符串/RISK 守卫（字符串分组 +
  RISK 的交叉表在导出时把引擎打崩，报错只有一排星号），以及 `exportCsv` 失败分支引用了不存在
  的 `outPath`。两个都修了。
- **CI 加跨平台腿**：`engine-cross` job 在 ubuntu / windows / macos-15 上下载对应平台的引擎包
  并跑 smoke、routes、flow、pdf-notes（`macos-14` 已于 2026-11 退役，且本来就是 x64）。
- 风险差注文里的类别改按整数显示（`1.00 → 1`，`1.50` 保持），`test/smoke.mjs` 的收尾不再能把
  一次全绿的运行变成 exit 1（Windows 上 `rm` 偶尔 EBUSY），改用 `teardown warning:` + `smoke finished`。

本次全量测试 445 条 ok / 31 个套件。

## 0.47.2

- 风险差注文里的类别改成按整数显示：引擎按变量的 FORMAT 打印类别，整数码会写成 `1.00`，
  注文照抄就成了 `事件列 = wave=1.00；第 1 行（1.00）`，而表里写的是 `1` —— 读起来像另一个取值。
  现在去掉多余的补零（`1.00 → 1`，`1.50` 保持 `1.50`）。
- `test/smoke.mjs` 的收尾不再能把一次全绿的运行变成 exit 1：Windows 上工作区文件偶尔还被占用
  一会儿，`rm` 抛 EBUSY 时断言早已全部通过（实机复验遇到过一次「rc=1 但没有任何失败行」）。
  现在收尾失败只打一行 `teardown warning:`，并在末尾打 `smoke finished`，下次再看日志就能分辨
  「断言失败」与「收尾失败」。

## 0.47.1

- 0.47.0 的三处改动各有一个会让它「看着在、其实不工作」的洞，这一版补上；全部由一轮独立审查
  与真引擎复现发现，不是猜的。
- **崩溃 banner 原来根本到不了文案**：引擎的 `-o/-e` 让诊断进文件，但 PSPP 的 bug 报告是直接写
  进程 fd 2 的，`-e` 那个文件在这种情况下是 0 字节。旧代码「读文件成功就用文件内容」，于是
  banner 被丢掉，用户看到的是「没有退出码，引擎没有输出任何诊断信息」。现在两个流都读、非空的
  拼起来；配套的真引擎回归用例（`test/smoke.mjs`）直接跑会崩的 `CROSSTABS RISK`（字符串分组），
  断言 banner 能穿过 `exec` 并变成「引擎崩溃…」。
- **面板读预设的接口名是错的**：`ctx.get('sessions')` 拿到的是 `ClientSessions`，它自己没有
  `projectionValues`，真正的位置是 `sessions.list.getSnapshot().byId[id].projectionValues`
  （DSH 的预设选择器就是这么读的）或 `sessions.manager.projectionValues(id)`。旧写法在真机上恒
  为 null ⇒ 提示条永不出现、「+」永不置灰，而单测喂的是假对象所以全绿。现在三条路径按
  `list → manager → 旧接口` 依次尝试，单测也改成真实形状（并保留一条「快照里还没有这个会话」
  的用例）。
- **交叉表标签撞车时不再瞎猜**：两个变量同 label（复制变量很常见）时，旧代码按 label 找到第一个
  ⇒ 注文会把 `q2` 的列说成 `q1`；现在 label 命中多于一个就退回位置措辞。同一变量两个值标签相同
  （都叫「是」）时同理，不再把第二列说成「=1」。
- **多张交叉表时风险差挂错表**：旧代码按 `/risk estimate/i` 找**第一张** Risk Estimate，一次跑
  两个 `CROSSTABS …RISK` 时第二张的差值会印在第一张下面。现在按 items 顺序取「本交叉表之后、
  下一张交叉表之前」的那张。
- 崩溃判据收紧：`proximate cause:` / `segmentation violation` 单独出现不再算崩溃（文件名里也可能
  有这两个词，会把真实的「打不开 X」盖成假崩溃），必须同时有 banner 的 `host_system:`/`build_system:`
  这类字段；banner 首句命中则照旧直接算。
- 崩溃文案不再被外层包成「引擎没有产出任何表（引擎崩溃（…））」这种双层括号；回退到位置措辞的
  风险差注文也补回「换成另一列是相反数」那句。

## 0.47.0

- 三处「用户看不明白」的地方改清楚，一处行为补齐。
- **引擎自己崩溃时不再冒充语法错误**：PSPP 2.1.3 撞到自己的缺陷会段错误并打印一段
  bug 报告（`You have discovered a bug in PSPP` / `proximate cause: Segmentation
  Violation`），而按行挑诊断的正则匹配不到 banner，最后挑到的是 `build_system: …`
  那一行 —— 用户看到「引擎没有产出任何表（退出码 139：******）」，既不知道是引擎的锅，
  也不知道该怎么绕。现在先认 banner（判据只看文本，**不看退出码**：同一个崩溃 Linux 报
  139、Windows 报 3），文案写明「这是 PSPP 引擎自身的缺陷，不是你的数据或语法问题」、
  附上引擎报告的原因、给出绕法，并去掉 `build_system`/`host_system`/临时语法文件路径。
  文件操作里崩（打开数据、导出）也不再说「打不开 X」，改说「处理 X 时引擎崩溃」。
- **风险差的注文写上真实类别**：PSPP 的 Risk Estimate 是按**列**给 `For cohort wave = 1`
  这类行，而插件补的差值是按**行**算的；注文原来只写「第 1 行 − 第 2 行（第一列的事件）」，
  用户对着两张表会以为算反了（实测反馈就是这样：`+0.500` 与期望的 `−0.500` 互为镜像）。
  现在写成 `事件列 = wave=1「第一波」；第 1 行（男） − 第 2 行（女） = 0.200（…）`，并明确
  「把事件列换成 wave=2「第二波」时差值是相反数，区间关于 0 对称」。标签从交叉表矩阵里读，
  变量名与值标签再从数据集回查；读不到就退回「第 N 行 / 第 N 列」，不影响计算。
- **面板知道自己跑在哪个预设下**：侧栏页签是全局注册的，工具却只在「数据分析」预设里挂载，
  于是别的预设的会话里留着一个用不上的入口。现在面板读宿主的会话投影
  （`ctx.get('sessions').projectionValues(sessionId).agentPreset`，读取走 `ctx.get`，
  因为插件没有 inject `sessions`），非 `analytics` 预设时在页签条上方给一条可关掉的提示
  （说明智能体看不到 `pspp_*` 工具、面板本身仍可用、怎么启用），并让 better-sidebar 的
  「+」菜单把这一行置灰（`available` 返回 false）。拿不到投影（旧宿主、测试环境）一律当作
  「未知」，行为与以前完全一致。
- 侧栏入口仍然做不到「按会话消失」：better-sidebar 的页签注册表是全局的，`available` 只
  决定「+」菜单置灰，`hidden` 是注册期静态值，`isTabEnabled` 只读全局 Side card 设置。
  要真正的按会话可见性得等上游加能力（已写好 issue 草稿，等插件公开后再提）。

## 0.46.0

- 交叉表再补两块：**风险差与它的置信区间**，以及一处会让引擎直接崩溃的组合。
- 风险差（插件计算）：PSPP 的 Risk Estimate 表只给比值比（Odds Ratio）和相对风险
  （Risk Estimate 的 For cohort 行），从不给差值与区间。这个差值与区间由插件自己算：
  Newcombe 混合得分法（方法 10，各比例的 Wilson 区间再按二次合成），附在 Risk Estimate
  表下，写明两行的比例与算法。选它是因为 2×2 表的格子数通常很小，
  Wald 区间会在空单元格上塌成一点，Newcombe 区间在这个量级上覆盖概率最接近名义值
  （56/70 对 48/80 的例子算出 0.0524 ~ 0.3339，与 Newcombe 1998 表里的数一致）。
- **修一个会让引擎崩溃的组合**：`CROSSTABS /STATISTICS=RISK` 遇上**字符串**分组变量时，
  PSPP 2.1.3 直接段错误（rc 139，整次运行没有任何输出），用户看到的是「引擎没有产出任何
  表」。现在插件在发语法前把这个 RISK 摘掉，把「为什么没发给引擎」写成表注，风险差与区间
  改由插件按同一张表的计数算出来。数值型分组变量不受影响，RISK 照旧交给引擎。

## 0.45.0

- 交叉表统计量再补一项「精确卡方 p」：统计量里勾上之后，插件按观测表的边际枚举
  所有同边际的表，算出 Pearson 卡方与似然比卡方各自的精确 p（SPSS 把这两个放在
  Crosstabs → Exact Tests 里）。PSPP 只在 2×2 打印 Fisher，`/METHOD=EXACT` 是语法
  错误，所以只能在这里算。
- 与「精确检验（Fisher–Freeman–Halton）」共用同一套枚举器，只换统计量：2×2 上两者
  必然给出同一个 p（χ² 与概率在同一族表上的排序一致），3×3 上就会分开——例如
  `[[4,2,1],[1,3,2],[2,1,5]]` 的 Pearson 卡方精确 p = 0.2437（χ² = 5.873、602 张表，
  与独立枚举逐位对账），而 Fisher–Freeman–Halton 给 0.2688。
- 同边际的表超过 20 万张时改抽样（固定种子、可复现），注文写成「… Monte Carlo 检验」，
  并给 99% 区间，与 SPSS 的 Monte Carlo 估计同一个说法。

## 0.44.1

- 修 0.44.0 的一处文案：数据被模型完全拟合（残差方差为 0）时，Cook's D 没有可用的
  分母，原先每一行都标成「杠杆接近 1」，可实际杠杆值只有 0.19–0.45，看着像算错了。
  现在 Cook's D 显示「—」、标记写「完美拟合，Cook D 无定义」；杠杆值等于 1 时另有
  「杠杆等于 1，Cook D 无定义」。判「完美拟合」用相对判据（`sse ≤ ε·SST·n`），因为
  解正规方程会留下 1e-15 量级的残差，除以同样微小的残差均方会把舍入噪声放大成看着
  像回事的 Cook's D。

## 0.44.0

- 回归面板补「影响诊断」（默认关）：勾上之后插件自己算每个个案对拟合的影响，追加
  一张「影响诊断（插件计算）」表——杠杆值、Cook's D、Mahalanobis 距离，按 Cook's D
  从大到小列出前 20 个并标出判据（Cook's D > 4/n、杠杆值 > 2p/n / 3p/n）。
  PSPP 的 `REGRESSION /SAVE=` 只认 `PRED` 与 `RESID`（`/SAVE=MAHAL COOK LEVER` 直接
  报 `expecting PRED or RESID`），所以这三个量只能在这里算。
- 杠杆值走 MGS 正交基（元素平方和），不求 `(X'X)⁻¹`，预测变量完全共线时也不会算出
  负值或 NaN——那种情况返回 null 并让共线性表去说明问题。
- Mahalanobis 距离按预测变量本身算：`√((n−1)(h − 1/n))`，处在均值处的个案距离正好 0。

## 0.43.0

- GLM 面板补「对比系数」：每个因子水平写一个数，多个对比用分号隔开（`2 -1 -1`
  或 `2 -1 -1; 0 1 -1`）。PSPP 的 `GLM` 不接受 `/CONTRAST`（探针：`expecting
  MISSING, INTERCEPT, CRITERIA, METHOD, or DESIGN`），但 `ONEWAY` 接受，而且拟合的
  就是同一个单因子模型，所以面板在需要时追加一条
  `ONEWAY … /CONTRAST=… /CONTRAST=…`，`Contrast Tests`（含假定方差齐性与
  Welch 两版 t、df、Sig）由引擎自己算。事后检验与对比可以同时勾，会合并进同一条
  `ONEWAY`。
- 系数个数与因子水平数不一致时，引擎只在 stderr 留一行 warning 就把这条对比丢掉，
  rc 仍是 0——表看起来像跑干净了。现在面板与工具都会先校验（个数一致、全是数字），
  万一漏网，宿主会在这张 ANOVA 表下注明「对比被引擎忽略了」。
- 工具侧 `pspp_analyze` 的 `glm` 收 `contrasts`（`[[2,-1,-1]]` 或
  `"2 -1 -1; 0 1 -1"` 两种写法等价），同样走 `ONEWAY`。
- 测试：build 加一条（单条/多条+事后、字符串与数组两种写法等价、个数不一致与
  非数字被拒）、面板加一条（`parseContrasts` 规则与工具侧一致）、smoke 加真引擎
  一条（夹具 12 例三组，`Contrast Tests` 出现且对比值 −27.00 / −9.00），另加一条
  确认「系数个数不对时注文点名」。

## 0.42.1

- 修 0.42.0 的 Monte Carlo 抽样偏差：逐格用条件超几何抽样看着等价，实测把
  p 从 0.2688（枚举）拉到了 0.3634。改成「把个案按列标签打乱再按行合计切开」，
  每个同边际的表等概率，抽样结果与枚举一致（0.2722 / 0.2684 / 0.2691）。
- 新增一条交叉校验：同一张 3×3 表既枚举又抽样，两者 p 必须相差 < 0.02，且枚举
  值要落在抽样的 99% 区间里。这类统计学实现光看代码看不出来，只能拿两条路径
  互相对账。

## 0.42.0

- 交叉表多了「精确检验（插件按边际枚举）」：r×c 表也能拿到 Fisher–Freeman–Halton
  双侧 p，不再只有 PSPP 愿意打的 2×2 Fisher。表小的时候枚举全部同边际的表，
  表大（同边际的表超过 20 万张）就换固定种子的 Monte Carlo 抽样，并给出 99%
  区间，跟 SPSS 的 Exact: Monte Carlo 一个口径。
- 概率走多重超几何、在 log 尺度比较，40 例的表不会因为阶乘溢出算成 NaN；
  上界 `∏ C(行合计 + 列数 − 1, 列数 − 1)` 先算一遍，超了直接抽样，不再先枚举
  20 万张才发现算不完（那是 44 秒，现在 0.8 秒）。
- 引擎拒收 `METHOD=EXACT` 这件事现在写进卡方那行表注：小期望频数时直接告诉
  用户勾「精确检验」就是出口，而不是说「没有确切检验可换」。
- 修两个面板下拉框的老毛病（Windows 复验 0.41.0 时抓到的）：
  - 「标识异常个案」的界值档写成了 `choices`，对话框只读 `options`，所以那个
    下拉里一个选项都没有；
  - 选项表里的 `[value, label]` 元组没有被归一化，于是置信区间水平、分位数、
    事后检验方法等下拉显示成空白项。现在 `normalizeChoices()` 同时认字符串、
    `{value,label}` 与元组三种写法。

## 0.41.0

- **数据 → 标识异常个案**（SPSS 数据菜单里那条，PSPP 同样没有对应命令）：对每个选中的数值变量取它自己的百分位界值，把落在带外的取值判为越界，出两张表 —— 「变量界值」（变量、个案数、下界/上界、低于下界数、高于上界数、合计）与「越界的个案」（个案号、变量、值、判定、下界/上界，最多 200 处并注明总数）。界值可选 5/95（默认）、10/90、2.5/97.5、1/99 四档。勾「创建指示变量」时新增 `outlier`（1 = 至少一个变量越界）与 `outlierN`（越界的变量个数），可接「选择个案」按 `outlier = 1` 筛。
- 口径：声明缺失码不参与界值计算、也不参与判定；字符串变量没有百分位带，表里用 `·` 表示并在表注里点名，不印 `NaN`；少于两个数值的变量同样只占一行、不算界值；个案在多个变量上越界时按「处」计数、按「个案」汇总，两个数字都给。
- 工具侧 `pspp_transform` 新增 `identifyOutliers`（别名 `outliers`、`unusualCases`），参数 `variables`、`percentiles`、`indicators`。
- 测试：新增 `test/outliers.mjs`（10 条：双边越界、字符串不进带、声明缺失码既不算界值也不被判越界、默认 5/95、非法带回落、多变量越界双重计数、全等值时严格比较不误判、单值变量给 `·`、空数据集返回 null、超 200 处截断并注明）；`test/routes.mjs` 加 `api/outliers` 六条（界值与计数、两张表进输出面板、两列指示变量落到网格、逐行标记、只要报告时不加列、字符串变量给 `·` 与注文）；`test/client.mjs` 加一条（对话框把百分位带解析成两个数字、默认 5/95、指示变量默认值）；`test/smoke.mjs` 加真引擎一条 —— 加完指示变量后跑 `DESCRIPTIVES /VARIABLES=outlier outlierN`，验证两列真的写回 `work.sav`。

全量 `npm test` exit 0 / **376 条断言 / 26 套件**（`test/outliers.mjs` 10 条）。

## 0.40.0

- **数据 → 标识重复个案**（SPSS 数据菜单里的同一条命令，PSPP 没有任何对应语法）：按你选的键变量比对当前数据集，出一张「标识重复个案（插件计算）」表 —— 组号、键变量值、个案号、组内序号、是否末条，最多列 50 组并注明总组数。勾「创建指示变量」时再新增两列 `dupSeq`（组内序号，0 表示唯一）与 `dupLast`（重复组的末条），可直接接「数据 → 选择个案」按 `dupSeq > 1` 筛。含声明缺失码的个案各自单列，不参与比对（与其它表的缺失口径一致）；键变量留空表示用全部变量。工具侧 `pspp_transform` 新增 `identifyDuplicates`。
- 数据分析预设里的工具说明同步：`pspp_transform` 的 description 与参数 schema 补上 `indicators`，agent 侧不必猜这条命令的入口。
- 测试：新增 `test/dupes.mjs`（9 条：重复成组与序号、两组并存、声明缺失码单列、留空=全部变量、空键值与空键值相等、无重复时给明说、未知变量名回落到全部、空数据集返回 null、超 50 组截断并注明）；`test/routes.mjs` 加 `api/duplicates` 六条（分组计数、表进输出面板、两列指示变量真的落到网格、序号与末条标记逐值对上、加列后数据集变脏、只要报告时不加列）；`test/client.mjs` 加一条（对话框只送键变量、指示变量默认开、不产引擎语法）；`test/smoke.mjs` 加真引擎一条 —— 加完指示变量后跑 `DESCRIPTIVES /VARIABLES=dupSeq dupLast`，验证两列真的写回了 `work.sav`。

全量 `npm test` exit 0 / **365 条断言 / 25 套件**（`test/dupes.mjs` 9 条）。

## 0.39.0

- **线性回归追加 Durbin-Watson**：PSPP 的 `REGRESSION` 根本不打印这个统计量（`/STATISTICS` 只有 `R COEFF ANOVA BCOV TOL CI ALL DEFAULTS`），所以插件在回归跑完后按残差在数据行序上自算，追加一张「Durbin-Watson（插件计算）」表：DW 值、个案数、预测变量数，加两条判读（数值含义 + n ≥ 15 时的 5% 界限区间；n < 15 时明说不引用界限表）。缺失值口径与其它表一致（`MISSING VALUES` 声明的码、空白都剔除）。完美拟合（残差方差为 0）时不出这张表，而不是印一个 `Infinity`。顺序按数据文件当前行序，表注里写明了「刚做过排序的话，这个数字描述的是排序后的顺序」。
- 测试：`test/regression.mjs` 加一条（手算 DW = 3.234 的锯齿残差、完美拟合返回 null、缺失码剔除后 n 变化、n = 20 时给界限判读、无预测变量返回 null）；`test/smoke.mjs` 加真引擎一条（20 例回归 → 断言 DW 表存在、值在 0–4、有界限判读、共线性表仍在）。

全量 `npm test` exit 0 / **355 条断言 / 24 套件**（`test/regression.mjs` 35 条）。

## 0.38.0

- **一般线性模型（单变量）加事后检验**：LSD / Bonferroni / Sidak / Tukey HSD / Scheffé。PSPP 的 `GLM` 不接受 `/POSTHOC`（探针原文 `expecting MISSING, INTERCEPT, CRITERIA, METHOD, or DESIGN`），所以勾了之后插件在 GLM 之后另发一条 `ONEWAY … /STATISTICS=DESCRIPTIVES HOMOGENEITY /POSTHOC=<法> ALPHA(0.05)` —— 单因子设计下拟合的是同一个模型，事后表（`Multiple Comparisons`、方差齐性检验、描述统计）就是 SPSS 那几张。两个因子以上的设计直接拒绝并说明原因，不假装能算。工具侧 `pspp_analyze` 的 `glm` 收 `posthoc`。
- 修 0.37.0 的一处文案：`rankTypes:["ntiles"]` 以前报「不认识的秩类型：ntiles（…与 ntiles）」，自相矛盾；现在明确说「ntiles 不是秩类型，它是个独立参数」。
- 测试：`test/build.mjs` 加一条（GLM 无/有事后、非法名、多因子拒绝）；`test/client.mjs` 加一条（对话框 build 与 pairwise 存活）；`test/smoke.mjs` 加真引擎一条 —— GLM + ONEWAY 两条语句一起跑，断言输出里既有 `Tests of Between-Subjects Effects` 也有 `Multiple Comparisons`。

全量 `npm test` exit 0 / **354 条断言 / 24 套件**（`test/build.mjs` 86 条）。

## 0.37.0

两处「引擎有、面板没接」补齐，都是原生语法，不涉及自算：

- **排秩**对话框从「只会算秩」扩到 PSPP `RANK` 的全部八种类型：秩、累计个案数（`N`）、百分位（`PERCENT`）、比例估计（`PROPORTION`）、相对秩（`RFRACTION`）、正态得分（`NORMAL`）、Savage 得分（`SAVAGE`）、分位数（`NTILES(n)`，2/4/5/10/100 可选），外加原有结值处理。新变量名按类型自动取（`r_x`/`n_x`/`p_x`/`prop_x`/`rf_x`/`z_x`/`sv_x`/`q_x`），一次提交可以同时产出多种。工具侧 `pspp_transform` 加 `rankTypes` 与 `ntiles`，认不出的类型名（例如 SPSS 文档里的 `FRACTION`、`SAVY`）直接报错而不是丢给引擎换一个 400。
- **描述**对话框加「将标准化值另存为变量（Z<变量名>）」，发 `DESCRIPTIVES … /SAVE`。当表因为中位数/众数/百分位要改走 `FREQUENCIES` 时，`/SAVE` 无法挂在同一条语句上，于是单独发一条 `DESCRIPTIVES /VARIABLES=… /SAVE.` 放在前面，两类输出都不丢。工具侧 `pspp_analyze` 的 `descriptives` 收 `save`。
- 测试：`test/build.mjs` 加两条（八种秩类型与拒绝非法名、描述保存的两种语句形态）；`test/client.mjs` 加一条（对话框 build 的输出与 `persist`）；`test/smoke.mjs` 加真引擎一条：`DESCRIPTIVES /SAVE` 后字典里出现 `Zx`，`RANK` 八种类型跑完变量 `rx/p_x/z_x/sv_x/q_x` 全部落盘。顺手修 `test/build.mjs` 末尾的汇总行：它原来在几条 `check()` 之前打印，导致断言数永远少 3 条、且 `0 passed` 也能退出 0。

全量 `npm test` exit 0 / **352 条断言 / 24 套件**（`test/build.mjs` 85 条）。

## 0.36.0

缺失值这一块 PSPP 2.1.3 是空的（`MVA is not yet implemented`、`RMV is not yet implemented`），所以这两个功能完全由插件从手上那份数据集算：

- 新增 **分析 → 缺失值分析…**：单变量统计量（N、平均值、标准差、最小/最大、缺失数、缺失 %）与缺失模式（`X` 有值 / `S` 字符串有值 / `.` 缺失，按个案数从多到少，带累计百分比）。缺失口径与其它表一致：空白、非数字、以及 `MISSING VALUES` 声明过的码（含 `THRU` 区间）都算缺失。表注会指出「完全没有缺失的个案占多少」以及「最常见的缺失模式有多大」——后者是判断插补能不能用的第一个信号。
- 新增 **转换 → 替换缺失值…**：序列平均值 / 线性趋势（相邻值内插，两端用首尾实际值，不外推）/ 临近点（先向前找）。整批替换记成一步撤销，下一次运行才写回 `work.sav`。
- 对应工具：`pspp_analyze` 接受 `mva`；`pspp_transform` 接受 `replaceMissing`（`method` = mean/linear/nearby）。
- 顺手修一个潜在数据 Bug：`Workspace.createDataset()` 造出来的变量没有 `position`，而所有按位置读格子的地方用的是 `position - 1`，于是「新建数据 + 逐条插入个案」建出来的数据集在插件自算的表里全部显示成缺失。真引擎跑语法不受影响，所以之前没暴露。
- 测试：新增 `test/mva.mjs`（10 条：缺失判定、数字格式、单变量、缺失模式、方法裁剪、三种替换、字符串与整列缺失的拒绝）；`test/routes.mjs` 加 `api/missing` 四条（两张表、只取一张、未知变量名报错、替换的计数与 dirty）；`test/client.mjs` 加两个对话框的 `build` 断言（交给宿主、默认两张表、方法回退）。

全量 `npm test` exit 0 / **349 条断言 / 24 套件**。

## 0.35.0

线性回归的两个缺口（先说清哪些是引擎给的、哪些不是）：

- 置信区间水平可选 90% / 95% / 99%。以前固定发 `CI`，PSPP 只按 95% 算；现在发 `CI(99)` 时表头确实变成 “99% Confidence Interval for B”（真引擎验过三档）。
- 新增「系数相关性矩阵」（`/STATISTICS=BCOV`），即 SPSS 的 Coefficient Correlations 表。
- 顺手核了引擎不接受的东西：`/STATISTICS=` 只收 `R COEFF ANOVA BCOV TOL CI ALL DEFAULTS`（`OUTS`、`CHANGE` 都报语法错）；`/RESIDUALS=`、`/CASEWISE=`、`/SCATTERPLOT=`、`/PARTIALPLOT=` 语法能收但**不产出任何表**，所以对话框不提供这几项——做了也是空承诺。`/SAVE=` 收 `PRED RESID ZPRED ZRESID SRESID COOK`（`MAHAL`、`LEVER` 被拒）。

全量 `npm test` exit 0 / 338 条断言 / 23 套件。

## 0.34.0

交叉表统计量补齐。PSPP 2.1.3 的 `CROSSTABS /STATISTICS=` 接受一整套关键字，面板此前只接了 6 个：

- 新增：不确定性系数（`UC`）、Kendall tau-b（`BTAU`）、Kendall tau-c（`CTAU`）、Somers' d（`D`）、Eta（`ETA`）、Spearman / Pearson R（`CORR`）、风险估计（`RISK`）。对话框与 `pspp_analyze` 工具同一套名字。
- **勾了但引擎没给时会点名**：引擎对不满足前提的统计量不报错、只是把那一行/那张表省掉（`RISK` 只给 2×2；`ETA` 要一个名义配一个数值；`tau-b/c`、`Somers' d` 要两个有序变量）。现在表下会写「这几项统计量勾了，但引擎没有输出：RISK（风险估计只在 2×2 表里输出）…」，避免用户以为插件漏了。
- 测试：`test/smoke.mjs` 用真引擎跑 3×3 表把 7 个新关键字全过一遍（断言 `Kendall's tau-b`/`tau-c`/`Somers' d`/`Eta`/`Uncertainty Coefficient`/`Lambda`/`Spearman Correlation` 真的打出来，且没有「引擎没有输出」的抱怨），再单独跑 `RISK` 断言被点名；`test/regression.mjs` 加三条注文单测；`test/client.mjs` 走真实菜单打开交叉表 → 统计量面板断言新选项在、勾上 `Somers' d`/`Eta` 后「帮助」里的语法含 `D` 与 `ETA`。

全量 `npm test` exit 0 / 337 条断言 / 23 套件。

## 0.33.2

Windows 复验 0.33.1 时提出的两条（都是「不发错误、只是结果不对/装不上」那类）：

- **面板点完「清除」画面不刷新**：`api/paste` 的返回只有 state（形状，没有单元格），而网格画的是本地 `rows`，于是服务端已经是缺失值、屏幕上还留着旧数字，要等下一次重载才对齐。现在按返回的变量表把 `cells` 打回本地行；如果这次粘贴新增了个案/变量（形状变了），就重载可见窗口。测试断言「清除后那个单元格立刻变空，不用重载」。
- **安装脚本在缺平台包时不再硬凑**：`install.mjs` 原来找不到本平台资产就取 `candidates[0]`，Windows 上会把 `-linux-x64` 包装进去（引擎是 Linux 二进制，插件起不来）。现在只接受本平台包或 0.32 之前的通用包，否则直接报错并列出这个发布有哪些平台。`pickTarball` 抽成可测函数，新增 `test/install.mjs` 四条（本平台优先、缺平台报错、通用包兼容、arm 不当 x64）。

全量 `npm test` exit 0 / 334 条断言 / 23 套件。

## 0.33.1

0.33.0 发出去之后自查抓到的自我回归：数据视图只在挂载时发布一次命令表（`GRID_COMMANDS`），而表里的 `copy/cut/clear` 闭包指向**首次渲染**的那份 `selection`（`null`）与 `rows`（空），于是 编辑 → 复制/剪切/清除 在真实面板里**点了没反应**（`clearSelection()` 闭包里看到的选区是 null，直接返回 false）。

- 修法：命令表只保留转发层，每次渲染把真正的实现挂到 `liveRef.current`（`copy/cut/paste/clear` 都读当前 `selection`），挂载时注册的 `commands` 调用 `liveRef.current.*`。
- 测试：`test/client.mjs` 加「发布出去的命令表看得到当前选区」——`Ctrl+A` 选中全部后调 `hooks.gridCommand('clear')`，断言返回 true、并且真的发出 `POST api/paste` 且 `cells` 全是 `null`（旧代码这里会返回 true 但一个请求都不发，所以这条能抓住它）。

全量 `npm test` exit 0 / 330 条断言 / 22 套件。

## 0.33.0

用户点名的两件事：**数据 → 重构**（长宽互转）与**编辑/视图菜单的低成本补齐**。

数据 → 重构（PSPP 2.1.3 两个命令都没实现，所以在宿主侧算）：

- 数据 → 重构 → **个案转变量…**：标识变量每个组合一行，索引变量的每个取值展开成新列。列名 `<变量名>_<取值>`；取值不是 ASCII 时退回 `_v1`/`_v2` 位置后缀（PSPP 变量名只能 ASCII，否则下一次运行写 `work.sav` 会失败）。重复的「标识+索引」保留第一个并计入 `duplicates`，结果提示里会说多少处，不静默覆盖。数据集被截断时拒绝执行（否则只重构前 N 行）。
- 数据 → 重构 → **变量转个案…**：一组同类型变量堆叠成「标识列 + 数值列 + 索引列」，索引列可存原变量名或堆叠顺序号。类型不一致会直接报错并点名是哪几个变量。
- 两条都在 `lib/workspace.js`（`restructureCasesToVars` / `restructureVarsToCases`），走 `POST api/restructure`；`pspp_transform` 增加 `casesToVars` / `varsToCases` 两个 operation（返回计数而不是语法，因为引擎没有对应命令）。一步撤销、置 `dirty`，下一次运行前写回 `work.sav`。

编辑菜单（`GRID_COMMANDS`：数据视图发布命令表，菜单调用，因为只有网格知道选区）：

- **剪切 / 复制 / 粘贴 / 清除**：作用于数据视图的选中矩形；剪切 = 复制 + 清空，清除走 `api/paste` 传 null，整块一个撤销点；Ctrl+X 也接到同一处。
- **粘贴变量…**：读剪贴板里的变量名，在变量视图定位第一个存在的变量并报告匹配数量（SPSS 是往对话框文本框填名字，我们的对话框是点选，所以取这个等价用法）。
- **转到个案… / 转到变量…**：前者复用已有对话框，后者是新加的名称候选列表，跳过去会选中并滚动到该行。

视图菜单：**网格线**、**工具栏** 两个显示开关（`localStorage` 记住），网格线关掉只去框线、保留表格结构与冻结。

测试：`test/routes.mjs` 覆盖两条重构（列名、行数、重复计数、混类型报错、找不到变量报错），`test/smoke.mjs` 用真引擎跑「重构 → `DESCRIPTIVES` → 逆重构 → `FREQUENCIES`」证明结果能过 `work.sav`，`test/client.mjs` 覆盖两个对话框的必填校验、编辑菜单七项、视图开关的 `✓` 与 `.ap-nogrid`。全量 `npm test` exit 0 / 330 条断言 / 22 套件。

## 0.32.5

菜单审计（子代理逐条读 `client.js` 的 `menus` 数组核对）抓到的三处真问题，都属于「菜单点了没反应」：

- **图形 → 快速图形 的五个子项点不开**：那一组定义用的是 `items: [...]`，而渲染器只认 `item.sub`（`renderMenuItems` 里 `item.sub ? <子菜单> : null`，`onClick` 也是 `if (!item.sub) runAction(item.action)`）⇒ 组里没有 `action`，点击是无操作、子项永远打不开。改成 `sub:` 后五个入口（柱状/直方/箱线/饼/折线）可达。
- **偏相关的位置与文档、与 SPSS 都不一致**：代码把「偏相关…」放在 分析 → 受引擎限制的功能 组里，而 `docs/FEATURES.md` 的多处与 SPSS 的 Correlate 菜单都在「相关」下。现在移到 分析 → 相关 → 偏相关…，并从「受引擎限制」组移除（那里只留真正受引擎限制的项，提示语也改成指向新位置）。
- **视图 菜单没有助记键**：`MENU_MNEMONICS` 只有 F/E/D/T/A/G/U/H，Alt+V 无反应。补 `v: '视图'`。

测试（`test/client.mjs` 的菜单用例追加）：`Alt+V` 能开「视图」；「图形 → 快速图形」展开后正好是那五个图；「相关」子菜单里能找到「偏相关…」；「受引擎限制的功能」里不再出现偏相关。全量 330 条断言 / 22 套件。

## 0.32.4

Windows 复验 0.32.3 的三项 PASS（版本号跨 SMB 能刷新、切语言 55/27 ms、多数据集四项独立），只剩 `test/paths.mjs` 两条 Windows 环境下的写法问题：

- `a path outside every root is refused with the folder to whitelist` 用正则匹配 `/etc/passwd`，而 Windows 把前导斜杠解析成当前盘符（`Z:\etc\passwd`）⇒ 改成断言消息里含 `resolve('/etc/passwd')`。
- `a symlink into a credential directory is caught` 原本链接进本机真实 `~/.ssh`，那台机器没有这个目录，`checkPath` 自然不报错 ⇒ 改为在临时目录造一个假 home（带 `.ssh`）再链接，既跨平台又不会在别人机器上碰真凭据目录。

全量 330 条断言 / 22 套件。

## 0.32.3

Windows 复验 0.32.1 时报告「三轮热重载后宿主仍报 0.32.0」，根因在版本号的缓存口径：

- `lib/version.js` 原来只按 `mtime` 判缓存。Windows 经 SMB 映射读这份 checkout 时，缓存住的 mtime 可能长时间不变，于是面板一直回报上一个版本。现在改为「最多每秒重读一次」，mtime 只作为一秒内的快速通道。
- 新增用例：同一个 mtime 下改内容，一秒后必须读到新版本（`utimesSync` 把时间戳钉死，模拟 SMB 的滞后）。
- 这也解释了复验里 A 项为什么三次 `disable→enable` 都「不换血」：代码其实是新的，只是版本号没重新读。

全量 330 条断言 / 22 套件。

## 0.32.2

Windows 复验 0.32.0 抓到三条可以直接修的问题。

- **切换语言不再等心跳**：设置页保存后立刻在窗口上广播 `ap:locale`，面板当场换语言（原来要等 3 秒一轮的心跳把 `state.locale` 带回来，实测 3 526 ms / 3 046 ms，超出「立即生效」的承诺）。心跳路径仍在，用于别处改设置的情形。
- **两条测试不再写死 Linux 路径**：`test/build.mjs` 的 THRU 用例改用 `os.tmpdir()`，`test/paths.mjs` 用 `path.resolve('/mnt/data/a')` 算期望值。原先在 Windows 上分别报 `ENOENT: Z:\tmp\range-test.sav.source.csv` 与 `['Z:\mnt\data\a']`，是测试口径问题，不是产品行为。
- **校验文案的期望值改由校验器自己产出**：`test/i18n.mjs` 原来手写「100 到 2000000」，而实现是 1000 到 5000000，导致复验单里出现一处并不存在的「文档与实现不一致」。

全量 329 条断言 / 22 套件。

## 0.32.1

- 导出文件里的「来源：… · N 例 · M 变量 · 打开于 …」也翻（英文下是 `Source: sixty.csv · 60 cases · 3 variables · opened at …`）；为此补了带空格的复数片段键（`例 · ` → `cases · `、` 变量` → ` variables`），避免「60  cases」「3 Variable」这种半吊子输出。
- `normalizeLang` 认大小写与首尾空白（手改的 `settings.json` 写 `EN` 不会再退回中文）。设置接口仍然只接受 `zh`/`en` 两个值，写错就 400。
- 新增 `test/i18n.mjs`（7 条）：词典规模、中文不需要词典、插值文案、宿主校验文案、路径与数字不被动、数据值（男/女）不被翻、语言取值。全量 327 条 / 22 套件。

## 0.32.0

英文界面（用户选「做，但要完整一轮」）。做法不是给 ~750 条文案逐个加 `t()`，而是把翻译塞进元素工厂：

- **`client.js` 的 `h()` 变成包装器**：`h` 原来是 `React.createElement` 的别名，现在在创建元素时翻译字符串子元素与 `title`/`placeholder`/`aria-label`/`alt` 四个文本属性。所以「菜单、工具栏、对话框、输出面板、状态栏、提示」一起换语言，调用点一个没改。
- **key = 中文原文**：先整串命中，命中不了再按最长键做子串替换，于是 `3000 个个案` 这种插值文案靠键 `个个案` → `cases` 也能换；纯 ASCII、路径、超过 600 字符的块直接原样返回，结果进 `TR_CACHE`（数据网格一帧要问几千次）。数据值（`男`/`女`）、变量名、PSPP 自己的表头都不进字典，不会被误翻。
- **词典 `locale/en.json`：929 条**（客户端 + 宿主错误与表注）。宿主侧新增 `lib/i18n.js`（`dictionaryFor`/`translateText`/`localize`），`lib/routes.js` 的 `sendJson` 在 `uiLanguage === 'en'` 时翻译 `error` 字段 ⇒ 英文界面不会弹中文报错。`GET api/locale?lang=en` 单独发词典（66 KB，不搭在每次 state 上）。
- **设置页新增「界面语言」（中文 / English）**，`settings.json` 的 `uiLanguage`（默认 `zh`）；`state.locale` 与心跳签名的 `view.locale` 都带它，所以开着的面板改完立刻跟着换，不用重开。
- 侧栏页签标题与数据文件查看器标题由宿主绘制、不走 `h()`，改为 `tr()` 并在 `apply()` 时按 `api/settings` 预载词典。
- 刻意没翻：工具描述（本来就是英文）、PSPP 输出的表头与统计量名、用户数据值。

## 0.31.5

Windows 对 0.31.4 的第 2 项是「部分 PASS」：`diagnostics[].message` 干净了，但两处仍带引擎临时路径。

- 「引擎没有产出任何表（…）」这条 400 的表单（`describeFailure`）现在也过 `stripEngineLocation`：用户看到的是「退出码 1：Unknown command \`FREQUENCIS'.」，不是 `C:\...\runs\6-8529db\run.sps:2.1-2.10: error: …`。
- `describeEngineError` 的自由文本分支同样剥离位置前缀。
- `diagnostics[].raw` **保留原文**（这是记录，导出/审计要用）；用户可见的 `message`、`hint`、400 文案都不带路径。
- **撤销栈加了内存预算**：以前只限步数（30 步），30 份「半个百万格」的快照就能吃掉 1 GB 并把用户的会话一起拖死。现在除步数外还有总格数预算（默认 400 万格，`config.historyBudgetCells` 可调），超了丢最早的那步，并在面板弹一句「数据集较大，撤销记录超出内存预算：最早的 N 步已丢弃」，`state.history.dropped` 记着丢了几步。

## 0.31.4

Windows 对 0.31.3 的四项复验全 PASS，它顺手报的两条我一起修了。

- **改设置后面板不跟**（它观察到的真问题）：面板只在心跳变了才重读 state，而心跳的签名里没有表格样式/导出上限这几个「画图用」的设置，于是改完要重开面板才生效。签名的 `view` 里现在带 `tableStyle`/`maxRows`/`maxExportRows`，改设置即刻反映到开着的面板。
- **引擎自己的临时路径漏到界面**（更早的 P1）：Windows 的 `C:\...\runs\3\run.sps:1.1-1.11:` 前缀会把位置正则顶掉，整行进「自由日志」原样显示；现在显式匹配位置，并把 PSPP 的 `Stopping syntax file processing` 这类记账行丢掉而不是当诊断。

## 0.31.3

Windows 复验 0.31.0 抓到的两处，加上一处措辞。

- **HTML 导出没跟设置**（真 FAIL）：Word/Excel 按 `maxExportRows` 截，浏览器侧那份 HTML 却按写死的 `EXPORT_ROWS = 2000` 截，于是把上限调成 500 后，导出的 HTML 仍然 2000 行。`api/state` 现在带 `maxExportRows`，面板四个出口读同一个数（`test/routes.mjs` 钉了「state carries the export cap」）。
- **空字符串的说法**：`Number('') === 0`，于是 `maxExportRows: ""` 报「必须在 100 到 100000 之间，收到 0」。现在明确说「留空表示不改这一项；要设置就写 100 到 100000 之间的整数」。
- **设置页提示**改成以「导出上限立即生效」开头，并点明四个出口同一数值 —— 原来那句「立即生效」容易被读成只管表格样式。

## 0.31.2

被截断的数据集不再伪装成一份小数据集。

「数据视图最多载入个案数」把 20 万个案的文件读成前 20 万条（默认上限就是 20 万），面板上只看到「200000 个个案 · 3 个变量」，和一份真的只有 20 万行的文件一模一样；没人会去核对文件本身有几行。

- 状态栏个案数后面加 `+`，并多一个「截断显示 N 例」的灰标签，悬停写明：只载入了前 N 例、在设置里改上限、分析/保存/导出仍在完整数据上跑。
- 打开文件时如果发生截断，除了「导入说明」之外再弹一句 toast —— 一行字，说明白为什么屏上少了行。
- 顺带明确一句事实：截断只发生在**面板读取数据视图**这一段；PSPP 的分析、保存、导出都走完整的 `work.sav`，所以频率表里的 N 与屏上的行数本来就可以不相同。
- 英文界面这一项**没有做**：`client.js` 里有 821 处不重复的中文界面文案，仓促机翻会得到一份中英混杂的界面，还会让 20 个套件里靠中文文案定位的断言全部失效。要做就单独排一轮，先抽 `t()`、加 `locale/en.json`、再按界面上到下逐块替换。

## 0.31.1

多份数据并排时的可辨认性。

- 每个标签页本来就是独立工作区（数据、输出、撤销栈、`runs/` 目录都不共享，工具跟着 `api/active` 指的那一页走），但底部工作台的标签页标题一直写死「PSPP」：开了四个就是四个 PSPP，改错数据只需一次点错。
- 加载完数据后把标签页标题改成数据集名（`renameDocTab(service, docId, baseSessionId, name)`，只对 `<会话>~<n>` 这类派生页生效，主面板保持「统计分析」）。`updateTab` 抛错不影响打开本身。
- 文档补 §2.1.4：三件事分开说清 —— 每个标签页一份数据、工具跟当前页、`runs/` 目录不会互相覆盖。

## 0.31.0

两件：导出不再无限膨胀，面板读状态不再把一种合法形状当成「没有数据」。

### 导出体积上限

频率表这类「一个取值一行」的表，3000 个取值就是 3000 行，整张塞进 Word 得到 4 MB 的文件（多张表叠加能到 7 MB 以上）：打得开、读不了。现在每张表只写前 `maxExportRows` 行（默认 2000，表头不计），后面跟一句 `表太长：这张表共 N 行，文档里只放了前 K 行；完整数据请用「导出为 CSV」。`

- 三个出口一致：`word/document.xml` 一句小字、Excel 工作表一行「注：…」、HTML 导出一段 `.ap-export-note`。
- 上限可调：设置 → 统计分析 → 「导出时每张表最多放多少行」（`maxExportRows`，100–100000，立即生效）；留空表示不改。
- 实测（3001 行频率表，含 PSPP 自己的 Total 行）：默认上限 docx 4.04 MB / xlsx 790 KB；调成 500 后 docx 1.02 MB / xlsx 202 KB，正文 500 行 + 表头、无尾部泄漏、注文在。
- 屏幕内的 200 行预览与导出是两套数：预览只影响屏上渲染，「显示全部」可以展开；复制 CSV 与导出按 `maxExportRows` 走。
- `lib/office.js` 新增 `EXPORT_ROW_LIMIT`、`clipMatrix()`、`clipNote()`；`buildDocx`/`buildXlsx` 都收 `maxRows`；`exportOffice()` 从 `liveConfig().maxExportRows` 传入。

### 面板与宿主的数据契约

宿主回 `{ ok: true, state: {…} }`，面板各处直接取 `value.state`。任何给裸状态对象的调用方（自建测试台、换了 envelope 的宿主）都会拿到 `undefined`，于是请求 200、面板却永远显示「尚未打开数据集」。

- 新增 `stateOf(value)`：`value.state` 是对象就用它；只要对象里有 `items` 数组与 `dataset` 就按状态本身处理；两者都不是就抛 `宿主返回的数据形状不认识：需要 { ok:true, state:{…} }，或者直接给状态对象`。
- 全部状态读取（首次载入、轮询、各操作后的刷新）都改走它；轮询里比较 items 增长与 `dataMoved` 也用规整后的对象。
- 宁可报一句能看懂的话，也不再把空面板伪装成「没有数据」。

测试：314 → 316 条（导出裁剪 1 条、裸状态契约 1 条；`test/settings.mjs` 补 `maxExportRows` 的三条校验）。

## 0.30.1

大表截断的两处判断题改对了。

- 表头行不再按「第一行」算，而是按「开头那些不含任何 `<td>` 的行」算。PSPP 把表头写在 `<tbody>` 里，形式是一整行 `<th>`；但数据行也可能带 `<th>`（「Valid」「Missing」这种行标签），所以按第一行判会误伤。交叉表有两行表头（列分组），现在两行都留在上面。
- 没有表头的表不再少数一行：以前一律「总行数 − 1」，那种表会把最后一行数据吃掉。现在先数表头行，再算表体行数。
- 截断点也按同样的行边界切（不再用 `<tr` 字符串位置），补 `</table>` 收口；`<caption>` 在切点之前，留着。
- 测试：`test/client.mjs` 用三种真实形状覆盖 —— PSPP 的 `<tbody>` 表头、完全没有表头、交叉表的两行表头。

## 0.30.0

面板 UI 对齐第二轮。

- **工具栏只画图**：打开/保存/值标签/频率/描述/交叉表/相关/回归/运行语法/清除输出 十个按钮换成内联 SVG 图标（16×16，`currentColor` 描边，深色主题跟着走），26×26 见方；文字挪进 `title` 与 `aria-label`，鼠标停一下能看到名字，读屏也能读。
- **输出树按运行分组**：SPSS 的 Viewer 把结果挂在产生它的过程下面，我们原来是一长条平铺，连着跑三个过程分不出边界。现在每次运行前加一行灰色「运行 N」，顺序就是实际执行顺序。
- **数据视图表头两行**：上面变量名，下面变量标签（10 px 灰字），跟 SPSS 数据编辑器一致；没有标签的变量只占一行，表头高度按内容长。
- **菜单有键盘通路**：`Alt+F/E/D/T/A/G/U/H` 直接下拉「文件/编辑/数据/转换/分析/图形/实用程序/帮助」，`↑`/`↓` 在条目间走，`Enter` 执行，`←`/`→` 在菜单间切换，`Esc` 收起并把焦点还给菜单名。此前面板完全没有键盘进菜单的路子 —— 那边用真浏览器点不开菜单时也就没有备选动作。
- 说明：变量视图的属性列宽、数据视图的列宽与列序拖拽本来就已经支持（拖表头右边界改宽、双击右边界自适应、拖表头改列序），这轮没动。
- 测试：313 → 314 条。新增一条 jsdom 用例覆盖 `Alt+F` 下拉、`↑`/`↓` 走位、`Esc` 收起，以及输出树出现「运行 1」「运行 2」两个分组。

## 0.29.0

大表先画一屏。

- 病根：输出表原来整张渲染。分类变量的频率表是「一个取值一行」，3000 例的数据一跑就是 3000 行，几千个 `<tr>` 同时挂进 DOM，面板卡、滚动卡，浏览器快照也大到没法用。
- 现在每张输出表先画前 200 行，表下写明「这张表共 N 行，面板先画前 200 行（复制 CSV 与导出仍是全部）」，右边一个「显示全部」；展开后给「只显示前 200 行」收回。展开状态按表记（每张表各管各的），切换页签不丢。
- PSPP 自己吐的 HTML 与本地算出的矩阵两条路都走同一个上限：HTML 那条数 `<tr` 起点、在超限那一行之前截断并补 `</table>`（thead、colgroup、列宽样式都留在前面），矩阵那条直接切片。行数按「表体行」算，表头不算进去。
- 只影响屏幕：复制 CSV、单表导出、Word/Excel/HTML/PDF 导出全都读完整矩阵，数字一个不少。
- 测试：`test/client.mjs` 新增一条 jsdom 用例 —— 300 行的表只画 200 行（加表头 201 个 `<tr>`）、提示写「共 300 行」、点「显示全部」变 301 行、再点回来恢复 201 行。全绿 313 条。

## 0.28.2

`runs/` 里的输出不再互相覆盖。

- 病根：`runId` 是每个工作区从 1 开始的计数器，而**面板会话与工具会话是两个工作区**，两边都往 `runs/1`、`runs/2` 里写 `chart.svg`、`output.html`。两套同时用的时候，后跑的会把先跑的文件覆盖掉；表现是「刚才那张图点开变成另一张」。
- 现在目录名是 `runs/<runId>-<6 位工作区id 哈希>`，`runId` 仍是那个数字（输出条目排序、图表归属、导出配对全按它，不变）。`runDir(runId)` 先找带后缀的目录，找不到再回落到旧的无后缀目录，所以升级前写下的运行仍然能读。
- `artifactPath()`、`loadOutputImages()`、图表导出/编辑、`exportDocument`/`exportScript` 回取产物、`clearOutput()` 全部走同一个 `runDir()`。
- 顺带补上「在飞请求」计数：`Workspace.inflight` 在读取产物文件时 +1，`release()` 与 `evictIdle()` 遇到 `>0` 一律跳过（此前只挡 `busyDepth` 与 mutex，跑完分析后正在读图的那一瞬间仍可能被回收）。
- 测试：`test/smoke.mjs` 新增两条 —— 两个工作区各跑到同一个 runId、断言 `runDir` 不同且 `artifact()` 取到的是各自的图；旧的无后缀目录仍可读；`inflight=1` 时 `release()` 必须拒绝。全绿 312 条。

## 0.28.1

把 0.28.0 只接了一半的样式收尾：**Word 与 Excel 导出也跟 `tableStyle` 走**。

- 以前 `lib/office.js` 的 `tableXml()` 把边框写死成三线表（表头上下一粗一细，其余无框线），设置里选「网格」只影响面板与 HTML。现在 `buildDocx` / `buildXlsx` 都收 `style`，`exportOffice` 从 `liveConfig()` 取当前设置：`grid` 给每格四边加细线、表头下 8 分、表级加 `insideH`/`insideV`；`plain` 一条线都不画；`three-line` 保持原样。
- Excel 侧没有「表格边框」这种东西，靠 cell style：`stylesXml(style)` 在 `grid` 时把原有七个样式追加一份带 `borderId=1` 的副本（`cellXfs` 从 7 变 14），`sheetXml` 用 `XLSX_BASE_XFS.length` 作偏移，所以表头、数据、百分比/小数/公式样式一起带框线。
- 设置页提示改成准确说法：「立即生效：面板、导出的 HTML、Word 与 Excel 都跟它走。」
- 顺手修 `scripts/install.mjs` 两处：profile 不再写死 `web`（不写就用唯一的那个，多个 profile 时列名字报错 —— Windows 桌面版只有一个 `desktop`，以前会装进不存在的 `web`）；`--offline` 没传时不再把第一个位置参数当路径吃掉（`install.mjs web` 之前会把 `web` 丢掉，回落到写死的 `web`，等于参数无效）。
- 测试 310 → 312：`test/office.mjs` 新增一条，按三种样式各生成一份 docx/xlsx，断言 `grid` 有 `insideV` 规则且每格四边都有线、`plain` 一条没有、`three-line` 只保留表头粗线；xlsx 侧断言 `borders count="2"`、`cellXfs count="14"`、表头样式从 2 变 9 而数字仍是数字。
- 实测（真引擎 + 真导出）：`DESCRIPTIVES` 后设 `grid` 导出 docx 16 989 B / xlsx 8 434 B，`word/document.xml` 含 `<w:insideV w:val="single"/>`，xlsx 的 `styles.xml` 是 `borders count="2"`、表头 `s="9"`；两份文件 LibreOffice 都能打开并转 PDF。

## 0.28.0

给「插件能碰哪些文件」立一条边界。这一版没有新功能，修的是**不需要用户犯错也会出事**的那一类。

- 病根：面板是 3080 端口上的网页，`open` / `save` / `export*` / `merge` / `convert` / `readFile` / `saveSyntax` 都接受任意绝对路径。Windows 侧复验员自己签了一个 cookie 就拿到了 `/analytics/api/*` 的全部权限 —— 也就是说「路径是用户输入的」不能当安全边界：一次笔误，或者数据集里某段文字把模型引到一个路径上，就能读走 `~/.dsh/.credentials.yaml`（浏览器 cookie 的签名密钥和 GitHub token 都在里面），或者覆盖任意文件。
- 新增 `lib/paths.js`：白名单 + 硬拒两类目录。默认允许主目录、会话工作目录、系统临时目录，以及 Linux 上的 `/mnt` 与 `/tmp`（Windows 上补 `C:\Temp`）；`~/.dsh`、`~/.ssh`、`~/.gnupg` **即使落在允许的根里也一律拒绝**，并且允许目录加不进这些路径。
- 所有读写都走 `Workspace.resolvePath()` 这一处闸门（`open`/`save`/`exportCsv`/`exportOffice`/`exportChart`/`exportDocument`/`exportScript`/`writeText`/`mergeFile`/`convert`/`listSheets`，以及工具侧的 `pspp_save` 等）；路由里的 `api/dir`、`api/readFile`、`api/saveSyntax` 三个直接吃路径的入口也接上同一个检查，`api/dir` 的目录清单不再能走到白名单之外。
- 越界不是静默失败，也不写英文栈：`<路径> 不在允许的目录里：<绝对路径> / 现在允许：… / 要放开就把它的上级目录加到「设置 → 统计分析 → 允许的目录」，比如 <上级目录>`。命中凭据目录另有一句说明。
- 设置页新增「允许读写哪些目录（每行一个）」（`lib/settings.js` 的 `allowedDirs`，默认空数组）：要读写别处就把上级目录写进去，`~` 会展开，相对路径与非绝对路径会被拒绝，重复项自动合并。
- 顺带修掉 Windows 判为 FAIL 的「立即生效」：`WorkspaceRegistry.configFor()` 只在创建工作区时读设置，老会话不跟随。现在 `Workspace` 持有 `settingsStore`，`liveConfig()` 每次按需重读（`SettingsStore` 自带 1 秒缓存），`state()` 的 `tableStyle`/`maxRows`、`timeoutMs`/`maxRows` getter 都走它 —— 表格样式与允许目录立即生效，载入上限与超时在下一次使用生效。
- 测试 302 → 310 条：新增 `test/paths.mjs`（10 条：`~` 展开、默认根、相对路径按会话目录解析、越界拒绝的措辞、三个凭据目录、符号链接指向 `~/.ssh` 也被拦、`allowedDirs` 的展开与去重、不允许把凭据目录加进白名单、空路径）；`test/routes.mjs` 补 7 条（`readFile` 拒凭据目录/拒 `/etc/passwd`、`writeText` 拒 `~/.dsh`、`api/dir` 越界与凭据目录都 400、允许目录仍 200）；`test/smoke.mjs` 一条真引擎用例（拒 `/etc` 与 `~/.ssh`、允许目录内仍能保存）；`test/settings.mjs` 一条（已开着的工作区跟随设置变化）。

## 0.27.3

把 0.27.2 只接到面板的那半个修复补完：**导出的 HTML 也跟表格样式走**。

- 0.27.0 的设置页写着「立即生效，也影响导出的 HTML」，但导出的文件里既没有表格样式的 CSS 规则，表格也只在「手工改过列宽/表头」时才带 class —— 那句话当时不成立。Windows 复验把它点出来了。
- 现在导出样式表里带 `ap-tbl-three` / `ap-tbl-grid` / `ap-tbl-plain` 三套规则，并且**每张表都盖 class**（PSPP 自己吐的裸 `<table>` 也盖），所以面板与导出的 HTML 是同一个版式。
- 设置页那句提示改成准确说法：「立即生效：面板与『导出输出为 HTML』都跟它走。Word/Excel 导出固定按三线表排版。」
- 测试：`test/client.mjs` 走真实菜单点「导出输出为 HTML…」，截下 Blob 断言文件里有 `ap-tbl-grid` 类与对应 CSS（顺带把 `URL` 全局绑定补上，之前 jsdom 下走的是 Node 的 `URL`）。

## 0.27.2

修一个 Windows 复验抓到的「死开关」：设置页里的**输出表格样式存了但不生效**。

- 病根是两套词汇：设置写 `three-line` / `grid`（`lib/settings.js`），面板画表用的是 `default` / `three` / `plain` / `grid` 且只读 `localStorage['ap.tableStyle']` —— 设置页改完，文件变了，表没变，谁也没读它。
- 现在 `api/state` 带 `tableStyle`（和 `maxRows`），面板把它当默认样式，`视图 → 表格样式` 变成**浏览器内覆盖**（多一项「跟随设置（三线表/全框线）」清掉覆盖）。设置改一次，所有会话的表一起变；想临时看无框线的，不必改共享设置。
- 测试：`test/routes.mjs` 断言 `api/state` 带回保存后的 `tableStyle`；`test/client.mjs` 断言状态里 `tableStyle: 'grid'` 时输出表格真带 `ap-tbl-grid` 类（此前这条完全没覆盖，正是它能静默失效的原因）。

## 0.27.1

修一个让 0.27.0 的设置页在本版 DSH 上**挂不出来**的错误：注册的槽名不对。

- 0.27.0 照 `@linxin666/dsh-chime` 的写法把设置页注册到 `settings.plugins.tab`。本版 DSH 的槽目录里**没有**这个槽（`Slots.listSubTree` 返回 `available: false`），注册到不存在的槽是静默无效——面板照常打开，设置页却永远不出现。
- 真正的座位是 **`settings.section`**（list，「One settings page per list entry」）；`settings.general.item` 只放单行开关，不是整页。已改成 `ctx.slots.inject('settings.section', …)`，页面出现在「设置 → 统计分析」。
- `test/client.mjs` 的槽名断言同步改成 `settings.section`，以后抄错槽名会直接红。其余功能与 0.27.0 相同；已经装了 0.27.0 的升级到 0.27.1 即可。

## 0.27.0

「像 SPSS 的成熟产品」缺的四件 + 一次视觉对齐。核心是：**不再需要改 profile 的 YAML 才能调参**，**对话框能像 SPSS 那样「粘贴」语法**，**统计层补上 PSPP 自己不做的三个量**，**装起来一条命令**，面板按 SPSS 的尺寸重画。

### 设置面板（设置 → 统计分析）

以前 `maxRows` / `timeoutMs` / `safer` 只能改 `cordis.patch.yml` 再停→启插件。现在有一页设置，写 `~/.dsh/analytics/settings.json`：

| 项 | 默认 | 生效时机 |
|---|---|---|
| 数据视图最多载入个案数 | 200000 | 新建或重新打开的会话 |
| 单次运行超时（秒） | 120 | 下一次运行 |
| 用 `--safer` 运行 | 关 | 下一次运行 |
| 输出表格样式（三线表 / 网格） | 三线表 | 立即、且影响导出的 HTML |

`registerTools` **只展示不可改**：它决定 23 个 `pspp_*` 工具是否进每个会话，属部署决定，仍在 patch 里。手改坏一个字段不会让设置页打不开——坏的那项回默认并在页面上点名（`lib/settings.js`，`GET/PUT api/settings`）。新工作区在创建时读一次设置，所以「下次生效」是准确的说法，不会中途改掉已经跑着的会话。

### 对话框「粘贴语法」

SPSS 的分析对话框都有「粘贴」：把这次设置生成的语法放进语法编辑器，**不执行**。现在 30 多个对话框都有，而且行为是**追加**（连点三个对话框的「粘贴」会拼出一段完整程序，不覆盖你已经写的），并自动切到语法视图。页脚顺序也按 SPSS 排：`确定 / 粘贴 / 重置 / 取消 / 帮助`，`帮助` 显示这段语法要做什么，`重置` 回到打开对话框时的状态。

### 统计层补三个量

- **Cramér's V**：交叉表只要请求了卡方，就在 2×2 之外的方表上追加 V 行（`V = sqrt(χ²/(N·(min(r,c)−1)))`）；2×2 会说明它就是 φ。引擎自己在 `Symmetric Measures` 里给了 V 时不重复追加，只做一致性核对；行列数与有效 N 对不上就不写（宁可没有，也不给一个口径说不清的数）。
- **小样本提示**：2×2 且期望频数 < 5 时，表注点名「看同表的 Fisher's Exact Test 行」——PSPP 本来就算这一行，是插件没引导用户去看。
- **Kappa**：交叉表统计量里新增「Kappa（方表一致性）」，透出 PSPP 的 `Symmetric Measures`，并按 Landis & Koch 分档；非方表、或没请求 Kappa 时分别给出解释而不是留个空。
- **ICC**：PSPP 的 `RELIABILITY` 不支持 `/ICC=`，所以由插件自算（双向方差分解，ICC(2,1)/(2,k)/(3,1)/(3,k) 四个口径 + F/df/p + 95% CI + 四条表注）。语法里带 `COMPUTE`/`WEIGHT`/`SELECT IF` 这类会改数据的命令、或引擎有效 N 与自算 n 不一致时**不出表**，只说明原因。

### 一条命令安装

`dsh-analytics` 这个名字在 npm 上已被别的包占用（0.4.0，2026-08-14 创建），本仓库也没有发布到 registry 的凭据，所以不抢名字，改走 GitHub Release + 安装脚本：

```bash
node scripts/install.mjs            # 下最新 .tgz、校验 sha256、打印要执行的两步
node scripts/install.mjs --apply    # 真的装：装包 + 把 dsh-analytics 加进 dsh.profile.bundles
```

私有仓库要 `GITHUB_TOKEN`（或 `~/.dsh/.credentials.yaml` 里的 `refs.GITHUB_TOKEN`），脚本自己去读；走代理时加 `NODE_USE_ENV_PROXY=1`（Node 的 fetch 默认不读代理变量）。发布从现在起附带 `SHA256SUMS`，脚本会在下载后自动比对。

### 面板按 SPSS 重画（紧凑版）

侧栏只有 380–520 px，所以是「按比例缩的 SPSS」：统一 12 px 字体、24 px 菜单栏（快捷键右对齐）、30 px 工具条（按下内凹、组间竖线）、**四个页签移到内容区下方**（Data Editor / Viewer 的位置）、输出大纲树 190 px、表格改三线表（外框 1 px、表头上下双线、去竖线、数值列右对齐）、对话框 520 px、状态栏 22 px。深浅色都靠原有 `--ap-*` 变量派生，没有新增只适合浅色的写死颜色。取舍与尺寸表见 [ui-spss.md](ui-spss.md)。

### 工程

测试从 19 个套件 272 条升到 20 个套件 **302 条**（新增 `test/settings.mjs` 9 条；`build` 82、`tables` 34、`regression` 31、`office` 50、`client` 含设置页渲染）。端点 42 → 43（新增 `api/settings`）。

## 0.26.5

Windows 复验 0.26.3 时抓到的 P21：**元数据不落盘**，重载后表会把「新建数据集」标成上一份文件。

- `createDataset()` 只写 `work.sav`，没写 `dataset.json`。于是 `pspp_new` 之后重启宿主，`dataset.json` 还描述着上一次打开的那个 `.csv`，恢复出来的数据集把 3 例新数据的表标成「60 例的 sixty.csv」，连 `sourceSize` 都是旧文件的 —— 来源与数据对不上，比没有来源更糟。现在 `workSav()` 写盘后同步 `rememberDataset()`，侧车文件跟着数据走；`dirty` 也一并记进去。
- 新建的数据集**重启后能回来**了：以前 `restore()` 只认 `sourcePath` 是字符串的工作区，`origin: 'new'` 的工作区一律当空面板（数据还在 `work.sav` 里，但用户看不到）。现在它也恢复，标签仍是「新建数据集（…，未保存）」。
- 保存数据（另存为）后指纹跟着走：原来 `save()` 只改 `sourcePath`/`name`，`origin` 还是 `new`、`sourceSize`/`sourceMtime` 还是 `null` 或上一份文件的。现在写完就 `stat` 目标文件，刷新 `origin: 'file'` + 真实大小与修改时间。
- 导出改成**每张表自带一行来源**（docx 小字一行、HTML 一段小字）：会话级的那段「数据来源：」保留，但它只说明这个会话碰过哪些数据，被单独拿走一张表的人需要的是那张表自己的答案。`sourceStamp()` 是新增的导出函数。xlsx 仍只有 `docProps`（Excel 里没有合适的可见位置）。

测试：`test/office.mjs` 新增「每张表带自己的来源行」，`test/smoke.mjs` 新增「侧车跟着数据走」与「新建数据集重启后回来（`origin` 仍是 new、`sourcePath` 仍是 null）」，合计 272 条 ok。

## 0.26.4

一个发版事故，只影响**从 .tgz 安装的人**（用 `link:` 装本仓库目录的不受影响）。

- **0.26.3 的安装包把工具放回了所有会话**。0.26.3 的 tarball 里 `cordis.patch.yml` 带的是 `registerTools: true` —— 也就是 0.26.0 之前的行为：`pspp_*` 23 个工具在**每一个**会话里都注册（约 6.2k token/请求），「只有选中『数据分析』预设才加载」失效。原因是复验期间为了验证逃生门，在共享目录 `Z:\work\dsh-analytics`（= 宿主 `/mnt/data`）上临时把它改成 `true`，写回时正好被一个纯文档提交（`9179056`）带上，而打包读的是工作树、不是 git 标签，于是错了的字节进了 Release。
- 三处堵住：`cordis.patch.yml` 回到 `registerTools: false`；`scripts/pack.mjs` 打包前检查工作树、打包后**再解包检查 tarball 自己的那一份**，任何一处出现 `registerTools: true` 就拒绝出包并打印原因；`test/preset.mjs` 早就断言 patch 里是 `false`，这次没拦住只是因为打包发生在测试之后——现在打包自己会拦。
- 打包脚本顺带打印 `sha256`，省掉每次手工 `sha256sum` 再抄进文档。
- 校验和：`0.26.4` 的 tgz 与 `0.26.3` 只差这一个字节级别的默认值，但必须重装才算数：`0.26.3` 的包建议直接弃用。

## 0.26.3

三件同源的事，都是「这张表的数字来自哪份数据」在离开面板之后就断了。

- **新建的数据集不再冒充文件**。`pspp_new` 建的数据集把调用方给的名字写进了 `dataset.sourcePath`，于是 `provenance` 报成 `{sourcePath: "prov-probe"}`，面板标签画成 `prov-probe · 3 例 · 1 变量` —— 看起来像个磁盘文件。现在 `createDataset()` 写 `sourcePath: null` + `origin: 'new'` + 创建时刻 `openedAt`，面板标签改成 `新建数据集（prov-probe，未保存） · 3 例 · 1 变量`，悬停说明「这份数据没有对应的磁盘文件」。拖入的副本另有 `origin: 'upload'`。
- **导出文件带上来源**。`buildDocx` / `buildXlsx` 新增 `docProps/core.xml`：`dc:subject` 写「数据来源：<路径> · N 例 · M 变量，size · 打开于 …」，`dc:description` 逐行列出来源并说明「改动数据后请重新运行分析」；Word 文档末尾还会**可见地**印一段「数据来源：」（9pt），因为没人会为了看来源去翻文件属性。HTML 导出同样在末尾追加来源块。实测：导出的 docx 用 LibreOffice 转 PDF，末页能抽出「数据来源：· /mnt/.../big.csv · 3000 例 · 3 变量，45.4 KB · 打开于 2026-11-16 12:43」。PDF 输出由 PSPP 自己渲染，本版未覆盖（见「已知限制」）。
- **来源文件有了实体指纹**。打开文件时记 `sourceSize`（字节）与 `sourceMtime`（毫秒时间戳），随 `provenance` 走出，并写进 `dataset.json` 一起挺过宿主重启。用途：同名、同例数、同变量数的另一版文件，现在能从「读入时 45.4 KB / 磁盘修改时间 2026-11-16 12:43」分辨出来。

测试：`test/office.mjs` 新增 3 条（`describeSources()` 对三种 origin 的措辞、docx 的 docProps 与正文档来源行、xlsx 的 docProps），`test/smoke.mjs` 新增 4 条真引擎断言（打开的文件 `origin/sourceSize/sourceMtime`、恢复后三者不丢、`createDataset()` 的 `origin: 'new'` 与 `sourcePath: null`），`test/client.mjs` 新增一条 jsdom 断言（新建数据集的标签不再像文件名）。合计 271 条 ok。

## 0.26.2

- **从 `work.sav` 恢复的会话不再丢 `openedAt`**：数据集指纹里的「什么时候读的这份文件」以前只活在内存里，宿主重启后 `provenance.openedAt` 变成 `null` —— 表还能说出源文件、例数、会话，却说不出是什么时候的那一份。现在 `openedAt` 写进 `dataset.json`，`restore()` 读回（`lib/workspace.js` 的 `rememberDataset()` 与恢复壳子），旧工作区读不到就仍是 `null`，不会伪造时间。
- `test/smoke.mjs` 的恢复用例补一条断言：新 `Workspace` 的 `dataset.openedAt` 必须与原来那次相同。

## 0.26.1 打包分发

- **Release `v0.26.1` 挂了 `dsh-analytics-0.26.1.tgz`（34.3 MB）**：自带 `engine/linux-x64` 与 `engine/win32-x64`，装完即可用，不需要系统装 PSPP 也不需要编译。引擎沿用 `engine-v1`，本版本没动引擎，所以没有重建（重建一次要 240 分钟 CI 额度、74 分钟墙钟）。
- **产物验证**：解包后 `pnpm add file:…` 装进临时目录，宿主半 `import('dsh-analytics')`、预设半 `import('dsh-analytics/tools')` 均解析成功，`engine/linux-x64/bin/pspp --version` 打印 `pspp (GNU PSPP) 2.1.3`；客户端半是浏览器模块（`window.__ModuleLoader__`），Node 里 import 报 `window is not defined` 属预期。`dsh --profile web --dump-config` 里能看到本包贡献的 `analytics` 与 `preset-analytics` 两行，说明 bundle 装配正确。
- **平台承诺写死**：`linux-x64`、`win32-x64` 实测；`linux-arm64`、`darwin-arm64`、`darwin-x64` 只用 CI 产物验证过，标为「未验证构建」。
- **文档**：`README.md` 与 `docs/install.md` 增加「从 Release 的 .tgz 装」的步骤与检查清单，`README.md` 的配置节补 `registerTools` 说明。

## 0.26.1

预设自检（真的在「数据分析」预设的会话里跑工具）顺手抓到一个真 bug：**保存到还不存在的文件夹会失败**。

- **`save` / `exportCsv` / `convert` 现在会先把目标文件夹建出来**：这三个入口都走 `stageOutput`，然后引擎往目标路径直接写，父目录不存在时内核报 ENOENT，被 `describeFsError` 翻成「找不到这个路径：…（检查路径是否写错）」。可路径没写错——只是那个文件夹还没建。图表导出、Office 导出、报告导出一直都有 `ensureParentDir`，只有这三条漏了，所以「另存为 `D:\新文件夹\a.sav`」这种最普通的操作会撞上。
- **测试**：`test/smoke.mjs` 用真引擎跑一遍「保存到不存在的嵌套目录 + 导出 CSV 到另一个不存在的目录」，断言文件确实写出来了。
- 顺带确认两件事不是 bug：400 字符 ASCII 长串与 240 字符中文串在「新建 → 保存 → 读回」之后逐字节一致（PSPP 的 A4000 截断只发生在用 `COMPUTE` 拼字符串那种非常规用法里）；`pspp_new` 的 `path` 参数确实会落盘。

## 0.26.0

Windows 端复验员提的结构性问题之一：**23 个 `pspp_*` 工具在装了插件的每个会话里都在**。它的原话是启动与 bundle 几乎零代价、真正的代价在请求上下文，而我这边正好是最贵的一种——每条工具定义都要进每一次请求，哪怕这个会话在聊 CSS。它的建议是「收进预设」，用户的诉求也是这个：**只有选中「数据分析」预设的会话才加载**。

- **宿主半不再注册工具**：`index.js` 只用 `ctx.provide('analytics', {registry, engine, config, version})` 把工作区注册成服务；工具注册保留在 `settings.registerTools === true` 后面当逃生门（老装法、或没装 bundle patch 的安装仍能用）。
- **新增预设半 `tools-entry.js`**（包内导出 `./tools`）：`inject = ['tools', 'analytics']`，`ctx.get('analytics')` 拿宿主半的 registry，惰性 `import('./lib/tools.js')` 后逐条 `ctx.tools.register`，卸载时逐个注销。缺宿主半时**抛错**而不是注册 0 个工具——静默的「工具没了」比报错难查。分两半的关键理由是数据：两半各建一个 registry，面板和对话就会各看一份长得一样的数据。
- **bundle patch 声明预设**：`preset-analytics`（`@deepseek-ai/dsh-agent-preset`，显示名「数据分析」，order 8），`plugins` = 一段 persona（写明「先 `pspp_status` / 先看变量字典与缺失码 / 报数字要带 provenance / PSPP 没实现的过程要明说」）+ `{id: analytics-tools, name: 'dsh-analytics/tools'}`。同时给 `analytics` 行加 `config: {registerTools: false}`。
- **实测**：本机 reload 后 `include:preset-analytics` 出现在 Loader 里（`cordis_inspect_query Config`，status `schema`），**不需要重启 dsh**；`analytics` 行的 `registerTools: false` 也随 bundle patch 热生效（日志 `[dsh-analytics] 0.26.0 routes ready (registerTools=false)`）；本会话（standard 预设）的 `Tool.listTools` 里 `pspp_` 出现 0 次——泄漏确实断了。
- **测试**：新增 `test/preset.mjs`（5 项：inject 列表、23 个工具挂在同一个 registry、缺宿主半抛错、卸载后清零、bundle patch 仍带预设与挂载行）；`test/build.mjs` 的 fake ctx 补 `provide()` 并断言宿主半确实发布了 `analytics` 服务。
- **文档**：README「Agent 工具」与 `docs/install.md` 的检查清单改成「选『数据分析』预设才出现 23 个工具」，`docs/FEATURES.md` 第 9 节补作用域说明。

## 0.25.1

Windows 端独立复验报回来的一条：**provenance 只在面板里有，工具的返回里没有**。`api/state` 的每个条目都带 `provenance`（面板标题栏据此显示 `a.sav · 60 例 · 5 变量`），但 `lib/tools.js` 的 `itemsForAgent()` 只挑 `kind/id/title/rows`（外加 `roc`/`pairwise`/`notes`）转发，`pspp_run`、`pspp_run_file`、`pspp_analyze`、`pspp_chart` 的结果里没有这个字段——模型过几轮再被问「这张表是哪份数据的」就没有依据了。现在表格与图表都把 `provenance` 一并回传；没有戳的条目也不会凭空造一个。

测试：`test/build.mjs` 新增一条用例（表格与图表的 `provenance` 逐字段相等、无戳条目不带该字段）。

## 0.25.0

三件都来自 Windows 端复验员的独立评判，按他的排序做：先说「数字是不是来自你正在看的那份数据」，再说表格本身能不能一眼认出来源。

- **面板轮询不再每次搬走全部输出矩阵**：面板每 3 秒拉一次 `api/state`，而 state 里带 `items`（每张表的完整矩阵）——3000 例的频率表约 300 KB，面板开着就是两百多 KB/s 的空转，表越大越糟。现在轮询先打 `GET api/heartbeat`（几百字节：数据集形状、变量字典摘要、输出条目数、变换开关、最近错误、撤销状态），只有签名真的变了才去拉完整 state。`signature()` 与 `state()` 共用同一套字段，签名随 state 一起返回，所以面板拿到新状态后不需要再多读一次才知道比对基准。
- **每张表、每张图都带数据集指纹**：条目新增 `provenance`（`sessionId`、`sourcePath`/`name`、`caseCount`、`varCount`、`openedAt`），在输出标题栏显示为 `a.sav · 60 例 · 5 变量` 的小标签，悬停给出完整来源路径与打开时间。同一台机器上「面板会话」和「对话会话」是两套工作区、两个同名文件可以同时存在，没有这一条，截图里的表无从追回是哪份数据。
- **导入改名的清单留在面板里**：改名的 toast 四秒就消失了，而用户往往是过一会儿才发现「我那列叫年龄，怎么变成 V1 了」。状态栏现在常驻一个「导入说明 N」按钮（`state.importNotes` 不为空时出现），打开列出每一列为什么改名、原名存在哪个变量的标签里。`api/state` 也开始返回 `importNotes`。
- **`api/run` 也回带 provenance**：`appendItems()` 打戳时会复制条目，而 `run()` 原来把打戳前的数组返回给调用方，于是面板里有来源、工具与运行结果里没有。现在两处是同一批对象。
- **轮询契约有测试钉住**：jsdom 里渲染面板，用桩 `fetch` 记录请求——挂载时只读一次完整 state，之后每 3 秒只打 `api/heartbeat`；把桩的签名改掉，下一次轮询才拉完整 state。这条防的正是「改成心跳后不再自动刷新」和「签名永远不等、每 3 秒全量拉一次」两种回归。
- **面板里的来源标签也有渲染测试**：`test/client.mjs` 用 jsdom 渲染一份带 provenance 与 importNotes 的状态，断言输出条目出现 `a.sav · 5 例 · 1 变量` 的标签、悬停带完整路径、状态栏有「导入说明 1」且点开列出改名原因。
- 文档订正：CSV 类型判定改成整列扫描 + 多数决之后，FEATURES 里还写着「前 200 个样本」；端点 41→42、测试项数按实际重数。

## 0.24.9

Windows 端验收（独立机器、独立复验员）在功能项全 PASS 之后报了两条「文案错、路径漏」的问题，都在文件被别的程序占用时触发：

- **打不开被占用的数据文件时，把引擎原文和内部路径甩给用户**：`.sav` 正被 Excel 或另一个会话打开时，`open()` 报的是 `cannot read a.sav: error: An error occurred while opening …: Permission denied. | C:\…\runs\1\run.sps:2: error: Stopping syntax file processing…`——里面既有引擎英文原文，又有插件自己临时目录里的 `run.sps`。现在统一走 `describeEngineError()`：识别到 `Permission denied` 就说「打不开 a.sav：文件正被其他程序占用（Excel/Word/另一个 DSH 会话），或者没有读权限。关掉占用它的程序再试」，并把这些行整条丢弃（`runs\<n>\run.sps`、`Stopping syntax file processing`）。读字典、读数据、保存、导出四条引擎调用路径都换成了同一套说法。
- **保存到被占用的文件被误判成权限问题**：Windows 把「文件被独占」报成 `EPERM`/`EACCES`，原来一律翻成「目录是只读的，或者属于另一个用户」，于是用户去查权限而真正的原因是文件开着。现在这句话补上第三种可能并点名场景：「目录是只读的、属于另一个用户，或者文件正被其他程序占用（Windows 上被 Excel/Word 打开会报这个错）。关掉占用它的程序再试」；另外单独认 `EBUSY`。
- **底层错误不再以英文前缀出现**：`DISPLAY DICTIONARY failed:`、`reading cases failed:`、`saving dataset failed:`、`export failed:` 换成中文的一句话，并带上用户自己的文件名而不是暂存目录。

测试：`test/build.mjs` 新增一条用例，钉住「引擎 stderr 里的 Permission denied 被翻成占用文案」「`run.sps` 与 `Stopping syntax` 不出现」「真正的内容错误仍保留引擎原话」「stderr 为空时说明引擎没给原因」。

## 0.24.8

字符串变量的 THRU 区间：PSPP 2.1.3 直接拒绝 `MISSING VALUES code ('AA' THRU 'ZZ')`（`Syntax error expecting string`），所以这种声明根本写不进 `.sav`。此前的做法是序列化成空字符串——保存「成功」，区间不见了。

- **保存改成明确报错**：`writeSav()` 在写任何东西之前检查字符串变量上的区间，报「字符串变量 code 的缺失值里有区间（THRU）：PSPP 只支持字符串用单个码…请把区间换成单独的码，或把该变量改成数值变量」。不静默，也不写出半截声明。
- **这类区间仍然参与统计**：`isUserMissing()` 对字符串区间按字典序比较（`AA THRU ZZ` 命中 `MM`），所以从 SPSS 文件或 API 带进来的区间不会让表格与图表的缺失口径分叉。
- **变量视图不再把它改写成两个码**：`AA THRU ZZ` 原样显示、原样解析回 `{ lo, hi, text: true }`，失焦不再提交破坏性改动。

## 0.24.7

同一族的最后两处，都是「THRU 区间」在用户手里悄悄消失：

- **保存 .sav 时 `MISSING VALUES age (90 THRU 99).` 变成空声明**：`lib/dataset.js` 的 `literal()` 只认同标量，区间被序列化成空字符串，写出来是 `MISSING VALUES age ().`。PSPP 接受这一行、读回来是「没有缺失码」，全程不报错。现在区间写成 `90 THRU 99`（字符串变量写成 `'a' THRU 'b'`）。
- **读回字典时区间又被丢掉**：PSPP 的 `DISPLAY DICTIONARY` 用**分号**分隔多个缺失码（`90 THRU 99; 999`），而 `parseMissingValues()` 只按逗号切分，于是高界变成 `99; 999`、`Number()` 得 NaN，整条声明被丢弃。现在逗号与分号都认。
- **变量视图的「缺失」输入框会把区间清空**：`defaultValue` 用 `variable.missing.join(' ')`，区间显示成 `[object Object]`；失焦时 `Number("[object Object]")` 为 NaN 被过滤，提交 `missing: []`——点进去再离开就把区间删了。现在显示为 `90 THRU 99 999`、解析认 `THRU`/逗号/空格，且值没变就不提交。

## 0.24.6

清洗器的最后一个绕过：**数字实体可以不带分号**。HTML 在属性值里允许 `&#58`、`&#x3a` 后直接跟字母，Chromium 照样解成冒号，于是 `javascript&#58alert(1)`、`javascript&#58 alert(1)`、`javascript&#x3a alert(1)` 都能穿过允许列表（解码后没出现字面冒号，被当成相对路径）。`decodeEntities()` 现在对数字实体接受可选分号；命名实体仍要求分号（浏览器也只认可这一小撮历史实体可省略）。

## 0.24.5

第四轮复验又找出同一族里的最后一处：`lib/mrsets.js` 的 `crosstab()` 还在用自己的 `groupMissing()`，只认数组与标量，`MISSING VALUES g (7 THRU 9)` 里的 8 照样成一个组（表头多一列「丙」、总计 3 而不是 2）。现在改成共用 `isUserMissing()`，并加用例钉住。

## 0.24.4

第三位复验员对 0.24.2 的生命周期六项给出全部 PASS（81 条断言，含独立进程恢复、120k 例九档时间偏移），另报两处收尾问题。

- **已释放的工作区对象实际上永远不会从 registry 删除**：`evictIdle()` 里 `if (workspace.dataset.evicted === true) continue` 把「空闲超过四倍窗口就从 map 删除」这段挡在后面——真实调用序列里每来一个请求就调一次 `evictIdle()`，窗口一到先释放（`evicted = true`），此后再空闲多久都不会被走过删除分支。等于只有「同一次调用里既释放又超窗」这一种罕见情况才会回收对象。现在已释放的对象单独判空闲，超四倍窗口就删（文件保留，下次请求重建并从磁盘恢复）。
- **xlsx 谎报解压大小时抛出 Node 原文**：文件头写 1 KB、实际解出 65 MB 的文件会被 `maxOutputLength` 挡住，但报的是 `Cannot create a Buffer larger than 67108864 bytes`。现在与其他拒绝文案一致：「…解压后超过上限 64 MB，拒绝读取（文件头写的解压大小与实际不符）」。

## 0.24.3

0.24.2 之后又一组独立复验（统计口径 / 导出与光栅化 / 已部署实例的 HTTP 行为）挖出来的问题。0.24.2 有两处「以为修好了其实没生效」。

### 会算错数

- **箱线图 Tukey 铰链在奇数个案时算错**：`lib/charts.js` 用 `Math.floor(count / 2)` 切两半，奇数时把中位数从两半里都排除了。1..5 得 1.5/4.5，而 SPSS 与 PSPP `EXAMINE /PLOT=BOXPLOT` 的 Tukey's Hinges 是 **2.00/4.00**（中位数同属两半）；1..7 应为 2.50/4.00/5.50，1..9 为 3/5/7。0.24.2 的测试只钉了 1..8（偶数），所以没抓到。
- **图表路径的 Welch t 没同步相对容差**：0.24.2 只改了 `lib/tables.js`，`lib/charts.js` 的 `welchTest` 仍是 `if (se === 0)`——三个 0.1 的浮点残差让 t 算出 1.41、p=.29（同一数据在表里是 t=0、p=1），两个不同的常数则被报成「无差异」。显著性括号吃的是同一条错值。
- **多选题总计行的「个案百分比」不是上面各行之和**：`lib/mrsets.js` 用 `respondents / cases`，三行加起来 133% 时总计印 67%。改为 `responses / cases`。
- **多选题的缺失值判定不再自带副本**：`lib/mrsets.js` 里的私有 `missing()` 已删，改用 `lib/missing.js` 的 `isUserMissing`——两套定义迟早会分叉（0.24.1 就分叉过一次）。

### 导出与光栅化

- **PNG 里的椭圆是空白**：`lib/raster.js` 的 `parseSvg()` 元素正则漏了 `ellipse`，0.24.2 新加的 ellipse 分支是死代码，整张图画不出东西。已补进正则。
- **`javascript&colon;` 一类 HTML5 命名实体能穿过清洗器**：`decodeEntities()` 只认 7 个实体名，而浏览器会解出 `javascript:` / `java\tscript:`。清洗器现在改成**允许列表**：只留 `http(s)`、`mailto`、`tel`、片段、相对路径，其余 scheme 一律去掉，并补上 `colon`/`Tab`/`NewLine`/`sol` 等命名实体。
- **PDF/ODT 的表注会描述文档里没有的表**：`exportDocument()` 重放的是最后一次运行的语法，而表注遍历的是全部输出条目。现在表注只取该次运行的条目。
- **空输出也能导出 PDF/ODT**：一行注释也能得到一个 874 字节的空 PDF。现在没有表也没有图时报「这次输出里没有表格也没有图…」，与 `.spv` 的防线一致。

### 静默成功与文案

- **`api/output` 删除不存在的 id 返回 200**：现在报「输出里没有这一项」。
- **`api/upload` 接受非法 base64**：`Buffer.from` 会忽略字母表外的字符，`!!!notbase64!!!` 曾落盘 6 字节垃圾并报成功。现在校验 base64 字符集与长度，报「上传的数据不是有效的 base64」。
- **几条文件错误绕过中文包装**：`api/dir` 列不存在的目录曾抛 `ENOENT: no such file or directory, scandir …`，`api/merge` 同；现在都走 `describeFsError()`。`api/convert` 的失败信息不再带出引擎安装路径。

### 文档与测试

- 测试总数改为实测 255 项，`mrsets` 14、`build` 77；「七种图表模型」改为八种（`computeArea`/`computeDualLine` 也在）。新增用例：奇数个案铰链、图表/表格 Welch 一致、多选题总计行、椭圆像素、命名实体与允许列表。

## 0.24.2

四个独立复验员（数据正确性 / 安全与文件 IO / 并发与磁盘 / 导出与文档）各自跑脚本核对 0.24.1，这份版本修的是他们挖出来的问题。其中两条是我们在 0.24.1 自己引入的回归。

### 会丢数据

- **`restore()` 在 0.24.1 被改坏（复验员 C）**：为了让读者看不到「没有 rows 的数据集」，`restore()` 改成先造壳子再 `reloadFromWork(shell)`，而 `reloadFromWork` 第一句 `await this.workSav()` 要求 `this.dataset` 已存在，于是抛 `no dataset is open` 被 catch 吞掉、返回 null。结果是宿主重启后所有绑定过数据文件的会话打开是空面板，工作区里 `work.sav` 明明还在。现在 `reloadFromWork(base, { flush })`：恢复路径不写回工作文件，只读；`test/smoke.mjs` 的恢复用例从 `console.log` 改成真断言（它此前一直在打印 `restored dataset: undefined false` 并照样退出 0）。
- **`release()` 不看 `busyDepth`，能把正在跑的分析的数据截短（复验员 C）**：`ensure()` 每个请求都调 `evictIdle()`，于是一次 persist 分析跑到一半就被释放，`release()` 自己再起一个 pspp 写同一个 `work.sav`（不是临时文件 + rename，是直接覆盖），实测 120001 例被写成 30768 例。现在 `release()` 在 `busyDepth > 0` 或 mutex 忙时直接返回 `false`，并整体包进 mutex。
- **`clearOutput()` 把运行中的 `runs/<n>` 删掉（复验员 C）**：随后引擎报 `error opening output file …/runs/3/output.err`。现在运行中抛「正在运行分析或载入数据，现在不能清除输出：等这次运行结束再清」。
- **`save(force: true)` 的逃生门是假的（复验员 C）**：提示叫调用方加 `force`，可 `workSav()` 里同一道截断检查又拦一次。现在 `force` 一路传到 `workSav({ force })`。
- **xlsx 解压上限读错了字段（复验员 B）**：`lib/xlsx.js` 取的是压缩后大小（local header +20），解压后大小在 +24，于是 71 KB 的工作簿解出 80–200 MB 也照读。现在读 +24 并给 `inflateRawSync` 加 `maxOutputLength`，超限抛「工作簿里的 X 解压后是 N MB，超过上限 64 MB，拒绝读取」。

### 会算错数

- **图上均数不排除用户缺失值（复验员 A）**：表格按 `MISSING VALUES` 排除了 999，柱状图却把 999 当数据点（同一份数据表里 42、图里 360）。缺失值与测量级别的判定抽到 `lib/missing.js`，表格、图表、共线性诊断共用同一套：`variableValue()`、`collinearityTable()` 都先过 `isUserMissing()`。
- **多选题的区间缺失码被当成答案（复验员 A）**：`tabulate()` 的 `missing()` 只认数字与数组，`MISSING VALUES x (1 THRU 5)`（字典给的是 `{lo, hi}`）里的码被算成真实类别，个案百分比可以超过 100%。现在认 `{lo, hi}` 与字符串码，固定类别域也一样过滤。
- **零方差比较用均值是否相等判定（复验员 A）**：`welch()`/`anova()` 用 `mean(a) === mean(b)` 判「两组完全一样」，浮点误差下 0.1×3 与 0.1×2 会算出 t=1.41、p=.29。现在用相对容差（`se <= 1e-12 × 离散度`、`ssWithin <= 1e-12 × 均值平方 × n`）。
- **箱线图四分位改用 Tukey 铰链**：见 0.24.1 那条订正。

### 导出与图表

- **PNG 里的圆全是方块（复验员 D）**：`lib/raster.js` 用 `fillRect` 画 `<circle>`——单切片饼图变方块、折线图节点（白填充 + 彩描边）变白方块且描边根本没画（白底上节点消失）、散点标记忽略透明度。现在逐行填圆 + 72 段描边，并补了 `<ellipse>` 分支。

### 安全

- **`sanitizeTableHtml` 有实体编码绕过（复验员 B）**：`javascript&#58;`、`javas&#99;ript:`、`java\tscript:`、`<span/onclick=1>` 都能通过。现在先按实体解码再判 scheme，并去掉标签里任何 `on*` 属性（含自闭合斜杠后的）。
- **`api/dir` 的允许根重复列出**：`[...new Set(...)]` 去重。

### 文档与测试

- **测试数字全是旧的（复验员 D）**：README 端点清单补 `api/chart/update`、`api/chart/export`、`api/report`（41 条）；FEATURES 的各套件条数改成实测值（合计 237），「六种图表模型」改为七种。
- **`test/office.mjs` 最后一条检查没 await**：失败会打印在汇总之后。现在补上。
- 新增用例：恢复路径真断言、运行中禁止 release/clearOutput、`force` 打通、共线性排除缺失码、图表排除缺失码、多选题区间码、xlsx 解压上限、清洗器实体编码。

## 0.24.1

0.24.0 的「仍然没修」清单逐条处理。除了 PNG 图上不画文字（此前按用户意见搁置，不是缺陷）之外，全部落地。

### 数据安全与并发

- **运行期间的面板编辑会被引擎覆盖**：`setCell`/`setCells`/`appendCase`/`insertCase`/`deleteCase`/`sortCases`/`addVariable`/`deleteVariable`/`moveVariable`/`updateVariable`/`setValueLabels`/`replace`/`undo`/`redo` 这些改动在 `runSyntax()` 或 `open()` 运行期间落到内存里，随后被工作文件的读回覆盖。现在 `runSyntax()`/`open()` 期间 `busyDepth > 0`，上面每个方法先过 `assertEditable()` 并报「正在运行分析或载入数据，现在不能改：等这次运行结束再编辑（输出视图里能看到进度）」。没有用 mutex 串行化编辑：那会改掉这些方法的同步签名，也会和既有面板的交互冲突；把静默丢失换成显式拒绝更符合直觉。
- **`restore()` 在 `await` 之前就把半成品挂到 `this.dataset`**：并发请求会看到没有 `rows` 的数据集并抛错。现在 `restore()` 只构造壳子，`reloadFromWork(base)` 读完再一次性赋给 `this.dataset`。
- **`init()` 每次调用都重跑一遍 mkdir 与 restore**：现在共享一次 `initPromise`；`hydrate()` 也单飞（两个请求同时撞到已回收的工作区时只读一次盘），`evicted` 的会话仍会重新水化。
- **截断的数据集会把自己写短**：面板只载入前 20 万个案，任何一次编辑触发的 `workSav()` 都会把工作文件重写成这个子集。现在 `workSav()` 在 `dataset.truncated === true` 时直接拒绝并说明怎么保住全部数据。

### 磁盘与内存

- **`runs/<n>` 只增不减**：每次运行的 HTML/CSV/SVG/`chart.json` 都留在工作区里，长会话能把磁盘写满。`clearOutput()` 现在删除 `runs/` 下全部子目录并返回 `removedRuns`（工作文件在根目录，不受影响）。
- **registry 里的 Workspace 对象永不回收**：空闲回收只清行，对象本身一直挂在 map 上。现在 `evictIdle()` 在释放成功后，若该会话空闲已超过窗口的四倍，就把对象也从 map 里删掉（文件保留，下次请求新建对象并从磁盘恢复）。
- **`defineMrSet` 持有 `dataset.rows` 引用**：多选题定义过之后，即使空闲回收清空了行数组，引用还活着，回收等于没做。现在定义里只存变量与计数值，表格本来就从 `work.sav` 重读。

### 前端交互

- **关闭未保存的数据集不问一声**：菜单「关闭数据集」与页签的关闭按钮都是直接关。现在 `dirty` 时弹确认框（正文说明未保存改动会丢），`switchDoc` 会把当前页签的 `dirty` 记下来供页签按钮判断。
- **面板级 Ctrl+F / Ctrl+Z 劫持整个页面**：面板在后台页签、或焦点在可编辑区域时仍会接管快捷键。现在只有面板可见且焦点不在 `contenteditable` 里才处理。
- **`api()` 没有超时**：宿主忙住时面板永远转圈。现在 180 秒超时并报「请求超时（180 秒没有回复）：宿主可能正忙，稍后再试」。
- **`loadMore` 没有在途锁**：快速滚动会重复请求同一页并把重复行追加进去。现在有在途锁，并且已经到底就不再请求。

### 图表与导出

- **docx 数据行的 `w:tcBorders` 落在 `</w:p>` 之后**：不合 OOXML 顺序，Word 打开可能提示修复、框线丢失。现在每个单元格只有一个 `<w:tcPr>`，框线在属性里，`<w:p>` 在其后。
- **图上显著性括号用未校正 P**：同一对组在图上标 `*`、在表格里是 `ns`（表格默认 Bonferroni）。现在图上也是校正后的 P（`min(1, p × 比较次数)`），原始 P 仍保留在 `pRaw`。
- **xlsx 只认双引号属性、缺 `r` 的单元格整行挤到第一列**：手写或工具生成的工作簿里 `r='A1'`、整行省略 `r=` 都合法，前者读不出值、后者列错位。现在两种都支持。
- **列类型只按前 200 行判断**：第 201 行的 `n/a` 会被静默当成缺失，超过 200 行的长文本会把列宽截短。现在全列扫描决定类型与列宽；数值列里夹着的非数字格子按缺失处理并计数写进导入提示，文本列里夹着的少量数字不会把整列变成数值（按多数决）。
- **`api/dir` 可以列任意目录**：同源页面能借它把整台机器的目录名与文件大小走一遍。现在只允许家目录、当前工作目录、`/tmp`、`/mnt`、`/media`、`/data`（可用配置项 `listRoots` 覆盖），越界返回 400 并列出允许的根；要打开别处的文件仍可在路径框里直接输入完整路径。

### 测试

- **`test/order.mjs` / `test/build.mjs` 的异步检查从未被统计**：`check()` 收集的 promise 在打印汇总之后才完成，于是 `0 passed, 0 failed` 也能退出 0。现在汇总前 `await Promise.all(pending)`。
- 新增用例：运行期间编辑被拒、截断数据集拒绝写回、关闭未保存数据集要先确认、docx 单元格属性在 `tcPr` 内、xlsx 单引号属性与缺省 `r`、箱线图四分位与 PSPP 同口径。
- **箱线图四分位的口径在 0.24.2 改为 Tukey hinges**：`FREQUENCIES /PERCENTILES` 对 1..8 印的是 2.75 / 4.5 / 6.25，但 SPSS 的箱线图与 PSPP 的 `EXAMINE /PLOT=BOXPLOT` 用的是 Tukey 铰链 2.5 / 4.5 / 6.5；箱线图应当和箱线图一致，所以不是「四分位数字对不上」，而是两套定义里选错了那一套。

## 0.24.0

一份独立体检（4 条 P0、18 条 P1、20 条 P2、10 条 P3）逐条核对后的修复。**先修会算错数、会丢数据、会被同源页面利用的三类**，其余按证据分档记录在下面。

### 会算错数

- **用户缺失值被当成有效数据（P0）**：`MISSING VALUES age (999)` 里的 999 原来会进入表 1／表 2／两两比较／偏相关／共线性的每一个统计量。8 个个案、两组各一个 999 时，`age` 的均数从 PSPP 的 45 变成 281.6、P 从显著变成 .992，而且没有任何提示。现在 `rawValue()`／`numericCell()` 统一按变量定义判缺失，支持单值、`{lo, hi}` 区间与字符串码，被排除的例数写进表注。
- **`MISSING VALUES` 的解析本来就是错的**：`1 THRU 5` 被切成 `[1, 5]`（1.5 反而有效）、`1; 5` 丢掉第一个、字符串缺失值带着 PSPP 打印的引号和补位空格。现在按 `THRU`、逗号分段并去掉引号。
- **数值编码的名义变量被当连续变量（P1）**：性别 1/2、学历 1–5、Likert 1–5 在表 1 里输出成 `1.50 ± 0.53, P=1.000`。现在测量级别是 nominal／ordinal 或带值标签的数值变量按 n(%) 呈现并跑卡方，`Cramér's V` 照旧。
- **两组方差都为 0 时判成「无差异」（P1）**：Welch 的 `se === 0` 分支直接返回 `t=0, p=1`，完全分离被读成没有差异。现在均值相同才返回 p=1，均值不同返回「没有检验」；单因素 ANOVA 的 `ssWithin === 0` 改成同一口径。
- **分类变量的百分比分母含缺失（P1）**：列合计不到 100%。现在分母是该组里**这个变量有有效值**的个案数，缺失不进分母。
- **多选题「个案百分比」分母用总行数（P1）**：整套变量全缺失的个案抬高了分母，每一格都系统性偏低。现在分母是「在这套变量上至少有一个非缺失值」的个案数，全零回答的个案仍然算有效个案。

### 会丢数据

- **引号里的换行把数据切坏（P0）**：字符串里带 `\n`（多行地址、开放题、往单元格粘多行文本），存盘走 CSV 时 PSPP 的 TXT 读入把一行拆成两行——实测 3 个个案存盘后变成 4 个，值错位。现在写盘前把 `\r`/`\n` 压成空格并计入保存提示。
- **超大文件保存会截短**：面板只载入前 20 万个案，保存时却把这份子集写回原文件。现在数据集被截断时拒绝保存并说明怎么保住全部数据（`force: true` 才强制）。
- **类型只按前 200 行判断**：第 201 行的 `n/a` 静默变成缺失。现在统计被丢弃的格子数并写进导入提示；同样地，超过列宽的字符串在存盘时会被截断，也记进提示。

### 安全边界（同源）

- **任意路径写文本（P0）**：`api/writeText`／`api/saveSyntax` 原来什么路径都写，还能 `mkdir -p`。现在只允许 `.sps .txt .csv .tsv .html .htm .md .json .labels .log`，并且拒绝点开头的隐藏文件（`~/.bashrc`、profile patch 这类不再是可写目标）。
- **任意路径读文件（P0）**：`api/readFile` 只检查大小，`/dev/zero` 的 `size` 是 0，一个请求就能把宿主内存读爆；`~/.dsh/.credentials.yaml` 也能整份回显。现在要求是普通文件（设备与 FIFO 直接拒绝）、限 4 MB、限文本扩展名。
- **没有鉴权连接时全放行**：`connection` 为空时 `authorize()` 返回 undefined，等于整条 API 开门。现在失败即拒绝。
- **会话名拼路径**：`sessionId` 来自查询串却直接 `join(root, id)`，`?sessionId=../escape` 能在根外建目录。现在清洗成文件名允许的字符。
- **导出时把任意文件塞进文档**：`loadOutputImages()` 用正则从 artifactUrl 抠 `runId`/`name` 再拼路径。现在要求 `runId` 全数字、文件名只含 `[A-Za-z0-9._-]`。
- **xlsx 解压炸弹**：408 KB 的工作簿能解出 419 MB 文本、峰值 2 GB 内存（插件与 DSH 同进程）。现在单条目解压上限 64 MB。
- **`sanitizeTableHtml()` 漏网**：只剥带引号的 `on*`，`<svg onload=alert(1)>`、`javascript:` 链接、`iframe` 都会进 `dangerouslySetInnerHTML`。现在整段剥掉 script/iframe/object/embed/svg/math/style 等标签与内容，无引号事件属性、`javascript:`/`vbscript:`/`data:` URL 一并清掉。

### 静默失败改成明说

- **退出码 0、零张表**：PSPP 有些拒绝只写 warning（Cochran's Q 三个取值时 `More than two values encountered`），原来返回空数组，读起来像「没有显著结果」。现在带 warning 或超时的空运行会报错并引用引擎原话；纯数据步（`COMPUTE`/`SORT`）仍然允许没有表。
- **超时**：`result.timedOut` 算出来没人用，用户只看到「没有退出码」。现在消息里明确写超时。
- **语法生成**：`glm` 带协变量会生成 PSPP 明确拒绝的 `WITH` 子句（退出码 1、零张表），现在直接说明做不了 ANCOVA；`npar_kruskal` 三组以上生成 `(1 2 3)` 是语法错，现在按范围写并说明；配对 t 检验奇数个变量原来静默丢掉最后一个，现在报错；事后比较里 Gabriel/Duncan 这类名字原来整段消失，现在报错并列出可用方法。
- **读数据不锁 locale**：`readData()` 没传 `LC_ALL=C`，德语等 locale 下 PSPP 写 `1,5` 会被解析成两列，数据静默损坏。现在与 open/export 一致。
- **编码与分隔符**：`decodeText()` 认 UTF-8/UTF-16LE/BE 的 BOM（原来 UTF-16 被当 GB18030 解成乱码）；`guessDelimiter()` 跳过引号内的分隔符（表头里带逗号的欧洲分号 CSV 不再被导成单列）。

### 图表与 Excel

- **分类轴按字符串排序**：`1..12` 被排成 `1,10,11,12,2,3`，画出不存在的趋势。现在两边都是数字时按数值比较。
- **刻度循环在 1e17 量级不前进**：`value += step` 被浮点吸收，实测卡住 3–5 秒、内存 1.9 GB 后抛 `RangeError`。现在检测不前进与刻度上限。
- **单类别饼图是空白**：起止点重合的整圆按 SVG 规范被忽略。现在画圆（环形则画双向弧）。
- **Excel 里 `.50`／`-.23` 被当文本**：p 值与标准差列不能排序求和。现在未带前导零的小数和科学计数法也是数值单元格。
- **HTML 导出的标题不转义**：`item.title`／`alt` 直接拼进文件，注释却转义了。现在一致。

### 工程

- **CI 只跑 4 个套件**：`order/raster/office/xlsx/ods/dta/stage/mrsets/regression/tables/messages` 十一个引擎无关的套件从没在 CI 里跑过，`smoke`/`routes` 一次也没有。现在 unit job 跑全部引擎无关套件并加 **Node 24**；下载引擎的 job 除了 PDF 表注，还跑 `smoke` 与 `routes`。
- **文档数字**：README 的「12 个 agent 工具」与 HTTP 路由清单（15 条）改成实际的 23 个工具、38 个端点；`docs/FEATURES.md` 的版本戳从 0.23.6 更新到本版。
- **根目录残留旧包**：`dsh-analytics-pspp-0.2.0-*.tgz`（16.8 MB）已移到备份目录，不再被当成发行物。

### 当时没修的部分

这批剩下的条目（运行期编辑、`runs/` 只增不减、关闭不确认、`api()` 无超时、docx 框线顺序、图上显著性未校正、xlsx 缺省 `r`、`api/dir` 可列任意目录等）已在紧接着的 **0.24.1** 里处理，逐条见文件开头那段。PNG 图上不画文字是按用户意见搁置的设计选择，不是缺陷。

## 0.23.34

Windows 对 0.23.33 的复核又提了一条（P20）和三条改进建议，都在这一版里：

- **P20 常数变量的表注重复三次**：同一个常数预测变量既会从自己那一行（`projectionFit` 返回 null）产生一条注，又会从它跟其余每个变量组成的每一对里各产生一条，于是三预测变量的模型里同一句话出现三次。改为按变量名去重（`constantSeen` 集合 + `noteConstant()`），一个常数变量一条注。回归测试从 19 项加到 20 项，并且断言 `notes.filter(n => n.includes('是常数')).length === 1`，另加「两个常数变量恰好两条注」。
- **隐藏数据页的缺失格不再写空单元格**：原来缺失值写成一个空的 `inlineStr` 单元格，Excel 里看着是空白，但 `COUNTA` 把 `""` 算成有值，于是「这列有多少个有效值」比表里的 N 大。现在 `sheetXml()` 支持 `omitEmptyCells`，数据页整格不写。`test/office.mjs` 断言缺失格没有 `<c>`、相邻格照常写入、单元格总数正好等于「表头 + 非缺失值」。
- **`evictIdle({ skip })`**：`ensure()` 在把工作区交给调用方之前会先回收空闲会话，原来会把这个会话自己也回收一遍——5 万例数据要多付一次 1.2 秒写盘加 1.3 秒读回。现在 `ensure()` 把要用的 key 传进去，`evictIdle` 跳过它。`test/smoke.mjs` 增加对应断言。
- **父路径里那个「文件」现在会被点名**：`ensureParentDir()` 遇到 `ENOTDIR`/`EEXIST` 时不再只说「上级路径里有一段是文件」，而是从根往下逐段 `stat` 出第一个不是文件夹的段并写进消息：`写不进去：/tmp/blocker.csv 是一个文件，不能当作文件夹用（/tmp/blocker.csv/deep 这段路径要经过它）；把路径换到别处，或者先给它改名`。`test/routes.mjs` 增加一条 400 用例断言文件名出现在消息里。

## 0.23.33

Windows 复核（0.23.30 / 0.23.31）提出两条，都是会给出错误结论的问题：

- **P18 缺失值变成 0（会算错）**：PSPP 导出 CSV 时把系统缺失写成**一个空格**，`readData()` 先用原串判空再 `trim()`，于是 `' '` 躲过判空、`Number('') === 0` 把每个缺失值读成真正的 0。影响保存后重开、`persist` 运行后的全部数据（面板、隐藏数据页、`pspp_data`、后续所有分析）。现在先 `trim()` 再判空。`test/smoke.mjs` 增加「缺失值往返」用例：建含缺失的数据集 → 存盘 → 重开 → `persist` 运行，三步都要求 `[[1,null],[2,3],[null,5]]`。
- **P19 共线表把可估变量也标成 0/∞**：`collinearityTable()` 原来用正规方程求 1 − R²，其余预测变量本身共线时方程奇异，就把每一个预测变量都打成 `0.000` / `∞`。改用「投影到列空间」求 R²（带重正交化的 MGS，秩亏时自动退化成列空间基），于是 `a`、`b` 完全相同时 `c` 的容忍度恢复为真实值 0.772 / VIF 1.295；只有**本变量落在其余变量的张成里**（残差相对范数 ≤ 1e-9）才写 `0.000`/`∞`。常数列改为「—」并单独给注，不写 0。
- 回归测试 19 项（新增「共线块之外的变量保住自己的容忍度」「常数列是未定义而不是 0」）。

## 0.23.32

发布前的隐私审计：文档与截图里不该带出本机的目录结构和个人痕迹。功能没有变化。

- **截图只保留面板**：`docs/screenshots/` 下 23 张原来都是整窗截图，左侧还带着 DSH 的会话栏与输入框。现在统一裁到面板区域（左边界 436 px），只留插件自己的界面。
- **路径中性化**：`docs/CHANGELOG.md` 里原先直接写出的本机目录换成 `/data/…`；「保存不再留下临时文件」那条里的示例文件名换成 `<数据文件>`。
- **硬件描述弱化**：性能基线里不再写具体盘位，改成「测试机（Fedora 44 x86-64、32 GB 内存）」。
- 仓库里保留的机器相关字样只剩两类必需项：`package.json` 的仓库地址（GitHub 账号即发布者身份）与 git 提交者信息。

## 0.23.31

打包前的最后一轮打磨，全部是「不会报错但会误导」的问题：

- **写文件时的路径错误说人话了**：`mkdir` 原来在 `try` 外面，父路径是文件时报的是 Node 的 `EEXIST`，而 `fserr` 又没有 EEXIST 分支，于是它落到 `error.message` 上，用户看到的是「EEXIST: file already exists, mkdir '/x/a.csv'」这种没法行动的话。现在所有「写到用户指定路径」的地方（导出 Word/Excel、图表 PNG/SVG、单表 CSV、PDF/ODT、报告卡、语法文件）都走同一个 `ensureParentDir()`：父路径是文件就直说「`/x/a.csv` 是一个文件，不能当作文件夹用；要保存到它旁边，把路径改成 `/x/` 下的另一个名字」；`fserr` 也补了 EEXIST / ENOTEMPTY 两种码。
- **共线性表的表注会点名是哪两个变量撞了**：两个预测变量互为镜像时，正则方程奇异，原来每一行都写「这一个预测变量与其余变量完全共线」——把「其余变量之间共线」说成是这一行的问题，用户会删错变量。现在容忍度照实写 `0.000` / `∞`（奇异就是 0，不是「算不出」），并单独加一条表注「A 与 B 完全相关（r = 1.000），两者的容忍度都会是 0：先删掉其中一个」；某列是常数时也会点名。求解器的主元阈值同时从绝对值 `1e-12` 改成相对阈值，1e6 量级的良态方程不会再被误判成奇异。
- **系数表里的 NaN / +Infinit 有表注了**：完全共线或常数预测变量会让引擎在 B、S.E.、t、Sig. 里打印 `NaN` / `+Infinit`，表看起来是完整的，数字会被当成结论抄进报告。现在这类表会追加一条表注说明这几行不能用、先看共线性诊断或去掉多余变量（同一张表不会重复堆同一条注）。
- **两两/偏相关矩阵里 |r| = 1 现在有星号**：`t` 在 |r| = 1 时是无穷，`studentP()` 拒绝无穷并返回 null，星号于是空着，`1.000` 看起来像「不显著」。改成 |r| ≥ 1 时 p 直接取 0，矩阵与逐对表都标 `***`。
- **回传给模型的表格最多 200 行**：把连续变量放进频率表能产生 4135 行的表，整张回传会吃掉调用方的上下文。`itemsForAgent()` 现在只回前 200 行并附 `truncated: { rows, shown, hint }`；面板与导出文件仍是完整表格。
- **Word/Excel 的跨表公式按 run 对齐**（P10）：同一份报告里跑两次同一个模型，两张表都叫「ANOVA (score)」，交叉引用原来只按标题里的变量名配对，第二次运行的系数表会去读第一次运行的自由度——p 值静默变了。现在键改成「标题里的主语 + runId」，两次运行各自指向自己的 ANOVA 表。
- 测试：build 72 项（表截断、EEXIST/ENOTDIR 文案）、regression 17 项（共线点名、NaN 表注、重复调用不堆注）、tables 23 项（|r| = 1 的星号）、office 44 项（两次运行各读自己的 ANOVA 表）。
- 版本号 0.23.31。

## 0.23.30

Windows 侧复核 0.23.29 挑出的问题，逐条修：

- **会话回收会丢数据（P17）**：0.23.28 的 `evictIdle()` 直接 `close()` 掉数据集，再 `ensure()` 时 `restore()` 因为 `dataset.json` 已被删而返回 null——文档说的「下次请求自动重开」不成立，未保存的改动也会丢。改成 `Workspace.release()`：先把脏数据写进 `work.sav`，再只释放个案行，变量/标签/值标签/多选题集合留在内存，撤销栈清空，会话仍然开着；下一次请求 `hydrate()` 从 `work.sav` 读回行，分析可以照常跑。`evictIdle()` 变 async，`ensure()` 里 `await`。`close()` 也改成 `await rememberDataset()`（原来是 `void`，删除与写入可能互相覆盖）。
- **转置会静默丢字符串列**：`FLIP` 只保留数值列，字符串列变成缺失值、变量名变 `VAR000…` 并多出 `CASE_LBL`。`Workspace.flip()` 现在遇到字符串变量直接报错并列出会丢的列，`api/flip` 需要 `force: true`；面板弹「转置数据」确认框，勾「我明白」才能继续。
- **`test/smoke.mjs` 在 Windows 上必挂**：`dropped.path.split('/').pop()` 切不开 `C:\…`，改用 `basename()`；顺带把全部路径输出也换成 `basename`。
- 文档按复核结果订正：13.2 的 TOL 行分 Linux（表仍完整）/ Windows（0 张表）两种情况写；13.3 补 `MEANS` 没有 `/STATISTICS`；13.5 的转置条目据实重写；第 14 节新增「线性（逐步）」「标识重复/异常个案」「单因素 ANOVA → 对比（引擎支持、面板未开放）」「编辑图表」四行，平均值改为「等价」并说明缺 ANOVA 表与关联量度，图形行按实际能力重写；数字订正为 23 个工具、227 项纯函数测试、39 个 API 端点、分析菜单 35 个入口（31 个 PSPP 过程 + 4 个插件入口）。
- 测试：`test/smoke.mjs` 的空闲回收用例改为断言「只释放行、变量还在、下一次 `ensure()` 把行读回来并能跑分析」。
- 版本号 0.23.30。

## 0.23.29

「已知限制」从凭印象改成逐条实测，并补一份 SPSS 菜单对照表。

- `docs/FEATURES.md` 第 13 节重写：分五组（引擎未实现 / 能跑但静默丢结果 / 语法坑 / 文件格式 / 数据编辑语义），每条都带实测得到的引擎原文。新增核实到的项：`UNIANOVA`、`MIXED`、`KM`、`PLUM`、`MVA`、`CASESTOVARS`、`VARSTOCASES`、`ALSCAL`、`HILOGLINEAR`/`LOGLINEAR`/`GENLOG`、`CSDESCRIPTIVES`、`GGRAPH` 全部 `is not yet implemented`；`GENLIN`、`PROXIMITY`、`MULTIPLE IMPUTATION`、`K-MEANS`、`CODEBOOK` 是 `Unknown command`；`MATRIX … END MATRIX` 其实可用（必须写完整块）；`MRSETS` 能定义但没有任何过程会用它算数。
- 新增第 14 节「SPSS 操作对照表」：按 SPSS 菜单路径（文件 / 编辑 / 数据 / 转换 / 分析 / 图形 / 实用程序）逐项写明在这里点哪里、是原生、等价、插件自算还是缺，共 60 行。
- 第 12 节平台行措辞与 install 对齐（仓库只随包 linux-x64，其余四平台从 Release 取）。
- `README.md` 新增「与 SPSS 的对应」指向上述两节。
- 版本号 0.23.29。

## 0.23.28

压测收尾：把结论写进文档，不再改功能。

- `README.md`：工具清单补全到 23 个；新增「性能与规模」一节（导入、分析、另存/重开、27 表导出、并发、LibreOffice 校验的实测数字），写明 `maxRows` / `timeoutMs` / 超 500 行表附注 / 会话空闲回收四个规模相关行为；配置示例补 `evictIdle`、`maxIdleMs`。
- `docs/FEATURES.md`：新增 12.2「性能基线与会话内存」，含同一张实测表、默认上限、空闲回收语义、字符串分组变量自动加引号的规则。
- `docs/install.md`：依赖矩阵的平台行改为「Linux x64/arm64 · macOS arm64/x64 · Windows x64」，注明仓库只带 `linux-x64`、其余用 `npm run engine:fetch` 取；新增「规模与性能」一节（配置项 + 空闲回收 + 大表提示）。
- 版本号 0.23.28。

## 0.23.27

压测第二轮（字符串分组变量、长变量名、内存回收）：

- **字符串分组变量在 agent 侧跑 T 检验 / 非参数检验直接报错**。`pspp_analyze ttest_independent {by:'grp', groupValues:['A','B']}` 生成 `T-TEST GROUPS=grp(A B)`，引擎回 `T-TEST: Syntax error expecting string.`——它要的是带引号的字符串码，而错误信息完全不提引号。面板侧一直会加引号，工具侧漏了。现在按数据集的变量类型决定：字符串分组变量 → `grp('A' 'B')`（码里的单引号双写），数值 → `grp(0 1)`；同样修正 `npar_mannwhitney`、`npar_kruskal`。
- **表头被截断时原表头没有保留**。70 个 ASCII 字符的表头被截到 64，注里却写「原表头保留为标签」——实际上只有含非法字符的表头才设标签，纯 ASCII 的长表头标签是空的，那句话是假的。现在只要变量名变了就写标签，三种改名（超长、无可用 ASCII、重名）都能靠标签找回原列名。
- **会话内存不回收**。一个跑过 5 万例的会话会把数据行一直留在进程里（压测里三个大会话把宿主 RSS 抬了约 17 MB 且不降）。`WorkspaceRegistry` 新增 `evictIdle({maxIdleMs})`：`ensure()` 时顺手释放 30 分钟没被访问、且不在屏幕上、也不是工具当前目标的会话数据集，磁盘上的 `work.sav` 与已保存文件不动，下次请求自动重开。`config.evictIdle === false` 可关掉。

压测复核项（本轮确认没问题）：CSV→.sav→重新打开后 `DESCRIPTIVES` 的 N/Mean/Std Dev/Min/Max 逐位相同（1 万例 4 个变量）；97 个取值的字符串变量做交叉表与卡方正常；字符串分组变量做 `ONEWAY` 正常（PSPP 自己接受字符串因子）；`DESCRIPTIVES` 遇到字符串变量给 warning 且不中断；64 字符变量名在整套分析里可用。

## 0.23.26

压测第二轮：把文件系统错误翻成人话。

- 打开不存在的文件、往只读目录保存、导出到不存在的目录，此前直接把 Node 的原文抛给用户，而且路径常常是插件自己工作目录里的暂存文件——用户既看不懂也修不了：
  - `EACCES: permission denied, copyfile '/home/…/.dsh/analytics/<session>/io/out-…sav' -> '/data/ro/out.sav'`
  - `ENOENT: no such file or directory, stat '/data/nope.csv'`
- 新增 `lib/fserr.js` 的 `describeFsError(error, target)`，按 `ENOENT`/`EACCES`/`EPERM`/`ENOSPC`/`EISDIR`/`ENOTDIR`/`EROFS`/`ENAMETOOLONG` 给出「哪个路径、为什么、怎么办」，并且永远指向用户请求的那个路径而不是内部暂存文件。`open`（stat 失败）、`save`（复制失败）、`exportOffice`/`exportDocument`/`exportScript`（写文件与复制）、`writeText`、`api/saveSyntax` 全部接上。
- 实测：打开一个不存在的 `/data/nope.csv` → 「找不到这个路径：…（检查路径是否写错；相对路径以会话工作目录为基准）」；保存到只读目录 → 「没有权限访问 …/ro/out.sav：目录是只读的，或者属于另一个用户」。

同一轮压测确认没问题的项：1 万例 CSV 打开 473 ms、5 万例 1400 ms；5 万例另存 .sav 1108 ms（2.6 MB）、重新打开 709 ms 且个案数不变；一个会话 27 张表 + 2 张图导出 docx 10.9 MB/573 ms、xlsx 8.5 MB/591 ms，LibreOffice 打开无 `Err:`/`#NAME`/`#VALUE`（29 张工作表，隐藏数据页 20000 行）；三个会话并发各跑一次回归，互不干扰。

## 0.23.25

压测第一轮修掉的三处（数据正确性问题优先）：

- **只有表头的 CSV 会多出一个个案**。空表导入后 `caseCount` 是 1 而不是 0：暂存 CSV 在 0 行时被写成单独一个换行，引擎把这一行读成「一个全缺失的个案」。改为 0 行时不写任何字节（`lib/csv.js` 的 `stringifyCsv`）。顺带修掉 `test/pdf-notes.mjs` 里被这个幻影个案掩盖的测试夹具错误——它把个案赋给 `dataset.cases`（不存在的别名，且不置 `dirty`），靠幻影个案才让 Logistic 有数据可跑。
- **表头不符合 PSPP 变量名规则时静默改名**。超过 64 字符被截断、全是中文变成 `V2`、重名两列撞车，三种情况都不告诉用户，改完就找不到那一列了。现在 `buildTable` 逐列记一条说明，`api/open` 与 `pspp_open` 一并返回（工具字段 `renamed`），面板弹提示「N 列的表头不符合 PSPP 变量名规则，已改名（原表头保留为标签）」。重名列现在加 `_2`、`_3` 后缀，不再撞成同一个名字。
- **连续变量做频率表会把导出撑爆**。`FREQUENCIES /VARIABLES=score` 在 1 万例上出 4135 行表，Word 导出 10.6 MB，但没有任何提示。现在矩阵超过 500 行的表会自动附一条注：「这张表有 N 行：多半是把连续变量放进了频率表……连续变量请改用描述统计或探索」，这条注随表进入 Word/Excel/PDF 导出。

压测数据（同一台机器，`~/.dsh/analytics` 工作区）：1 万例 7 变量 CSV 打开 473 ms，5 万例 1400 ms；1 万例上 FREQUENCIES 237 ms、CROSSTABS+CHISQ 146 ms、DESCRIPTIVES 143 ms、回归 142 ms；27 张表 + 2 张图导出 docx 10.9 MB/573 ms、xlsx（含隐藏数据页）8.5 MB/591 ms。

测试：`test/build.mjs` 增 2 项（表头改名与重名说明、只有表头时 0 个案），`test/regression.mjs` 增 2 项（超大表附注、普通表不附注），`test/pdf-notes.mjs` 夹具改为通过 `createDataset` 的 `rows` 建数据。

## 0.23.24

- **偏相关矩阵**（③，Windows 排的最后一项功能）：对话框多一个「表格形式」，选「矩阵」就出变量 × 变量的星号网格（对角线 1、上下对称），适合多变量共用一个控制集时排版；工具 `pspp_partial` 加 `layout`（`rows`/`matrix`）。整张矩阵**共用一次列表删除**——只保留分析变量与控制变量都齐全的个案，否则各单元格在不同个案集上算出的 r 摆在一起看会误导；`df = N − 控制变量个数 − 2` 写在表注里，自由度 ≤ 0 时整表给「—」并说明原因。
- 控制变量共线、字符串变量、变量名不存在、同一变量既分析又控制这四类输入错误，矩阵形式与逐对形式给同样的报错。
- 测试：`test/tables.mjs` 增 2 项（矩阵与逐对表数值必须一致且对称、四类错误与自由度不足），`test/routes.mjs` 增 1 项（`api/partial` 带 `layout:"matrix"`）。

## 0.23.23

- **修 0.23.22 引入的路由 404**：改版本号读取时漏了 `index.js` 里唯一一处 `pkg.version`（在 `ctx.inject(['webServer'])` 的回调里，`routes ready` 那行日志），回调抛 `ReferenceError` → 工具照常注册、但 `/analytics` 与 `/analytics-pspp` 两条前缀**一条都没注册**，面板和 curl 全部 404。现在改用 `pluginInfo().version`。
- **补了一条会挡住这类错误的测试**：`test/build.mjs` 里 `apply(ctx, …)` 用桩 ctx 跑一遍，断言 `webServer.register` 收到 `/analytics` 与 `/analytics-pspp` 两条。之前所有套件都只测 `createHandler`，宿主入口 `index.js` 没人覆盖，所以「工具好使、路由全丢」这种半死不活的状态测试看不出来。

## 0.23.22

- **版本号不再被模块缓存粘住**（热重载验证的真问题）：`lib/tools.js` 用 `createRequire(...)('../package.json')` 读版本，Node 会把 JSON 模块缓存到进程结束，于是热重载后 `pspp_status.plugin.version` 与面板状态栏仍报旧版本——Windows 每轮验收都靠这个字段判断「新代码有没有生效」，报错版本会让人以为热重载失败。新增 `lib/version.js`（`pluginInfo()` 按 mtime 读盘，只在不变化时复用），`index.js`、`lib/tools.js`、`lib/workspace.js` 的 `state()` 全部改用它，面板与工具现在报的是磁盘上的真实版本。
- 测试：`test/build.mjs` 增一项（`pluginInfo()` 必须等于 `package.json` 的 version/name，且两次调用一致）。
- 这一条也是给 Windows 的说明：上一版 0.23.21 热重载后若 `pspp_status` 仍报 0.23.20，原因就是这个缓存，不是热重载没生效。

## 0.23.21

- **图表也能「单独导出…」**（0.23.18 只做了表）：图条目标题栏的「导出 SVG」后面多一个「单独导出…」，导出范围只含这一张图——Word 里是一条内嵌图片段落（`<wp:inline>`，不包空表、无 `<wp:anchor>`），Excel 里图占独立工作表首格（`oneCellAnchor` 锚在 A1），`tables` 计 0、`images` 计 1。后端本来就支持 image 条目（`pairCharts` + `loadOutputImages` 都按 kind 走），缺的只是面板入口。
- **`pspp_export_office` 增加 `items` 参数**：按条目 id 只导指定输出，表格与图表都认；id 已失效直接报「指定的输出条目已经不在了」，不会静默退化成导出全部。优先级高于 `scope`。
- 测试：`test/routes.mjs` 增「export office one chart by id」（docx 只有 `<wp:inline>`、无空表；xlsx 有 `oneCellAnchor`）；`test/client.mjs` 的 mock 输出加一条 image 条目，断言图也有「单独导出…」按钮。
- 复核：本机 `pspp_chart` 出图 → `pspp_export_office {items:["chart-3-0"]}` → `tables:0 images:1`；docx 解包 `tbl 0 / inline 1 / anchor 0`，xlsx 有 `xl/drawings/drawing1.xml` 的 `oneCellAnchor`。

## 0.23.20

- **控制变量完全共线时给对结论**（P11a，Windows 复验发现）：原来正规方程奇异、高斯消元除以零主元后拿到全零残差，于是报「残差没有变异，算不出偏相关（控制变量把两个变量都解释完了）」，看起来像变量被解释干净了，实际是控制变量之间共线。现在主元判据改成相对阈值（`1e-10 × 矩阵最大元素`），奇异时直接报「控制变量之间完全共线（或其中某个是常数），无法求残差：请删掉一个控制变量（当前控制：…）」。相对阈值也顺手修掉了两个边界：原先绝对的 `1e-12` 会把量级 1e6 的良态方程判成奇异，也会漏掉 1e-3 量级的近共线。
- **字符串变量直接报错**（P11c）：原来字符串列读成 null，走列表删除后 N=0，提示「有效个案 0 个」——像是数据空了。现在 `variables` 或 `controls` 里出现非数值变量就报「偏相关只能用于数值变量：s 是字符串变量」。面板只列数值变量不会碰到，工具路径会。
- **`pspp_status` 的 capabilities 补上偏相关**（P11b）：`analyses` 加 `partial`、`tables` 加 `partial（偏相关）`。agent 只读 capabilities 时不会再以为没有这个能力。
- 备注措辞：没有控制变量时不再说「对控制变量做回归」，改为说明「这里的 r 就是普通的 Pearson 相关；df = 有效个案数 − 2」。
- 测试：`test/tables.mjs` 增 3 项（共线控制变量必须报共线、字符串变量必须报错、无控制时的备注措辞），`test/routes.mjs` 增 1 项（`api/partial` 遇字符串变量返 400）。
- 复核口径提醒（Windows 提出）：拿 PSPP 自己算残差再 `CORRELATIONS` 时，那张表的 `Sig.` 按 `N−2` 算，偏相关的 p 必须按 `N−k−2` 重算；两者只有 r 可比。

## 0.23.19

- **偏相关**（分析 → 相关 → 偏相关…，工具 `pspp_partial`）：PSPP 2.1.3 没有 `PARTIAL CORR`，所以这张表由插件自己算。两个变量分别对控制变量做含截距的最小二乘回归（高斯消元解正规方程），取两组残差求 Pearson r；`t = r·√(df/(1-r²))`、`df = N − 控制变量数 − 2`，P 是 t 分布双尾概率。输出「变量对 / 控制变量 / r / df / P / N / 标记」，缺失按列表删除（N 只数分析变量与控制变量都齐全的个案），自由度为 0 或残差无变异时给「—」并在备注里说明原因。多个分析变量两两成行，控制变量集对所有变量对通用。
- 面板：分析 → 相关 → 偏相关…（原来那条「PSPP 没有 PARTIAL CORR」的提示改成打开对话框）；「受引擎限制的功能」里偏相关一条改为指向本插件的实现；README 的缺口清单里去掉了 `PARTIAL CORR`。
- 测试：`test/tables.mjs` 增 4 项（残差法结果必须与闭式解 0.994 对账、无控制变量退化成 Pearson、列表删除后自由度不足、变量既作分析又作控制要报错）；`test/routes.mjs` 增 3 项（`api/partial` 正常、带控制变量、只给一个变量报 400）；`test/client.mjs` 增菜单与对话框断言。
## 0.23.18

- **每张输出表的标题栏新增「单独导出…」**：SPSS 的导出可以只导选中的输出，这里做得更直接——表就在眼前，点一下只把这张表写进 `.docx` 或 `.xlsx`（后缀决定格式），文件名按表标题预填。请求体带 `items: [<表 id>]`，路由负责把 id 解析成条目；id 已经不在了直接 400「指定的输出条目已经不在了」，不会悄悄退化成导出全部。
- 表格标题栏的按钮顺序保持：ROC 曲线… / 两两比较 / 编辑表格 / 单独导出… / 复制 CSV / 下载 CSV / 导出 CSV…。
## 0.23.17

- **相关表的 `Sig. (2-tailed)` 变成公式**：r 与 N 与 p 同在一列，所以 p 就是 `t = r·√((N-2)/(1-r²))`、df = N-2 的 t 尾概率，写成 `_xlfn.T.DIST.2T(ABS(r*SQRT((N-2)/(1-r^2))),N-2)`。对角线 r=1、Sig. 为空，不写。
- **非参数检验的竖排 `Test Statistics` 也写公式**：PSPP 把统计量、df、`Asymp. Sig.` 各放一行，卡方类（K-W、Friedman）写 `_xlfn.CHISQ.DIST.RT(χ²,df)`，Wilcoxon / Mann-Whitney 的 Z 写 `2*(1-_xlfn.NORM.S.DIST(ABS(Z),TRUE))`；二项、游程、K-S 只印 p 不印统计量，保持数值。
## 0.23.16

- **Model Summary 的 R / R Square / Adjusted R Square 变成公式**：三者都来自 ANOVA 表的平方和，`R Square = 1 - SSres/SStot`、`R = SQRT(R Square)`、`Adjusted = 1-(1-R²)(n-1)/(n-p-1)`，其中 `n-1` 与 `n-p-1` 正好是 ANOVA 打出来的两个 df，所以不需要额外知道个案数。没有同批 ANOVA 表时保持打印值。
- **新增可选的隐藏数据页**（`pspp_export_office` 的 `dataSheet`、导出对话框的「附带原始数据页（.xlsx，隐藏）」、路由 `data`）：勾上后 xlsx 末尾多一张 `state="hidden"` 的工作表，表头是变量名、每行一个个案（最多 2 万行），这样报告里没打印的量（均数、标准差）可以用 `AVERAGE`/`STDEV.S` 自己算。默认关，避免含敏感数据的报告自带一份数据副本。
## 0.23.15

- **导出对话框的公式提示补上重算说明**：xlsx 刻意不写 `<calcPr fullCalcOnLoad>`（否则打开就重算，绕过「缓存值 = PSPP 打印值」的设计），所以改完输入单元格后要按 Ctrl+Alt+F9 手动重算；提示里写明了，免得被当成公式坏了。
- **README 更正热重载结论**：此前写「Windows 安装里 disable → enable 不生效、要重启」，2026-11-14 在 Windows 上实测不成立——停用再启用后 `pspp_status.plugin.version` 直接变成新版本，进程未重启。真实差别只有两点：插件目录走 SMB 链接时，Windows 重定向器会缓存远程文件元数据约 10 秒（太快重载会读到旧 mtime），以及浏览器里的 `client.js` 要刷新页面才会换成新界面。

## 0.23.14

- **ANOVA 的 F 检验补上 p 值公式**：`REGRESSION` 打印的 `ANOVA` 表把 F、df1（Regression 行）、df2（Residual 行）、Sig. 都在同一张表里，现在写成 `_xlfn.F.DIST.RT(F, df1, df2)`，改 F 或任一自由度都会跟着重算。
- **回归系数表的 Sig. 变成跨表公式**：`Coefficients` 表只有 t、没有 df，此前只能保持数值。现在按表标题里的因变量名（`Coefficients (y)` ↔ `ANOVA (y)`）找到同一批输出里的 ANOVA 工作表，取其 Residual 行的 df 单元格，写成 `_xlfn.T.DIST.2T(ABS(t),'ANOVA (y)'!C4)`。表名含空格/括号/引号时按 Excel 规则加单引号并双写内部引号；找不到对应 ANOVA 表（例如只导了系数表）就退回数值，不会写坏公式。
- **导出面板加「写入 Excel 公式」勾选**（`client.js` 导出对话框，仅 .xlsx 生效）：默认开，关掉得到纯数字的表格；对应路由 `formulas` 字段此前只有 `pspp_export_office` 能传，现在面板也能传。
- **图表归属记住上次选择**：图形对话框的「导出时图表归属」默认取上一次选过的表（`localStorage` 的 `ap.chartTarget`），同一张表连画几张图不用重复选；表已不在当前输出里时回到「自动」。
- 测试：`test/office.mjs` 38 项（新增 ANOVA 同表公式、跨表残差 df、表名转义、双表导出实测 XML）、`test/routes.mjs` 新增「关掉公式后没有 `<f>`」与「回归导出跨表公式」、`test/client.mjs` 新增记忆与勾选断言。

## 0.23.13

- **交叉表的卡方检验表补上 p 值公式**（Windows P9）：`CROSSTABS /STATISTICS=CHISQ` 打印的 `Chi-Square Tests` 表把检验名放在行标签（Pearson Chi-Square / Likelihood Ratio / Continuity Correction / Linear-by-Linear Association），统计量在 `Value` 列、自由度在 `df` 列、p 值在 `Asymptotic Sig. (2-tailed)` 列，此前只有表头叫 `Chi-square` 的表（NPAR 的 Test Statistics）才会写公式，交叉表这张一直是死的数值。现在按行标签识别卡方类检验，写 `_xlfn.CHISQ.DIST.RT(Value, df)`；`Fisher's Exact Test`（精确检验，不是卡方尾）与 `N of Valid Cases` 跳过。
- **图表可以指定归属表**（B2）：图形对话框（条形/直方/箱线/折线/饼/面积/散点）新增「导出时图表归属（可选）」下拉，列出当前输出里已有的表。选了就在导出 Word/Excel 时把这张图嵌进那张表（Word 表内 `wp:inline`，Excel 该表所在工作表的 `oneCellAnchor`），不选仍按来源 runId 自动配对。显式指定是权威的：指定的表已经不在了，图就单独成段/单独成表，不会退回去猜。
- `pspp_chart` 新增 `tableId` 参数（取值为此前输出的表 id），agent 侧同样能显式绑定。

## 0.23.12

Windows 侧 0.23.11 复核提出的四条（P4–P7），逐条处理：

- **P7（真问题，最要紧）**：`CHISQ.DIST.RT`、`T.DIST.2T` 是 Excel 2010 才有函数，OOXML 里必须写成 `_xlfn.CHISQ.DIST.RT(...)`、`_xlfn.T.DIST.2T(...)`，否则真 Excel 打开显示 `#NAME?`。LibreOffice 会容忍缺前缀，所以此前的 LibreOffice 重算全绿并不能证明 Excel 里没问题。现在三处（Logistic 的 Sig.、t 检验的 Sig. (2-tailed)、卡方的 Asymp. Sig.）都带前缀，单测断言公式文本以 `_xlfn.` 开头。
- **P5（真问题）**：有效百分比原来把有效合计写成字面量（`C3/63*100`），改计数不会跟随；改为 `C3/SUM(C3:C4)*100`，与百分比列一样跟着数据走。
- **P6（改进）**：累计百分比首行原先 `SUM(E3:E3)` 单格求和，改为直接引用 `E3`，后续行仍是累加。
- **P4（未复现）**：Windows 报告「合计行百分比单元格 s=0、显示 100 而不是 100.0%」。用同规模数据（60 例、两类）在本机复跑，合计行百分比单元格是 `s="4"`（`0.0"%"`），LibreOffice 重算显示 `100`——格式化后应为 `100.0%`；导出文件已附上供对照。若 Windows 仍能稳定复现，需要他们提供那份 xlsx。
- **P8（不采纳）**：没有 `<calcPr fullCalcOnLoad="1"/>` 是刻意的——加了会让 Excel 打开即按单元格重算，绕过「缓存值 = PSPP 打印值」的设计；想要的正是「打开看到原值，改输入才重算」。
## 0.23.11

- Excel 导出补上检验的 p 值公式：t 检验的 `Sig. (2-tailed)` = `T.DIST.2T(ABS(t), df)`，卡方检验的 `Asymp. Sig.` = `CHISQ.DIST.RT(χ², df)`；判据是统计量与自由度在同一行，且两者都是有限数值（`NaN`、`+Infinit` 行跳过、保持打印值）。F 检验的 p 需要两个自由度分处不同行，暂不算。

## 0.23.10

- Excel 导出把「表内自洽量」写成公式：频率表的百分比 = 计数 / 合计、Valid Percent = 计数 / 有效合计、Cumulative Percent = 逐行累加、合计行 = SUM；交叉表的行合计与列合计 = SUM；Logistic 系数表的 Wald = (B/S.E.)²、Sig. = CHISQ.DIST.RT(Wald,1)、Exp(B) = EXP(B)、区间 = EXP(B ± 1.96·S.E.)。每个公式都带打印值作为缓存结果，打开文件看到的就是 PSPP 打印的数值，改输入单元格才重算。均数与标准差无法从表内重算，仍是数值。

- 公式可关：`pspp_export_office` 新增 `formulas`（默认 true），面板导出走同一开关。
- 图移到表内表头之上（标题 → 图 → 表头），Word 仍是表内 `wp:inline`。
- CI 新增 `pdf-notes` job：下载引擎 + poppler，用 `pdftotext` 读回 PDF 断言「注：」确实落在页面上。

## 0.23.9

### 修复

- **图不再被塞进不相干的表里**（0.23.8 验收的 D11）：上一版按「图跟随它上方最近的表」配对，于是一张 `score by y` 的分布图被嵌进了 `Variables in the Equation` 回归系数表——内容错配，而且会一路进论文稿。现在：
  - 画图时记录来源分析轮次（`item.sourceRunId = 最近一次分析的 runId`，也可用 `sourceRunId` / `tableId` 显式指定）；
  - 导出配对规则改成：① 显式 `tableId` 优先；② 来源轮次只产出一张表时，就配那张；③ 多表轮次只有当**图的变量与分组变量同时出现在同一张表的文字里**（唯一命中）才配；④ 其余一律不嵌，作为独立图表排在文档里，Excel 单独进「图表」工作表。
  - 结果：单表分析后的图照旧嵌进该表（这是常见场景），多表分析后画的图不再乱挂，正文里既不会出现「分布图坐在系数表里」，也不会丢图。
- **同一张图在 Word 与 Excel 里尺寸一致**（D12）：原先 docx 固定 14 cm、xlsx 用 15.24 cm，同一张图差 8.8%。现在两个写出器共用 `imageExtent(width, height)`：按像素 ÷ 96 dpi 换算 EMU，并统一封顶在正文栏宽（14 cm / 5 040 000 EMU），实测两侧都是 `5040000 × 3240000`。

- **图表工作表的 `<drawing>` 引用漏写**：单独收集图的「图表」工作表有锚点、有 media，却漏了 `<drawing r:id="rId1"/>`，Excel 打开是空白页。已补，并加断言。
- **同名变量多表时的归属**：`FREQUENCIES` 会同时产出 `Statistics` 与以变量名为标题的频数表，两张都提到变量名。现在多命中时优先标题里含该变量名的那张（频数表），仍不唯一才放弃配对。

### 测试

- `test/office.mjs` 增 6 项（跨轮次的图不落表、单表轮次仍成对、唯一文字命中成对、docx 与 xlsx 的 extent 相等、图表工作表有 drawing 引用、同名多表按标题归位），现 21 项。

## 0.23.8

### 修复

- **表注不再只活在面板里**（0.23.7 验收的 D10）：`item.notes` 一直存在（面板能显示、agent 能读到），但 `.docx` / `.xlsx` 写出器只取标题和矩阵，于是分离提示、容忍度注、跳过变量的注在导出后全部消失——而 Word 才是交稿的那份。现在：
  - `.docx`：每条注一段，斜体 10.5 pt（`<w:i/>` + `w:sz 21`），前缀「注：」，紧跟在所属表格之后；
  - `.xlsx`：注写在矩阵下方、跨列合并（斜体样式 `s="3"`）；
  - `.pdf` / `.odt`：这两个由 PSPP 自己排版，插件只能用 `ECHO` 补写，因此表注以「注：<表名>：…」的段落追加在文档末尾；
  - 面板的「导出输出为 HTML」也会把注写在表后。

### 新增

- **图表嵌进表格里导出**（表内嵌图）：
  - `.docx`：图按「跟随它上方最近的表格」配对，作为该表内一行合并单元格里的 `wp:inline` 图片（不用浮动锚点），页断时不会和数字分家；
  - `.xlsx`：以前图表**根本不进 Excel**。现在按同一规则配对，用 `oneCellAnchor` 锚定到工作表首格（`xdr:from` col=0,row=0），并在表格上方预留按图高换算的空行（15 pt/行），图片不会压在数据上；没有表格可挂的图单独进「图表」工作表；
  - 图片来自输出项自己的 `artifactUrl`（`runId` + `name` 解析），插件画的 SVG 图用 `lib/raster.js` 转 PNG，PSPP 的 PNG 直接用——此前导出只会去拉「最后一轮」的 png，早期运行的图表一律显示「（图表缺失）」。

### 测试

- `test/office.mjs` 增 5 项（表注斜体段落、图在表格内部且无 floating anchor、xlsx 注样式与合并、xlsx `oneCellAnchor` + 预留行 + 媒体文件、只有图时也出工作表），现 15 项。

## 0.23.7

### 修复

- **分离表注不再把大截距当成分离**（0.23.6 验收的 D9）：以前的判据是「表里任意一行的 `Exp(B) > 100` 或 `< 0.01`」，于是 2000 例里只有 10 例阴性时，常数项的 `Exp(B)=149.40` 也会触发一条「这是分离」的注，而真正的预测变量 `Exp(B)=1.35`、CI 0.46–4.01 完全正常——这条假注会一路进 Word / PDF 导出。现在改成只看预测变量行（跳过 `Constant` / `常数` / `截距`），并要求分离的直接证据：`S.E. > 5`、CI 含 `+Infinit` / `Inf` 之类非有限值、或 CI 上下限相差 1000 倍以上（这条抓到了 op19 那次 `Exp(B)=55.06`、CI 0.81–3765.36 的漏报），`Exp(B)` 只在极端量级（> 1e6 或 < 1e-6）时单独成立。真实强效应（`OR=150`、CI 120–190）不会误标。表注末句补了「本例可用 Firth 惩罚似然或精确 Logistic 复核」。

### 测试

- `test/regression.mjs` 增 6 项：大截距不误报、真实强效应不误报、`S.E.` 爆炸触发、CI 相差千倍触发、没有 CI 列时的表能判定、非 Logistic 表不动。

## 0.23.6

### 修复

- **agent 侧拿到 Logistic 的 ROC 提示**（0.23.5 验收的 A-2）：`itemsForAgent()` 以前只把 `kind / id / title / rows` 交给 agent，`item.roc` 与 `item.pairwise` 在最后一层被丢掉，于是面板有「ROC 曲线…」按钮、agent 却只能自己猜哪个是因变量。现在两个提示都随表格项返回（`{kind:'table', id, title, rows, roc?, pairwise?, notes?}`），表注（分离提示、跳过变量等）也一并给出去，`pspp_analyze` / `pspp_run` / `pspp_export_*` 的输出一致。
- **Logistic 的极端 Exp(B) 有了解释**：小样本里结局几乎被完全预测时（分离），`Exp(B)` 会到几十上百、置信区间宽到几千，看起来像算错。现在检测到 `Exp(B) > 100` 或 `< 0.01` 时，该表自动附一条表注：「小样本里结局几乎被完全预测时会出现这种『分离』现象…不代表拟合出错，可增加样本量或改用精确 Logistic 回归」。

### 说明

- 面板版本条一直读的是服务端 `state.version`（装载时由 `package.json` 取一次并缓存），不是每次去读文件，所以「面板显示 vX 但进程是旧代码」只可能是装载后没热重载，不是版本条读错。README 里那条「改了代码怎么生效」仍然是唯一判据。

### 测试

- `test/build.mjs` 增 1 项（`itemsForAgent` 保留 roc / pairwise、无提示时不凭空添加、rows 不变），现 61 项。
- `test/routes.mjs` 增「分离时表注解释 Exp(B)」一条。

## 0.23.5

### 新增

- **Logistic 结果可以直接接着画 ROC**：二元 Logistic 的结果头多一个「ROC 曲线…」按钮，点开就是 ROC 对话框，状态变量预填这次的因变量、检验变量预填第一个协变量，不用再选一遍。`pspp_analyze` 跑 logistic 时也会把同样的提示写到结果项上（`item.roc`），agent 侧拿到题面后不会再问用户要哪两个变量。注意 PSPP 要画拟合模型的 ROC 需要 `/SAVE=PRED` 生成预测概率变量，本插件不默认写数据，所以预填的是原始协变量；要画预测概率就先在语法里加 `SAVE=PRED` 再把 `PRE_1` 填进检验变量。

### 修复

- **Word 导出里的显著性星号变成真上标**（B）：显著性矩阵的单元格形如 `-10.000 **`，以前整串按普通文本写进 docx，星号落在基线上；现在拆成两个 run，星号带 `<w:vertAlign w:val="superscript"/>`，与期刊三线表的排法一致。表头单元格不拆分（表头里以星号结尾的文字不是标记），Excel 导出保持原样（xlsx 的富文本需要 sharedStrings 富文本段，暂未做）。
- **退化拟合时引擎那列容忍度不再误导**（0.23.4 验收的 P3）：引擎判为不可信时，把 Coefficients 表里的 Tolerance / VIF 两格改成「—」，并在表注里写明「引擎打印的容忍度不可用…正确值见下面的『共线性诊断（插件计算）』」，不再让读者先看到 `.00 / +Infinit`。

### 测试

- `test/office.mjs` 增 1 项（星号成上标、值不带星号、表头不拆、普通单元格仍是单 run），现 10 项。
- `test/build.mjs` 增 logistic 的 `analysisExtras` 断言（带 roc 提示 / 缺因变量时不给）。
- `test/routes.mjs` 增「logistic 结果项带 ROC 提示」「退化拟合的容忍度被置为 —」两条。
- `test/client.mjs` 增「Logistic 结果头出现 ROC 按钮、点开是预填好的 ROC 对话框」。

## 0.23.4

### 修复

- **D7：重跑之后日志承诺的共线性表不再缺席**。上一版里 agent 侧只要显式传了 `statistics:["TOL"]` 或 `["ALL"]`，`analysisExtras()` 就直接不传 regression 提示；引擎一崩、自动重跑去掉 TOL 之后，日志仍写「容忍度与 VIF 见下面的『共线性诊断（插件计算）』」，但那张表根本没生成（Windows 上 24 次显式 TOL 运行里崩 3 次，3 次都缺表）。现在提示始终随语法一起传下去，重跑后会补齐该表；若引擎自己真打印了可用的容忍度，则不再重复输出。
- **D8：`/STATISTICS=ALL` 的兜底重跑真正生效**。旧逻辑只摘掉 `TOL` 这一个词，`ALL` 还留在语法里、照样把 TOL 带回来，于是重跑同样崩溃、照样零张表（Windows 实测 8 次挂 2 次）。现在 `TOL` 与 `ALL` 一并去除，摘空时降级为 `COEFF R ANOVA CI BCOV`；另外只改 `REGRESSION` 语句的 `/STATISTICS`，不会误改 `FREQUENCIES /STATISTICS=ALL` 这类别的命令。
- **D8：报错带上退出码与引擎原文**。以前「退出码非 0 且零张表」的提示是 `引擎没有产出任何表：引擎没有给出原因`——前缀重复，还把引擎真正那句 `gsl_blas_dsymm: matrix/vector sizes are not conformant` 丢了。现在格式为 `引擎没有产出任何表（退出码 19：src/math/linreg.c:261:gsl_blas_dsymm: ...）`，stderr 为空时回落到 stdout 的最后一行。
- **引擎打印的容忍度只在可信时才采用**：PSPP 在退化拟合下会把容忍度写成 `.00`、VIF 写成 `+Infinit`，即使本次没崩。现在只有当引擎那列数值都是有限值、落在 0–1、且与插件重算结果的差 ≤ 0.02 时才跳过插件表；不一致时仍输出重算表，并注明引擎数值不可用。

### 测试

- `test/regression.mjs` 增 2 项（`degradeStatistics` 的 TOL/ALL 去除与降级、`describeFailure` 的退出码与引擎原文），现 7 项。
- `test/build.mjs` 改为断言显式 `TOL`/`ALL` 仍然携带 regression 提示。
- `test/routes.mjs` 增「显式 TOL 运行必有一张共线性表」「连续 5 次 `/STATISTICS=ALL` 都有表」两条。

## 0.23.3

### 修复

- **带 TOL 的回归不再偶发整次无输出**（D6）：PSPP 2.1.3 的 `REGRESSION` 只要 `/STATISTICS` 含 `TOL`，约 1/6 的运行会在 `gsl_blas_dsymm: matrix/vector sizes are not conformant` 处崩溃（exit 19），并且一张表都不写、stderr 只有那一行。现在插件**默认不再向引擎要 TOL**，改发 `COEFF R ANOVA CI`，容忍度与 VIF 由插件自己算（`lib/regression.js`：对每个预测变量做「对其余预测变量 + 截距」的最小二乘，`容忍度 = 1 − R²`、`VIF = 1/容忍度`），单独输出「共线性诊断（插件计算）」表；单预测变量固定 1.000 / 1.000，正好绕开 PSPP 在单变量下打印 `+Infinit` / `NaN` 的毛病。数值以 R `car::vif` 为基准做过对照（两变量模型两边都得 0.9113718）。
- **显式要 TOL 时自动兜底**：如果调用方确实传了 `statistics:["TOL"]` 而这次运行崩了（退出码非 0 且 0 张表），会自动去掉 TOL 重跑一次，并在日志里写明「PSPP 的 TOL 统计量偶发崩溃，已去掉 TOL 自动重跑一次」。
- **空输出不再静默**：以前「退出码非 0 且没有任何表」会原样返回一个空运行，面板显示「跑完了，什么都没出现」，用户会误以为是没有显著结果。现在直接抛错，消息里带引擎自己那行错误（如 `REGRESSION: nosuchvar is not a variable name`），面板与 agent 都能看到。

### 改进

- 面板回归对话框的选项从「共线性诊断（容忍度 / VIF）」改成「共线性诊断（容忍度 / VIF，由插件计算）」，勾选后走插件计算路径，语法里不再出现 TOL。
- `pspp_analyze` 的 `statistics` 与 `collinearity` 描述写明默认不发 TOL 及原因。
- 新增 `test/regression.mjs`（5 项：与 R 对照的容忍度/VIF、单预测变量、完全共线、例数不足、含缺失行），并接进 `npm test`；`test/routes.mjs` 增加「连续 10 次回归都有表」「缺变量时明确报错」两条。

## 0.23.2

### 新增

- **二元 Logistic 回归给出 Exp(B) 的 95% 置信区间**：语法改为 `LOGISTIC REGRESSION dep WITH 自变量 /PRINT=CI(95) SUMMARY.`，输出表的 `Variables in the Equation` 现在有 `Exp(B)` 与 `95% CI for Exp(B) Lower / Upper`。对话框「选项」里可以关掉（只留 SUMMARY）。注意 PSPP 不接受 `/METHOD=ENTER`，写了会报 `expecting MISSING, ORIGIN, NOORIGIN, ...`，本插件不再生成它。
- **ROC 曲线输出坐标表**：新语法带 `/PRINT=COORDINATES`，输出 `Coordinates of the Curve`（Positive if greater than or equal to / Sensitivity / 1 − Specificity），可以直接抄进论文或拿去算约登指数。对话框「选项」里可关。
- **两两比较矩阵表**：对话框「表格形式」可选「逐对一行」或「矩阵表（变量 × 组对）」。矩阵表一列一对组，单元格是均数差加星号，是多组论文最常见的排法；agent 侧 `pspp_pairwise` 也支持 `layout:"matrix"`。

### 改进

- **两两比较表增加 df 列**：表头现在是 `变量 | 比较 | 均数差 | 标准误 | t | df | P | P（Bonferroni） | 95% CI（差） | Cohen's d | d 的 95% CI | 标记`。上一版 CI 用了 Welch 自由度但表里不显示，读者无法核对；`df` 摆出来就能自己算。
- **Cohen's d 给出 95% 区间**：用 Hedges & Olkin 的大样本近似，`SE(d)=sqrt((n1+n2)/(n1·n2) + d²/(2(n1+n2)))`；两组各 2 例时区间仍会较宽，这是样本量的下限，不是算法问题。
- **限制清单每条都给了替代做法**：菜单「分析 → 受引擎限制的功能」里每一项都写明绕行方案（如 ANCOVA 用「回归 → 线性」加哑变量、CURVEFIT 用「计算变量」造 x² 再回归、残差自相关用「保存残差」后自己算 DW）；`pspp_status.capabilities.unsupported` 每条也带上 `alternative` 字段。

## 0.23.1

### 修复

- **「只导出最近一次运行」不再丢表**（D1）：两两比较表、表 1/表 2 是从内存数据集算出来的，没有 `runId`，而 `scope:'last'` 按最大 `runId` 挑，于是只能挑到上一次引擎运行的旧表。现在每个动作产出的条目都带单调递增的 `batchId`，`last` 取最新批次，两两比较、表 1/表 2、多选题表、图表都能被导出。
- **导出对话框有范围选项了**（D2）：以前 `scope` 只有 agent 能用。现在「文件 → 导出输出为 Word/Excel…」的路径对话框里有「导出范围：整个会话 / 最近一次运行」下拉，选完直接带进 `api/exportOffice`。
- **小样本 95% 置信区间不再虚宽**（D3）：`tCritical95` 以前把自由度向下取整（df=2.88 当 2 用，t=4.303）。现在用二分法反解双侧 P（`studentTwoSidedP`），df=2.881 得 3.2581，与 R `qt(0.975, 2.881)` 的 3.258119 一致。审查单里写的 3.44 对不上 R；本次实现按 R 的值核对。图形误差线的 CI 同步受益。
- **回归带 TOL 时的假报错降级为提示**（D5）：PSPP 2.1.3 只要 `/STATISTICS` 里含 `TOL` 就以退出码 1 结束并打 `REGRESSION: No valid data found. This command was skipped.`，而三张表其实都在。现在当本次运行有产出且消息来自 REGRESSION 时把它降成 note，并附一句「表已完整产出，结果可用」；直接跑引擎复现确认这是引擎自身的毛病（`COEFF R ANOVA`、`... CI` 退出码 0，任何含 `TOL` 的组合退出码 1）。
- **限制清单措辞与菜单对齐**（D4）：`MULTIPLE IMPUTATION` 改成「引擎不认识这条命令（Unknown command）」；`CURVEFIT` 的措辞去掉粘连；菜单补齐「曲线估计」「多选题直接进 CROSSTABS 等过程」两项，与 `capabilities.unsupported` 的条目一一对应。

### 改进

- agent 侧 `pspp_analyze` 跑 t 检验 / 单因素 ANOVA / GLM 时也把变量与分组带进结果，输出里同样有「两两比较」按钮（以前只有面板发起的运行才有）。

## 0.23.0

### 新增

- **两两比较从结果里直接发起**：独立样本 T、单因素 ANOVA、GLM 的结果标题栏多一个「两两比较」按钮，点开就是这套变量与分组，不用再选一遍。菜单「分析 → 比较平均值 → 两两比较…」也可以独立打开。
- **效应量**：表 1 / 表 2 末尾加「效应量」列 —— 两组给 Cohen's d（合并标准差），三组以上给 η²，分类变量给 Cramér's V。两两比较表加 95% CI（差）与 Cohen's d。
- **导出范围**：`pspp_export_office` 与 `api/exportOffice` 加 `scope`。`last` 只导最近一次运行产出的表和图，`session`（默认）仍导全部。
- **引擎限制清单**：`pspp_status` 的 `capabilities.unsupported` 与分析菜单「受引擎限制的功能」列出 PSPP 2.1.3 明确没有的过程与原因（生存分析、复杂抽样、多重插补、ANCOVA 的 WITH、偏相关、TREE/REPORT/PPLOT、CURVEFIT、Durbin-Watson、多选题直接进 CROSSTABS）。

### 改进

- 线性回归默认输出 `/STATISTICS=COEFF R ANOVA CI TOL`：标准化 β、B 的 95% 置信区间、容忍度与 VIF 一并给出（以前要自己写语法）。也接受显式 `statistics` 列表，无法识别的关键字会被丢掉而不是发给引擎。
- 因子分析默认打印 KMO 与 Bartlett；旋转支持 VARIMAX / EQUAMAX / QUARTIMAX / PROMAX / 不旋转，且「不旋转」正确发成 `NOROTATE`（PSPP 不认 `NONE`，以前这一项会直接报语法错）。

## 0.22.2

### 修复

- `pspp_pairwise` 的默认值改成 **Bonferroni 校正**：以前默认不校正，表头却写「P（校正）」，列里放的其实是原始 P —— 被抄进论文就是没人能发现的错误。现在默认校正、表头写「P（Bonferroni）」；显式传 `adjust:'none'` 才给原始 P，表头写「P（未校正）」，备注里也不再出现 Bonferroni 字样。
- 全缺失的变量以前会报「至少有一组不足 2 个个案」，把「没有数据」说成「样本量不够」；现在写「没有有效数据（已跳过）」。某几对因例数不足没比较时，备注也会区分校正与不校正两种情况。

### 改进

- `.spv` 导出不再产出空壳：PSPP 在没有表格可写时照样生成一个只有 heading 的压缩包，SPSS 打开是空白文档。现在导出后检查归档里有没有 `*_lightTableData.bin`，没有就删掉临时文件并提示「先运行一个会出表的分析，或改导出 PDF / ODT」。
- 版本自证：面板状态栏右下角显示 `v<版本>`，`pspp_status` 返回 `plugin.version`，宿主日志每次装载打一行 `[dsh-analytics] <版本> routes ready`。
- README 补「改了代码之后怎么生效」：`client.js` 刷新即可；`lib/*.js`、`index.js`、入口配置在 Windows 安装里 disable → enable 之后仍是旧模块（新路由 404、旧解码生效），Linux 安装里实测会重新加载 —— 拿不准就重启 dsh web，再用状态栏版本号与 `pspp_status` 的 `plugin.version` 核实。
- `docs/FEATURES.md` 补 GB18030 回退的边界：只对中文 Windows 成立，西文 ANSI（cp1252）会被误当汉字解，西文环境请另存 UTF-8。
- 回归测试补三条：两两比较的默认/关闭校正两个分支、全缺失变量的备注措辞、`.spv` 有表可导与无表拒导；另加「合并后 persist 不改个案数」的回归。

## 0.22.1

### 修复

- 重开 .sav 时多选题的中文标签不再乱码：PSPP 在 Windows 上把 MRSETS 属性串按系统 ANSI 代码页（中文系统是 cp936）写进文件，以前一律按 UTF-8 解码，于是「多选题测试」变成「��ѡ�����」。现在先按 UTF-8 严格解一次，失败回落 GB18030；Linux 端仍走 UTF-8 分支，行为不变。

### 改进

- 转换失败的提示不再套两层括号：引擎原文与中文解释之间用「——」分隔，例如「转换失败：`x.csv' is not a system or portable file. —— 这不是 SPSS 数据文件（.sav/.por/.sys）…」。
- `pspp_new` / `pspp_add_variable` 的返回值补上 `measure`、`role`、`alignment`，agent 建完表不用再查一次 `pspp_variables`。
- 新增工具 `pspp_pairwise`：对分组变量的每一对组做 Welch t 检验，给均数差、标准误、t、原始 P、Bonferroni 校正 P 与星号标记；不要求方差齐，组不均衡时比 ANOVA 事后检验更稳。结果同时进面板输出，可编辑、可导出。

## 0.22.0

### 图表

- 误差线可选三种：±1 个标准差（SD）、±1 个标准误（SE）、95% 置信区间（CI）。条形图与折线图都适用；区间在模型层算好（用 t(0.975, n−1)，不假设 1.96），标题与导出一起写明是哪种。
- 条形图可自动标注组间差异：每一对类别做 Welch t 检验，画括号并标 `***`/`**`/`*`/`ns`；括号按重叠情况分层，顶部留白自动加高。t 分布的双侧 p 值就地实现（正则化不完全贝塔函数），不引依赖。
- 折线图支持双 Y 轴：填一个「第二变量（右轴）」，两个变量各读自己的刻度，网格跟左轴走，图例标出（左轴）/（右轴）。适合例数与浓度这类量纲差一个数量级的图。
- 类别轴的顺序改按底层编码：带值标签的分组（1=对照组 2=低剂量组 3=高剂量组）以前按标签拼音排，图上是「低剂量组、对照组、高剂量组」。

### 表格

- 每张输出表可「编辑表格」：逐列改表头文字、给列宽（像素，留空自动），再填一行脚注，用于三线表排版；保存后按矩阵重绘，导出 HTML 时一并生效。
- 新增「表 1：基线特征」与「表 2：组间比较」（分析 → 表）：选一个分组变量，自动给连续变量的均数±标准差（或中位数与四分位间距）、分类变量逐水平的 n（%），最后一列是 P —— 两组用 Welch t，三组以上用单因素方差分析，分类变量用 Pearson 卡方；有单元格期望频数 <5 时在备注里指出该用 Fisher 确切概率法。
- 新增工具 `pspp_publication_table`，agent 也能直接生成这两张表。

## 0.21.0

### 修复

- `pspp_status` 的引擎版本不再是空的：探测 `--version` 时没带引擎自己的动态库环境，Windows 上静默失败，现在返回 `pspp (GNU PSPP) 2.1.3`。
- `pspp_chart` 的输出补上 `runId` 与图表 `url`：以前 agent 画完图拿不到这两个值，`pspp_export_chart` 直接报「needs a runId or the url of a chart」，导出图这条路走不通。
- `pspp_run_file` 会识别 GBK 语法：以前无条件按 UTF-8 读，老师给的、老版本 PSPP 导出的 `.sps` 跑完看着成功，中文标签却是坏的。现在先严格按 UTF-8 解，解不开回落 GB18030，也可以用 `encoding` 强制。
- 多选题写回失败时显示真正的原因：引擎的提示行（`note: MRSETS is implemented…`）总排在错误前面，以前只取第一行，于是 `'q' is not valid here because this identifier must start with '$'` 这种关键信息被藏住了。现在优先取 `error:` 行。多选题名不带 `$` 时自动补上，而不是让引擎报错。
- 多选题名现在真的能写回：`g` 这样的名字会被补成 `$g`，与 SPSS 的显示一致。
- 转换失败时附中文提示：`pspp-convert` 只吃 SPSS 数据文件，拿 CSV 当输入时给的是英文原文，现在后面跟一句「这不是 SPSS 数据文件……」。

### 新增

- 打开 `.sav` 时把多选题定义读回来：PSPP 把它们存成文件属性却没有任何命令能读，以前重开文件后「多选题面板」是空的（虽然 SPSS 还能认出这些集合）。现在从字典属性里恢复名称、标签、类型、变量列表与计数值；解析不出来的（变量名对不上、格式不认识）会被丢掉而不是瞎猜。
- agent 侧可以从零建表了，不用再绕 `DATA LIST`：
  - `pspp_new`：一次给出变量定义与初始个案，建好的表立即能跑分析。
  - `pspp_add_variable`：往现有数据集追加一列（右侧，已有个案填系统缺失）。
  - `pspp_append_cases`：批量追加个案，整批算一步撤销。
- `pspp_convert` 的描述收紧了：源必须是 `.sav/.por/.sys`，并说明 CSV/Excel 要先 `pspp_open` 导入再转换。

## 0.20.0

### 修复

- Windows 中文路径终于能用：引擎（`pspp.exe`）把路径交给 C 运行库时按系统 ANSI 代码页（简中 = cp936）解释，而程序内部用的是 UTF-8，于是任何含中文的路径都报 `No such file or directory` —— 读不出、也存不进。现在所有进出引擎的路径都先换成 ASCII 暂存目录里的副本（`lib/stage.js`），由 Node 在完成后拷回用户指定的位置；打开、保存、导出 CSV、转换、合并、写回多选题定义六处都接上了。工作区目录本身含中文（Windows 中文用户名）时，运行目录回落到 `ProgramData` 下的 ASCII 路径。
- 语法文件强制按 UTF-8 交给引擎（`--syntax-encoding=UTF-8`）：插件写出的语法永远是 UTF-8，不能再让引擎按 locale 猜，否则中文变量标签会变成乱码。
- 文件对话框认识 Windows 反斜杠路径：以前「.. 上级目录」会原地重开同一目录，双击文件会拼出 `C:\data\a.sav/b.sav`。
- 引擎报错附一句中文提示：PSPP 的中文语言包只覆盖一部分，报错原文多写给已经懂这条命令的人。现在每条诊断都带 `hint`（原文一字不改），提示弹窗和状态栏都会显示。

### 新增

- 状态栏常驻显示会话语义设置：`SPLIT FILE` / `WEIGHT BY` / `FILTER BY` / `SELECT IF` 跨运行生效却在数据视图里看不见，一个忘记关掉的筛选会让后面每个数字都变。现在它们显示为 chip，前三者带 × 可一键关闭，`SELECT IF` 标注为「已删除个案、不可取消」。工作区同时记住加权与筛选，并在后续运行前自动重放（拆分原来就有）。
- 工具有了两条缺的：`pspp_run_file`（跑磁盘上的 `.sps` 语法文件，讲义/存好的语法都能直接用）与 `pspp_convert`（用引擎自带 `pspp-convert` 在 `.sav`/`.por`/`.sys`/`.csv`/`.txt` 之间转换）。

## 0.19.1

### 修复

- 频率分析的统计量选项不再被丢掉：以前只有「全部统计量」能生效，界面或工具里勾选的均数、中位数、偏度等会被静默忽略；现在按勾选取值并拼进 `/STATISTICS=`，非法统计量会明确报错。百分位数（`/PERCENTILES=`）同时生效，并默认用 `FORMAT=NOTABLE` 只出统计量表。
- 探索（`EXAMINE`）现在真的给出描述统计：中位数、四分位数、四分位数间距、偏度峰度与 Shapiro-Wilk 检验，箱线图仍在；可选正态 Q-Q 图（`normalPlot`）或只要统计量不要图（`noPlot`）。
- 一般线性模型支持多因子与协变量：不再是只认一个分组变量的 `GLM y BY g`，可以做随机区组（`GLM drop BY trt block /DESIGN=trt block`）、带协变量（`WITH`）和自定义设计项。
- 交叉表支持第三个「分层变量」：`CROSSTABS /TABLES=行 BY 列 BY 层`，相当于 SPSS 的「层 1 of 1」，不用再靠拆分文件；对话框里多了一个「分层变量（可选）」输入框。
- 拆分文件（`SPLIT FILE BY`）以前跑完就丢：PSPP 的拆分是会话级设置、不写进 `.sav`，每次运行都是新进程。现在工作区记住拆分变量，并在后续每次运行前自动重放，`SPLIT FILE OFF` 可以关闭；工具参数也接受文档里写的 `break`。

## 0.19.0

### 新增

- 多选题（MRSETS）：把几个是/否变量合并成一个集合，或把「第一/第二/第三选择」合成一个类别集合，然后在多选题面板里出频数表（响应数、百分比、个案百分比）或按分组变量出交叉表。
  - 二分法与多分类两种定义；多分类可以限定「计数哪些值」、选「每个响应者只算一次」，也可把没人选的类别列出来（计数 0）。
  - PSPP 2.1.3 只把 `MRSETS` 收进字典、任何命令都用不上（`FREQUENCIES /VARIABLES=$q1` 直接报 `$q1不是有效的变量名`），所以频数与交叉表由插件在数据上直接统计，不经过引擎。
  - 保存数据时把定义重放成 `MRSETS /MCGROUP … VARIABLES=…` 写进 `.sav`，SPSS 打开能认出这些集合。
- 报告卡：在输出里勾选若干个结果，按输出顺序重放它们背后的语法，导出成一份 PDF/ODT/`.spv` 文档。重放从当前工作数据出发，`SAVE` 与 `GET FILE` 头会被去掉，不会把变换再跑一遍、也不会改写数据文件。

### 修复

- 报告卡导出的语法若为空会给出明确提示（「报告卡里还没有可导出的内容：先勾选几个结果」），而不是让引擎去跑一个空脚本。

## 0.18.0

### 新增

- 交叉表的单元格多了期望频数、残差、标准化残差、调整残差和合计，判断「哪个格子偏离期望」不用再自己算。
- 描述统计可以要偏度、峰度及其标准误、中位数、众数，以及任意百分位数（`PERCENTILES=25 50 75`）。
- 数据视图右键菜单：复制、清空、设为系统缺失值、在第 N 行前插入个案、删除个案、按这一列升降序、跳到个案，以及「画这一列的直方图」。
- 输出可以导出为 SPSS 自己写的 `.spv` 输出档案，PSPP 跑完的结果能拿回 SPSS 打开。
- 输出里每张表可以单独「导出 CSV…」到指定路径，不必先导出整份。
- 图形菜单新增「快速图形（用当前选中的列）」：柱状图自动挑分类变量做分组、折线/面积自动找类别轴。
- 批量导入值标签时可以一次套用到所有同类型变量。
- 语法补全认识子命令与选项：`/` 后给子命令，`/STATISTICS=`、`/CELLS=`、`/CRITERIA=` 之后给 `MEAN`、`EXPECTED`、`HOMOGENEITY` 这类关键字。

### 修复

- `exec()` 现在真的尊重 `collectOutput`：二进制产物（`.spv` 是 zip）不再被按 UTF-8 读进内存。

## 0.17.2

### 修复

- 变量视图的变量名不显示：`editable('name', …)` 传入的三个子元素（拖动把手、名称、删除按钮）在运行期只留下第一个，名称与 × 根本不在 DOM 里。`editable` 改为 `(...content)` 收集可变子元素后，名称与删除按钮恢复显示，且名称可直接单击改名。
- 读 `.sav` 时对齐方式一律判成右对齐：字典里没写对齐（或写的是 PSPP 之外的词）就落到右对齐，字符串变量也被推到右边；现在按 PSPP 的规则回落（数值右、字符串左），面板和数据视图一致。


本文件记录插件自身的变化；**PSPP 引擎**的版本另算（当前 2.1.3，产物在 Release `engine-v*`）。
版本号遵循：补功能 → 次版本；只修 bug/文案 → 修订号。

## 0.17.1

### 修复
- 保存数据时补写 `FORMATS` 与 `VARIABLE ALIGNMENT`：宽度、小数位与对齐方式以前只存在于内存里，第二次打开文件全部退回默认值（数值一律右对齐、宽度 8、两位小数）。
- 面板的轮询签名加入变量列表（名字/对齐/格式/类型/标签），在对话里改标签或对齐后侧栏 3 秒内跟上，不再要等数据形状变化。
- 切到「数据视图」页签时重新读取行数据，切换页签后不再沿用上一份数据的列样式。

## 0.17.0

### 新增
- 数据视图「键入即编辑」：选中单元格后直接敲字符即进入编辑（与 SPSS 一致），回车提交并下移到下一个个案、Tab 提交并右移一行；最后一个案之后继续回车会自动追加个案。
- 变量视图单击单元格打开的空编辑器会把原值显示为占位提示，键入即替换，直接回车则保留原值。
- 列对齐按变量的对齐方式走：字符串默认左对齐、数值默认右对齐，变量视图里把某个变量改成「左」也立刻生效。

## 0.16.0
### 新增
- 变量视图支持「单击单元格就地编辑」：点名称格或名称文字直接改变量名，点宽度/小数/标签/缺失任意一格进入编辑；回车提交并下移一行，Tab 提交并右移，Esc 取消。
- 变量视图整表键盘导航：↑/↓ 选行，可打印字符直接进入该行的名称格编辑，Delete 删除选中变量。
### 修复
- 就地编辑的输入框改为非受控 + 读实时节点值，避免窗口级快捷键先于 React 合成事件触发提交时拿到空白内容导致「输入后回车没保存」。
- 顶端工具栏「新建变量」按钮不再被挤成两行。
- 数据视图最后一案与首个空白行之间的幽灵空行（尾随占位行被 CSS 最小行高撑起）。
- 变量视图选中行高亮改为与数据视图一致的浅蓝，不再出现「背景与文字同色」。

## 0.15.0

### 新增

- **变量视图整行选中与右键菜单**：单击选中一行，Shift 单击选一段，Ctrl 单击加选/取消；右键弹出菜单，可「新建变量…」「移到最前面」「移到最后面」「删除变量」（多选时批量操作）。
- **粘贴多格可以扩表**：从 Excel/Calc 复制一片数据，在数据视图按 `Ctrl+V`，超出最后变量或最后一个案的部分不再被丢弃——会自动补变量（`V1`、`V2`…）和个案，粘贴后提示「新增 N 个个案、M 个变量」。
- **从 Excel 复制会读 HTML 表格**：剪贴板里带 `text/html` 时优先用表格结构，单元格里含制表符或换行也不会错位（原来只看制表符分隔的纯文本）。

### 修复

- **最后一个案和第一条空白行之间多出一条灰行**：虚拟滚动的尾部占位行高度为 0 时，里面的单元格仍被行高规则撑成 22 px。占位行现在只在确实有被折叠的行时渲染，且单元格不再参与行高计算。
- **「新建变量」按钮被挤成两行**：工具条里的按钮会被提示文字挤压换行，已禁止收缩。
- **变量视图选中行的高亮盖住文字**：改为与数据视图一致的淡蓝底，文字保持正常对比度。

## 0.14.0

### 新增

- **变量顺序可调整**：变量视图每行左侧多了拖动把手，把变量拖到另一行即可改变顺序；数据视图里直接拖动列头也一样（拖到目标列左半边插到它前面，右半边插到后面）。两种方式走同一个接口，数据视图的列顺序、分析语法里的变量顺序会跟着一起变，撤销记录里记为「调整变量顺序」。
- **变量视图底部「＋ 单击这一行新建变量」**：像 SPSS 的变量视图那样，在最后一行下方点一下就能输入变量名新建（留空则自动命名为 `V1`、`V2`…），不用再翻菜单。
- **数据视图空白格可以直接输入**：单击空白格开始编辑；最后一个案之后的空白行也能直接输入，会自动补个案。

### 修复

- **数据视图里会凭空出现一条灰行**：空白行是单独的一行，斑马纹按 `nth-child` 计数时把表头算了进去，导致第一个空白行被涂成深色像多出一行。空白行现在单独配色。
- **「插入变量」点了报 `VariableDialog is not defined`**：该对话框在一次重构里被删掉但调用还留着。已改为转到变量视图底部的新建行。
- 单元格内按 Tab/Enter 之后焦点丢失，无法继续键入；现在会回到表格继续操作。

### 变更

- 数据菜单的「插入变量…」改为「新建变量（转到变量视图最后一行）」。

## 0.13.0

### 新增

- **数据视图铺满，像 SPSS 的编辑区**：最后一行变量右边、最后一个案下边都是一格一格的空白区，不再是空白一片。
  - 双击空列的列头、或双击任意空白格，直接弹出输入框；填进去的值马上写进这一格，同时自动建一个变量（名字 `V3`、`V4`…，按输入判断数值还是字符串）。
  - 在最后一个案下面双击已有变量的单元格，会先补齐到那一行的所有个案再写值，不用先点「插入个案」。
  - 空白列按面板宽度自动摊开：列少时摊宽填满，列多时保持 96 px 并横向滚动。

## 0.12.3

### 修复

- **数据视图最左边的行号列看不见**：行号格同时带上了冻结首列的类，于是第一列那条 `left:52px` 的 sticky 规则盖掉了行号自己的 `left:0`，把整列行号推到第一列的位置、被第一列压住。现在行号格不再借用列冻结的类，另给一条更高优先级的 `left:0`，行号固定在最左边、第一列固定在它右侧，和变量视图的表现一致。

## 0.12.2

### 修复

- **数据视图右侧空出一大片**：表格宽度原来只等于各列宽度之和，变量少的时候（比如 2 个变量约 245 px）右边会空出大半屏。现在补一根**填充列**吃掉剩余宽度，表格总是铺到右边界 —— 这是 SPSS 的做法。没有直接把表格拉到 100%，因为那样行号列也会被等比拉伸（实测会从 52 px 变成 213 px）。填充列会在列宽拖大、或窗口变窄时自动缩到 0；列比面板宽时照常横向滚动，冻结列不受影响。

## 0.12.1

### 新增

- **数据 → 关闭加权**：原先加权对话框必须选一个变量，做完加权汇总数据的分析后没法在界面里关掉加权（教材明确要求分析完 `WEIGHT OFF`）。现在菜单里紧挨「加权个案…」多了一项「关闭加权」，直接发 `WEIGHT OFF`。

## 0.12.0

### 新增

- **百分比堆叠柱**：条形图「条形图选项」里勾「堆叠按百分比」，每根柱按自身合计归一化到 100%，段内标注占比，纵轴固定 0–100。没选堆叠变量时该选项自动无效（没有可归一化的东西）。
- **误差线折线图**：折线图「折线图选项」里勾「显示误差线」，每个点带 ±1 个样本标准差的须线；某类别只有 1 个个案时不画须线（无离散度可言）。
- **面积图**：图形菜单新增「面积图…」，类别轴上按均值画填充趋势；选了「分层变量」就变成堆叠面积（各层累加），没选就是单条填充曲线。`pspp_chart` 的 `type` 支持 `area`。

### 修复

- **PNG 导出丢失面积图**：光栅化器不认 `<polygon>`，导出后整张面积图空白。现补上多边形填充（扫描线 + 奇偶规则），描边同样走现有线段绘制。
- 删掉一段永远走不到的百分比堆叠分派分支（`renderSvg` 里 `model.kind === 'bar'` 已被 `renderBar` 接走），形态判断统一放在 `renderBar` 内部。

## 0.11.0

### 新增

- **折线图分线**：折线图对话框多了「分线变量（可选）」，选上之后同一个类别轴上按该变量的每个取值画一条线（SPSS 里「线表示：变量」的那种）。某个类别在某个取值下没有个案时，那条线在该处断开，而不是直接连过去；多条线自动配色并带图例。`pspp_chart` 的 `cluster` 参数同样适用于 `line`。
- **环形图**：饼图对话框的「饼图选项」里勾「显示为环形图」，扇区变成圆环，占比数字直接画在环上（扇区太窄就不标，避免叠字）。是否环形记在图表模型里（`donut: true`），所以重新渲染、编辑、导出都不会丢。

### 修复

- **PNG 导出丢失环形图主体**：光栅化器原先只认 rect/line/polyline/circle，而饼图和环形图的扇区是 `<path>` 的圆弧，导出后整张图只剩图例。现在补上 `path` 支持（`M/L/A/Z`，按 SVG 1.1 椭圆弧规范采样 64 步，再按偶奇规则填充，所以环形中间的空洞是真的空的）。纯描边路径只描边不填充。
- 环形图渲染原先依赖调用方再传一次 `donut`，重放或编辑后就会退回实心饼；现在 `computePie` 把它写进模型。

## 0.10.0

### 新增

- **条形图三种形态**：普通柱、**分组并列柱**（`cluster`，第二个变量把每根柱拆成并排几根，自动配色并画图例）、**堆叠柱**（`stack`，第二个变量把每根柱切成上下几段，正负分段都从零向两侧累加）。图表对话框新增「分组（并列）」与「堆叠」两个字段，`pspp_chart` 增加同名参数。
- **误差线**：条形图可画 ±1 个标准差（样本估计，n−1 分母，与 SPSS 的 SE/SD 口径一致）；每组少于 2 个案时不画。对话框里在「条形图选项」二级面板勾选，工具侧是 `errorBars: true`。
- 条形图改由插件自绘（此前交给引擎），这是分组、堆叠与误差线能存在的前提；标题会标明形态与是否带误差线。

### 修复

- 堆叠柱的第二段此前从零向下画（累加方向写反），现在按数据单位累加，正段向上、负段向下，段与段严丝合缝。
- 类别轴、分组、堆叠选到同一个变量时此前会画出重复/重叠的柱子，现在直接报错说明。
## 0.9.0

### 新增

- **输出摘要行**：输出导航栏里每张表下面显示一行统计摘要，例如 `F=139.28 · df=2 · p=.000`（方差分析）或 `N=60 · 均值=59.3450 · SD=9.07276`（描述统计）。取值来自 PSPP 的英文列头（`N`、`t`、`F`、`Chi-Square`、`U`、`Z`、`df`、`Sig.`、`Mean`、`Std. Deviation`），认不出的表不显示摘要。
- **图表导出 PNG / SVG**：输出里每张图多了「导出 PNG」「导出 SVG」两个按钮（走文件选择框，默认文件名取图表标题）。
  - SVG：原样复制引擎渲染的矢量图，文字可编辑。
  - PNG：新增 `lib/raster.js`，把 SVG 子集（rect/line/polyline/circle）光栅化并自写 PNG 编码器（IHDR/IDAT/IEND + CRC-32 + deflate），**没有新增依赖**。**文字不绘制**（没有字体光栅化器，标签留给文档）；`scale` 可放大到 4 倍。
  - 新增工具 `pspp_export_chart`（`path` + `runId` 或图表 `url` + `scale`），`capabilities.exports` 增加 `.png`、`.svg`。

### 修复

- `parseSvg` 的属性名正则写成 `[A-Za-z-]+`，把 `x1="…"` 吃成 `x`、`y2` 吃成 `y`，导致导出的 PNG 里所有坐标轴线都落在原地或画错位置——改成 `[A-Za-z][A-Za-z0-9-]*`。
- `drawLine` 拿到 `NaN` 坐标时会无限循环（`fillRect` 对 `NaN` 静默返回，Bresenham 永远走不到终点），把 `rasterizeSvg` 卡死；现在数值统一走 `num()` 解析，解析不出的点直接跳过。
- 三种/四种/八位十六进制颜色（`#333`、`#3344`、`#33445566`）此前只认六位，坐标轴颜色 `#333` 全被当透明；现在四种长度都认，并且保留透明度。

## 0.8.0

### 新增

- **冻结首行/首列**（数据视图）：默认冻结列标题行与行号列，视图菜单可分别关闭，选择记在 localStorage（`ap.freezeRows` / `ap.freezeCols`）。冻结列宽按行号列实测宽度对齐，斑马纹、选中态、单元格编辑框都跟着冻结列走。
- **跳转到个案**（视图 → 跳转到个案…）：输入个案号回车即定位并选中；目标行不在当前窗口里时先向 host 拉取附近的行。
- **在输出中查找**（视图 → 在输出中查找…）：按关键字筛选输出项（标题、图注、表格标题与全部单元格），状态栏显示「命中/总数」并可一键清除。
- **保存语法文件（.sps）**（文件 → 保存语法文件…）：把语法编辑器的内容写到磁盘（host 端 `POST api/saveSyntax`，只接受 `.sps`，自动建目录、末尾补换行），默认路径是当前目录的 `<数据集名>.sps`。
- **导出输出为 Word（.docx）/ Excel（.xlsx）**：`lib/zip.js` 自写 ZIP（store 方式 + CRC-32），`lib/office.js` 自写 OOXML，**没有新增任何运行时依赖**。
  - `.docx`：表格按三线表样式排版（表头行上下线 + 行间细线），图表以 PNG 内嵌（取自产生当前输出的那一轮 run，图不重放、URL 不变），A4 版面，标题居中。
  - `.xlsx`：每张表一个工作表，表名取表格标题（非法字符替换、重名加序号、截断到 31 字符），标题合并首行，纯数字写成数值型单元格（Excel 里可直接求和作图）。
  - 新增工具 `pspp_export_office`（`path` → `.docx`/`.xlsx`），`pspp_status` 的 `capabilities.exports` 列出新格式。
- 修复：`.docx` 内嵌图表时按 `item.url` 找图，而面板输出项用的是 `artifactUrl`，导致「图表缺失」——现在两字段都认（`test/office.mjs` 有回归断言）。

## 0.7.0

### 新增

- **单因素 ANOVA 事后检验可选**：Tukey / LSD / Bonferroni / **Sidak** / **Scheffé**（原来只有前三个且 Tukey 默认勾选）。实测 PSPP 2.1.3 只实现这五种，Gabriel、Dunnett、Duncan、SNK、REGW 会报 `Unknown post hoc analysis method`，因此不放进对话框；同时补上 `/STATISTICS=… HOMOGENEITY`（Levene）选项。`pspp_analyze` 新增 `postHoc` 与 `homogeneity` 参数。
- **双变量相关的选项补全**：单尾/双尾、显著性列（`SIG`/`NOSIG`）、描述统计量（`/STATISTICS=DESCRIPTIVES`）、成对/整行排除缺失（`/MISSING=PAIRWISE|LISTWISE`）。`pspp_analyze` 同步支持 `oneTailed`、`noSignificance`、`missing`、`statistics`。
- **批量导入值标签**（数据 → 批量导入值标签…）：粘贴「值,标签」两列或直接粘贴 `VALUE LABELS …` 语句，自动识别列顺序（第二列是数字时按「标签,值」读），支持从文件读取（4 MB 上限，自动判 UTF-8/GB18030），可选「保留原有标签」合并模式；整次导入只记一条撤销记录（`Workspace.setValueLabels` + `POST api/valuelabels` + `POST api/readFile`）。
- **语法编辑器补全**：输入时提示数据集变量名（变量优先）、已用变量与 PSPP 命令；`↑↓` 选择、`Enter`/`Tab` 补全、`Esc` 关闭、`Ctrl+Space` 手动打开；注释内部不提示。
- **输出表格样式**（视图 → 输出表格样式）：默认 / **三线表（论文用）** / 全框线 / 无框线，记在 localStorage。

### 修复

- 移除 11-05 改名时留下的兼容软链依赖：`<项目目录>/dsh-analytics-pspp` 已移入备份目录，插件重启后从 `<项目目录>` 解析引擎。

## 0.6.7

### 修复

- **保存不再在数据文件旁留下临时文件**：写盘要用一份暂存的 CSV（`<目标>.source.csv`）喂给引擎，而它此前没有删掉，保存几次就在文件夹里堆几个 `<数据文件>.tmp-<pid>-<时间戳>.source.csv`。现在暂存 CSV 与失败时的 `.tmp-<pid>-<时间戳>` 系统文件都会清掉，`test/smoke.mjs` 增加断言守着。
- **「文件」面板打开数据文件时不再闪一下中转标签**：转交标签的关闭从 `useEffect`（首帧之后）改成 `useLayoutEffect` 里立刻执行，标签在挂载的同一个提交里就被关掉，浏览器不会画出那一格；重试间隔也压到 60/320 ms，并记住已关过的标签 id，避免重复关闭。

## 0.6.6

### 变更

- **接入 `dsh-plugin-toolkit` 的检查**：`npm run doctor`（九项清单）与 `npm run verify:pack`（打成 tarball、装进临时目录、确认装完的副本里有面板代码）都进了 CI；`package.json` 补 `engines.dsh`、README 补 Requirements 段——这两条正是插件市场索引会拒的地方。
- **新增客户端测试 `test/client.mjs`**（jsdom + 真 React）：把 bundle 按宿主的加载方式求值，断言页签与文件查看器的注册、菜单栏渲染、空工作台不显示文档标签条，以及「文件面板转交后关掉自己的中转标签」这条回归。`npm test` 现在 50 项。
- 开发依赖：`dsh-plugin-toolkit`、`jsdom`、`react`、`react-dom`（仅测试用，插件运行时仍然零依赖）。

### 说明

- 工具自带的面板挂载检查对**依赖 `dsh-better-sidebar` 的插件不成立**（stub host 没有 `betterSidebar`），CI 用 `--no-mount`，客户端那一半由我们自己的 jsdom host 覆盖。
- 工具的 `verify` 读 `npm pack --json`，npm 12 的输出形状与之不符（对象 vs 数组），本地要跑请用 npm ≤ 11；CI 的 node 20/22 自带的 npm 没问题。

## 0.6.5

### 修正

- **中转标签页终于会自己关掉**。两个真实原因：① 客户端不能用 `ctx.sidebarRight` 这种属性写法读服务——cordis 会抛 `cannot get property "sidebarRight" without inject`（我们没在 `inject` 里声明它），必须用无守卫的 `ctx.get('sidebarRight')`；② `tabsIn()` 返回的 `TabRecord` 只有 `id`/`kind`/`title`，**没有 address 也没有 path**，所以按完整路径匹配永远不命中，改成把标题与文件 basename 对比后才真正关掉。已在真机验证：点 `第5题_两独立样本秩和检验.sav` 后，侧栏不再残留中转标签，面板直接显示 16 个案 · 2 变量，状态栏是真实路径。

## 0.6.4

### 修正

- **中转标签页的兜底关闭**：`ctx.sidebarRight` 与注册表两条路都是「按 id 关」，而原生资源标签的 id 取决于 DSH 实现；两条都落空时，按标签标题等于该文件名找到那个标签并点它自己的关闭按钮（已在真实 DOM 上验证能定位到 `nArs4W_tab` 与 `nArs4W_tabClose`）。这一层只在前两层失败后、且标题完全同名时才动手。

## 0.6.3

### 修正

- **转交用的中转标签页真的会自己关掉了**：从「文件」面板点开的标签页是侧栏原生的资源标签（它的 id 不是 `editor:<路径>`），所以按注册表 id 关闭一直无效、页面里留着一条「正在「统计分析」中打开 …」的标签。现在先向 `ctx.sidebarRight` 查这个会话里哪些标签挂着该路径，命中后用 `closeIn(sessionId, id)` 关；查不到再退回注册表 `closeTab`。占位页也给了「关闭这个标签页」按钮兜底。
- **非活动文档标签不再一律显示「数据集」**：以前标签文案取的是"当前数据集名"，切换后其它标签就退回「数据集」；现在每个文档记住自己的名字（数据集就位即写入），只有还没打开数据时才显示「数据集」。
- **空面板不再显示标签条**：只有一个文档、且还没有任何数据集时不渲染标签条，避免出现一个点了也没变化的「数据集」标签；打开数据后标签条照常常驻。

## 0.6.2

### 变更

- **「文件」面板里点数据文件不再另开标签页**：那个标签页现在只做转交（把路径给面板、把面板切到前台、自己关掉），文件作为**面板内的一份文档**打开，文档标签条上多一个以文件名命名的标签。这样所有数据集都活在同一個工作台里，不需要在侧栏里来回切。
- **文档标签条常驻**：以前只有一个文档时会把整条标签条藏起来，现在无论几个都显示（SPSS 的 Data Editor 也是这样）。

### 修正

- 文件查看器标签挂载时不再被面板的「自己新建的标签才自动打开」握手拦住（上一版 0.6.1 的修补保留在工作区恢复路径上）。

## 0.6.1

### 修正

- **从「文件」树点 `.sav` 打开的是空面板**：文件查看器标签不是面板自己新建的，挂载时的「按 `tab.path` 打开」被 `PENDING_OPEN` 握手拦住了（那个集合只登记面板内新建的标签），于是界面停在「尚未打开数据集」。现在查看器标签带 `meta.fromViewer`，挂载时直接打开，且工作区已有数据集时只恢复不重开。

## 0.6.0

### 新增

- **图表编辑器**：输出里的图片条支持「编辑图表」（双击图也可），可改标题、X/Y 轴标题、主色、类别排序，改完就地重算同一个 `chart.svg`；模型侧对应新工具 `pspp_edit_chart`，`pspp_chart` 也接受同样的覆盖参数。实现上新增 `applyChartOverrides()`，`renderSvg` 的所有主色都走 `model.accent ?? 默认色`。
- **三个非参数子过程**：McNemar（两个相关样本的二分类差异）、Cochran Q（三个以上相关样本的二分类）、Kendall W（三个以上评分者的一致性）。面板里在「分析 → 非参数检验」下，模型侧是 `pspp_analyze` 的 `npar_mcnemar` / `npar_cochran` / `npar_kendall`。

### 改名

- 插件内部入口 id 由 `analytics-pspp` 改为 **`analytics`**：`plugin_manager` 里改代码后重载要用 `include:analytics`；`cordis.patch.yml` 的 entry id 同步改。**这属于启动期配置，重启 dsh 后才生效**，重启前旧 id 仍然可用。
- 项目目录改为 `<项目目录>`（旧的 `dsh-analytics-pspp` 留了一个软链指过来，运行中的进程不会断）。
- 兼容保留：HTTP 前缀 `/analytics-pspp`、环境变量 `DSH_ANALYTICS_PSPP_ENGINE`、旧工作区目录 `~/.dsh/analytics-pspp`（首次启动自动改名）。

### 不做

- **MRSETS（多重响应集）**：PSPP 2.1.3 的语法解析要求 `NAME/VARIABLES/LABEL` 而是实测报错，且引擎自己提示 *"MRSETS is implemented but no other commands support multiple response sets yet"* —— 定义出来没有任何命令能消费，做了也是死功能。
- **DATASET（多数据集管理）**：引擎支持，但插件已经用「面板内文档标签条 + 每文档独立工作区」实现了同等能力，再引入 `DATASET` 会有两套互相打架的概念。

## 0.5.0

### 改名

- 插件改名为 **dsh-analytics**（包名、模块 id、HTTP 前缀 `/analytics`、文档、GitHub 仓库）。它的内核仍然是 GNU PSPP，界面仍然按 SPSS 的操作范式组织——名字说的是用途，PSPP 说的是引擎。
- 兼容：旧的 HTTP 前缀 `/analytics-pspp` 仍然可用；环境变量旧名 `DSH_ANALYTICS_PSPP_ENGINE` 仍然认；旧的 `~/.dsh/analytics-pspp` 工作区目录在首次启动时改名成 `~/.dsh/analytics`（改名失败就继续用旧目录，不丢数据）。
- 侧栏页签标题从「PSPP」改成「统计分析」，说明文字写明是内置 GNU PSPP 引擎。
- **需要一次 dsh web 重启**才会切到新包名（bundle patch 的入口 id 属于启动期配置）；重启前当前实例继续跑旧代码。

### 新增

- **在「文件」面板直接打开数据文件**：注册 better-sidebar 文件查看器 `analytics:data`（`.sav .por .sys .dta`），点开即用这个面板，每份文件一个独立工作区（`file-<hash>`）。`.csv/.xlsx/.ods/.txt` 故意不接管，留给通用查看器。

### 修正

- 语法编辑器的占位提示改为「在此输入 PSPP 语法或导入 sps 语法文件」。
- 注入样式表的 `data-analytics` 属性名与查找条件不一致（每次挂载都会多插一个 `<style>`），已对齐。

## 0.4.0

### 新增

- **Stata 文件导入（`.dta`，release 117/118）**：`lib/dta.js`，零依赖。读二进制 `<K>`（16 位）与 `<N>`（64 位）字段，按段长推导 117/118 之间变宽的名字段（33→129 字节）与标签段（81→321 字节）；支持 byte/int/long/float/double/str#，各类型的顶部编码识别为系统缺失；变量标签、值标签、格式串（`%12.2f` → `F12.2`）一并带入。旧版 113–115 与含 strL 的文件给出明确提示。
- **OpenDocument 表格导入（`.ods`）**：`lib/ods.js`，复用 `.xlsx` 的 ZIP/XML 解析，读 `office:value-type`（数值/字符串/布尔/日期/货币/百分比），展开行列重复标记并对超长空行重复提前收敛，合并单元格记为空格，`text:s`/`text:line-break` 还原。
- **语法编辑器行号与高亮**：左侧行号栏 + 透明 textarea 背后的高亮层（命令、子命令、字符串、数字、`*` 与 `/* */` 注释五类着色，深色主题自动换亮一档）；`Tab` 在编辑器内缩进两个空格；滚动与行号同步。

### 测试

- 新增 `test/ods.mjs`（6 项）、`test/dta.mjs`（7 项，含 R `haven` 写出的真实 118 文件 `test/fixtures/haven-118.dta`）；ZIP 写入器抽到 `test/zip.mjs` 供 `.xlsx`/`.ods` 两个测试共用。

## 0.3.4

### 修正

- **语法草稿在各标签页之间串台**：语法编辑器原来只有一个全局 `syntax` 状态，拖入一个 `.sps` 后切到任何数据标签页看到的都是同一段。现在每个文档各存一份（localStorage `ap.syntaxByDoc`，键为文档 id），切标签换草稿、关文档丢草稿。

## 0.3.3

### 修正

- **拖入 `.sps` 没有出现在语法编辑器**：`api/open` 早就返回 `{kind:'syntax',text}`，但客户端只认 `state`，结果既没显示语法，还把面板状态清成了空。
- **拖入 `.sps` 之后拖入的 `.sav` 张冠李戴**：`.sps` 曾被当成一个"文档"记账（但它没有数据集），下一个数据文件就落进了这个文档的会话，标签页还挂着 `.sps` 的名字。现在语法文件单独处理：填语法编辑器、切视图、不建文档、不动数据集。
- **偶数行选中不变蓝**：斑马纹规则（`tbody tr:nth-child(even) td`）比选区规则更具体，一直压着它；补了同等级的 `.ap-cell-selected` 规则。
- **双击编辑框里的值跟格子不一致**：开着值标签时格子显示「男」、编辑框却是 `1`。现在编辑框以显示文本为初值，提交时把标签反查回数值。

## 0.3.2

### 新增

- **数据视图块粘贴**：`Ctrl+V` 把剪贴板里的制表符/换行块写进选区左上角；越界忽略、整块先校验后写入（一个数字不对就一个都不写）、整次粘贴是一步撤销。新路由 `POST api/paste` 与 `Workspace.setCells`。

### 修正

- **拖选时不再同时出现浏览器原生文本高亮**：网格加 `user-select:none`（输入框、下拉框仍是可选的），之前两种高亮叠在一起、形状还不一样。
- **语法编辑器跟随主题**：`textarea` 之前没设背景色，深色主题下是一块浅色底；现在用 `--ap-panel` / `--ap-text` / `--ap-accent` 光标色。

## 0.3.1

### 新增

- **变量视图列宽可拖**：表头右边界拖动（48–600 px），双击恢复默认，宽度存 `ap.varWidths`。
- **输出项折叠 / 单条删除**：每项输出有 `▾/▸` 与「删除」按钮；折叠只是视图状态（导航栏同步变淡），删除走新路由 `POST api/output`，只移除该项，不动数据与其它输出。
- **直方图叠加正态曲线**：自绘 SVG 里按「期望频数 = n × 箱宽 × 密度」与柱子同尺度画折线，右上角标 μ/σ；`buildChartModel` 的直方图模型新增 `normal` 字段。

### 修正

- 变量视图工具条原来写死 `#f4f5f8` / `#d5d8dd`，深色主题下是一块白条；改用 `--ap-bar` / `--ap-line-2`。

## 0.3.0

### 新增

- **Excel（`.xlsx`）导入**：自带零依赖解析层 `lib/xlsx.js`（Node 内置 `zlib` 解 ZIP + 读 workbook/sharedStrings/styles/worksheets）。多工作表弹窗选表，`pspp_open` 用 `sheet` 参数。26k 行实测 0.74 s。
- **文本导入选项**：编码（自动/UTF-8/GBK/GB18030/Big5/Latin-1）、分隔符（自动/`,`/`;`/Tab/`|`）、首行是否变量名；非 ASCII 列名转 `V1…Vn` 并把原名写进变量标签。
- **回归保存预测值/残差**：`REGRESSION … /SAVE=PRED RESID ZPRED ZRESID SRESID COOK`，写回数据集；对话侧 `pspp_analyze` 的 `save` 参数同样生效。
- **自动重新编码**（`AUTORECODE`）：字符串分类 → 连续编号，值标签自动带过去。
- **Jonckheere-Terpstra 检验**（有序备择的非参数检验）。
- **交叉表统计量透传**：`pspp_analyze` 的 `statistics`/`cells` 不再写死，可用 KAPPA、RISK、ETA 等。
- **两种分发包**：`npm run pack`（自带本机引擎，13 MB）/ `npm run pack:portable`（3.0 MB，装后 `npm run engine:fetch`）。

### 界面

- **跟随主题与字体**：颜色改由 Harness token 派生（文字色混合出工具条/表头/网格线/斑马纹），字体字号跟随「设置 → 通用」，表格行高随字号伸缩；根元素输出 `data-dsh-plugin` 等语义属性，皮肤中心 L2 可命中。
- 拖入文件的命名改回唯一时间戳前缀（同一文件反复拖入不再变 `(3)`），显示一律去前缀。
- 副本的 `sourcePath` 在 host 侧就返回 `null`，界面任何位置都不会再出现 `uploads/…` 完整路径（含第 2、3 份文档——它们各自工作区打开别人的 `uploads/` 副本，此前被判成真文件）。

### 修正

- 面板内多文档/底部多标签的能力边界写进文档：右栏一种插件只保留一个标签，改用面板内文档条。
- `docs/FEATURES.md` 里描述「行高菜单 18/22/28/34」等于代码里已被撤掉的功能，已改成实际行为。

## 0.2.0

这一版补齐了“界面行为”和“跨平台交付”，也修掉了多轮迭代里积累的一批界面 bug。

### 新增

- **撤销 / 重做**：编辑菜单与 Ctrl+Z / Ctrl+Y；单元格编辑记前后值，结构改动（插删个案/变量、排序、转置、合并、写回数据的语法）记整份快照；栈深 30 步。
- **查找 / 替换**：Ctrl+F，可选区分大小写、整格匹配；数值变量只做整格替换。
- **值标签显示开关**：数据视图可在“标签 / 数值”之间切换（localStorage 记忆）。
- **拖放上传**：文件拖进面板即可打开；支持 `.sav/.por/.sys/.csv/.txt/.tsv/.sps`，上限 64 MB。
- **文本导入选项**：打开 `.csv/.txt/.tsv` 时先选**编码**（自动 / UTF-8 / GBK / GB18030 / Big5 / Latin-1）、**分隔符**（自动 / `,` / `;` / Tab / `|`）、**首行是否变量名**。自动模式先严格按 UTF-8 解，失败再按 GB18030。
- **pspp-convert 转换**：文件菜单里把当前数据转成 `.sav/.por/.csv/.txt/.ods/.html` 等。
- **NPAR 子过程 8 个**：二项、K-S、游程、Wilcoxon、符号、M-W、K-W、Friedman。
- **合并文件**：添加个案（ADD FILES）、按关键变量合并（MATCH FILES /BY）。
- **导出 PDF / ODT**：把上一次运行的分析结果按原语法重放成文档（中文实测正常）。
- **图表扩充**：箱线图、折线图、饼图（自绘 SVG），共 6 种。
- **缺失值编辑**：变量视图「缺失」列可填离散值，写回 `MISSING VALUES`。
- **面板内文档列表**：右栏一个标签只能显示一个面板时，第二份数据在面板内并列（底部工作台仍用真标签页）。

### 界面修正

- 列宽可拖（40–600 px，双击边缘自适应）；Ctrl/Shift 多选与拖框选择；`Ctrl+C` 复制选中单元格。
- 状态栏显示**打开文件的完整路径**；拖入的副本只显示文件名并标注 `（拖入副本 · 路径未知）`——浏览器从不为拖放文件提供路径。
- 打开/另存为对话框从**当前会话的工作目录**起步，不再从 dsh 服务进程的 cwd 起步。
- 面板不再自带“跟随皮肤”的配色实验：恢复固定的浅灰 SPSS 风格（那次改动导致条纹变黑白、拖入覆盖原数据）。
- 拖入的文件落盘为 `<时间戳><序号>-<原名>`，**同一文件反复拖入不再变成 `名字 (3).sav`**；显示时始终去掉前缀。

### 引擎与交付

- 引擎改为**按平台目录** `engine/<platform>-<arch>/`，随包 `linux-x64`（glibc ≥ 2.28，23 MB，45 个共享库）。
- **CI 产出五个平台**：linux-x64、linux-arm64、darwin-arm64、darwin-x64、win32-x64；发布在 Release `engine-v1`，`npm run engine:fetch` 按平台取回。
- 插件 CI：`test.yml`（Node 20/22，`node --check` + 纯函数测试）；引擎 CI 只在 `workflow_dispatch` 或 `engine-v*` 标签时跑。

### 测试

`npm test` = build（语法构造/图表模型/文本导入）+ engine（引擎定位与环境变量）+ smoke（引擎端到端、恢复规则、上传命名）+ routes（22 条 HTTP 路由、多文档、副本保存保护）。

## 0.1.0

- 首个可用版本：SPSS 风格面板、37 个对话框、12 个 `pspp_*` 工具、撤销/重做之前的数据编辑、CSV/SAV 导入导出、NPAR 之前的统计过程、内置 PSPP 2.1.3 引擎。
