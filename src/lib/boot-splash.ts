const BOOT_SPLASH_EXIT_MS = 240

/** Fade-out splash HTML tĩnh sau khi React mount. */
export function dismissBootSplash() {
  const splash = document.getElementById("app-boot-splash")
  if (!splash || splash.dataset.dismissed === "true") return

  splash.dataset.dismissed = "true"
  splash.classList.add("app-boot--exit")

  const remove = () => splash.remove()
  splash.addEventListener("animationend", remove, { once: true })
  window.setTimeout(remove, BOOT_SPLASH_EXIT_MS + 40)
}
