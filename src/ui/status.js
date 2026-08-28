// The status line in the transport bar. Long messages scroll into a toast
// that clears itself, so callers just set text and forget.

let statusToastTimer = null;

export function getStatusEl() {
  return document.getElementById('status');
}

export function setStatus(text) {
  const status = getStatusEl();
  if (status) {
    const statusText = status.querySelector('.status-text') || status;
    statusText.textContent = text;
    status.title = text;
    status.dataset.message = text;
    status.classList.remove('status-overflow', 'status-toast-visible');
    if (statusToastTimer) clearTimeout(statusToastTimer);
    requestAnimationFrame(() => {
      if (status.dataset.message !== text || statusText.scrollWidth <= statusText.clientWidth) {
        return;
      }
      status.classList.add('status-overflow', 'status-toast-visible');
      statusToastTimer = setTimeout(() => {
        status.classList.remove('status-toast-visible');
        statusToastTimer = null;
      }, 5000);
    });
  }
}
