import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PixelButton } from './PixelButton';
import { providerPreset, type AgentProvider } from '@/store/config';
import { MODEL_ID_MAX } from '@shared/modelCatalogPayload';
import {
  CUSTOM_MODEL_SENTINEL, customModelFormat, isCustomModel, validateCustomModelId
} from '@shared/customModel';

export { CUSTOM_MODEL_SENTINEL, isCustomModel };

/** How a typed model id reads in a picker: `<id> (custom)`. */
export function customModelLabel(t: TFunction, id: string): string {
  return t('customModel.label', { id });
}

/** The label of the "Custom…" entry every model picker carries. */
export function customModelOptionLabel(t: TFunction): string {
  return t('customModel.option');
}

const defaultInputStyle: CSSProperties = {
  flex: 1, minWidth: 0,
  padding: '3px 8px 1px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 12,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

/**
 * The text field behind a picker's "Custom…" entry, shared by every model
 * picker (chip rows and native selects alike). It validates on submit, shows the
 * engine's model-id format as a hint, and hands back the trimmed id verbatim.
 * Enter submits, Escape cancels.
 */
export function CustomModelInput({ provider, initial, onSubmit, onCancel, inputStyle }: {
  provider: AgentProvider;
  initial?: string;
  onSubmit: (id: string) => void;
  onCancel: () => void;
  inputStyle?: CSSProperties;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const providerLabel = providerPreset(provider).label;

  const submit = () => {
    const result = validateCustomModelId(text, provider);
    if (!result.ok) {
      setError(t(`customModel.error.${result.error}`, { max: MODEL_ID_MAX }));
      return;
    }
    onSubmit(result.id);
  };

  // The pickers sit inside a <label> Row. Clicking "use" unmounts this field
  // mid-click, so the label no longer sees the click as its own content and
  // forwards it to its first control (the "CLI default" chip), resetting the
  // model and command. Cancelling the default action stops that forwarding.
  return (
    <div onClick={(e) => e.preventDefault()} style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          autoFocus
          value={text}
          onChange={(e) => { setText(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
          }}
          placeholder={t('customModel.placeholder')}
          aria-label={t('customModel.placeholder')}
          aria-invalid={!!error}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={MODEL_ID_MAX * 2}
          style={{ ...defaultInputStyle, ...inputStyle }}
        />
        <PixelButton variant="secondary" size="sm" onClick={submit}>{t('customModel.use')}</PixelButton>
        <PixelButton variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</PixelButton>
      </div>
      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', lineHeight: '14px' }}>
        {t(`customModel.hint.${customModelFormat(provider)}`, { provider: providerLabel })}
      </span>
      {error && (
        <span role="alert" style={{ fontSize: 11, color: 'var(--cth-coral)', lineHeight: '14px' }}>{error}</span>
      )}
    </div>
  );
}
