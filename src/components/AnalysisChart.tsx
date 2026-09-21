import { Component, useEffect, useRef, type ReactNode } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts'
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsType } from 'echarts/core'
import type { PivotAggregation, PivotGrid } from '../state/logRecords'
import {
  analysisChartModel,
  analysisHeatmapData,
  type AnalysisChartDatum,
  type AnalysisVisualization,
} from '../domain/analysis-view'

echarts.use([
  BarChart,
  HeatmapChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  DataZoomComponent,
  AriaComponent,
  CanvasRenderer,
])

type ExportImage = (() => string | null) | null

interface AnalysisChartProps {
  grid: PivotGrid
  passFailGrid: PivotGrid
  visualization: Exclude<AnalysisVisualization, 'cross_table'>
  aggregation: PivotAggregation
  selectedCellKeys: ReadonlySet<string>
  onMark: (cellKeys: readonly string[], additive: boolean) => void
  onExportReady?: (exportImage: ExportImage) => void
}

type ChartDatum = AnalysisChartDatum & { itemStyle?: Record<string, unknown> }

const COLORS = ['#75a7ff', '#b495f5', '#65b7c6', '#dba96b', '#97a7bd', '#d784a8']
const TEXT = '#c9d0da'
const MUTED = '#7f8996'
const LINE = '#292f38'
const FAIL = '#ef7c82'
const PASS = '#75a7ff'

const selectedStyle = (active: boolean, color?: string) => ({
  color,
  borderColor: active ? '#f3f6fa' : 'transparent',
  borderWidth: active ? 2 : 0,
  opacity: active ? 1 : .9,
})

const numberLabel = (value: number, aggregation: PivotAggregation) => aggregation === 'fail_rate' || aggregation === 'fail_event_share'
  ? `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`
  : value.toLocaleString('ko-KR')

const categoryTotals = (grid: PivotGrid) => {
  const model = analysisChartModel(grid)
  return model.categories.map((name, index) => {
    const values = model.series.map((series) => series.values[index]).filter(Boolean)
    return {
      name,
      passCount: values.reduce((sum, item) => sum + (item.passCount ?? 0), 0),
      failCount: values.reduce((sum, item) => sum + (item.failCount ?? 0), 0),
      definitiveCount: values.reduce((sum, item) => sum + (item.definitiveCount ?? 0), 0),
      cellKeys: [...new Set(values.flatMap((item) => item.cellKeys))],
      sourceIds: [...new Set(values.flatMap((item) => item.sourceIds))],
    }
  })
}

const datum = (item: AnalysisChartDatum, selected: ReadonlySet<string>, color?: string): ChartDatum => ({
  ...item,
  itemStyle: selectedStyle(item.cellKeys.some((key) => selected.has(key)), color),
})

export const compactDataZoom = (count: number, orientation: 'horizontal' | 'vertical') => count <= 18 ? [] : [
  { id: orientation + '-inside', type: 'inside', ...(orientation === 'horizontal' ? { xAxisIndex: 0 } : { yAxisIndex: 0 }), start: 0, end: 100, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: false },
  { id: orientation + '-slider', type: 'slider', ...(orientation === 'horizontal' ? { xAxisIndex: 0, bottom: 4, height: 16 } : { yAxisIndex: 0, right: 2, width: 16 }), start: 0, end: 100, showDetail: false, borderColor: LINE, fillerColor: '#75a7ff22', handleStyle: { color: MUTED }, textStyle: { color: TEXT } },
]

/** Builds a restrained ECharts option while keeping SCT selection metadata on
 * every datum. The surrounding controls stay native to the product. */
export function buildAnalysisChartOption(input: Omit<AnalysisChartProps, 'onMark' | 'onExportReady'>): Record<string, unknown> {
  const { grid, passFailGrid, visualization, aggregation, selectedCellKeys } = input
  const base = {
    animationDuration: 160,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Pretendard, -apple-system, BlinkMacSystemFont, sans-serif', color: TEXT, fontSize: 12 },
    aria: { enabled: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#20242b',
      borderColor: '#3a424e',
      textStyle: { color: '#eef2f7', fontSize: 12 },
      extraCssText: 'box-shadow:0 10px 28px rgba(0,0,0,.28);border-radius:7px;',
    },
  }

  if (visualization === 'heatmap') {
    const cells = analysisHeatmapData(grid)
    const values = cells.map((item) => aggregation === 'pass_fail'
      ? item.definitiveCount ? (item.failCount ?? 0) / item.definitiveCount * 100 : 0
      : item.value)
    const max = Math.max(1, ...values)
    return {
      ...base,
      grid: { top: 16, right: 40, bottom: 50, left: 96, containLabel: true },
      xAxis: { type: 'category', data: grid.columns.map((column) => column.label), axisLabel: { color: TEXT, hideOverlap: true }, axisLine: { lineStyle: { color: LINE } }, splitArea: { show: false } },
      yAxis: { type: 'category', data: grid.rows.map((row) => row.label), axisLabel: { color: TEXT, width: 110, overflow: 'truncate' }, axisLine: { lineStyle: { color: LINE } }, splitArea: { show: false } },
      visualMap: { show: false, min: 0, max, inRange: { color: ['#222831', '#56353b', '#b45159', FAIL] } },
      dataZoom: [...compactDataZoom(grid.columns.length, 'horizontal'), ...compactDataZoom(grid.rows.length, 'vertical')],
      tooltip: {
        ...(base.tooltip as object),
        formatter: (params: { data: ChartDatum & { value: [number, number, number] } }) => {
          const item = params.data
          const value = aggregation === 'pass_fail'
            ? `PASS ${item.passCount ?? 0} · FAIL ${item.failCount ?? 0}`
            : aggregation === 'fail_event_count'
              ? `Fail 주소 ${item.failureEventCount ?? item.value[2]}회 · ${item.failureSourceCount ?? 0}개 로그${item.topFailureSignature ? `<br/>${item.topFailureSignature}` : ''}`
              : aggregation === 'fail_source_count'
                ? `${item.failureSourceCount ?? item.value[2]}개 로그 · Fail 주소 ${item.failureEventCount ?? 0}회`
            : numberLabel(item.value[2], aggregation)
          return `<b>${item.name}</b><br/>${value}`
        },
      },
      series: [{
        name: '값', type: 'heatmap', progressive: 400,
        data: cells.map((item, index) => ({
          ...item,
          value: [index % grid.columns.length, Math.floor(index / grid.columns.length), values[index]],
          itemStyle: selectedStyle(item.cellKeys.some((key) => selectedCellKeys.has(key))),
          label: {
            show: grid.rows.length * grid.columns.length <= 100,
            color: '#eef1f5', fontSize: 11,
            formatter: aggregation === 'pass_fail'
              ? `PASS ${item.passCount ?? 0} · FAIL ${item.failCount ?? 0}`
              : aggregation === 'fail_event_count'
                ? `${item.failureEventCount ?? item.value}회`
                : aggregation === 'fail_source_count'
                  ? `${item.failureSourceCount ?? item.value}개`
                  : numberLabel(item.value, aggregation),
          },
          emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } },
        })),
      }],
    }
  }

  const model = analysisChartModel(grid)
  const horizontal = visualization === 'bar_horizontal'
  const categoryAxis = { type: 'category', data: model.categories, axisLabel: { color: TEXT, hideOverlap: true, width: horizontal ? 128 : undefined, overflow: 'truncate' }, axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false } }
  const valueAxis = { type: 'value', axisLabel: { color: MUTED, formatter: aggregation === 'fail_rate' || aggregation === 'fail_event_share' ? '{value}%' : '{value}' }, splitLine: { lineStyle: { color: LINE } }, axisLine: { show: false } }
  const commonCartesian = {
    ...base,
    grid: { top: 42, right: 42, bottom: 50, left: horizontal ? 48 : 34, containLabel: true },
    legend: { top: 4, right: 18, textStyle: { color: TEXT, fontSize: 11 }, itemWidth: 12, itemHeight: 8 },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    dataZoom: compactDataZoom(model.categories.length, horizontal ? 'vertical' : 'horizontal'),
  }

  if (visualization === 'stacked_bar' || visualization === 'stacked_percent' || visualization === 'combo') {
    const totals = categoryTotals(passFailGrid)
    const percentage = visualization === 'stacked_percent'
    const passData = totals.map((item) => datum({ ...item, value: percentage && item.definitiveCount ? Math.round(item.passCount / item.definitiveCount * 1_000) / 10 : item.passCount }, selectedCellKeys, PASS))
    const failData = totals.map((item) => datum({ ...item, value: percentage && item.definitiveCount ? Math.round(item.failCount / item.definitiveCount * 1_000) / 10 : item.failCount }, selectedCellKeys, FAIL))
    if (visualization === 'stacked_bar' || visualization === 'stacked_percent') return {
      ...commonCartesian,
      tooltip: { ...(base.tooltip as object), trigger: 'axis' },
      ...(percentage ? { yAxis: { ...valueAxis, max: 100, axisLabel: { color: MUTED, formatter: '{value}%' } } } : {}),
      series: [
        { name: 'PASS', type: 'bar', stack: 'result', barMaxWidth: 42, itemStyle: { color: PASS }, label: { show: true, position: 'inside', color: '#f4f7fb', fontSize: 11, formatter: (params: { value?: number }) => params.value ? `${params.value}${percentage ? '%' : ''}` : '' }, data: passData },
        { name: 'FAIL', type: 'bar', stack: 'result', barMaxWidth: 42, itemStyle: { color: FAIL }, label: { show: true, position: 'inside', color: '#fff', fontSize: 11, formatter: (params: { value?: number }) => params.value ? `${params.value}${percentage ? '%' : ''}` : '' }, data: failData },
      ],
    }
    const rateData = totals.map((item) => datum({
      ...item,
      value: item.definitiveCount ? Math.round(item.failCount / item.definitiveCount * 1_000) / 10 : 0,
    }, selectedCellKeys, '#dba96b'))
    return {
      ...commonCartesian,
      tooltip: { ...(base.tooltip as object), trigger: 'axis' },
      yAxis: [valueAxis, { ...valueAxis, axisLabel: { color: '#dba96b', formatter: '{value}%' }, splitLine: { show: false } }],
      series: [
        { name: 'FAIL 건수', type: 'bar', barMaxWidth: 42, itemStyle: { color: FAIL }, data: failData },
        { name: '불량률', type: 'line', yAxisIndex: 1, symbolSize: 7, smooth: false, data: rateData, lineStyle: { width: 2, color: '#dba96b' }, itemStyle: { color: '#dba96b' } },
      ],
    }
  }

  if (aggregation === 'pass_fail' && (visualization === 'bar' || visualization === 'bar_horizontal')) {
    const totals = categoryTotals(passFailGrid)
    return {
      ...commonCartesian,
      tooltip: { ...(base.tooltip as object), trigger: 'axis' },
      series: [
        { name: 'PASS', type: 'bar', barMaxWidth: 38, itemStyle: { color: PASS }, data: totals.map((item) => datum({ ...item, value: item.passCount }, selectedCellKeys, PASS)) },
        { name: 'FAIL', type: 'bar', barMaxWidth: 38, itemStyle: { color: FAIL }, data: totals.map((item) => datum({ ...item, value: item.failCount }, selectedCellKeys, FAIL)) },
      ],
    }
  }

  const series = model.series.map((item, index) => ({
    name: item.name,
    type: visualization === 'line' ? 'line' : 'bar',
    ...(visualization === 'line' ? { symbolSize: 7, connectNulls: false, smooth: false } : { barMaxWidth: 38 }),
    data: item.values.map((value) => datum(value, selectedCellKeys, COLORS[index % COLORS.length])),
    itemStyle: { color: COLORS[index % COLORS.length] },
    lineStyle: { color: COLORS[index % COLORS.length], width: 2 },
  }))
  return { ...commonCartesian, tooltip: { ...(base.tooltip as object), trigger: 'axis' }, series }
}

export function restoreChartZoom(option: Record<string, unknown>, previous: Record<string, unknown> | undefined): Record<string, unknown> {
  const ranges = previous?.dataZoom as Array<{ id: string; start: number; end: number }> | undefined
  return { ...option, dataZoom: ((option.dataZoom ?? []) as Array<{ id: string }>).map((zoom) => {
    const range = ranges?.find((item) => item.id === zoom.id)
    return range ? { ...zoom, start: range.start, end: range.end } : zoom
  }) }
}

class ChartErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? <div className="pattern-inline-empty" role="alert"><strong>차트를 표시하지 못했습니다.</strong><button onClick={() => this.setState({ failed: false })}>다시 표시</button></div> : this.props.children
  }
}

export function AnalysisChart(props: AnalysisChartProps) {
  return <ChartErrorBoundary key={props.visualization}><RenderedAnalysisChart {...props} /></ChartErrorBoundary>
}

function RenderedAnalysisChart(props: AnalysisChartProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const layoutKeyRef = useRef('')
  const markRef = useRef(props.onMark)
  markRef.current = props.onMark

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const chart = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = chart
    layoutKeyRef.current = ''
    const resize = new ResizeObserver(() => chart.resize())
    resize.observe(host)
    chart.on('click', (params) => {
      const data = params.data as unknown as ChartDatum | null | undefined
      const keys = data?.cellKeys
      if (!keys?.length) return
      const event = params.event?.event as MouseEvent | undefined
      markRef.current(keys, Boolean(event?.ctrlKey || event?.metaKey || event?.shiftKey))
    })
    props.onExportReady?.(() => chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#171a1f' }))
    return () => {
      resize.disconnect()
      props.onExportReady?.(null)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const layoutKey = JSON.stringify([props.visualization, props.aggregation, props.grid.rows, props.grid.columns, props.grid.cells.flat().map((cell) => cell.sourceIds)])
    const option = buildAnalysisChartOption(props)
    const next = layoutKeyRef.current === layoutKey ? restoreChartZoom(option, chart.getOption()) : option
    layoutKeyRef.current = layoutKey
    chart.setOption(next, { notMerge: true, lazyUpdate: false })
  }, [props.aggregation, props.grid, props.passFailGrid, props.selectedCellKeys, props.visualization])

  const hasZoom = props.grid.rows.length > 18 || props.grid.columns.length > 18
  return <div className="analysis-chart-frame">{hasZoom ? <div className="chart-zoom-controls"><span>Ctrl + 휠로 확대 · 범위 막대로 이동</span><button type="button" onClick={() => chartRef.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })}>전체 보기</button></div> : null}<div className="analysis-chart" ref={hostRef} role="img" aria-label={`${props.visualization} 분석 시각화`} /></div>
}
