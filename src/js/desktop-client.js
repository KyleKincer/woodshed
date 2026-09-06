import { initializeLocalDesktop } from "./companion.js";
let state = { status: "idle" },
  button,
  applying = false;
const icon =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function render() {
  if (!button) return;
  button.hidden = !["available", "downloading", "ready"].includes(state.status);
  button.disabled = applying;
  const label =
    state.status === "downloading"
      ? `Downloading update — ${Math.round(state.percent || 0)}%`
      : state.status === "ready"
        ? "Update ready — restart Woodshed"
        : "Update available";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.toggle("is-downloading", state.status === "downloading");
}
async function checkUpdates() {
  if (applying) return;
  applying = true;
  try {
    await window.woodshedDesktop.update("show");
  } catch (error) {
    console.error("Could not show updates:", error);
  } finally {
    applying = false;
    render();
  }
}
export async function initializeDesktop() {
  button = document.createElement("button");
  button.type = "button";
  button.className = "desktop-update-trigger";
  button.innerHTML = icon;
  button.onclick = checkUpdates;
  document.getElementById("user-button").before(button);
  render();
  let receivedUpdate = false;
  window.woodshedDesktop.onUpdate((next) => {
    receivedUpdate = true;
    state = next;
    render();
  });
  window.woodshedDesktop.onOpenUpdates?.(checkUpdates);
  document.addEventListener("woodshed:show-updates", checkUpdates);
  try {
    const info = await initializeLocalDesktop();
    if (!receivedUpdate) state = info.update;
    render();
  } catch (error) {
    console.error("Could not initialize local processing:", error);
  }
}
