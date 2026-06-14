"use client"

import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Clipboard, Download, FileText, Loader2, Sparkles, Trash2, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface CoconutRecord {
  id: string
  grade: string
  createdAt: string
  weight: number
  height: number
  waterContent: number
  waterLevel?: number | null
  majorAxis: number | null
  minorAxis: number | null
  volume: number | null
  density: number | null
  ai_summary?: string
  geminiAnalysis?: string
  export_suitable?: boolean
  confidence_score?: number
  yolo_detections?: Array<{ class: string; confidence: number }>
}

interface CoconutHistoryProps {
  history: CoconutRecord[]
  loading: boolean
  selectedId?: string
  onSelectRecord: (record: CoconutRecord) => void
  onDeleteRecord: (id: string) => void
}

interface ReportDefect {
  defect: string
  count: number
  percent: number
}

interface SessionReportStats {
  total_assessed: number
  time_range: {
    start_time: string | null
    end_time: string | null
    mode: "latest_50" | "custom_range"
  }
  grade_breakdown_count: Record<string, number>
  grade_breakdown_percent: Record<string, number>
  grade_ab_percent: number
  export_suitable_count: number
  export_suitable_percent: number
  average_weight_kg: number | null
  average_height_cm: number | null
  average_moisture_percent: number | null
  average_water_level_percent?: number | null
  most_common_defects: ReportDefect[]
  highest_confidence_score: number | null
  lowest_confidence_score: number | null
}

interface SessionReportResponse {
  report_text: string
  stats: SessionReportStats
  generated_at: string
}

function gradeClasses(grade: string) {
  if (grade === "A") return "bg-green-50 border-green-200 text-green-700"
  if (grade === "B") return "bg-blue-50 border-blue-200 text-blue-700"
  if (grade === "C") return "bg-yellow-50 border-yellow-200 text-yellow-700"
  return "bg-red-50 border-red-200 text-red-700"
}

function gradeIcon(grade: string) {
  if (grade === "A" || grade === "B") {
    return <CheckCircle2 className="h-5 w-5" />
  }
  return <AlertCircle className="h-5 w-5" />
}

function asText(value: number | null | undefined, suffix: string) {
  if (value === null || value === undefined) {
    return "N/A"
  }
  return `${value}${suffix}`
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "N/A"
  }
  return `${value.toFixed(1)}%`
}

function formatAverage(value: number | null | undefined, suffix: string) {
  if (value === null || value === undefined) {
    return "N/A"
  }
  return `${value.toFixed(2)}${suffix}`
}

function formatConfidence(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "N/A"
  }
  return `${(value * 100).toFixed(1)}%`
}

function getWaterLevel(record: CoconutRecord) {
  return record.waterLevel ?? record.waterContent
}

export function CoconutHistory({ history, loading, selectedId, onSelectRecord, onDeleteRecord }: CoconutHistoryProps) {
  const [sessionReport, setSessionReport] = useState<SessionReportResponse | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")

  useEffect(() => {
    if (!reportOpen) {
      document.body.classList.remove("report-modal-open", "report-print-mode")
      return
    }

    document.body.classList.add("report-modal-open")

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setReportOpen(false)
      }
    }

    const handleAfterPrint = () => {
      document.body.classList.remove("report-print-mode")
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("afterprint", handleAfterPrint)

    return () => {
      document.body.classList.remove("report-modal-open", "report-print-mode")
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("afterprint", handleAfterPrint)
    }
  }, [reportOpen])

  const downloadRecord = (record: CoconutRecord) => {
    const detections = record.yolo_detections?.length
      ? record.yolo_detections.map((item) => `- ${item.class}: ${(item.confidence * 100).toFixed(1)}%`).join("\n")
      : "None"

    const content = `COCONUT ASSESSMENT REPORT\n========================\nID: ${record.id}\nDate: ${new Date(record.createdAt).toLocaleString()}\nGrade: ${record.grade}\nWeight: ${record.weight} kg\nHeight: ${record.height} cm\nWater Level: ${getWaterLevel(record)}%\nMajor Axis: ${asText(record.majorAxis, " cm")}\nMinor Axis: ${asText(record.minorAxis, " cm")}\nVolume: ${asText(record.volume, " cm3")}\nDensity: ${asText(record.density, " g/cm3")}\nExport Suitable: ${record.export_suitable ? "Yes" : "No"}\nConfidence Score: ${Math.round((record.confidence_score || 0) * 100)}%\n\nAI Summary:\n${record.ai_summary || record.geminiAnalysis || "No summary available."}\n\nYOLO Detections:\n${detections}`

    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `coconut-report-${record.id.slice(0, 8)}.txt`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const downloadAll = () => {
    const content = history
      .map(
        (record, index) =>
          `${index + 1}. ${new Date(record.createdAt).toLocaleString()} | Grade ${record.grade} | Weight ${record.weight} kg | Water Level ${getWaterLevel(record)}%`
      )
      .join("\n")

    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "coconut-history-summary.txt"
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const generateSessionReport = async () => {
    try {
      setReportLoading(true)
      setReportError(null)
      setCopyState("idle")

      const response = await fetch("http://localhost:5000/api/report/session")
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error || "Failed to generate report.")
      }

      setSessionReport(payload)
      setReportOpen(true)
    } catch (error) {
      setReportError(error instanceof Error ? error.message : "Failed to generate report.")
    } finally {
      setReportLoading(false)
    }
  }

  const handlePrint = () => {
    document.body.classList.add("report-print-mode")
    window.print()
  }

  const copyReportText = async () => {
    if (!sessionReport) {
      return
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sessionReport.report_text)
      } else {
        const textArea = document.createElement("textarea")
        textArea.value = sessionReport.report_text
        textArea.style.position = "fixed"
        textArea.style.opacity = "0"
        document.body.appendChild(textArea)
        textArea.focus()
        textArea.select()
        document.execCommand("copy")
        document.body.removeChild(textArea)
      }
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }

    window.setTimeout(() => setCopyState("idle"), 2200)
  }

  const reportStats = sessionReport?.stats
  const reportScopeLabel =
    reportStats?.time_range.mode === "custom_range" ? "Custom date window" : "Latest 50 assessments"

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 rounded-3xl border border-green-100 bg-gradient-to-r from-white via-emerald-50 to-lime-50 p-5 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-800">Assessment History</h3>
              <p className="text-sm text-gray-600">Review recent grading results and generate a shift-ready quality summary.</p>
            </div>

            {history.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={generateSessionReport}
                  disabled={reportLoading}
                  className="bg-green-600 text-white hover:bg-green-700"
                >
                  {reportLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  Generate Report
                </Button>
                <Button variant="outline" size="sm" onClick={downloadAll} className="border-green-200 text-green-700 hover:bg-green-50">
                  <Download className="mr-2 h-4 w-4" />
                  Download All
                </Button>
              </div>
            )}
          </div>

          {reportError && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {reportError}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          </div>
        ) : history.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-gray-200 bg-white py-12 text-center text-sm text-gray-500">
            No assessments saved yet.
          </p>
        ) : (
          <div className="space-y-3">
            {history.map((record) => {
              const selected = selectedId === record.id
              return (
                <div
                  key={record.id}
                  className={`cursor-pointer rounded-2xl border-2 bg-white p-4 transition-all ${selected ? "border-green-500 shadow-md" : "border-gray-200 hover:border-green-300"}`}
                  onClick={() => onSelectRecord(record)}
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex items-start gap-3">
                      <div className={`rounded-full border p-2 ${gradeClasses(record.grade)}`}>{gradeIcon(record.grade)}</div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-lg font-bold text-gray-900">Grade {record.grade}</p>
                          <Badge className={record.export_suitable ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}>
                            {record.export_suitable ? "Export Ready" : "Needs Review"}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-500">{new Date(record.createdAt).toLocaleString()}</p>
                      </div>
                    </div>

                    <div className="grid gap-2 text-sm text-gray-600 sm:grid-cols-2 lg:min-w-[340px]">
                      <span>Weight: <strong className="text-gray-900">{record.weight} kg</strong></span>
                      <span>Height: <strong className="text-gray-900">{record.height} cm</strong></span>
                      <span>Water Level: <strong className="text-gray-900">{getWaterLevel(record)}%</strong></span>
                      <span>Confidence: <strong className="text-gray-900">{Math.round((record.confidence_score || 0) * 100)}%</strong></span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 border-y border-gray-100 py-3 text-sm text-gray-600 md:grid-cols-4">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-gray-400">Major Axis</p>
                      <p className="font-semibold text-gray-900">{asText(record.majorAxis, " cm")}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-gray-400">Minor Axis</p>
                      <p className="font-semibold text-gray-900">{asText(record.minorAxis, " cm")}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-gray-400">Volume</p>
                      <p className="font-semibold text-gray-900">{asText(record.volume, " cm3")}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-gray-400">Density</p>
                      <p className="font-semibold text-gray-900">{asText(record.density, " g/cm3")}</p>
                    </div>
                  </div>

                  <p className="mt-3 text-sm leading-6 text-gray-600">{record.ai_summary || record.geminiAnalysis || "No AI summary saved."}</p>

                  {selected && record.yolo_detections && record.yolo_detections.length > 0 && (
                    <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">YOLO Detections</p>
                      <ul className="mt-2 space-y-1 text-sm text-blue-900">
                        {record.yolo_detections.map((detection, index) => (
                          <li key={`${record.id}-${index}`}>
                            {detection.class} - {(detection.confidence * 100).toFixed(1)}%
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {selected && (
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          downloadRecord(record)
                        }}
                        className="border-blue-200 text-blue-700 hover:bg-blue-50"
                      >
                        <FileText className="mr-2 h-4 w-4" />
                        Download Report
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          onDeleteRecord(record.id)
                        }}
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete Assessment
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {reportOpen && sessionReport && reportStats && (
        <div className="session-report-modal fixed inset-0 z-[70] overflow-y-auto">
          <div className="session-report-backdrop flex min-h-full items-start justify-center bg-slate-950/70 px-4 py-6 md:items-center md:py-10" onClick={() => setReportOpen(false)}>
            <div
              role="dialog"
              aria-modal="true"
              className="session-report-panel w-full max-w-5xl rounded-[32px] border border-emerald-100 bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-emerald-100 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.2),_transparent_40%),linear-gradient(135deg,_#f8fffb,_#ecfdf5_55%,_#fefce8)] px-6 py-6 md:px-8">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-3">
                    <Badge className="w-fit bg-emerald-100 text-emerald-800">Shift Assessment Report</Badge>
                    <div>
                      <h4 className="text-2xl font-bold tracking-tight text-slate-900">Automated Quality Summary</h4>
                      <p className="mt-1 text-sm text-slate-600">
                        {reportScopeLabel} - Generated {new Date(sessionReport.generated_at).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setReportOpen(false)}
                    className="session-report-close self-end rounded-full text-slate-500 hover:bg-white/80 hover:text-slate-800"
                  >
                    <X className="h-5 w-5" />
                  </Button>
                </div>
              </div>

              <div className="space-y-6 px-6 py-6 md:px-8">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Total Assessed</p>
                    <p className="mt-3 text-3xl font-bold text-slate-900">{reportStats.total_assessed}</p>
                    <p className="mt-1 text-sm text-slate-500">Records included in this report</p>
                  </div>
                  <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-emerald-700">Export Suitable</p>
                    <p className="mt-3 text-3xl font-bold text-emerald-900">{formatPercent(reportStats.export_suitable_percent)}</p>
                    <p className="mt-1 text-sm text-emerald-700">{reportStats.export_suitable_count} coconuts marked export ready</p>
                  </div>
                  <div className="rounded-3xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-amber-700">Grade A+B</p>
                    <p className="mt-3 text-3xl font-bold text-amber-900">{formatPercent(reportStats.grade_ab_percent)}</p>
                    <p className="mt-1 text-sm text-amber-700">High-quality share of the assessed batch</p>
                  </div>
                  <div className="rounded-3xl border border-sky-200 bg-sky-50 p-4">
                    <p className="text-xs uppercase tracking-[0.2em] text-sky-700">Average Weight</p>
                    <p className="mt-3 text-3xl font-bold text-sky-900">{formatAverage(reportStats.average_weight_kg, " kg")}</p>
                    <p className="mt-1 text-sm text-sky-700">Average unit weight across the session</p>
                  </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-[1.55fr_1fr]">
                  <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex items-center gap-2 text-slate-500">
                      <FileText className="h-4 w-4" />
                      <p className="text-xs font-semibold uppercase tracking-[0.2em]">AI Shift Narrative</p>
                    </div>
                    <p className="mt-4 text-base leading-7 text-slate-700">{sessionReport.report_text}</p>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-5">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Process Snapshot</p>
                      <div className="mt-4 space-y-3 text-sm text-slate-700">
                        <div className="flex items-center justify-between gap-3">
                          <span>Average height</span>
                          <strong className="text-slate-900">{formatAverage(reportStats.average_height_cm, " cm")}</strong>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Average water level</span>
                          <strong className="text-slate-900">{formatAverage(reportStats.average_water_level_percent ?? reportStats.average_moisture_percent, "%")}</strong>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Highest confidence</span>
                          <strong className="text-slate-900">{formatConfidence(reportStats.highest_confidence_score)}</strong>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span>Lowest confidence</span>
                          <strong className="text-slate-900">{formatConfidence(reportStats.lowest_confidence_score)}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[28px] border border-slate-200 bg-white p-5">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Grade Mix</p>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {Object.entries(reportStats.grade_breakdown_percent).map(([grade, percent]) => (
                          <div key={grade} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                            <p className="text-xs uppercase tracking-wide text-slate-500">Grade {grade}</p>
                            <p className="mt-1 text-xl font-bold text-slate-900">{formatPercent(percent)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-[28px] border border-emerald-100 bg-emerald-50/60 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">Most Common Defects</p>
                  {reportStats.most_common_defects.length > 0 ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {reportStats.most_common_defects.map((item) => (
                        <div key={item.defect} className="rounded-2xl border border-emerald-200 bg-white px-4 py-3">
                          <p className="text-sm font-semibold capitalize text-slate-900">{item.defect}</p>
                          <p className="mt-1 text-sm text-slate-600">
                            {item.count} mention{item.count === 1 ? "" : "s"} - {formatPercent(item.percent)}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-emerald-900">No recurring defects were highlighted in the AI summaries for this report window.</p>
                  )}
                </div>

                <div className="session-report-actions flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
                  <Button variant="outline" onClick={copyReportText} className="border-slate-300 text-slate-700 hover:bg-slate-50">
                    <Clipboard className="mr-2 h-4 w-4" />
                    {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy Failed" : "Copy Report Text"}
                  </Button>
                  <Button variant="outline" onClick={handlePrint} className="border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                    <Download className="mr-2 h-4 w-4" />
                    Download as PDF
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
