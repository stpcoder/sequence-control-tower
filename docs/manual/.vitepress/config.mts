import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'ko-KR',
  title: 'Sequence Control Tower',
  description: '로그 분석, 결과 정리, 평가 이력, Agent 사용 매뉴얼',
  base: '/sequence-control-tower/',
  rewrites: { 'README.md': 'index.md' },
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    logo: '/manual-logo.svg',
    siteTitle: 'Sequence Control Tower 매뉴얼',
    search: { provider: 'local' },
    nav: [
      { text: '매뉴얼', link: '/' },
      { text: '다운로드', link: 'https://github.com/stpcoder/sequence-control-tower/releases/latest' },
    ],
    sidebar: [
      { text: '시작', items: [{ text: '기능 안내', link: '/' }, { text: '설치와 프로젝트', link: '/01-설치와-프로젝트' }] },
      { text: '로그 분석', items: [{ text: '검색과 판정', link: '/02-검색과-판정' }, { text: '분석 규칙', link: '/03-분석-규칙' }, { text: '결과 정리와 내보내기', link: '/04-결과-정리' }] },
      { text: 'Agent', items: [{ text: 'Agent 사용', link: '/05-Agent' }, { text: '평가 이력', link: '/06-평가-이력' }] },
      { text: '설정', items: [{ text: 'LLM과 OpenCode', link: '/07-LLM-OpenCode' }, { text: '문제 해결', link: '/08-문제-해결' }] },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/stpcoder/sequence-control-tower' }],
    footer: { message: '원본 로그는 읽기 전용입니다.', copyright: 'Sequence Control Tower' },
    outline: { level: [2, 3], label: '이 페이지' },
    docFooter: { prev: '이전', next: '다음' },
    lastUpdated: { text: '최종 수정' },
  },
})
