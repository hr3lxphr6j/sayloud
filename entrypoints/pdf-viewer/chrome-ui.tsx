/**
 * The strip of controls above the PDF's pages.
 *
 * Split out of `main.tsx` because it is the one part of the viewer that is
 * pure Preact: it holds no document state and reads no module-level variable.
 * Every action arrives as a callback, so the page owns what a click does and
 * this file owns only what it looks like.
 */

import { useEffect, useState } from 'preact/hooks';
import { I18nProvider, type Translator, useT, useUiLanguage } from '~/lib/i18n';
import type { SettingsStore } from '~/lib/settings-store';
import type { SidebarLabels, ViewerApi } from './viewer';

/** What the strip above the pages is saying right now. */
export type Notice = 'opening' | 'pick' | 'missing' | 'empty' | 'ready';

export interface SearchUiState {
  open: boolean;
  /** What the reader typed; the plugin's own query lags behind the debounce. */
  query: string;
  /** 0-based index of the current match, or -1 when there is none. */
  active: number;
  total: number;
  loading: boolean;
}

export interface ChromeState {
  notice: Notice;
  /** Current zoom factor, from EmbedPDF's zoom plugin. */
  zoom: number;
  /** Non-null while a password is being asked for; `wrong` after a rejection. */
  password: { wrong: boolean } | null;
  /** Whether a document is open, which is what the zoom control needs to know. */
  open: boolean;
  /** Current page (1-based) and the page count, from the scroll plugin. */
  page: number;
  total: number;
  /** Whether the thumbnail/outline rail is visible. */
  sidebar: boolean;
  search: SearchUiState;
}

/**
 * The sidebar's labels, for the part of the viewer `Chrome` does not render.
 *
 * `viewer.tsx` is mounted straight into EmbedPDF's tree, outside the
 * `I18nProvider` above, and it stays text-free so it has no translator of its
 * own. This is where its three words come from.
 */
export function sidebarLabels(t: Translator): SidebarLabels {
  return {
    pages: t('pdf.sidebar.pages'),
    contents: t('pdf.sidebar.contents'),
    empty: t('pdf.sidebar.empty'),
  };
}

/** The toolbar, the search bar, and whatever is blocking the view. */
interface ChromeProps {
  settings: SettingsStore;
  state: ChromeState;
  api: ViewerApi | null;
  onZoom: (direction: 1 | -1) => void;
  onFitWidth: () => void;
  onPick: (file: File) => void;
  onPassword: (value: string | null) => void;
  onPage: (page: number) => void;
  onOpenSearch: () => void;
  onSearchQuery: (query: string) => void;
  onSearchNext: () => void;
  onSearchPrevious: () => void;
  onSearchClose: () => void;
  onToggleSidebar: () => void;
  onDownload: () => void;
}

export function Chrome(props: ChromeProps) {
  const { lang } = useUiLanguage(props.settings);
  return (
    <I18nProvider lang={lang}>
      <ChromeBody {...props} />
    </I18nProvider>
  );
}

function ChromeBody({
  state,
  api,
  onZoom,
  onFitWidth,
  onPick,
  onPassword,
  onPage,
  onOpenSearch,
  onSearchQuery,
  onSearchNext,
  onSearchPrevious,
  onSearchClose,
  onToggleSidebar,
  onDownload,
}: ChromeProps) {
  const t = useT();
  const canPick = state.notice === 'pick' || state.notice === 'missing' || state.notice === 'empty';
  const controls = state.open && api !== null;

  return (
    <>
      <div class="pdf-top">
        <button
          type="button"
          class="pdf-icon-button"
          aria-label={t('pdf.sidebar.toggle')}
          aria-pressed={state.sidebar}
          disabled={!controls}
          onClick={onToggleSidebar}
        >
          ⊞
        </button>
        {/* Never dismissible: a multi-column paper read down the columns looks
            like broken ordering, and the line is what distinguishes the two. */}
        <p class="pdf-order-hint">{t('pdf.order.hint')}</p>
        {state.open && (
          <div class="pdf-page-nav">
            <button
              type="button"
              aria-label={t('pdf.page.previous')}
              disabled={!controls || state.page <= 1}
              onClick={() => onPage(state.page - 1)}
            >
              ←
            </button>
            <PageField page={state.page} total={state.total} onGo={onPage} />
            <button
              type="button"
              aria-label={t('pdf.page.next')}
              disabled={!controls || state.page >= state.total}
              onClick={() => onPage(state.page + 1)}
            >
              →
            </button>
          </div>
        )}
        {state.open && (
          <fieldset class="pdf-zoom">
            <button
              type="button"
              aria-label={t('pdf.zoom.out')}
              disabled={!controls}
              onClick={() => onZoom(-1)}
            >
              −
            </button>
            <span class="pdf-zoom-level" aria-live="polite">
              {Math.round(state.zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label={t('pdf.zoom.in')}
              disabled={!controls}
              onClick={() => onZoom(1)}
            >
              +
            </button>
            <button
              type="button"
              aria-label={t('pdf.fit-width')}
              disabled={!controls}
              onClick={onFitWidth}
            >
              ⤢
            </button>
          </fieldset>
        )}
        {state.open && (
          <button
            type="button"
            class="pdf-text-button"
            aria-label={t('pdf.search')}
            aria-expanded={state.search.open}
            disabled={!controls}
            onClick={onOpenSearch}
          >
            {/* The button's word, without the ellipsis its placeholder has. */}
            {t('pdf.search').replace('…', '')}
          </button>
        )}
        {state.open && (
          <button
            type="button"
            class="pdf-icon-button"
            aria-label={t('pdf.download')}
            disabled={!controls}
            onClick={onDownload}
          >
            ↓
          </button>
        )}
      </div>

      {state.search.open && (
        <div class="pdf-search">
          <input
            type="text"
            aria-label={t('pdf.search')}
            placeholder={t('pdf.search')}
            value={state.search.query}
            autofocus
            onInput={(event) => onSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (event.shiftKey) onSearchPrevious();
              else onSearchNext();
            }}
          />
          <span class="pdf-search-count" aria-live="polite">
            {searchCount(state.search, t)}
          </span>
          <button
            type="button"
            aria-label={t('pdf.search.previous')}
            disabled={state.search.total === 0}
            onClick={onSearchPrevious}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={t('pdf.search.next')}
            disabled={state.search.total === 0}
            onClick={onSearchNext}
          >
            ↓
          </button>
          <button type="button" aria-label={t('pdf.search.close')} onClick={onSearchClose}>
            ×
          </button>
        </div>
      )}

      {state.notice === 'opening' && <p class="pdf-notice">{t('panel.loading')}</p>}

      {canPick && (
        <div class="pdf-notice">
          {state.notice !== 'pick' && (
            <p role="alert">{t(state.notice === 'missing' ? 'pdf.missing' : 'pdf.empty')}</p>
          )}
          <label class="pdf-pick">
            <span>{t('pdf.pick')}</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                // Clearing lets the same file be chosen again after an error.
                event.currentTarget.value = '';
                if (file) onPick(file);
              }}
            />
          </label>
        </div>
      )}

      {state.password && (
        <PasswordCard
          // A rejection remounts the form, which clears the previous attempt.
          key={state.password.wrong ? 'wrong' : 'first'}
          wrong={state.password.wrong}
          onAnswer={onPassword}
        />
      )}
    </>
  );
}

/** The "3/12" counter, or a state label when there is nothing to count. */
function searchCount(search: SearchUiState, t: Translator): string {
  if (search.query.trim() === '') return '';
  if (search.loading && search.total === 0) return '…';
  if (search.total === 0) return t('pdf.search.no-matches');
  return `${search.active + 1}/${search.total}`;
}

/** The editable page number in the middle of the page navigation control. */
function PageField({
  page,
  total,
  onGo,
}: {
  page: number;
  total: number;
  onGo: (page: number) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(String(page));
  const [editing, setEditing] = useState(false);

  // While the reader is typing, the field owns its value; otherwise it follows
  // the page the viewer is actually on (scrolling, page buttons, search).
  useEffect(() => {
    if (!editing) setValue(String(page));
  }, [page, editing]);

  // The label is one message with the number in it, split around `{page}` so
  // the input can take the number's place. That is what lets Japanese put the
  // number first, where gluing a translated "Page" onto the front cannot.
  const [before = '', after = ''] = t('pdf.page.label', { total }).split('{page}');

  return (
    <form
      class="pdf-page-field"
      onSubmit={(event) => {
        event.preventDefault();
        const next = Number.parseInt(value, 10);
        if (!Number.isFinite(next)) {
          setValue(String(page));
          return;
        }
        onGo(Math.min(Math.max(next, 1), Math.max(total, 1)));
      }}
    >
      {before && <span>{before}</span>}
      <input
        type="text"
        inputMode="numeric"
        aria-label={t('pdf.page.label', { page, total })}
        value={value}
        onFocus={() => setEditing(true)}
        onInput={(event) => setValue(event.currentTarget.value)}
        onBlur={() => {
          setEditing(false);
          setValue(String(page));
        }}
      />
      <span>{after}</span>
    </form>
  );
}

interface PasswordCardProps {
  wrong: boolean;
  onAnswer: (value: string | null) => void;
}

function PasswordCard({ wrong, onAnswer }: PasswordCardProps) {
  const t = useT();
  const [value, setValue] = useState('');

  return (
    <form
      class="pdf-password"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(value);
      }}
    >
      <h2>{t('pdf.password.title')}</h2>
      {wrong && <p role="alert">{t('pdf.password.wrong')}</p>}
      <input
        type="password"
        aria-label={t('pdf.password.title')}
        autofocus
        value={value}
        onInput={(event) => setValue(event.currentTarget.value)}
      />
      <button type="submit" aria-label={t('pdf.password.title')}>
        →
      </button>
      <button type="button" onClick={() => onAnswer(null)}>
        {t('pdf.password.cancel')}
      </button>
    </form>
  );
}
