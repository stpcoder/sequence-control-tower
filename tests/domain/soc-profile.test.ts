import { describe, expect, it } from 'vitest'
import { bootProfile, detectSocFilenameContext, normalizedEvaluationStem } from '../../src/domain/soc-profile'

describe('SoC and boot profile detection', () => {
  it('selects Qualcomm and MediaTek profiles from bounded filename tokens', () => {
    expect(detectSocFilenameContext('LPDDR6_SM-8975_SKEW-SS_DIE03_SMP07.log')).toMatchObject({
      vendor: 'qualcomm', socModel: 'SM-8975', bootProfileId: 'qualcomm-default', confidence: 0.98,
    })
    expect(detectSocFilenameContext('XIAOMI_MTK-24D_SKEW-SS_RT2.log')).toMatchObject({
      vendor: 'mediatek', socModel: 'MTK-24D', bootProfileId: 'mediatek-default', explicitRetest: true, attemptNo: 2,
    })
    expect(bootProfile('mediatek-default')?.stages.map((stage) => stage.id)).toContain('post-pbl')
    expect(bootProfile('qualcomm-default')?.stages.map((stage) => stage.id)).toContain('uefi')
  })

  it('keeps RT as attempt metadata instead of a boot stage', () => {
    expect(normalizedEvaluationStem('SM-8975_SMP07_SEQ-A_FAIL_RUN1.log')).toBe(
      normalizedEvaluationStem('SM-8975_SMP07_SEQ-A_RT2.log'),
    )
  })
})
