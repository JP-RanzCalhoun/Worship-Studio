// Small, reusable UI primitives. Styling lives in styles/components.css.

import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties, type ReactNode, useRef } from "react";

type Variant = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  pressed,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; pressed?: boolean }) {
  return (
    <button
      {...rest}
      aria-pressed={pressed}
      className={`btn btn-${variant} btn-${size}${pressed ? " is-pressed" : ""} ${className}`}
    />
  );
}

/** Segmented control: one choice from a few. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        // Arrow keys move the choice (standard radio-group keyboard behaviour).
        const i = options.findIndex((o) => o.value === value);
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const next = options[(i + d + options.length) % options.length];
        onChange(next.value);
        const btns = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role=radio]");
        window.setTimeout(() => btns[(i + d + options.length) % options.length]?.focus(), 0);
      }}
    >
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? "is-on" : ""}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Labelled control. Use `group` for button rows: a <label> would forward heading clicks to the first button. */
export function Field({ label, hint, children, group }: { label: string; hint?: string; children: ReactNode; group?: boolean }) {
  const body = (
    <>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </>
  );
  return group ? (
    <div className="field" role="group" aria-label={label}>
      {body}
    </div>
  ) : (
    <label className="field">{body}</label>
  );
}

export function Toggle({ checked, onChange, label, hint, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; ariaLabel?: string }) {
  return (
    <label className="toggle" title={hint}>
      <input type="checkbox" checked={checked} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span>{label}</span>
    </label>
  );
}

/** Confidence of a machine estimate. Text + dots, never color alone. */
export function Confidence({ value, confirmed, compact }: { value?: number; confirmed?: boolean; compact?: boolean }) {
  if (confirmed)
    return (
      <span className="conf conf-confirmed" title="You confirmed or edited this">
        ✓{compact ? "" : " Confirmed"}
      </span>
    );
  const v = value ?? 0;
  const level = v >= 0.6 ? 3 : v >= 0.35 ? 2 : 1;
  const word = ["", "Low", "Medium", "High"][level];
  return (
    <span className={`conf conf-${level}`} title={`Estimate · ${word.toLowerCase()} confidence (${Math.round(v * 100)}%)`}>
      <span className="conf-dots" aria-hidden>
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= level ? "on" : ""} />
        ))}
      </span>
      {!compact && <span>{word}</span>}
    </span>
  );
}

export function Banner({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "error" | "ok"; title?: string; children?: ReactNode; action?: ReactNode }) {
  const icon = { info: "i", warn: "!", error: "×", ok: "✓" }[tone];
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="banner-icon" aria-hidden>
        {icon}
      </span>
      <div className="banner-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {children && <div className="empty-body">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Collapsible technical detail, closed by default. */
export function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="details">
      <summary>{summary}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}

export function Progress({ pct, label, onCancel }: { pct: number; label: string; onCancel?: () => void }) {
  return (
    <div className="progress-card" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <div className="progress-row">
        <span>{label}</span>
        <span className="num">{Math.round(pct)}%</span>
        {onCancel && (
          <Button size="sm" variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------- toasts ----------

interface Toast {
  id: number;
  tone: "info" | "ok" | "warn" | "error";
  text: string;
  action?: { label: string; run: () => void };
}
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((xs) => [...xs.slice(-3), { ...t, id }]);
    window.setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.tone === "error" ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            {t.action && (
              <Button size="sm" variant="quiet" onClick={t.action.run}>
                {t.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- modal dialog and popover (the browser's own: modern-web-guidance light-dismiss-a-dialog, declarative-dialog-popover-control) ----------

/**
 * A modal <dialog> opened with showModal(): the browser traps focus, closes on Esc and on a click outside
 * (closedby="any"), keeps the page behind inert and gives focus back to where it was. WebView2 only, so no fallbacks.
 */
export function Modal({ open, onClose, labelledBy, describedBy, alert, className = "", children }: {
  open: boolean; onClose: () => void; labelledBy: string; describedBy?: string; alert?: boolean; className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`dialog ${className}`} role={alert ? "alertdialog" : undefined} aria-labelledby={labelledBy} aria-describedby={describedBy}
      {...({ closedby: "any" } as object)} onClose={() => openRef.current && onClose()}>
      {open && children}
    </dialog>
  );
}

/**
 * A popover in the top layer (popover="auto"): Esc and a click outside close it. It sits under its button through
 * CSS anchor positioning: give the button popoverTarget={id} and style={anchorStyle(id)}.
 */
export function Popover({ id, open, onOpenChange, label, className = "", children }: {
  id: string; open: boolean; onOpenChange: (open: boolean) => void; label: string; className?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const shown = el.matches(":popover-open");
    if (open && !shown) el.showPopover();
    else if (!open && shown) el.hidePopover();
  }, [open]);
  return (
    <div ref={ref} id={id} popover="auto" role="dialog" aria-label={label} className={`popover ${className}`}
      style={{ positionAnchor: `--${id}` } as CSSProperties}
      onToggle={(e) => onOpenChange((e.nativeEvent as ToggleEvent).newState === "open")}>
      {children}
    </div>
  );
}
export const anchorStyle = (id: string) => ({ anchorName: `--${id}` }) as CSSProperties;

// ---------- confirm dialog ----------

const ConfirmCtx = createContext<(o: { title: string; body: string; confirm: string; danger?: boolean }) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmHost({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ title: string; body: string; confirm: string; danger?: boolean; resolve: (b: boolean) => void } | null>(null);
  const ask = useCallback(
    (o: { title: string; body: string; confirm: string; danger?: boolean }) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })),
    [],
  );
  const close = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal open={!!req} onClose={() => close(false)} alert labelledBy="dlg-title" describedBy="dlg-body">
        {req && (
          <>
            <h2 id="dlg-title">{req.title}</h2>
            <p id="dlg-body">{req.body}</p>
            <div className="dialog-actions">
              <Button autoFocus onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant={req.danger ? "danger" : "primary"} onClick={() => close(true)}>
                {req.confirm}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </ConfirmCtx.Provider>
  );
}
