import { useEffect, useState } from "preact/hooks";
import { html } from "../html.js";
import { Empty, Skeleton } from "../ui.js";
import { get } from "../api.js";
import { reportError } from "../store.js";
import { board } from "./state.js";

const PROVIDERS = [
  { id: "claude", label: "Claude", note: "New tokens: input, cache writes and output. Re-read context is counted separately." },
  { id: "codex", label: "Codex", note: "Codex reports one running total per thread, re-read context included, counted on the thread's last day." }
];

export function amount(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 1000) return `${Math.round(number / 1000)}k`;
  return String(number);
}

const weekday = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short" });

function ProviderUsage({ provider, usage }) {
  const days = usage.days;
  const peak = Math.max(...days.map((day) => day[provider.id]), 1);
  const pace = usage.pace[provider.id];
  const models = usage.models.filter((row) => row.provider === provider.id);
  const today = usage.today[provider.id];
  return html`<section class=${`card usage-card usage-${provider.id}`}>
    <header class="usage-head">
      <div>
        <div class="eyebrow">${provider.label}</div>
        <h3>${amount(today)} today <span class="muted">· ${amount(usage.week[provider.id])} this week</span></h3>
      </div>
      ${pace.fast ? html`<span class="pill pill-warn">${pace.ratio.toFixed(1)}× your usual day</span>` : pace.usual ? html`<span class="pill">Usual day: ${amount(pace.usual)}</span>` : null}
    </header>
    <div class="usage-bars" role="img" aria-label=${`${provider.label} tokens per day for the last ${days.length} days`}>
      ${days.map((day, index) => html`<div class=${`usage-bar ${index === days.length - 1 ? "is-today" : ""}`} title=${`${day.day}: ${amount(day[provider.id])}${provider.id === "claude" && day.jarvis ? `, ${amount(day.jarvis)} from runs started here` : ""}`}>
        <i style=${`height: ${(day[provider.id] / peak) * 100}%`}></i>
        <span>${weekday(day.day).slice(0, 2)}</span>
      </div>`)}
    </div>
    <p class="muted small">${provider.note}${provider.id === "claude" && usage.today.claudeCacheRead ? ` ${amount(usage.today.claudeCacheRead)} re-read today.` : ""}</p>
    ${models.length ? html`<table class="usage-models">
      <thead><tr><th>Model</th><th>${days.length} days</th>${provider.id === "claude" ? html`<th>Re-read</th>` : null}</tr></thead>
      <tbody>${models.map((row) => html`<tr><td><code>${row.model}</code></td><td>${amount(row.tokens)}</td>${provider.id === "claude" ? html`<td class="muted">${amount(row.cacheRead)}</td>` : null}</tr>`)}</tbody>
    </table>` : null}
  </section>`;
}

export function Usage() {
  const [usage, setUsage] = useState(null);
  const working = board.value?.counts?.working || 0;
  useEffect(() => {
    get("/api/agents/usage").then((data) => setUsage(data.usage)).catch(reportError);
  }, [working]);
  if (!usage) return html`<${Skeleton} lines=${8} />`;
  const providers = PROVIDERS.filter((provider) => provider.id === "claude" || usage.sources.codex);
  if (!usage.days.some((day) => day.claude || day.codex)) return html`<${Empty} icon="layers" title="No usage yet">Token use from Claude Code and Codex on this computer shows up here.</${Empty}>`;
  const jarvis = usage.days.reduce((sum, day) => sum + day.jarvis, 0);
  return html`<div class="usage">
    <p class="muted small">Tokens used on this computer over the last ${usage.days.length} days, read from Claude Code's and Codex's own records. Jarvis can't see your plan's limits, so these are amounts, not a share of your allowance.${jarvis ? ` Runs started here used ${amount(jarvis)}; they're included above.` : ""}</p>
    ${providers.map((provider) => html`<${ProviderUsage} key=${provider.id} provider=${provider} usage=${usage} />`)}
  </div>`;
}
