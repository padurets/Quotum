import {useLayoutEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {LOCALES, setLocale, t, useLocale, type Locale} from '../i18n';
import {messageOf} from '../lib/http';

export const SERVICE = 'Quotum';

/** The dialogs open now, the last on top: only it answers Escape, and the page stays out of reach until none is left. */
const dialogs: {panel: HTMLDivElement; overlay: HTMLElement}[] = [];
/** How the page scrolled before the first of them opened. */
let pageOverflow = '';
let pageInert = false;
let pageFocus: HTMLElement | null = null;

/**
 * A dialog over the page, centred or as a panel on its side; closes on Escape and on a
 * click outside. Without `onClose` it cannot be closed at all (a question that needs an
 * answer). It is placed in <body>, so a header with a backdrop filter or a moved widget
 * it was opened from cannot box it in.
 */
export function Modal({title, onClose, children, wide, side}: {title: string; onClose?: () => void; children: ReactNode; wide?: boolean; side?: boolean}) {
  const panel = useRef<HTMLDivElement>(null);
  // The latest handler, so the effect below runs once: focus moves in when the dialog opens and back when it closes.
  const close = useRef(onClose);
  close.current = onClose;
  // Taken while rendering: a field of the dialog with autoFocus would be it by the effect.
  const [previous] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    const own = panel.current!;
    const overlay = own.parentElement!;
    const page = document.documentElement;
    const root = document.getElementById('root');
    if (!dialogs.length) {
      pageOverflow = page.style.overflow;
      pageInert = root?.inert ?? false;
      pageFocus = previous;
    }
    page.style.overflow = 'hidden';
    if (root) root.inert = true;
    // Portals are siblings of #root: the lower dialogs need their own inert boundary.
    for (const dialog of dialogs) dialog.overlay.inert = true;
    const entry = {panel: own, overlay};
    dialogs.push(entry);
    const top = () => dialogs.at(-1) === entry;
    const keydown = (event: KeyboardEvent) => {
      if (!top()) return;
      if (event.key === 'Escape') return close.current?.();
      if (event.key !== 'Tab') return;
      const fields = [...own.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]')]
        .filter(field => field.tabIndex >= 0 && !field.matches(':disabled') && !field.closest('[inert]') && field.getClientRects().length);
      const first = fields[0];
      const last = fields.at(-1);
      const focused = document.activeElement;
      if (!first || focused === own || !own.contains(focused) || (event.shiftKey ? focused === first : focused === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        if (!first) own.focus();
      }
    };
    const focus = () => {
      if (top() && !own.contains(document.activeElement)) own.focus();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focus);
    focus();
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focus);
      const wasTop = top();
      dialogs.splice(dialogs.indexOf(entry), 1);
      overlay.inert = false;
      const below = dialogs.at(-1);
      if (below) {
        below.overlay.inert = false;
        if (wasTop) {
          if (previous?.isConnected && below.panel.contains(previous)) previous.focus();
          if (!below.panel.contains(document.activeElement)) below.panel.focus();
        }
        return;
      }
      page.style.overflow = pageOverflow;
      if (root) root.inert = pageInert;
      if (pageFocus?.isConnected) pageFocus.focus();
      pageFocus = null;
    };
  }, []);
  return createPortal(
    <div className={`overlay ${side ? 'is-side' : ''}`} onMouseDown={event => event.target === event.currentTarget && onClose?.()}>
      <div className={`dialog glass ${wide ? 'is-wide' : ''} ${side ? 'is-side' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}>
        <div className="dialog-head">
          <h2>{title}</h2>
          {onClose && (
            <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A labelled input; its hint is read out as its description, not as part of its name. */
export function Field({label, hint, ...input}: {label: string; hint?: string} & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
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
    } catch {
      /* no clipboard access: the value stays selectable */
    }
  };
  return (
    <div className="copy-field">
      {label && <span className="copy-label">{label}</span>}
      <div className={`copy ${secret ? 'is-secret' : ''}`}>
        <code>{value}</code>
        <button type="button" className="copy-button" onClick={copy}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
    </div>
  );
}

/** A failed request, put into words in the reader's language. */
export function ErrorLine({error}: {error: unknown}) {
  return error ? (
    <p className="form-error" role="alert">
      {messageOf(error)}
    </p>
  ) : null;
}

/** A row of mutually exclusive choices; `value` is the key of the chosen one. */
export function Segmented<K extends string>({options, value, onChange, label}: {options: [K, string][]; value: K; onChange: (key: K) => void; label: string}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={key === value} onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * The Quotum mark: a Q that is also a magnifier, dark on the accent colour. The
 * favicon (public/favicon.svg) is the same Q in the accent colour on a dark tile.
 */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="quotum-logo-tile" x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#b8bdff" />
          <stop offset="1" stopColor="#7c83f2" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#quotum-logo-tile)" />
      <circle cx="15.2" cy="15.2" r="7.4" className="logo-mark" />
      <path d="M18.3 18.3L23.4 23.4" className="logo-mark" />
    </svg>
  );
}

/** The logo and the name; a link home where there is somewhere to go back to. */
export function Brand({href}: {href?: string}) {
  const content = (
    <>
      <Logo />
      <span>{SERVICE}</span>
    </>
  );
  return href ? (
    <a className="brand" href={href} aria-label={SERVICE}>
      {content}
    </a>
  ) : (
    <span className="brand">{content}</span>
  );
}

/** The dashboard's languages; the choice is kept in this browser. */
export function LanguageSelect() {
  const locale = useLocale();
  return (
    <label className="language">
      <span className="sr-only">{t('common.language')}</span>
      <select value={locale} onChange={event => setLocale(event.target.value as Locale)}>
        {(Object.keys(LOCALES) as Locale[]).map(code => (
          <option key={code} value={code} lang={code}>
            {LOCALES[code].name}
          </option>
        ))}
      </select>
    </label>
  );
}
