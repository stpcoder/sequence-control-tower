# Qualcomm-style synthetic bring-up corpus

This corpus is a deterministic, privacy-safe test corpus for the desktop log-analysis product. It contains exactly 160 `.log` fixtures under `tests/fixtures/qualcomm-bringup/` and is generated from:

```bash
node tests/fixtures/soc-logs/generators/generate-qualcomm-bringup-corpus.mjs
```

For tests or local inspection, write to a temporary directory instead of replacing the checked-in corpus:

```bash
node tests/fixtures/soc-logs/generators/generate-qualcomm-bringup-corpus.mjs --output /tmp/qualcomm-bringup
```

The machine-readable inventory is `tests/fixtures/qualcomm-bringup/manifest.json`. Each fixture records its relative path, scenario family, expected terminal result, review flag, sample/material/temperature/mode/VDD/run metadata, ordered stage markers, and feature tags.

## Scenario matrix

| Family | Count | Coverage | Oracle labels |
| --- | ---: | --- | --- |
| `pass` | 16 | canonical completed boot | `PASS` |
| `uefi-failure` | 16 | UEFI failure, timeout, halt | `UEFI_FAIL`, `SYSTEM_HALT` |
| `uefi-exit` | 16 | failed or missing UEFI exit | `UEFI_EXIT_FAIL` |
| `os-failure` | 16 | OS panic, halt, incomplete capture | `OS_PANIC`, `SYSTEM_HALT`, `INCOMPLETE` |
| `reboot-recovered` | 16 | watchdog reboot and recovered second run | `SYSTEM_REBOOT`, `PASS` |
| `stale-conflict` | 16 | stale, contradictory, and conflicting markers | `UNKNOWN` + review |
| `multiple-runs` | 16 | multiple runs in one file, including truncated tails | `UNKNOWN` + review |
| `metadata-mismatch` | 16 | temperature, VDD, mode, and filename/content mismatch | `PASS` + review |
| `filename-variants` | 16 | delimiter, case, nesting, CRLF variations | `PASS` |
| `memory-records` | 16 | parser-conformant stressapptest and tSKHYNIX records, including zero-row and parser-error cases | `TEST_FAIL` for accepted mismatches, `PASS` for equal/baseline zero-row cases, `UNKNOWN` + review for excluded/malformed/parser-error cases |

The corpus uses the ordered flow convention `SYN_POWER_ON -> SYN_UEFI_ENTER -> SYN_UEFI_EXIT -> SYN_OS_BOOT_START -> SYN_OS_READY`. These `SYN_*` values are corpus conventions, **not official Qualcomm strings**.

Memory records are deliberately synthetic and follow the read-only reference parser grammar. stressapptest cases use full `Hardware Error: miscompare on CPU ... at outer(inner:DIMM...): read..., reread... expected...` records plus a CRC form; they cover low/high/both-half mismatches and repeated physical addresses. tSKHYNIX cases begin with `tSKHYNIX_<test-name>` and cover 32-bit, 64-bit split, supported field aliases and context (`AP`/`IDX`/`CS`/`BK`/`ROW`/`COL`), repeated addresses, equal/missing fields, misalignment, and overlong values.

Each memory fixture has a `parserOracle` in `manifest.json` with expected stressapptest and tSKHYNIX row/record counts and an expected parser-error classification where applicable. The Vitest suite always checks the local grammar and oracle; when `/Users/taehoje/study_lp/lpddr6-packet-mapper` and `python3` are available, it also invokes the reference parser's read-only line parser conditionally.

## Safety notice

Do not add production logs, real sample identifiers, proprietary addresses, customer data, secrets, or copied vendor logs to this directory. The filenames, values, addresses, errors, and labels are synthetic fixtures. The expected labels are an explicit corpus oracle for tests; they do not change current product classification behavior or assert that the `SYN_*` markers are vendor-defined.
