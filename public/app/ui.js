import { useEffect, useRef } from "preact/hooks";
import { html } from "./html.js";
import { Icon } from "./icons.js";
import { categoryColor, CATEGORY_META } from "./format.js";

export function Button({ children, variant = "secondary", size = "", icon, iconRight, class: className = "", ...props }) {
  return html`<button type="button" class=${`btn btn-${variant} ${size ? `btn-${size}` : ""} ${className}`} ...${props}>
    ${icon ? html`<${Icon} name=${icon} size=${size === "sm" ? 15 : 17} />` : null}
    ${children ? html`<span>${children}</span>` : null}
    ${iconRight ? html`<${Icon} name=${iconRight} size=${size === "sm" ? 15 : 17} />` : null}
  </button>`;
}

export function IconButton({ icon, label, size = 18, class: className = "", ...props }) {
  return html`<button type="button" class=${`icon-btn ${className}`} aria-label=${label} title=${label} ...${props}><${Icon} name=${icon} size=${size} /></button>`;
}

export function Ring({ value = 0, size = 64, stroke = 6, color = "var(--accent)", track = "var(--surface-3)", children, label }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, value));
  return html`<div class="ring" style=${{ width: `${size}px`, height: `${size}px` }} role="img" aria-label=${label || `${Math.round(clamped * 100)}%`}>
    <svg width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`}>
      <circle cx=${size / 2} cy=${size / 2} r=${radius} fill="none" stroke=${track} stroke-width=${stroke} />
      <circle class="ring-value" cx=${size / 2} cy=${size / 2} r=${radius} fill="none" stroke=${color} stroke-width=${stroke}
        stroke-linecap="round" stroke-dasharray=${circumference} stroke-dashoffset=${circumference * (1 - clamped)}
        transform=${`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
    <div class="ring-label">${children}</div>
  </div>`;
}

export function Bar({ value = 0, color = "var(--accent)", class: className = "" }) {
  return html`<div class=${`bar ${className}`}><span style=${{ width: `${Math.max(0, Math.min(100, value * 100))}%`, background: color }}></span></div>`;
}

export function CategoryTag({ category, compact = false }) {
  return html`<span class="cat-tag" style=${{ "--cat": categoryColor(category) }}>
    <i></i>${compact ? CATEGORY_META[category]?.short || category : CATEGORY_META[category]?.label || category}
  </span>`;
}

export function Check({ checked, onChange, label, color }) {
  return html`<button type="button" role="checkbox" aria-checked=${checked ? "true" : "false"} aria-label=${label}
    class=${`check ${checked ? "is-checked" : ""}`} style=${color ? { "--check": color } : null}
    onClick=${(event) => { event.stopPropagation(); onChange(!checked); }}>
    <${Icon} name="check" size=${13} />
  </button>`;
}

export function Kbd({ children }) {
  return html`<kbd class="kbd">${children}</kbd>`;
}

export function Empty({ icon = "sparkles", title, children }) {
  return html`<div class="empty">
    <div class="empty-icon"><${Icon} name=${icon} size=${22} /></div>
    <strong>${title}</strong>
    ${children ? html`<p>${children}</p>` : null}
  </div>`;
}

export function Skeleton({ lines = 3 }) {
  return html`<div class="skeleton">${Array.from({ length: lines }, (_, index) => html`<span style=${{ width: `${92 - index * 14}%` }}></span>`)}</div>`;
}

export function Tabs({ tabs, value, onChange, class: className = "" }) {
  return html`<div class=${`tabs ${className}`} role="tablist">
    ${tabs.map((tab) => html`<button type="button" role="tab" aria-selected=${tab.id === value ? "true" : "false"}
      class=${`tab ${tab.id === value ? "is-active" : ""}`} onClick=${() => onChange(tab.id)}>
      ${tab.icon ? html`<${Icon} name=${tab.icon} size=${15} />` : null}<span>${tab.label}</span>
      ${tab.count !== undefined ? html`<em>${tab.count}</em>` : null}
    </button>`)}
  </div>`;
}

// Keeps focus inside a dialog and closes on Escape.
function useDialog(open, onClose, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const node = ref.current;
    const focusable = () => [...node.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled);
    requestAnimationFrame(() => (node.querySelector("[autofocus]") || focusable()[0] || node).focus());
    const onKey = (event) => {
      if (event.key === "Escape") {
        // Key repeat from an Escape held before the dialog opened (hold Esc to
        // leave focus) must not close it the moment it appears.
        if (event.repeat) return;
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open]);
}

export function Modal({ open, onClose, title, children, wide = false, class: className = "" }) {
  const ref = useRef(null);
  useDialog(open, onClose, ref);
  if (!open) return null;
  return html`<div class="overlay" onMouseDown=${(event) => event.target === event.currentTarget && onClose()}>
    <div ref=${ref} class=${`modal ${wide ? "modal-wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label=${title} tabindex="-1">
      ${title ? html`<header class="modal-head"><h2>${title}</h2><${IconButton} icon="x" label="Close" onClick=${onClose} /></header>` : null}
      ${children}
    </div>
  </div>`;
}

export function Sheet({ open, onClose, title, children }) {
  const ref = useRef(null);
  useDialog(open, onClose, ref);
  if (!open) return null;
  return html`<div class="overlay overlay-sheet" onMouseDown=${(event) => event.target === event.currentTarget && onClose()}>
    <aside ref=${ref} class="sheet" role="dialog" aria-modal="true" aria-label=${title} tabindex="-1">${children}</aside>
  </div>`;
}

export function Field({ label, hint, children }) {
  return html`<label class="field"><span class="field-label">${label}</span>${children}${hint ? html`<span class="field-hint">${hint}</span>` : null}</label>`;
}
