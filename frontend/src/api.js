const API_BASE = import.meta.env.VITE_API_URL || "http://127.0.0.1:4000";

async function request(path, options = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const data = await r.json();
  if (!r.ok && !data.error) {
    throw new Error(r.statusText || "Request failed");
  }
  return data;
}

export const api = {
  getState: () => request("/api/state"),
  getHistory: () => request("/api/history"),
  previewPolicy: (body) =>
    request("/api/policy/preview", { method: "POST", body: JSON.stringify(body) }),
  registerPolicy: (body) =>
    request("/api/policy/register", { method: "POST", body: JSON.stringify(body) }),
  agentProve: (body) =>
    request("/api/agent/prove", { method: "POST", body: JSON.stringify(body) }),
  agentAuthorize: (body = {}) =>
    request("/api/agent/authorize", { method: "POST", body: JSON.stringify(body) }),
  runDemo: (type) => request(`/api/demo/${type}`, { method: "POST" }),
};

export { API_BASE };
