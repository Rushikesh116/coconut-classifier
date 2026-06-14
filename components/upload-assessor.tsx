"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  ImagePlus,
  Loader2,
  RefreshCcw,
  Upload,
  X,
} from "lucide-react"
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface ClassificationFactors {
  label?: string
  process_output?: string
  colour: string
  water_level: string
  holes: string
  patches: string
  size?: string
  pulp_content: string
  volume: string
  density: string
  weight: string
}

export interface AssessmentResult {
  id: string | null
  grade: "A" | "B" | "C" | "D" | null
  timestamp: string
  image_path: string | null
  weight_kg: number | null
  height_cm: number | null
  height_source?: string | null
  height_confidence?: number | null
  moisture_percent: number | null
  water_level_percent?: number | null
  classification_factors?: ClassificationFactors | null
  classification_label?: string | null
  classification_confidence?: number | null
  classification_reason?: string | null
  major_axis_cm: number | null
  minor_axis_cm: number | null
  volume_cm3: number | null
  density_g_cm3: number | null
  surface_quality: string | null
  crack_confidence: number | null
  mold_detected: boolean | null
  color_grade: string | null
  export_suitable: boolean
  ai_summary: string
  texture_notes?: string
  confidence_score: number
  yolo_detections: Array<{
    class: string
    confidence: number
    source?: string
  }>
  coconut_detected?: boolean
  axis_detected?: boolean
  axis_source?: string | null
  axis_angle_degrees?: number | null
  axis_confidence?: number | null
  axis_warning?: string | null
  filename?: string
  error?: string
  inference_warning?: string | null
}

interface BatchSummary {
  type: "batch_summary"
  total_processed: number
  grade_breakdown: Record<string, number>
  export_suitable_count: number
  average_weight: number
  average_moisture: number
  average_water_level?: number
  processing_time_seconds: number
}

interface UploadAssessorProps {
  onAssessmentSaved: () => Promise<void> | void
  defaultInputMode?: "upload" | "camera"
}

interface FileItem {
  id: string
  file: File
  previewUrl: string
}

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"]
const CHART_COLORS = ["#16a34a", "#2563eb", "#ca8a04", "#dc2626"]

function getGradeClasses(grade: string | null) {
  if (grade === "A") return "bg-green-100 text-green-800 border-green-200"
  if (grade === "B") return "bg-blue-100 text-blue-800 border-blue-200"
  if (grade === "C") return "bg-yellow-100 text-yellow-800 border-yellow-200"
  if (grade === "D") return "bg-red-100 text-red-800 border-red-200"
  return "bg-gray-100 text-gray-800 border-gray-200"
}

function getClassificationClasses(label: string | null | undefined) {
  if (label === "Tender Coconut") return "bg-cyan-100 text-cyan-800 border-cyan-200"
  if (label === "Ripe Coconut") return "bg-amber-100 text-amber-800 border-amber-200"
  if (label === "Rotten Coconut") return "bg-rose-100 text-rose-800 border-rose-200"
  if (label === "Fibre Section") return "bg-violet-100 text-violet-800 border-violet-200"
  if (label === "Husk") return "bg-orange-100 text-orange-800 border-orange-200"
  return "bg-gray-100 text-gray-800 border-gray-200"
}

function formatNullable(value: number | null, suffix: string) {
  if (value === null || value === undefined) {
    return "N/A"
  }
  return `${value}${suffix}`
}

function formatAxisSource(source: string | null | undefined) {
  if (!source) {
    return "Not available"
  }
  if (source === "local_shape_model") {
    return "Local shape model"
  }
  if (source === "roboflow") {
    return "YOLO guided"
  }
  return source.replaceAll("_", " ")
}

function createFileItem(file: File): FileItem {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    previewUrl: URL.createObjectURL(file),
  }
}

export function UploadAssessor({ onAssessmentSaved, defaultInputMode = "upload" }: UploadAssessorProps) {
  const [inputMode, setInputMode] = useState<"upload" | "camera">(defaultInputMode)
  const [isBatchMode, setIsBatchMode] = useState(false)
  const [files, setFiles] = useState<FileItem[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [singleResult, setSingleResult] = useState<AssessmentResult | null>(null)
  const [batchResults, setBatchResults] = useState<AssessmentResult[]>([])
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null)
  const [progressText, setProgressText] = useState<string | null>(null)
  const progressTimer = useRef<number | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    setInputMode(defaultInputMode)
  }, [defaultInputMode])

  useEffect(() => {
    return () => {
      for (const item of files) {
        URL.revokeObjectURL(item.previewUrl)
      }
      if (progressTimer.current) {
        window.clearInterval(progressTimer.current)
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
      }
    }
  }, [files])

  useEffect(() => {
    if (inputMode === "camera") {
      if (isBatchMode) {
        setIsBatchMode(false)
      }
      void startCamera()
    } else {
      stopCamera()
      setCameraError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputMode, isBatchMode])

  const helperText = useMemo(() => {
    if (inputMode === "camera") {
      if (files.length > 0) {
        const file = files[0].file
        return `Captured image ready - ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`
      }
      return "Capture one image from the live camera to start assessment."
    }

    if (files.length === 0) {
      return isBatchMode
        ? "Accepts up to 20 JPG, PNG, or WEBP images."
        : "Accepts one JPG, PNG, or WEBP image."
    }

    if (isBatchMode) {
      return `${files.length} files selected`
    }

    const file = files[0].file
    return `${file.name} - ${(file.size / 1024 / 1024).toFixed(2)} MB`
  }, [files, isBatchMode, inputMode])

  const donutData = useMemo(() => {
    if (!batchSummary) {
      return []
    }

    return Object.entries(batchSummary.grade_breakdown)
      .filter(([, count]) => count > 0)
      .map(([grade, count]) => ({ name: `Grade ${grade}`, value: count }))
  }, [batchSummary])

  const classificationFactorEntries = useMemo(() => {
    const factors = singleResult?.classification_factors
    if (!factors) {
      return []
    }

    return [
      ["Label", factors.label || singleResult?.classification_label || "Not estimated"],
      ["Process Output", factors.process_output || singleResult?.classification_label || "Not estimated"],
      ["Colour", factors.colour],
      ["Water Level", factors.water_level],
      ["Holes", factors.holes],
      ["Patches", factors.patches],
      ["Size", factors.size || "Not estimated"],
      ["Pulp Content", factors.pulp_content],
      ["Volume", factors.volume],
      ["Density", factors.density],
      ["Weight", factors.weight],
    ] as Array<[string, string]>
  }, [singleResult])

  const resetResults = () => {
    setSingleResult(null)
    setBatchResults([])
    setBatchSummary(null)
    setProgressText(null)
  }

  const clearAll = () => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current)
      progressTimer.current = null
    }
    for (const item of files) {
      URL.revokeObjectURL(item.previewUrl)
    }
    setFiles([])
    setError(null)
    resetResults()
    setIsSubmitting(false)
  }

  const validateFiles = (incomingFiles: File[]) => {
    if (incomingFiles.length === 0) {
      return [] as File[]
    }

    const invalidType = incomingFiles.find((file) => !ACCEPTED_TYPES.includes(file.type))
    if (invalidType) {
      setError("Unsupported file type. Please upload JPG, PNG, or WEBP images only.")
      return [] as File[]
    }

    if (isBatchMode && incomingFiles.length > 20) {
      setError("Batch mode accepts up to 20 images at once.")
      return [] as File[]
    }

    setError(null)
    return incomingFiles
  }

  const replaceFiles = (incomingFiles: File[]) => {
    const validFiles = validateFiles(incomingFiles)
    if (validFiles.length === 0) {
      return
    }

    for (const item of files) {
      URL.revokeObjectURL(item.previewUrl)
    }

    resetResults()
    setFiles(isBatchMode ? validFiles.map(createFileItem) : [createFileItem(validFiles[0])])
  }

  const removeFile = (id: string) => {
    setFiles((current) => {
      const target = current.find((item) => item.id == id)
      if (target) {
        URL.revokeObjectURL(target.previewUrl)
      }
      return current.filter((item) => item.id !== id)
    })
  }

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setCameraReady(false)
  }

  const startCamera = async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access is not available in this browser.")
      return
    }

    try {
      stopCamera()
      setCameraError(null)
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraReady(true)
    } catch (cameraErr) {
      setCameraReady(false)
      setCameraError(cameraErr instanceof Error ? cameraErr.message : "Unable to access camera.")
    }
  }

  const captureFromCamera = async () => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      setError("Camera is not ready. Please wait and try again.")
      return
    }

    const canvas = document.createElement("canvas")
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext("2d")
    if (!context) {
      setError("Failed to capture image from camera.")
      return
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95))
    if (!blob) {
      setError("Failed to capture image from camera.")
      return
    }

    const capturedFile = new File([blob], `camera-capture-${Date.now()}.jpg`, { type: "image/jpeg" })
    replaceFiles([capturedFile])
  }

  const retakeCameraPhoto = () => {
    for (const item of files) {
      URL.revokeObjectURL(item.previewUrl)
    }
    setFiles([])
    setError(null)
    resetResults()
    if (!streamRef.current) {
      void startCamera()
    }
  }

  const startProgress = (total: number) => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current)
    }

    let current = 1
    setProgressText(`Analyzing ${current} of ${total} coconuts...`)
    progressTimer.current = window.setInterval(() => {
      current = Math.min(current + 1, Math.max(total - 1, 1))
      setProgressText(`Analyzing ${current} of ${total} coconuts...`)
    }, 1400)
  }

  const stopProgress = () => {
    if (progressTimer.current) {
      window.clearInterval(progressTimer.current)
      progressTimer.current = null
    }
  }

  const handleSingleAssess = async () => {
    if (files.length === 0) {
      setError("Please choose an image before assessing.")
      return
    }

    const formData = new FormData()
    formData.append("image", files[0].file)
    if (inputMode === "camera") {
      formData.append("input_source", "camera")
    }

    setIsSubmitting(true)
    setError(null)
    resetResults()
    setProgressText("Analyzing coconut...")

    try {
      const response = await fetch("http://localhost:5000/api/assess", {
        method: "POST",
        body: formData,
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.error || "Assessment failed.")
      }
      setSingleResult(payload)
      await onAssessmentSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assessment failed.")
    } finally {
      setProgressText(null)
      setIsSubmitting(false)
    }
  }

  const handleBatchAssess = async () => {
    if (files.length === 0) {
      setError("Please choose one or more images before assessing.")
      return
    }

    const formData = new FormData()
    for (const item of files) {
      formData.append("images", item.file)
    }

    setIsSubmitting(true)
    setError(null)
    resetResults()
    startProgress(files.length)

    try {
      const response = await fetch("http://localhost:5000/api/assess/batch", {
        method: "POST",
        body: formData,
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.error || "Batch assessment failed.")
      }

      const summary = payload.find((item: { type?: string }) => item.type === "batch_summary") || null
      const results = payload.filter((item: { type?: string }) => item.type !== "batch_summary")
      setBatchSummary(summary)
      setBatchResults(results)
      setProgressText(`Analyzed ${files.length} of ${files.length} coconuts.`)
      await onAssessmentSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch assessment failed.")
    } finally {
      stopProgress()
      setIsSubmitting(false)
    }
  }

  const exportBatchCsv = () => {
    if (batchResults.length === 0) {
      return
    }

    const headers = [
      "filename",
      "grade",
      "weight_kg",
      "height_cm",
      "water_level_percent",
      "major_axis_cm",
      "minor_axis_cm",
      "volume_cm3",
      "density_g_cm3",
      "surface_quality",
      "crack_confidence",
      "mold_detected",
      "color_grade",
      "export_suitable",
      "confidence_score",
      "ai_summary",
      "error",
    ]

    const escape = (value: string | number | boolean | null | undefined) => {
      const text = value === null || value === undefined ? "" : String(value)
      return `"${text.replaceAll('"', '""')}"`
    }

    const rows = batchResults.map((result) =>
      [
        result.filename,
        result.grade,
        result.weight_kg,
        result.height_cm,
        result.water_level_percent ?? result.moisture_percent,
        result.major_axis_cm,
        result.minor_axis_cm,
        result.volume_cm3,
        result.density_g_cm3,
        result.surface_quality,
        result.crack_confidence,
        result.mold_detected,
        result.color_grade,
        result.export_suitable,
        result.confidence_score,
        result.ai_summary,
        result.error,
      ]
        .map(escape)
        .join(",")
    )

    const csv = [headers.join(","), ...rows].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `coconut-batch-results-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-2">
      <Card className="gap-0 rounded-lg border-slate-200 py-0 shadow-sm">
        <CardHeader className="space-y-1 p-2 pb-0">
          <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={inputMode === "upload" ? "outline" : "ghost"}
                onClick={() => setInputMode("upload")}
                className={`h-7 rounded-md border px-2.5 text-sm ${inputMode === "upload" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-600 hover:bg-slate-100"}`}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Upload Images
              </Button>
              <Button
                type="button"
                variant={inputMode === "camera" ? "outline" : "ghost"}
                onClick={() => setInputMode("camera")}
                className={`h-7 rounded-md border px-2.5 text-sm ${inputMode === "camera" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-600 hover:bg-slate-100"}`}
              >
                <Camera className="mr-1.5 h-3.5 w-3.5" />
                Live Camera
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500">Batch Mode</span>
              <button
                type="button"
                aria-label="Toggle batch mode"
                disabled={inputMode === "camera"}
                onClick={() => {
                  clearAll()
                  setIsBatchMode((current) => !current)
                }}
                className={`h-6 w-11 rounded-full transition ${inputMode === "camera" ? "cursor-not-allowed bg-slate-200" : isBatchMode ? "bg-emerald-500" : "bg-slate-300"}`}
              >
                <span
                  className={`block h-4 w-4 rounded-full bg-white transition-transform ${isBatchMode && inputMode !== "camera" ? "translate-x-6" : "translate-x-1"}`}
                />
              </button>
            </div>
          </div>
          <CardDescription className="text-xs text-slate-500">
            {inputMode === "camera"
              ? "Capture coconut image directly from camera."
              : isBatchMode
                ? "Drop coconut images for batch quality assessment."
                : "Drop a coconut image or browse files to start."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1 p-2 pt-1">
          {inputMode === "upload" ? (
            <label
              className={`flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-4 text-center transition ${
                isDragging
                  ? "border-emerald-500 bg-emerald-50"
                  : "border-emerald-200 bg-gradient-to-br from-white to-emerald-50/60 hover:border-emerald-300"
              }`}
              onDragOver={(event) => {
                event.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setIsDragging(false)
                replaceFiles(Array.from(event.dataTransfer.files || []))
              }}
            >
              <input
                type="file"
                multiple={isBatchMode}
                accept=".jpg,.jpeg,.png,.webp"
                className="hidden"
                onChange={(event) => replaceFiles(Array.from(event.target.files || []))}
              />
              {files.length > 0 && !isBatchMode ? (
                <div className="w-full space-y-4">
                  <img src={files[0].previewUrl} alt="Coconut preview" className="mx-auto max-h-40 rounded-lg object-contain shadow-sm" />
                  <div className="flex items-center justify-center gap-2 text-sm text-slate-600">
                    <ImagePlus className="h-4 w-4" />
                    Click or drop a different image to replace this one.
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-1 rounded-full bg-emerald-100 p-2 text-emerald-700">
                    <Upload className="h-4 w-4" />
                  </div>
                  <p className="text-base font-semibold text-slate-900">{isBatchMode ? "Drop coconut images here" : "Drop coconut image here"}</p>
                  <p className="text-sm text-slate-500">
                    or <span className="font-semibold text-emerald-700">browse files</span>
                  </p>
                </>
              )}
            </label>
          ) : (
            <div className="rounded-lg border-2 border-dashed border-emerald-200 bg-slate-50 p-2">
              <div className="relative h-72 overflow-hidden rounded-md bg-slate-900">
                <video
                  ref={videoRef}
                  className={`h-full w-full object-contain ${cameraReady && files.length === 0 ? "block" : "hidden"}`}
                  muted
                  playsInline
                />
                {files.length > 0 ? (
                  <div className="flex h-full w-full flex-col items-center justify-center bg-slate-950">
                    <img src={files[0].previewUrl} alt="Captured coconut" className="h-full w-full object-contain" />
                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-slate-950/80 px-3 py-1 text-xs font-semibold text-white shadow">
                      Captured image ready for assessment
                    </div>
                  </div>
                ) : null}
                {!cameraReady && files.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center text-slate-300">
                    <CameraOff className="mb-1 h-6 w-6" />
                    <p className="text-sm">Camera preview unavailable</p>
                  </div>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => (files.length > 0 ? retakeCameraPhoto() : void startCamera())}
                  variant="outline"
                  className="h-8 border-emerald-200 text-sm text-emerald-700 hover:bg-emerald-50"
                >
                  <Camera className="mr-1.5 h-3.5 w-3.5" />
                  {files.length > 0 ? "Retake Photo" : "Start Camera"}
                </Button>
                <Button
                  type="button"
                  onClick={() => void captureFromCamera()}
                  disabled={!cameraReady || files.length > 0}
                  className="h-8 bg-emerald-600 text-sm text-white hover:bg-emerald-700"
                >
                  Capture Image
                </Button>
              </div>
              {cameraError && <p className="mt-1 text-xs text-rose-700">{cameraError}</p>}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
            <span>{helperText}</span>
            {files.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={clearAll} className="h-6 px-2 text-xs">
                Clear
              </Button>
            )}
          </div>

          {isBatchMode && inputMode === "upload" && files.length > 0 && (
            <div className="grid gap-2 md:grid-cols-2">
              {files.map((item) => (
                <div key={item.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-white p-1.5">
                  <img src={item.previewUrl} alt={item.file.name} className="h-9 w-9 rounded object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-900">{item.file.name}</p>
                    <p className="text-xs text-slate-500">{(item.file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeFile(item.id)} className="h-6 w-6">
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {progressText && (
            <div className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{progressText}</span>
            </div>
          )}

          <p className="text-xs leading-none text-slate-500">Supports JPG, PNG, WEBP | up to 20 files</p>

          <Button
            type="button"
            onClick={isBatchMode && inputMode === "upload" ? handleBatchAssess : handleSingleAssess}
            disabled={files.length === 0 || isSubmitting}
            className="h-7 w-full bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isBatchMode && inputMode === "upload" ? "Analyzing batch..." : "Analyzing coconut..."}
              </>
            ) : isBatchMode && inputMode === "upload" ? (
              "Assess All"
            ) : (
              "Assess Coconut"
            )}
          </Button>
        </CardContent>
      </Card>

      {singleResult && files[0] && !isBatchMode && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-gray-900">Assessment Result</CardTitle>
              <CardDescription>{new Date(singleResult.timestamp).toLocaleString()}</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge className={`border px-4 py-2 text-lg font-bold ${getGradeClasses(singleResult.grade)}`}>
                Grade {singleResult.grade}
              </Badge>
              {singleResult.classification_label && (
                <Badge className={`border px-4 py-2 text-sm font-semibold ${getClassificationClasses(singleResult.classification_label)}`}>
                  {singleResult.classification_label}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-[1.1fr,1fr]">
              <div className="space-y-4">
                <img src={files[0].previewUrl} alt="Uploaded coconut" className="w-full rounded-2xl border border-gray-200 object-cover" />
                <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm font-semibold text-gray-700">Gemini Vision Summary</p>
                  <p className="mt-2 text-sm leading-6 text-gray-600">{singleResult.ai_summary}</p>
                  {singleResult.texture_notes && <p className="mt-3 text-xs text-gray-500">Texture notes: {singleResult.texture_notes}</p>}
                  {singleResult.classification_label && (
                    <div className="mt-4 rounded-xl border border-gray-200 bg-white px-3 py-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Labeled Category</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge className={`border ${getClassificationClasses(singleResult.classification_label)}`}>
                          {singleResult.classification_label}
                        </Badge>
                        {singleResult.classification_confidence !== null && singleResult.classification_confidence !== undefined && (
                          <span className="text-xs text-gray-500">{(singleResult.classification_confidence * 100).toFixed(0)}% confidence</span>
                        )}
                      </div>
                      {singleResult.classification_reason && <p className="mt-2 text-xs leading-5 text-gray-600">{singleResult.classification_reason}</p>}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                {classificationFactorEntries.length > 0 && (
                  <div className="rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4">
                    <p className="text-sm font-semibold text-emerald-900">Classification Factors</p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {classificationFactorEntries.map(([label, value]) => (
                        <div key={label} className="rounded-xl border border-emerald-100 bg-white px-3 py-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">{label}</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">{value || "Not estimated"}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <MetricCard label="Weight" value={formatNullable(singleResult.weight_kg, " kg")} />
                  <MetricCard
                    label="Height"
                    value={formatNullable(singleResult.height_cm, " cm")}
                    hint={
                      singleResult.height_source === "axis_regression_estimate"
                        ? `Estimated from axes${singleResult.height_confidence ? ` (${(singleResult.height_confidence * 100).toFixed(0)}% confidence)` : ""}`
                        : singleResult.height_source === "simulated_sensor"
                          ? "Fallback estimate"
                          : undefined
                    }
                  />
                  <MetricCard label="Water Level" value={formatNullable(singleResult.water_level_percent ?? singleResult.moisture_percent, "%")} />
                  <MetricCard label="Surface Quality" value={singleResult.surface_quality || "N/A"} />
                  <MetricCard label="Major Axis" value={formatNullable(singleResult.major_axis_cm, " cm")} />
                  <MetricCard label="Minor Axis" value={formatNullable(singleResult.minor_axis_cm, " cm")} />
                  <MetricCard label="Volume" value={formatNullable(singleResult.volume_cm3, " cm3")} />
                  <MetricCard label="Density" value={formatNullable(singleResult.density_g_cm3, " g/cm3")} />
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant="outline" className="border-gray-300 px-3 py-1 text-sm text-gray-700">
                    Color Grade: {singleResult.color_grade || "N/A"}
                  </Badge>
                  <Badge className={singleResult.export_suitable ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}>
                    Export Suitable: {singleResult.export_suitable ? "Yes" : "No"}
                  </Badge>
                  <Badge variant="outline" className="border-gray-300 px-3 py-1 text-sm text-gray-700">
                    Crack Confidence: {singleResult.crack_confidence !== null ? `${(singleResult.crack_confidence * 100).toFixed(0)}%` : "N/A"}
                  </Badge>
                  <Badge variant="outline" className="border-gray-300 px-3 py-1 text-sm text-gray-700">
                    Mold Detected: {singleResult.mold_detected ? "Yes" : "No"}
                  </Badge>
                </div>

                <div className="rounded-2xl border border-gray-200 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-semibold text-gray-800">Detection and Axis Analysis</p>
                    <span className="text-xs text-gray-500">
                      Confidence score: {(singleResult.confidence_score * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="mb-3 grid gap-3 sm:grid-cols-3">
                    <div className="rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-gray-500">Axis Model</p>
                      <p className="mt-1 text-sm font-semibold text-gray-800">{formatAxisSource(singleResult.axis_source)}</p>
                    </div>
                    <div className="rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-gray-500">Axis Angle</p>
                      <p className="mt-1 text-sm font-semibold text-gray-800">
                        {singleResult.axis_angle_degrees !== null && singleResult.axis_angle_degrees !== undefined
                          ? `${singleResult.axis_angle_degrees.toFixed(1)}°`
                          : "N/A"}
                      </p>
                    </div>
                    <div className="rounded-xl bg-gray-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-gray-500">Axis Confidence</p>
                      <p className="mt-1 text-sm font-semibold text-gray-800">
                        {singleResult.axis_confidence !== null && singleResult.axis_confidence !== undefined
                          ? `${(singleResult.axis_confidence * 100).toFixed(0)}%`
                          : "N/A"}
                      </p>
                    </div>
                  </div>
                  {singleResult.yolo_detections.length > 0 ? (
                    <ul className="space-y-2 text-sm text-gray-600">
                      {singleResult.yolo_detections.map((detection, index) => (
                        <li key={`${detection.class}-${index}`} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                          <span className="font-medium text-gray-800">{detection.class}</span>
                          <span>{(detection.confidence * 100).toFixed(1)}%</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-gray-500">No object detections were returned for this image.</p>
                  )}
                  {!singleResult.axis_detected && (
                    <p className="mt-3 text-xs text-amber-700">
                      {singleResult.axis_warning || "No coconut contour was detected, so axis measurements were left empty."}
                    </p>
                  )}
                </div>

                <Button type="button" variant="outline" onClick={clearAll} className="w-full border-green-200 text-green-700 hover:bg-green-50">
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  Save and Assess Another
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {isBatchMode && batchSummary && (
        <Card className="border-gray-200 shadow-sm">
          <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-gray-900">Batch Results Summary</CardTitle>
              <CardDescription>
                Processed {batchSummary.total_processed} coconuts in {batchSummary.processing_time_seconds.toFixed(2)} seconds.
              </CardDescription>
            </div>
            <Button type="button" variant="outline" onClick={exportBatchCsv} className="border-green-200 text-green-700 hover:bg-green-50">
              Export Batch Results to CSV
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 lg:grid-cols-[320px,1fr]">
              <div className="h-72 rounded-2xl border border-gray-200 bg-white p-4">
                {donutData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={90} paddingAngle={3}>
                        {donutData.map((entry, index) => (
                          <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-gray-500">No graded results yet.</div>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Export Suitable" value={`${batchSummary.export_suitable_count} of ${batchSummary.total_processed}`} />
                <MetricCard label="Average Weight" value={`${batchSummary.average_weight.toFixed(2)} kg`} />
                <MetricCard label="Average Water Level" value={`${(batchSummary.average_water_level ?? batchSummary.average_moisture).toFixed(2)}%`} />
                <MetricCard
                  label="Grade Breakdown"
                  value={Object.entries(batchSummary.grade_breakdown)
                    .map(([grade, count]) => `${grade}:${count}`)
                    .join(" ")}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {isBatchMode && batchResults.length > 0 && (
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {batchResults.map((result, index) => {
            const source = files.find((item) => item.file.name === result.filename) || files[index]
            return (
              <Card key={`${result.filename || "item"}-${index}`} className="min-w-0 overflow-hidden border-gray-200 py-0 shadow-sm">
                <CardHeader className="block space-y-3 overflow-hidden px-4 pt-4 pb-0">
                  <div className="min-w-0 space-y-2">
                    <div className="min-w-0">
                      <CardTitle className="line-clamp-2 break-all text-base leading-5 text-gray-900">{result.filename || `Coconut ${index + 1}`}</CardTitle>
                      <CardDescription className="mt-1">
                        {result.classification_label || (result.grade ? `Grade ${result.grade}` : "Assessment failed")}
                      </CardDescription>
                    </div>
                    <div className="flex max-w-full flex-wrap gap-2">
                      <Badge className={`border ${getGradeClasses(result.grade)}`}>{result.grade || "Error"}</Badge>
                      {result.classification_label && (
                        <Badge className={`border ${getClassificationClasses(result.classification_label)}`}>{result.classification_label}</Badge>
                      )}
                    </div>
                  </div>
                  {source && (
                    <div className="flex h-48 w-full items-center justify-center overflow-hidden rounded-lg bg-slate-100 p-2">
                      <CroppedPreviewImage src={source.previewUrl} alt={result.filename || `Coconut ${index + 1}`} />
                    </div>
                  )}
                </CardHeader>
                <CardContent className="space-y-4 px-4 py-4">
                  {result.error ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{result.error}</div>
                  ) : (
                    <>
                      <p className="text-sm leading-6 text-gray-600">{result.ai_summary}</p>
                      {result.classification_reason && (
                        <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
                          <span className="font-semibold text-gray-800">Category reason:</span> {result.classification_reason}
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <MiniMetric label="Weight" value={formatNullable(result.weight_kg, " kg")} />
                        <MiniMetric label="Water Level" value={formatNullable(result.water_level_percent ?? result.moisture_percent, "%")} />
                        <MiniMetric label="Height" value={formatNullable(result.height_cm, " cm")} />
                        <MiniMetric label="Surface" value={result.surface_quality || "N/A"} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge className={result.export_suitable ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}>
                          {result.export_suitable ? "Export Yes" : "Export No"}
                        </Badge>
                        <Badge variant="outline">Confidence {(result.confidence_score * 100).toFixed(0)}%</Badge>
                      </div>
                      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Detections</p>
                        {result.yolo_detections.length > 0 ? (
                          <ul className="space-y-1 text-sm text-gray-700">
                            {result.yolo_detections.map((detection, itemIndex) => (
                              <li key={`${detection.class}-${itemIndex}`} className="flex items-center justify-between">
                                <span>{detection.class}</span>
                                <span>{(detection.confidence * 100).toFixed(1)}%</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-sm text-gray-500">No detections returned.</p>
                        )}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-2 flex items-center gap-2 text-base font-semibold text-gray-900">
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        {value}
      </p>
      {hint && <p className="mt-2 text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
      <p className="mt-1 font-semibold text-gray-900">{value}</p>
    </div>
  )
}

function CroppedPreviewImage({ src, alt }: { src: string; alt: string }) {
  const [displaySrc, setDisplaySrc] = useState(src)

  useEffect(() => {
    let cancelled = false
    const image = new window.Image()
    image.crossOrigin = "anonymous"
    image.onload = () => {
      const canvas = document.createElement("canvas")
      const context = canvas.getContext("2d", { willReadFrequently: true })
      if (!context || image.naturalWidth === 0 || image.naturalHeight === 0) {
        if (!cancelled) setDisplaySrc(src)
        return
      }

      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      context.drawImage(image, 0, 0)

      const { width, height } = canvas
      const pixels = context.getImageData(0, 0, width, height).data
      let minX = width
      let minY = height
      let maxX = 0
      let maxY = 0

      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4
          const red = pixels[index]
          const green = pixels[index + 1]
          const blue = pixels[index + 2]
          const alpha = pixels[index + 3]
          const maxChannel = Math.max(red, green, blue)
          const minChannel = Math.min(red, green, blue)
          const brightness = (red + green + blue) / 3
          const saturation = maxChannel - minChannel
          const isDarkPadding = brightness < 35
          const isLightPadding = brightness > 225 && saturation < 18
          const isVisiblePixel = alpha > 10 && !isDarkPadding && !isLightPadding

          if (isVisiblePixel) {
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
          }
        }
      }

      const cropWidth = maxX - minX + 1
      const cropHeight = maxY - minY + 1
      const shouldCrop = cropWidth > 0 && cropHeight > 0 && (cropWidth < width * 0.92 || cropHeight < height * 0.92)

      if (!shouldCrop) {
        if (!cancelled) setDisplaySrc(src)
        return
      }

      const padding = 8
      const sx = Math.max(minX - padding, 0)
      const sy = Math.max(minY - padding, 0)
      const sw = Math.min(cropWidth + padding * 2, width - sx)
      const sh = Math.min(cropHeight + padding * 2, height - sy)
      const cropped = document.createElement("canvas")
      const croppedContext = cropped.getContext("2d")

      if (!croppedContext) {
        if (!cancelled) setDisplaySrc(src)
        return
      }

      cropped.width = sw
      cropped.height = sh
      croppedContext.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)

      if (!cancelled) {
        setDisplaySrc(cropped.toDataURL("image/jpeg", 0.92))
      }
    }
    image.onerror = () => {
      if (!cancelled) setDisplaySrc(src)
    }
    image.src = src

    return () => {
      cancelled = true
    }
  }, [src])

  return <img src={displaySrc} alt={alt} className="block h-full w-full rounded-md object-contain object-center" />
}
