import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">
        <span>{value}</span>
        {sub ? <span className="row-sub">{sub}</span> : null}
      </span>
    </div>
  );
}

export function Button({ children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={className ? `button ${className}` : 'button'} {...rest}>
      {children}
    </button>
  );
}
