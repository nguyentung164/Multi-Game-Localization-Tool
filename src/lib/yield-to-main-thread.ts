/** Nhường main thread để React kịp vẽ loading trước tác vụ nặng. */
export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}
