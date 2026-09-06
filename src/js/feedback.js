// Shared transient feedback. Progress belongs in the initiating button; errors
// stay available to read/copy until dismissed or replaced by the next message.
export function notify(message, { error = false } = {}) {
  document.getElementById('app-notification')?.remove();
  const notice = document.createElement('div');
  notice.id = 'app-notification';
  notice.className = `app-notification${error ? ' is-error' : ''}`;
  notice.setAttribute('role', error ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'btn-ghost';
  dismiss.textContent = 'Dismiss';
  dismiss.onclick = () => notice.remove();
  notice.append(text, dismiss);
  document.body.append(notice);
  if (!error) setTimeout(() => notice.remove(), 6000);
}

export async function withButtonProgress(button, label, work) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try {
    return await work(text => { button.textContent = text; });
  } catch (error) {
    if (error.name !== 'AbortError') notify(error.message, { error: true });
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
}
