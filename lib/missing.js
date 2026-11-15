/**
 * Missing-value codes and measurement levels, in one place.
 *
 * `MISSING VALUES age (999)` is the user telling SPSS that 999 is not data. It
 * belongs with the data handling, not with one report: the table builder, the
 * charts and the collinearity check all have to drop the same cases, or the
 * same dataset prints two different means.
 */

function isNumeric(variable) {
  return variable?.type !== 'string'
}

export function isUserMissing(variable, value) {
  const entries = Array.isArray(variable?.missing) ? variable.missing : []
  if (entries.length === 0) return false
  if (value === null || value === undefined || value === '') return false
  const numeric = isNumeric(variable)
  const probe = numeric ? Number(value) : String(value)
  if (numeric && !Number.isFinite(probe)) return false
  for (const entry of entries) {
    if (entry === null || entry === undefined || entry === '') continue
    if (typeof entry === 'object') {
      if (!numeric) continue
      const lo = Number(entry.lo)
      const hi = Number(entry.hi)
      if (Number.isFinite(lo) && Number.isFinite(hi) && probe >= lo && probe <= hi) return true
      continue
    }
    if (numeric ? Number(entry) === probe : String(entry) === probe) return true
  }
  return false
}

export function isCategorical(variable) {
  if (variable?.type === 'string') return true
  const measure = String(variable?.measure ?? '').toLowerCase()
  if (measure === 'nominal' || measure === 'ordinal') return true
  return Object.keys(variable?.valueLabels ?? {}).length > 0
}