/**
 * The PDF interception rule, and the fragment it hands the viewer.
 *
 * The browser API is injected rather than mocked globally: the rule is the
 * whole output, and asserting the exact object Chrome will be given is what
 * keeps the redirect target, the resource type and the case folding honest.
 */
import { describe, expect, it } from 'vitest';
import {
  type DynamicRulesApi,
  disablePdfIntercept,
  enablePdfIntercept,
  isInterceptHash,
  PDF_DNR_RULE_ID,
  PDF_URL_PATTERN,
  parseInterceptedUrl,
  syncPdfIntercept,
} from '~/lib/pdf/dnr';

const VIEWER = 'chrome-extension://abcdefghijklmnop/pdf-viewer.html';

function fakeRules() {
  const calls: Parameters<DynamicRulesApi['updateDynamicRules']>[0][] = [];
  const api: DynamicRulesApi = {
    async updateDynamicRules(options) {
      calls.push(options);
    },
  };
  return { api, calls };
}

describe('enabling the interception rule', () => {
  it('adds one main-frame redirect from http(s) pdfs to the viewer', async () => {
    const { api, calls } = fakeRules();

    await enablePdfIntercept(api, VIEWER);

    expect(calls).toHaveLength(1);
    const [options] = calls;
    expect(options?.removeRuleIds).toEqual([PDF_DNR_RULE_ID]);
    expect(options?.addRules).toEqual([
      {
        id: PDF_DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: `${VIEWER}#url=\\0` },
        },
        condition: {
          regexFilter: PDF_URL_PATTERN,
          resourceTypes: ['main_frame'],
          isUrlFilterCaseSensitive: false,
        },
      },
    ]);
  });

  it('matches only navigations the viewer can fetch', () => {
    const pattern = new RegExp(PDF_URL_PATTERN);

    expect(pattern.test('https://example.com/paper.pdf')).toBe(true);
    expect(pattern.test('https://example.com/paper.pdf?dl=1')).toBe(true);
    expect(pattern.test('https://example.com/download?file=paper.pdf')).toBe(true);
    expect(pattern.test('https://example.com/paper.pdf#page=2')).toBe(true);

    // `file:` is not covered by the host grant, and a subresource named `.pdf`
    // is not a navigation.
    expect(pattern.test('file:///tmp/paper.pdf')).toBe(false);
    // The greedy match must still end on the extension.
    expect(pattern.test('https://example.com/paper.pdfx')).toBe(false);
    expect(pattern.test('https://example.com/paper.pdf/extra')).toBe(false);
    // Already the viewer: a second redirect would nest one inside another.
    expect(pattern.test(`${VIEWER}#url=https://example.com/paper.pdf`)).toBe(false);
  });
});

describe('disabling the interception rule', () => {
  it('removes the rule by id and adds nothing', async () => {
    const { api, calls } = fakeRules();

    await disablePdfIntercept(api);

    expect(calls).toEqual([{ addRules: [], removeRuleIds: [PDF_DNR_RULE_ID] }]);
  });
});

describe('syncing the rule with the setting', () => {
  it('installs it when enabled and removes it when disabled', async () => {
    const { api, calls } = fakeRules();

    await syncPdfIntercept(true, api, VIEWER);
    await syncPdfIntercept(false, api, VIEWER);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.addRules).toHaveLength(1);
    expect(calls[1]).toEqual({ addRules: [], removeRuleIds: [PDF_DNR_RULE_ID] });
  });
});

describe('the redirected document url', () => {
  it('reads the value verbatim, keeping what URLSearchParams would decode', () => {
    expect(parseInterceptedUrl('#url=https://example.com/a%2Fb.pdf?q=a+b')).toBe(
      'https://example.com/a%2Fb.pdf?q=a+b'
    );
  });

  it('keeps a fragment that belongs to the document url', () => {
    expect(parseInterceptedUrl('#url=https://example.com/a.pdf#page=2')).toBe(
      'https://example.com/a.pdf#page=2'
    );
  });

  it('accepts the fragment with or without the leading hash', () => {
    expect(parseInterceptedUrl('url=https://example.com/a.pdf')).toBe('https://example.com/a.pdf');
  });

  it('refuses a url the viewer cannot fetch', () => {
    expect(parseInterceptedUrl('#url=file:///tmp/a.pdf')).toBeNull();
    expect(parseInterceptedUrl('#url=javascript:alert(1)')).toBeNull();
    expect(parseInterceptedUrl('#url=')).toBeNull();
    expect(parseInterceptedUrl('#url=not a url')).toBeNull();
  });

  it('does not mistake a staged id for a redirect', () => {
    const staged = '#3f4d2c1a-0000-4000-8000-000000000000';
    expect(parseInterceptedUrl(staged)).toBeNull();
    expect(isInterceptHash(staged)).toBe(false);
    expect(parseInterceptedUrl('')).toBeNull();
    expect(isInterceptHash('')).toBe(false);
  });

  it('recognises a malformed redirect so the viewer can report it missing', () => {
    expect(isInterceptHash('#url=')).toBe(true);
    expect(parseInterceptedUrl('#url=')).toBeNull();
  });
});
