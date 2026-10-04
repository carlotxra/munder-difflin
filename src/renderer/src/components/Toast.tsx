import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';

const SHOW_MS = 6000;

/** One short transient notice at the bottom of the window (T-029: "Jim 2
 *  hired, cloned from Jim"). The newest notice replaces the current one. */
export function Toast() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), SHOW_MS);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div
      role="status"
      data-testid="toast"
      onClick={() => setVisible(false)}
      style={{
        position: 'fixed', left: '50%', bottom: 132, transform: 'translateX(-50%)',
        maxWidth: 'min(640px, 90vw)', zIndex: 600, cursor: 'pointer',
        padding: '8px 12px', background: 'var(--cth-ink-900)', color: 'var(--cth-cream-50)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 13, boxShadow: 'var(--cth-shadow-hard)'
      }}
    >{toast.text}</div>
  );
}
