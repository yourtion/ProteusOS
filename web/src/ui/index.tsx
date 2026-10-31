import {
  cloneElement,
  useId,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { statusMeta, type Tone } from "./status";

export function Button({
  variant = "secondary",
  pending = false,
  disabled,
  type = "button",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  pending?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`button button-${variant} ${className}`}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {children}
    </button>
  );
}
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p className="note">{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}
export function Field({
  label,
  hint,
  children,
  hiddenLabel = false,
}: {
  label: string;
  hint?: string;
  hiddenLabel?: boolean;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
}) {
  const generated = useId();
  const id = children.props.id ?? generated;
  const description = [children.props["aria-describedby"], hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="field">
      <label htmlFor={id} className={hiddenLabel ? "sr-only" : undefined}>
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": description || undefined })}
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: Tone }) {
  return (
    <div className={`notice tone-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}
export function StatusBadge({
  state,
  children,
  tone,
}: {
  state?: string;
  children?: ReactNode;
  tone?: Tone;
}) {
  const meta = statusMeta(state ?? "");
  return <span className={`badge tone-${tone ?? meta.tone}`}>{children ?? meta.label}</span>;
}
export function EvidenceDetails({
  title,
  value,
  children,
  open,
}: {
  title: string;
  value?: unknown;
  children?: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="disclosure" open={open}>
      <summary>{title}</summary>
      <div className="disclosure-body">
        {children ?? (
          <pre className="data-block">
            {value === undefined ? "暂无记录" : JSON.stringify(value, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}
export function SelectionBar<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="segmented"
      role="group"
      aria-label={label}
      onKeyDown={(event) => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        onChange(options[next]!.value);
      }}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
