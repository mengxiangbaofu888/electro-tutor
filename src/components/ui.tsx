/**
 * 通用 UI 组件（移动端优先）。
 */
import type { ChangeEvent, ReactNode } from 'react';

/* ------------------------------ 卡片 ------------------------------ */

export function Card({
  title,
  extra,
  children,
  className = '',
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || extra) && (
        <div className="row between">
          {title ? <h3 className="card-title">{title}</h3> : <span />}
          {extra}
        </div>
      )}
      {children}
    </div>
  );
}

/* ------------------------------ 按钮 ------------------------------ */

type ButtonVariant = 'default' | 'primary' | 'accent' | 'ghost' | 'danger' | 'ok';

export function Button({
  children,
  onClick,
  variant = 'default',
  size,
  disabled,
  loading,
  block,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  size?: 'sm';
  disabled?: boolean;
  loading?: boolean;
  block?: boolean;
  type?: 'button' | 'submit';
}) {
  const classes = ['btn'];
  if (variant !== 'default') classes.push(variant);
  if (size) classes.push(size);
  if (block) classes.push('block');
  return (
    <button
      type={type}
      className={classes.join(' ')}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading && <span className="spinner" />}
      {children}
    </button>
  );
}

/* ------------------------------ 表单 ------------------------------ */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  password,
  secret,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  /**
   * 真正的密码框（`type="password"`）。
   * ⚠️ 安卓上它会唤起**系统安全键盘**（没有剪贴板、不能长按粘贴），
   * 所以需要粘贴长内容（比如 API Key）的地方**不要用它**，改用 `secret`。
   */
  password?: boolean;
  /**
   * "看起来是密码，但键盘是普通键盘"：CSS 打码，输入框类型仍是 text。
   *
   * 起因是真实反馈："填 API Key 时那个键盘是手机系统的安全键盘，没有剪贴板，
   * API Key 那么长你让我一个手敲吗？"
   * 换成 CSS 打码后，长按粘贴/剪贴板/联想输入都正常，旁边的人依然看不到内容。
   */
  secret?: boolean;
  /** 失焦时触发：用于"填完 Key 就自动联网拉模型列表"这类动作 */
  onBlur?: () => void;
}) {
  return (
    <input
      type={password ? 'password' : type}
      className={secret && !password ? 'input-secret' : undefined}
      value={value}
      placeholder={placeholder}
      autoComplete={password || secret ? 'off' : undefined}
      autoCorrect="off"
      spellCheck={false}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 6,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select value={value} onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/* ------------------------------ 展示类 ------------------------------ */

export function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'ok' | 'bad' | 'warn' | 'primary';
}) {
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export function Progress({ value, tone }: { value: number; tone?: 'ok' | 'bad' }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={`progress${tone ? ` ${tone}` : ''}`}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Alert({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'error' | 'ok' | 'warn';
}) {
  if (!children) return null;
  return <div className={`alert${tone ? ` ${tone}` : ''}`}>{children}</div>;
}

export function Empty({ icon = '📭', text, hint }: { icon?: string; text: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div>{text}</div>
      {hint && <div className="small" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

export function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="stat">
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="row" style={{ padding: '24px 0', justifyContent: 'center', color: 'var(--muted)' }}>
      <Spinner />
      <span className="small">{text}</span>
    </div>
  );
}

/* ------------------------------ 底部弹层 ------------------------------ */

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
