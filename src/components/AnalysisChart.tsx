import { useEffect, useRef } from 'react'
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

const numberLabel = (value: number, aggregation: PivotAggregation) => aggregation === 'fail_rate'
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

const compactDataZoom = (count: number, orientation: 'horizontal' | 'vertical') => count <= 18 ? [] : [{
  type: 'inside',
  ...(orientation === 'horizontal' ? { xAxisIndex: 0 } : { yAxisIndex: 0 }),
  startValue: 0,
  endValue: Math.min(count - 1, 17),
  zoomOnMouseWheel: true,
  moveOnMouseWheel: true,
  moveOnMouseMove: true,
}]

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
      grid: { top: 16, right: 22, bottom: 44, left: 96, containLabel: true },
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
            formatter: aggregation === 'pass_fail' ? `P ${item.passCount ?? 0} · F ${item.failCount ?? 0}` : numberLabel(item.value, aggregation),
          },
          emphasis: { itemStyle: { borderColor: '#fff', borderWidth: 1 } },
        })),
      }],
    }
  }

  const model = analysisChartModel(grid)
  const horizontal = visualization === 'bar_horizontal'
  const categoryAxis = { type: 'category', data: model.categories, axisLabel: { color: TEXT, hideOverlap: true, width: horizontal ? 128 : undefined, overflow: 'truncate' }, axisLine: { lineStyle: { color: LINE } }, axisTick: { show: false } }
  const valueAxis = { type: 'value', axisLabel: { color: MUTED, formatter: aggregation === 'fail_rate' ? '{value}%' : '{value}' }, splitLine: { lineStyle: { color: LINE } }, axisLine: { show: false } }
  const commonCartesian = {
    ...base,
    grid: { top: 42, right: 26, bottom: 44, left: horizontal ? 48 : 34, containLabel: true },
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
        { name: 'PASS', type: 'bar', stack: 'result', barMaxWidth: 42, data: passData },
        { name: 'FAIL', type: 'bar', stack: 'result', barMaxWidth: 42, data: failData },
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
        { name: 'FAIL 건수', type: 'bar', barMaxWidth: 42, data: failData },
        { name: 'FAIL률', type: 'line', yAxisIndex: 1, symbolSize: 7, smooth: false, data: rateData, lineStyle: { width: 2, color: '#dba96b' }, itemStyle: { color: '#dba96b' } },
      ],
    }
  }

  if (aggregation === 'pass_fail' && (visualization === 'bar' || visualization === 'bar_horizontal')) {
    const totals = categoryTotals(passFailGrid)
    return {
      ...commonCartesian,
      tooltip: { ...(base.tooltip as object), trigger: 'axis' },
      series: [
        { name: 'PASS', type: 'bar', barMaxWidth: 38, data: totals.map((item) => datum({ ...item, value: item.passCount }, selectedCellKeys, PASS)) },
        { name: 'FAIL', type: 'bar', barMaxWidth: 38, data: totals.map((item) => datum({ ...item, value: item.failCount }, selectedCellKeys, FAIL)) },
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

export function AnalysisChart(props: AnalysisChartProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsType | null>(null)
  const markRef = useRef(props.onMark)
  markRef.current = props.onMark

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const chart = echarts.init(host, undefined, { renderer: 'canvas' })
    chartRef.current = chart
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
    chart.setOption(buildAnalysisChartOption(props), { notMerge: true, lazyUpdate: true })
  }, [props.aggregation, props.grid, props.passFailGrid, props.selectedCellKeys, props.visualization])

  return <div className="analysis-chart" ref={hostRef} role="img" aria-label={`${props.visualization} 분석 시각화`} />
}
