import React, {useEffect, useRef, useState, type ReactNode} from 'react';

/** A centered dialog over the page; closes on Escape and on a click outside. */
export function Modal({title, onClose, children, wide}: {title: string; onClose: () => void; children: ReactNode; wide?: boolean}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', escape);
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', escape);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'is-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Закрыть" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({label, hint, ...input}: {label: string; hint?: string} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** A value to copy: a command, a token, a link. */
export function CopyField({value, label, secret}: {value: string; label?: string; secret?: boolean}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  return (
    <div className={`copy ${secret ? 'is-secret' : ''}`}>
      {label && <span className="copy-label">{label}</span>}
      <code>{value}</code>
      <button className="copy-button" onClick={copy}>
        {copied ? 'Скопировано' : 'Копировать'}
      </button>
    </div>
  );
}

export function ErrorLine({message}: {message: string | null}) {
  return message ? (
    <p className="form-error" role="alert">
      {message}
    </p>
  ) : null;
}

/** Tabs as a segmented control; `value` is the key of the active tab. */
export function Tabs<K extends string>({tabs, value, onChange, label}: {tabs: [K, string][]; value: K; onChange: (key: K) => void; label: string}) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {tabs.map(([key, text]) => (
        <button key={key} role="tab" aria-selected={key === value} aria-pressed={key === value} onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="1" y="1" width="30" height="30" rx="9" className="logo-bg" />
        <rect x="8" y="17" width="4" height="8" rx="2" className="logo-bar a" />
        <rect x="14" y="12" width="4" height="13" rx="2" className="logo-bar b" />
        <rect x="20" y="7" width="4" height="18" rx="2" className="logo-bar c" />
      </svg>
      <span>Agent Limits</span>
    </span>
  );
}
