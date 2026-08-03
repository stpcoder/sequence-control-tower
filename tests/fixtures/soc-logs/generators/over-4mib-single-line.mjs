// This stays out of the normal fixture tree so the repository does not carry a 4 MiB blob.
// Run with: node tests/fixtures/soc-logs/generators/over-4mib-single-line.mjs /tmp/over-4mib.log
import { writeFile } from 'node:fs/promises'

const output = process.argv[2]
if (!output) throw new Error('Output .log path is required.')
await writeFile(output, `STRESSAPP PASS ${'x'.repeat(4 * 1024 * 1024 + 1)}`, 'utf8')
