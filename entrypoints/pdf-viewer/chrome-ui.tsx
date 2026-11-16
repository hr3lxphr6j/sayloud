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

// ─── SVG icons ────────────────────────────────────────────────────────────────
// Inline SVGs use currentColor so they inherit the toolbar text colour without
// an extra paint step. All icons are decorative — the surrounding button always
// carries an accessible name — so each is aria-hidden and focusable="false".
// biome requires aria-hidden to be a literal prop (not a spread) to satisfy
// noSvgWithoutTitle, so we set it explicitly on each element.

const ICON_SIZE = 16;
const ICON_VIEWBOX = '0 0 16 16';

function SvgIcon({ name }: { name: string }) {
  switch (name) {
    case 'sidebar':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
          <line x1="5.5" y1="2" x2="5.5" y2="14" />
        </svg>
      );
    case 'info':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="8" cy="8" r="6.5" />
          <line x1="8" y1="7.5" x2="8" y2="11" />
          <circle cx="8" cy="5" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'chevron-left':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <polyline points="10 4 6 8 10 12" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
      );
    case 'zoom-in':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="6.5" cy="6.5" r="4.5" />
          <line x1="10" y1="10" x2="13.5" y2="13.5" />
          <line x1="6.5" y1="4.5" x2="6.5" y2="8.5" />
          <line x1="4.5" y1="6.5" x2="8.5" y2="6.5" />
        </svg>
      );
    case 'zoom-out':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="6.5" cy="6.5" r="4.5" />
          <line x1="10" y1="10" x2="13.5" y2="13.5" />
          <line x1="4.5" y1="6.5" x2="8.5" y2="6.5" />
        </svg>
      );
    case 'fit-width':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <polyline points="2 6 2 2 6 2" />
          <polyline points="10 2 14 2 14 6" />
          <polyline points="14 10 14 14 10 14" />
          <polyline points="6 14 2 14 2 10" />
        </svg>
      );
    case 'download':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <line x1="8" y1="2" x2="8" y2="10.5" />
          <polyline points="5 7.5 8 10.5 11 7.5" />
          <line x1="2" y1="13.5" x2="14" y2="13.5" />
        </svg>
      );
    case 'search':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="6.5" cy="6.5" r="4.5" />
          <line x1="10" y1="10" x2="13.5" y2="13.5" />
        </svg>
      );
    case 'chevron-up':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <polyline points="4 10 8 6 12 10" />
        </svg>
      );
    case 'chevron-down':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <polyline points="4 6 8 10 12 6" />
        </svg>
      );
    case 'close':
      return (
        <svg
          width={ICON_SIZE}
          height={ICON_SIZE}
          viewBox={ICON_VIEWBOX}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      );
    default:
      return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

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
      {/* ─── Main toolbar ─────────────────────────────────────────────────── */}
      <div class="pdf-top">
        <div class="pdf-top-left">
          <button
            type="button"
            class="pdf-icon-button"
            aria-label={t('pdf.sidebar.toggle')}
            aria-pressed={state.sidebar}
            disabled={!controls}
            onClick={onToggleSidebar}
          >
            <SvgIcon name="sidebar" />
          </button>

          {/* Reading-order hint collapsed into a tooltip on the info icon.
              It is never dismissible — a multi-column paper looks broken
              otherwise — but it no longer occupies permanent toolbar space. */}
          <div class="pdf-info-wrap">
            <button
              type="button"
              class="pdf-icon-button pdf-info-trigger"
              aria-label={t('pdf.order.hint')}
            >
              <SvgIcon name="info" />
            </button>
            {/* Keep .pdf-order-hint in the DOM so e2e tests can assert on it;
                visually it only shows on hover via the tooltip below. */}
            <p class="pdf-order-hint sr-only">{t('pdf.order.hint')}</p>
            <div class="pdf-info-tooltip" role="tooltip">
              {t('pdf.order.hint')}
            </div>
          </div>
        </div>

        <span class="pdf-top-spacer" />

        {state.open && (
          <div class="pdf-top-right">
            {/* Page navigation */}
            <div class="pdf-ctrl-group">
              <button
                type="button"
                aria-label={t('pdf.page.previous')}
                disabled={!controls || state.page <= 1}
                onClick={() => onPage(state.page - 1)}
              >
                <SvgIcon name="chevron-left" />
              </button>
              <PageField page={state.page} total={state.total} onGo={onPage} />
              <button
                type="button"
                aria-label={t('pdf.page.next')}
                disabled={!controls || state.page >= state.total}
                onClick={() => onPage(state.page + 1)}
              >
                <SvgIcon name="chevron-right" />
              </button>
            </div>

            {/* Zoom */}
            <div class="pdf-ctrl-group">
              <button
                type="button"
                aria-label={t('pdf.zoom.out')}
                disabled={!controls}
                onClick={() => onZoom(-1)}
              >
                <SvgIcon name="zoom-out" />
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
                <SvgIcon name="zoom-in" />
              </button>
              <button
                type="button"
                aria-label={t('pdf.fit-width')}
                disabled={!controls}
                onClick={onFitWidth}
              >
                <SvgIcon name="fit-width" />
              </button>
            </div>

            {/* Actions */}
            <div class="pdf-ctrl-group">
              <button
                type="button"
                aria-label={t('pdf.search')}
                aria-expanded={state.search.open}
                disabled={!controls}
                onClick={onOpenSearch}
              >
                <SvgIcon name="search" />
              </button>
              <button
                type="button"
                aria-label={t('pdf.download')}
                disabled={!controls}
                onClick={onDownload}
              >
                <SvgIcon name="download" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── Search bar ───────────────────────────────────────────────────── */}
      {state.search.open && (
        <div class="pdf-search">
          <span class="pdf-search-icon">
            <SvgIcon name="search" />
          </span>
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
          <div class="pdf-ctrl-group">
            <button
              type="button"
              aria-label={t('pdf.search.previous')}
              disabled={state.search.total === 0}
              onClick={onSearchPrevious}
            >
              <SvgIcon name="chevron-up" />
            </button>
            <button
              type="button"
              aria-label={t('pdf.search.next')}
              disabled={state.search.total === 0}
              onClick={onSearchNext}
            >
              <SvgIcon name="chevron-down" />
            </button>
          </div>
          <button
            type="button"
            class="pdf-search-close"
            aria-label={t('pdf.search.close')}
            onClick={onSearchClose}
          >
            <SvgIcon name="close" />
          </button>
        </div>
      )}

      {/* ─── Notices ──────────────────────────────────────────────────────── */}
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
        <SvgIcon name="chevron-right" />
      </button>
      <button type="button" onClick={() => onAnswer(null)}>
        {t('pdf.password.cancel')}
      </button>
    </form>
  );
}
