// Run: node --test .github/scripts/pr-email
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanHeader,
  descriptionExcerpt,
  emailKind,
  emailModel,
  escapeHtml,
  HEADING,
  linkedIssues,
  renderHtml,
  renderText,
  safeUrl,
} from './render.mjs';

const REPO = 'Delivery-Plus0/delivery-plus';

function pr(overrides = {}) {
  return {
    number: 272,
    title: 'fix(dispatch): assign the longest-idle verified driver',
    body: '## Summary\nLongest idle first.\n\n## Related issue\n\nCloses #210\n<!-- template comment -->',
    html_url: 'https://github.com/Delivery-Plus0/delivery-plus/pull/272',
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    user: { login: 'MohamedAhmed-SUT', type: 'User', html_url: 'https://github.com/MohamedAhmed-SUT', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' },
    head: { label: 'MohamedAhmed-SUT:fix/210-longest-idle-driver' },
    base: { ref: 'dev' },
    additions: 296,
    deletions: 25,
    changed_files: 18,
    commits: 5,
    labels: [{ name: 'driver-service' }],
    milestone: { title: 'Production 2 · Onboarding & service area' },
    ...overrides,
  };
}

test('sends for an opened or reopened pull request, and for a merged one', () => {
  assert.equal(emailKind(pr(), 'opened'), 'opened');
  assert.equal(emailKind(pr(), 'ready_for_review'), 'opened');
  assert.equal(emailKind(pr({ state: 'closed', merged: true, merged_at: '2026-10-27T10:00:00Z' }), 'closed'), 'merged');
});

test('sends nothing for drafts, bots, or a pull request closed without merging', () => {
  assert.equal(emailKind(pr({ draft: true }), 'opened'), null);
  assert.equal(emailKind(pr({ user: { login: 'dependabot[bot]', type: 'Bot' } }), 'opened'), null);
  assert.equal(emailKind(pr({ state: 'closed' }), 'closed'), null);
  assert.equal(emailKind(undefined, 'opened'), null);
});

test('escapes everything a contributor controls', () => {
  const hostile = pr({
    title: '<img src=x onerror=alert(1)> "quotes" & <b>bold</b>',
    body: '<script>alert(1)</script>\n<a href="javascript:alert(1)">x</a>',
    head: { label: 'evil:<svg/onload=alert(1)>' },
    labels: [{ name: '<i>label</i>' }],
    user: { login: 'x"><script>', type: 'User', html_url: 'javascript:alert(1)', avatar_url: 'javascript:alert(1)' },
  });
  const html = renderHtml(emailModel(hostile, REPO, 'opened'));
  assert.doesNotMatch(html, /<script>|<img src=x|<svg|<i>label|<b>bold/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /src="javascript:/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('keeps the subject on one line, so it cannot inject email headers', () => {
  const subject = emailModel(pr({ title: 'Fix\r\nBcc: attacker@example.com\nmore' }), REPO, 'opened').subject;
  assert.doesNotMatch(subject, /[\r\n]/);
  assert.equal(subject, '[Delivery Plus · Backend] New pull request: Fix Bcc: attacker@example.com more (#272)');
  assert.ok(cleanHeader('x'.repeat(400)).length <= 150);
});

test('names the repository and the outcome in the subject', () => {
  assert.equal(emailModel(pr(), REPO, 'opened').subject, '[Delivery Plus · Backend] New pull request: fix(dispatch): assign the longest-idle verified driver (#272)');
  assert.match(emailModel(pr(), 'Delivery-Plus0/delivery-plus-driver-app', 'merged').subject, /^\[Delivery Plus · Driver app\] Merged: /);
});

test('links the issues the pull request closes, in this repo or another', () => {
  assert.deepEqual(linkedIssues('Closes #210, fixes Delivery-Plus0/delivery-plus-customer-app#52 and resolves #210', REPO), [
    { repo: REPO, number: 210 },
    { repo: 'Delivery-Plus0/delivery-plus-customer-app', number: 52 },
  ]);
  assert.deepEqual(linkedIssues('Part of #26', REPO), []);
  const html = renderHtml(emailModel(pr(), REPO, 'opened'));
  assert.match(html, /href="https:\/\/github\.com\/Delivery-Plus0\/delivery-plus\/issues\/210"/);
});

test('turns the description into a short plain excerpt, headings marked for bold', () => {
  assert.equal(descriptionExcerpt(pr().body), `${HEADING}Summary\nLongest idle first.\n\n${HEADING}Related issue\nCloses #210`);
  assert.equal(descriptionExcerpt('Use `POST /auth/login` now'), 'Use POST /auth/login now');
  const html = renderHtml(emailModel(pr(), REPO, 'opened'));
  assert.match(html, /<strong[^>]*>Summary<\/strong>/);
  assert.doesNotMatch(renderText(emailModel(pr(), REPO, 'opened')), new RegExp(HEADING));
  assert.equal(descriptionExcerpt('- [x] tests\n- docs'), '• tests\n• docs');
  const long = descriptionExcerpt('word '.repeat(300));
  assert.ok(long.length <= 601 && long.endsWith('…'));
});

test('only http(s) URLs make it into links', () => {
  assert.equal(safeUrl('https://github.com/x'), 'https://github.com/x');
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('not a url'), '#');
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('the merged email credits the merger and author; the text version carries the link', () => {
  const merged = emailModel(pr({ state: 'closed', merged: true, merged_by: { login: 'Yousefa7medmaher' } }), REPO, 'merged');
  const html = renderHtml(merged);
  assert.match(html, />Merged</);
  assert.match(html, /@Yousefa7medmaher<\/a> merged this pull request by/);
  assert.match(html, /See the merged changes/);
  const text = renderText(merged);
  assert.match(text, /MERGED · Backend · #272/);
  assert.match(text, /See the merged changes: https:\/\/github\.com\/Delivery-Plus0\/delivery-plus\/pull\/272/);
});
