import { lazy } from "react"

let pipelineChunkPromise: Promise<typeof import("@/components/pipeline-page")> | null =
  null

export function prefetchPipelineChunk() {
  pipelineChunkPromise ??= import("@/components/pipeline-page")
  return pipelineChunkPromise
}

export const LazyPipelinePage = lazy(() =>
  prefetchPipelineChunk().then((module) => ({ default: module.PipelinePage })),
)
