export function resolveJobEventText(
  eventType: string,
  payload: Record<string, unknown>,
): { title: string; description: string } {
  const title = payload.title ?? payload.message
  const description = payload.description
  if (typeof title === "string" && typeof description === "string" && description) {
    return { title, description }
  }
  if (typeof title === "string" && !payload.phase) {
    return {
      title,
      description: typeof description === "string" ? description : "",
    }
  }

  const phase = String(payload.phase ?? "")
  if (phase === "endpoint-switch") {
    return {
      title: "Đổi model hoặc API key",
      description: [
        payload.reason ?? "Endpoint hiện tại không khả dụng",
        payload.keyIndex !== undefined && payload.keyCount !== undefined
          ? `Key ${payload.keyIndex}/${payload.keyCount}`
          : null,
        payload.model,
      ]
        .filter(Boolean)
        .join(" · "),
    }
  }
  if (phase === "retry") {
    return {
      title: "Đang thử lại API",
      description: `Lần ${payload.attempt ?? "?"} · chờ ${payload.waitSeconds ?? "?"} giây`,
    }
  }
  if (phase === "item-fallback") {
    return {
      title: "Fallback dịch từng mục",
      description: `ID ${payload.id ?? "?"} · ${payload.error ?? "Không dịch được batch"}`,
    }
  }
  if (phase === "qa-summary") {
    const counts = payload.issueCounts
    const summary =
      counts && typeof counts === "object" && !Array.isArray(counts)
        ? Object.entries(counts as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 5)
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ")
        : String(payload.issueCount ?? 0)
    return {
      title: "QA phát hiện cảnh báo",
      description: `${payload.issueCount ?? 0} vấn đề · ${summary}`,
    }
  }

  return {
    title: typeof title === "string" ? title : eventType,
    description:
      typeof description === "string"
        ? description
        : typeof payload.reason === "string"
          ? payload.reason
          : typeof payload.error === "string"
            ? payload.error
            : "",
  }
}
