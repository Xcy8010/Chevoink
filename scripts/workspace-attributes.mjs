// Exact commands installed by upstream Git LFS 3.7.1. Never execute a driver to
// identify it. A matching configuration is safe only when no path uses a filter.
const standardLfs = new Map([
  ['filter.lfs.clean', 'git-lfs clean -- %f'], ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.process', 'git-lfs filter-process'], ['filter.lfs.required', 'true'],
])
const records = value => {
  if (!value) return []
  if (!value.endsWith('\0')) throw new Error('Incomplete Git attribute evidence')
  return value.slice(0, -1).split('\0')
}

/** Read attributes only; no filters, config writes or Git LFS commands. */
async function inspectFilters(git, head, target) {
  const config = records(await git(['config', '--null', '--get-regexp', '^filter\\.'], [0, 1]))
  if (!config.length) return { safe: true, status: 'no_configured_filters' }
  if (config.some(row => {
    const split = row.indexOf('\n')
    return split < 0 || standardLfs.get(row.slice(0, split)) !== row.slice(split + 1)
  })) return { safe: false, status: 'nonstandard_filter_configuration' }
  // An inherited source override would make a worktree query ambiguous.
  if (process.env.GIT_ATTR_SOURCE) return { safe: false, status: 'attribute_source_override_unverified' }
  const paths = new Set()
  for (const row of records(await git(['ls-files', '--stage', '-z']))) {
    const match = /^(100644|100755|120000) [a-f0-9]+ 0\t([\s\S]+)$/.exec(row)
    if (!match) return { safe: false, status: 'index_or_submodule_attributes_unverified' }
    paths.add(match[2])
  }
  const trees = [...new Set([head, target].filter(Boolean))]
  for (const tree of trees) {
    for (const row of records(await git(['ls-tree', '-r', '-z', tree]))) {
      const match = /^(100644|100755|120000) blob [a-f0-9]+\t([\s\S]+)$/.exec(row)
      if (!match) return { safe: false, status: 'tree_or_submodule_attributes_unverified' }
      paths.add(match[2])
    }
  }
  if (!paths.size) return { safe: false, status: 'empty_attribute_evidence' }
  const input = [...paths].join('\0') + '\0'
  const sources = [[], ['--cached'], ...trees.map(tree => [`--source=${tree}`])]
  for (const source of sources) {
    const complete = records(await git(['check-attr', '-z', '--stdin', ...source, 'filter'], [0], input))
    if (complete.length !== paths.size * 3) throw new Error('Incomplete Git attribute evidence')
    const seen = new Set()
    for (let index = 0; index < complete.length; index += 3) {
      const file = complete[index]
      if (!paths.has(file) || seen.has(file) || complete[index + 1] !== 'filter') throw new Error('Unrelated Git attribute evidence')
      seen.add(file)
      if (complete[index + 2] !== 'unspecified') return { safe: false, status: 'filter_attribute_present' }
    }
    // --all omits unspecified attributes. Using `filter` alone would confuse
    // an actual `filter=unspecified` assignment with the unspecified state.
    const output = records(await git(['check-attr', '-z', '--stdin', '--all', ...source], [0], input))
    if (output.length % 3) throw new Error('Incomplete Git attribute evidence')
    for (let index = 0; index < output.length; index += 3) {
      if (!paths.has(output[index]) || !output[index + 1]) throw new Error('Unrelated Git attribute evidence')
      if (output[index + 1] === 'filter') return { safe: false, status: 'filter_attribute_present' }
    }
  }
  return { safe: true, status: 'standard_lfs_unused', trackedPaths: paths.size, trees, attributeSources: sources.length }
}

export async function assessFilterSafety(git, head, target) {
  try { return await inspectFilters(git, head, target) }
  catch (error) {
    return { safe: false, status: 'attribute_evidence_unverified', failure: ['timeout', 'output_limit', 'stdin_error'].includes(error.fault) ? error.fault : 'query_failed' }
  }
}
