const PANELS = ["keys", "agents", "analytics", "billing"];

export function dashboardPanel(location) {
  const query = new URLSearchParams(location.search).get("panel")?.trim().toLowerCase();
  const hash = String(location.hash || "").slice(1).trim().toLowerCase();
  return PANELS.includes(query) ? query : PANELS.includes(hash) ? hash : "";
}

export function dashboardDestination(location, login = false) {
  const params = new URLSearchParams();
  if (login) params.set("login", "1");
  const panel = dashboardPanel(location);
  if (panel) params.set("panel", panel);
  return `/dashboard${params.size ? `?${params}` : ""}`;
}

export function dashboardPanelUrl(href, panel) {
  const url = new URL(href);
  url.hash = "";
  if (panel === "keys") url.searchParams.delete("panel");
  else if (PANELS.includes(panel)) url.searchParams.set("panel", panel);
  return `${url.pathname}${url.search}`;
}
