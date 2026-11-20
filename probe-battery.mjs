import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceRegistry } from './lib/workspace.js'
import { resolveEngine } from './lib/engine.js'

const root = await mkdtemp(join(tmpdir(), 'apbat-'))
const reg = new WorkspaceRegistry({ engine: resolveEngine(), root, config: {} })
const ws = await reg.ensure('bat', root)
const rows = []
for (let i = 0; i < 30; i++) rows.push([i % 3 + 1, 10 + (i % 7), 20 + (i % 5), 30 - (i % 4)])
await ws.createDataset({
  name: 'bat',
  variables: [
    { name: 'g', type: 'numeric', measure: 'nominal' },
    { name: 'a', type: 'numeric', measure: 'scale' },
    { name: 'b', type: 'numeric', measure: 'scale' },
    { name: 'c', type: 'numeric', measure: 'scale' },
  ],
  rows,
})

const cases = [
  'FREQUENCIES g /STATISTICS=MODE.',
  'DESCRIPTIVES a b c /STATISTICS=MEAN STDDEV MIN MAX SEMEAN KURTOSIS SKEWNESS.',
  'EXAMINE VARIABLES=a b /PLOT=BOXPLOT NPPLOT SPREADLEVEL.',
  'T-TEST PAIRS=a WITH b (PAIRED).',
  'T-TEST GROUPS=g(1 2) /VARIABLES=a.',
  'ONEWAY a BY g /STATISTICS=DESCRIPTIVES HOMOGENEITY /POSTHOC=LSD ALPHA(0.05).',
  'GLM a BY g /METHOD=SSTYPE(3) /PRINT=DESCRIPTIVE ETASQ HOMOGENEITY /CRITERIA=ALPHA(.05).',
  'REGRESSION /DEPENDENT=a /METHOD=ENTER b c /STATISTICS=DEFAULTS CI TOL.',
  'CORRELATIONS /VARIABLES=a b c /PRINT=TWOTAIL NOSIG /STATISTICS=DESCRIPTIVES.',
  'PARTIAL CORR /VARIABLES=a b BY c.',
  'RELIABILITY /VARIABLES=a b c /SCALE(ALL) /MODEL=ALPHA /STATISTICS=DESCRIPTIVE CORR.',
  'NPAR TESTS /MANN-WHITNEY=a BY g(1 2).',
  'NPAR TESTS /KRUSKAL-WALLIS=a BY g(1 3).',
  'RANK VARIABLES=a (R) /NTILES(2) INTO ar.',
  'CROSSTABS /TABLES=g BY g /STATISTICS=CHISQ PHI CC UC BTAU CTAU RISK GAMMA D KAPPA ETA CORR.',
  'AUTORECODE VARIABLES=G /INTO grp /PRINT.',
  'SORT CASES BY g (A) a (D).',
  'AGGREGATE /OUTFILE=* MODE=ADDVARIABLES /BREAK=g /gm=MEAN(a).',
  'FLIP VARIABLES=a b c.',
  'DESCRIPTIVES a /SAVE.',
  'COMPUTE d = a + b. EXECUTE.',
  'MEANS TABLES=a BY g /CELLS=MEAN COUNT STDDEV.',
  'DO IF (g = 1). COMPUTE flag = 1. ELSE. COMPUTE flag = 0. END IF. EXECUTE.',
  'MISSING VALUES a (99).',
  'FACTOR /VARIABLES=a b c /PRINT=INITIAL CORRELATION EXTRACTION /ROTATION=VARIMAX /CRITERIA=MINEIGEN(1).',
]
for (const syntax of cases) {
  try {
    const r = await ws.runSyntax(syntax)
    const notes = r.items.reduce((sum, i) => sum + (i.notes ?? []).length, 0)
    console.log('OK  ', syntax.slice(0, 42).padEnd(42), 'items', String(r.items.length).padStart(2), 'notes', notes)
  } catch (error) {
    console.log('FAIL', syntax.slice(0, 42).padEnd(42), '->', error.message.replace(/\s+/g, ' ').slice(0, 110))
  }
}
