import assert from 'node:assert'
import { describeEngineCrash, describeEngineError } from '../lib/fserr.js'
import { describeFailure } from '../lib/workspace.js'
import { localize } from '../lib/i18n.js'

let checks = 0
function check(name, body) {
  try {
    body()
    checks += 1
    console.log(`ok   ${checks} - ${name}`)
  } catch (error) {
    checks += 1
    process.exitCode = 1
    console.log(`FAIL  ${name}: ${error.message}`)
  }
}

// The banner PSPP 2.1.3 prints when one of its own defects fires. Captured from
// the bundled engine: `CROSSTABS /STATISTICS=RISK` on an A1 grouping variable
// dies with SIGSEGV, and the exit code is 139 on Linux and 3 on Windows for the
// very same crash — which is why the code must never be the test.
const BANNER = [
  '******************************************************',
  'You have discovered a bug in PSPP.  Please report this',
  'to bug-gnu-pspp@gnu.org.  Please include this entire',
  'message, *plus* several lines of output just above it.',
  'For the best chance at having the bug fixed, also',
  'include the syntax file that triggered it and a sample',
  'of any data file used for input.',
  'proximate cause:     Segmentation Violation',
  'version:             GNU pspp 2.1.3',
  'host_system:         x86_64-pc-linux-gnu',
  'build_system:        x86_64-pc-linux-gnu',
  'locale_dir:          /work/out/share/locale',
  '******************************************************',
].join('\n')

const SYNTAX = 'C:\\Users\\me\\AppData\\Local\\Temp\\runs\\9\\run.sps:2: error: Unknown command'

check('a real crash banner is reported as an engine defect, not a syntax error', () => {
  const said = describeFailure({ code: 139, stderr: BANNER })
  assert.match(said, /PSPP/)
  assert.match(said, /缺陷/)
  assert.match(said, /不是你的数据或语法问题/)
  assert.match(said, /Segmentation Violation/)
  assert.match(said, /退出码 139/)
  // The build host and version lines are what made the old message useless.
  assert.doesNotMatch(said, /build_system/)
  assert.doesNotMatch(said, /host_system/)
  assert.doesNotMatch(said, /version:/)
  // The temporary syntax file the user never saw must not leak either.
  assert.doesNotMatch(said, /run\.sps/)
  // Actionable: change the approach and report the defect.
  assert.match(said, /换一种做法再试/)
  assert.match(said, /反馈给插件维护者/)
})

check('the crash paragraph is translatable, exit code included', () => {
  // It used to be glued together with `${}`: no dictionary key can match a
  // sentence that is already built, so the English interface showed the whole
  // paragraph in Chinese.
  const said = describeFailure({ code: 139, stderr: BANNER })
  const english = localize(said, 'en')
  assert.doesNotMatch(english, /[\u4e00-\u9fff]/, `no Chinese left: ${english}`)
  assert.match(english, /\(exit code 139\)/, 'the exit code keeps its brackets in English')
  assert.match(english, /defect in PSPP itself/, 'the point of the message survives')
})

check('the same crash on Windows (exit code 3) takes the same branch', () => {
  const linux = describeFailure({ code: 139, stderr: BANNER })
  const windows = describeFailure({ code: 3, stderr: BANNER })
  assert.match(windows, /退出码 3/)
  assert.match(windows, /Segmentation Violation/)
  assert.doesNotMatch(windows, /build_system/)
  assert.doesNotMatch(windows, /run\.sps/)
  // Identical wording apart from the exit code reference.
  assert.equal(windows.replace('退出码 3', '退出码 139'), linux)
})

check('a banner without a proximate cause still says it is a defect and names no reason', () => {
  const said = describeFailure({
    code: 139,
    stderr: 'You have discovered a bug in PSPP.  Please report this to bug-gnu-pspp@gnu.org.',
  })
  assert.match(said, /PSPP/)
  assert.match(said, /缺陷/)
  assert.match(said, /没有给出原因/)
  assert.doesNotMatch(said, /build_system/)
  assert.doesNotMatch(said, /Segmentation Violation/)
})

check('an ordinary syntax error keeps the old one-line wording', () => {
  assert.equal(describeEngineCrash(SYNTAX), null)
  const said = describeFailure({ code: 1, stderr: SYNTAX })
  assert.equal(said, '退出码 1：Unknown command')
  assert.doesNotMatch(said, /引擎崩溃/)
  assert.doesNotMatch(said, /PSPP/)
})

check('a file name that merely contains the banner words is not a crash', () => {
  // Linux allows these names, and claiming a crash here would replace the real
  // "cannot open" reason with a bug report that never happened.
  for (const name of ['proximate cause: report.sav', 'segmentation violation.csv']) {
    const said = describeEngineError(`cannot open ${name}: No such file or directory`, name)
    assert.match(said, /打不开/)
    assert.doesNotMatch(said, /引擎崩溃|缺陷/)
  }
  // The banner fields are what makes the difference: the same words plus the
  // real report shape do count.
  const banner = describeEngineError('proximate cause: Segmentation Violation\nhost_system: x86_64-pc-linux-gnu', 'x.sav')
  assert.match(banner, /引擎崩溃/)
})

check('a crash under a file operation never reads as "cannot open"', () => {
  const said = describeEngineError(BANNER, 'out.pdf', 139)
  assert.doesNotMatch(said, /打不开/)
  assert.match(said, /PSPP/)
  assert.match(said, /缺陷/)
  assert.match(said, /Segmentation Violation/)
  assert.match(said, /out\.pdf/)
  assert.doesNotMatch(said, /build_system/)
})

check('a crash killed by a signal still shows the shell-style exit code', () => {
  // Node reports code null and signal SIGSEGV for the same death; 139 is what
  // the user would see in a terminal, and it is only a reference, never a test.
  const said = describeFailure({ code: null, signal: 'SIGSEGV', stderr: BANNER })
  assert.match(said, /退出码 139/)
  assert.match(said, /缺陷/)
})

console.log(`\n${checks} checks passed in test/crash.mjs`)
if (checks < 6) process.exitCode = 1
