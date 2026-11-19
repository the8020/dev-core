export default function mount({host, config, signal}) {
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  const frame = document.createElement("iframe");
  frame.title = "Tuxee";
  frame.allow = "microphone; autoplay; clipboard-read; clipboard-write; fullscreen";
  host.classList.add("desktop-view");
  host.replaceChildren(status, frame);
  let current;
  async function connect(active) {
    if (!active) {
      current?.abort();
      current = undefined;
      frame.removeAttribute("src");
      host.classList.remove("uui-content-fullscreen");
      return;
    }
    if (current || signal.aborted) return;
    host.classList.add("uui-content-fullscreen");
    status.textContent = config.loading;
    const lifetime = current = new AbortController();
    try {
      const res = await fetch("/desktop/open", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({language:config.language}), signal:lifetime.signal});
      if (!res.ok) throw Error(String(res.status));
      const {url, code, view} = await res.json();
      if (!lifetime.signal.aborted) {
        const attached = await fetch("/desktop/attached", {method:"POST", headers:{"Content-Type":"text/plain"}, body:view, signal:lifetime.signal});
        if (!attached.ok) throw Error(String(attached.status));
        frame.onload = () => {status.textContent = "";};
        frame.src = url + "#" + code;
        const reader = attached.body.getReader();
        while (!(await reader.read()).done) { /* The open response holds the sandbox console. */ }
        if (!lifetime.signal.aborted) throw Error(String(attached.status));
      }
    } catch (e) {if (!lifetime.signal.aborted) { frame.onload = null; frame.removeAttribute("src"); status.textContent = config.error + " (" + e.message + ")"; }}
  }
  connect(true);
  const close = () => {connect(false); host.classList.remove("desktop-view");};
  signal.addEventListener("abort", close, {once:true});
  return {setActive:connect, dispose:close};
}
