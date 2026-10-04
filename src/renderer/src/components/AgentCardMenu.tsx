import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { disposeTerminal } from './terminalPool';
import { cloneBlock } from '@shared/cloneAgent';

/**
 * Right-click menu on an agent strip card (T-029). It only gathers actions that
 * already exist elsewhere (detail panel, hold button, note editor) plus Clone,
 * so a card can be managed without opening its panel first.
 */
export function AgentCardMenu({ agent, x, y, onClose, onEditNote }: {
  agent: Agent;
  x: number;
  y: number;
  onClose: () => void;
  onEditNote: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const st = useStore.getState();
  const blocked = cloneBlock(agent);
  const run = (fn: () => void | Promise<void>) => () => { onClose(); void fn(); };

  const items: { key: string; label: string; onClick?: () => void; disabled?: boolean; tip?: string; sep?: boolean }[] = [
    { key: 'terminal', label: t('cardMenu.openTerminal'), onClick: run(async () => { await window.cth.openTerminalAt(agent.cwd); }) },
    ...(agent.isGod ? [] : [{ key: 'edit', label: t('cardMenu.edit'), onClick: run(() => { st.select(agent.id); st.requestEditAgent(agent.id); }) }]),
    {
      key: 'clone',
      label: t('cardMenu.clone'),
      onClick: blocked ? undefined : run(() => st.openClone(agent.id)),
      disabled: !!blocked,
      tip: blocked === 'god' ? t('clone.blockedGod') : blocked === 'assistant' ? t('clone.blockedAssistant') : undefined
    },
    ...(agent.isGod ? [] : [
      { key: 'note', label: t('cardMenu.editNote'), onClick: run(onEditNote) },
      {
        key: 'hold',
        sep: true,
        label: agent.onHold ? t('cardMenu.endHold') : t('cardMenu.hold'),
        onClick: run(async () => {
          const r = await window.cth.hiveSetAgentHold?.(agent.id, !agent.onHold);
          if (r?.ok) useStore.getState().updateAgent(agent.id, { onHold: !agent.onHold });
        })
      },
      ...(agent.ptyId ? [{
        key: 'kill',
        label: t('cardMenu.kill'),
        onClick: run(async () => {
          if (!agent.ptyId || !confirm(t('agentDetail.killConfirm', { name: agent.name }))) return;
          await window.cth.killPty(agent.ptyId);
          disposeTerminal(agent.ptyId);
          useStore.getState().archiveAgent(agent.id);
        })
      }] : [])
    ])
  ];

  const left = Math.max(8, Math.min(x, window.innerWidth - 220));
  const bottom = Math.max(8, window.innerHeight - y);
  return (
    <>
      <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 400 }} />
      <div role="menu" data-testid="agent-card-menu" style={{
        position: 'fixed', left, bottom, zIndex: 401, minWidth: 190,
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900), var(--cth-shadow-hard)'
      }}>
        {items.map((it) => (
          <button
            key={it.key}
            role="menuitem"
            disabled={it.disabled}
            title={it.tip}
            onClick={it.onClick}
            style={{
              display: 'block', width: '100%', textAlign: 'start', padding: '6px 10px',
              border: 'none', borderTop: it.sep ? '1px solid var(--cth-ink-100)' : 'none',
              background: 'transparent', cursor: it.disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13,
              color: it.disabled ? 'var(--cth-ink-300)' : 'var(--cth-ink-900)'
            }}
          >{it.key === 'clone' ? '⧉ ' : ''}{it.label}</button>
        ))}
      </div>
    </>
  );
}
