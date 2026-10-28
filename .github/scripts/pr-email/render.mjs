#!/usr/bin/env node
// Renders the Delivery Plus pull-request email (HTML + plain text + subject) from a GitHub
// pull_request payload. No dependencies: it runs on the stock Node of a GitHub runner.
//
// Everything that comes from the pull request (title, description, branch, labels, logins) is
// attacker-controlled: the workflow runs on pull_request_target, so it is only ever escaped into the
// email, never executed, and the subject is stripped of line breaks (no header injection).
//
// CLI: node render.mjs --out <dir>
//   reads GITHUB_EVENT_PATH (or fetches PR_NUMBER from GITHUB_REPOSITORY with GITHUB_TOKEN), writes
//   <dir>/email.html and <dir>/email.txt, and prints `skip`, `subject`, `html` and `text` to
//   GITHUB_OUTPUT.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORG = 'Delivery-Plus0';
const ASSETS = `https://raw.githubusercontent.com/${ORG}/delivery-plus/dev/assets`;

export const BRAND = {
  red: '#FF0000',
  redText: '#D70000',
  redSoft: '#FFEDED',
  tan: '#E4C98C',
  tanSoft: '#FAF3E3',
  page: '#F6F3F3',
  card: '#FFFFFF',
  text: '#1A1A1A',
  textSecondary: '#60646C',
  textMuted: '#8A8F98',
  border: '#ECE7E7',
  green: '#1A7F37',
  greenSoft: '#E8F5EC',
  logo: `${ASSETS}/logo_nest.png`,
  icon: `${ASSETS}/icon.png`,
};

/** Readable names for the organisation's repositories. */
export const REPOSITORIES = {
  'delivery-plus': 'Backend',
  'delivery-plus-customer-app': 'Customer app',
  'delivery-plus-driver-app': 'Driver app',
  'delivery-plus-restaurant-app': 'Restaurant app',
  'delivery-plus-admin-app': 'Admin app',
};

const FOOTER_LINKS = [
  ['Backend', `https://github.com/${ORG}/delivery-plus`],
  ['Customer app', `https://github.com/${ORG}/delivery-plus-customer-app`],
  ['Driver app', `https://github.com/${ORG}/delivery-plus-driver-app`],
  ['Restaurant app', `https://github.com/${ORG}/delivery-plus-restaurant-app`],
  ['Roadmap', `https://github.com/${ORG}/delivery-plus/blob/dev/docs/roadmap/production.md`],
  ['Contributing', `https://github.com/${ORG}/delivery-plus/blob/dev/CONTRIBUTING.md`],
];

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links into hrefs; anything else becomes a harmless anchor. */
export function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
}

/** One line, no control characters, bounded: safe as an email Subject header. */
export function cleanHeader(value, max = 150) {
  const text = String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** `Closes #12`, `fixes org/repo#3`, … in the description, as unique {repo, number}. */
export function linkedIssues(body, repository) {
  const found = new Map();
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;
  for (const [, repo, number] of String(body ?? '').matchAll(pattern)) {
    const target = repo ?? repository;
    found.set(`${target}#${number}`, { repo: target, number: Number(number) });
  }
  return [...found.values()];
}

/** Marks a heading line in an excerpt; the HTML shows it bold, the text version drops the mark. */
export const HEADING = '\u0002';

/** One pass: drops each `<!--` up to its `-->` or `--!>`, or to the end when it never closes. */
function stripCommentsOnce(text) {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const start = text.indexOf('<!--', at);
    if (start === -1) return out + text.slice(at);
    out += text.slice(at, start);
    const ends = [text.indexOf('-->', start + 4), text.indexOf('--!>', start + 4)].filter((i) => i !== -1);
    if (ends.length === 0) return out;
    const end = Math.min(...ends);
    at = end + (text.startsWith('-->', end) ? 3 : 4);
  }
  return out;
}

/**
 * Removes HTML comments, repeating until none is left (nested or broken ones included). Cosmetic:
 * the excerpt is HTML-escaped when rendered either way.
 */
export function stripComments(value) {
  let text = String(value ?? '');
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = stripCommentsOnce(text);
  }
  return text;
}

/** A short, plain excerpt of the description: no HTML comments, no markdown markers, ~600 chars. */
export function descriptionExcerpt(body, max = 600) {
  const text = stripComments(String(body ?? '').replace(/\r\n?/g, '\n'))
    .replace(/[\u0000-\u0008\u000B-\u001F]/g, '')
    .replace(/^#{1,6}\s*(.+)\n+/gm, `${HEADING}$1\n`)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*-\s\[[ xX]\]\s*/gm, '• ')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).trimEnd()}…`;
}

const plural = (count, one, other) => `${count} ${count === 1 ? one : other}`;

/**
 * What the email is about. `merged` for a merged pull request, `opened` for a new or reopened one
 * ready for review; null when nothing should be sent (draft, bot, closed without merging).
 */
export function emailKind(pr, action) {
  if (!pr) return null;
  if (pr.user?.type === 'Bot' || /\[bot\]$/.test(pr.user?.login ?? '')) return null;
  if (pr.merged || pr.merged_at) return 'merged';
  if (pr.state === 'closed' || action === 'closed') return null;
  if (pr.draft) return null;
  return 'opened';
}

/** Everything the templates need, already escaped where it will be shown. */
export function emailModel(pr, repository, kind) {
  const [, repoName = repository] = repository.split('/');
  const repoLabel = REPOSITORIES[repoName] ?? repoName;
  const merged = kind === 'merged';
  const title = cleanHeader(pr.title, 200);
  const issues = linkedIssues(pr.body, repository);
  return {
    merged,
    repoLabel,
    repository,
    number: pr.number,
    title,
    url: safeUrl(pr.html_url),
    author: pr.user?.login ?? 'unknown',
    authorUrl: safeUrl(pr.user?.html_url),
    authorAvatar: safeUrl(pr.user?.avatar_url ? `${pr.user.avatar_url}${pr.user.avatar_url.includes('?') ? '&' : '?'}s=80` : ''),
    mergedBy: pr.merged_by?.login ?? null,
    head: pr.head?.label ?? pr.head?.ref ?? '',
    base: pr.base?.ref ?? 'dev',
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    files: pr.changed_files ?? 0,
    commits: pr.commits ?? 0,
    labels: (pr.labels ?? []).map((label) => label.name).filter(Boolean),
    milestone: pr.milestone?.title ?? null,
    issues,
    excerpt: descriptionExcerpt(pr.body),
    subject: cleanHeader(`[Delivery Plus · ${repoLabel}] ${merged ? 'Merged' : 'New pull request'}: ${title} (#${pr.number})`),
    preheader: merged
      ? `${pr.merged_by?.login ? `@${pr.merged_by.login} merged` : 'Merged'} #${pr.number} by @${pr.user?.login ?? 'unknown'} into ${pr.base?.ref ?? 'dev'}.`
      : `@${pr.user?.login ?? 'unknown'} opened #${pr.number} in ${repoLabel}. Review it when you can.`,
  };
}

function row(label, valueHtml) {
  return `<tr>
              <td style="padding:10px 0;border-top:1px solid ${BRAND.border};font:600 13px/1.4 ${FONT};color:${BRAND.textSecondary};width:132px;vertical-align:top;">${escapeHtml(label)}</td>
              <td style="padding:10px 0;border-top:1px solid ${BRAND.border};font:400 14px/1.5 ${FONT};color:${BRAND.text};vertical-align:top;">${valueHtml}</td>
            </tr>`;
}

const link = (href, text, color = BRAND.redText) =>
  `<a href="${escapeHtml(safeUrl(href))}" style="color:${color};text-decoration:none;font-weight:600;">${escapeHtml(text)}</a>`;

function pill(text, color, background) {
  return `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${background};color:${color};font:700 11px/1.6 ${FONT};letter-spacing:1.2px;text-transform:uppercase;">${escapeHtml(text)}</span>`;
}

function button(href, text) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px;">
            <tr>
              <td align="center" bgcolor="${BRAND.red}" style="border-radius:10px;">
                <a href="${escapeHtml(safeUrl(href))}" style="display:inline-block;padding:14px 28px;font:700 15px/1 ${FONT};color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(text)} &rarr;</a>
              </td>
            </tr>
          </table>`;
}

export function renderHtml(model) {
  const m = model;
  const issueLinks = m.issues.length
    ? m.issues.map((issue) => link(`https://github.com/${issue.repo}/issues/${issue.number}`, `${issue.repo === m.repository ? '' : issue.repo}#${issue.number}`)).join(', ')
    : `<span style="color:${BRAND.textMuted};">None linked</span>`;
  const labels = m.labels.length
    ? m.labels.map((name) => `<span style="display:inline-block;margin:0 6px 4px 0;padding:2px 10px;border-radius:999px;background:${BRAND.tanSoft};border:1px solid ${BRAND.tan};font:600 12px/1.6 ${FONT};color:${BRAND.text};">${escapeHtml(name)}</span>`).join('')
    : null;
  const excerpt = m.excerpt
    ? m.excerpt
        .split('\n')
        .map((line) => (line.startsWith(HEADING) ? `<strong style="color:${BRAND.text};">${escapeHtml(line.slice(1))}</strong>` : escapeHtml(line)))
        .join('<br>')
    : `<span style="color:${BRAND.textMuted};">No description.</span>`;
  const nextSteps = m.merged
    ? `The change is on <strong>${escapeHtml(m.base)}</strong>. Pull it before you start your next branch, and thank <strong>@${escapeHtml(m.author)}</strong> for the contribution.`
    : `Before it merges: every check green, one issue per pull request, a test for each acceptance criterion, and the docs updated in the same pull request.`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(m.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.page};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(m.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.page};">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

          <!-- Header -->
          <tr>
            <td align="center" style="background:${BRAND.card};border-radius:16px 16px 0 0;padding:28px 32px 22px;border-bottom:4px solid ${BRAND.red};">
              <a href="https://github.com/${ORG}" style="text-decoration:none;">
                <img src="${BRAND.logo}" width="260" alt="Delivery Plus" style="display:block;width:260px;max-width:80%;height:auto;border:0;">
              </a>
            </td>
          </tr>

          <!-- Main -->
          <tr>
            <td style="background:${BRAND.card};padding:32px 32px 8px;">
              ${m.merged ? pill('Merged', BRAND.green, BRAND.greenSoft) : pill('New pull request', BRAND.redText, BRAND.redSoft)}
              <span style="font:600 13px/1.6 ${FONT};color:${BRAND.textSecondary};margin-left:8px;">${escapeHtml(m.repoLabel)} &middot; #${escapeHtml(m.number)}</span>
              <h1 style="margin:16px 0 8px;font:700 22px/1.35 ${FONT};color:${BRAND.text};">${escapeHtml(m.title)}</h1>
              <p style="margin:0 0 20px;font:400 15px/1.6 ${FONT};color:${BRAND.textSecondary};">
                ${m.merged
                  ? `${m.mergedBy ? `${link(`https://github.com/${m.mergedBy}`, `@${m.mergedBy}`)} merged` : 'Merged'} this pull request by ${link(m.authorUrl, `@${m.author}`)} into <strong style="color:${BRAND.text};">${escapeHtml(m.base)}</strong>.`
                  : `${link(m.authorUrl, `@${m.author}`)} opened a pull request into <strong style="color:${BRAND.text};">${escapeHtml(m.base)}</strong>. It's ready for review.`}
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                ${row('Author', `<img src="${escapeHtml(m.authorAvatar)}" width="22" height="22" alt="" style="vertical-align:middle;border-radius:50%;margin-right:8px;border:0;">${link(m.authorUrl, `@${m.author}`)}`)}
                ${row('Repository', link(`https://github.com/${m.repository}`, m.repository, BRAND.text))}
                ${row('Branch', `<code style="font:500 13px/1.5 SFMono-Regular,Consolas,monospace;background:${BRAND.page};padding:2px 6px;border-radius:6px;">${escapeHtml(m.head)}</code> &rarr; <code style="font:500 13px/1.5 SFMono-Regular,Consolas,monospace;background:${BRAND.page};padding:2px 6px;border-radius:6px;">${escapeHtml(m.base)}</code>`)}
                ${row('Changes', `<span style="color:${BRAND.green};font-weight:700;">+${escapeHtml(m.additions)}</span> &nbsp;<span style="color:${BRAND.redText};font-weight:700;">&minus;${escapeHtml(m.deletions)}</span> &nbsp;<span style="color:${BRAND.textSecondary};">in ${escapeHtml(plural(m.files, 'file', 'files'))}, ${escapeHtml(plural(m.commits, 'commit', 'commits'))}</span>`)}
                ${row('Issues', issueLinks)}
                ${m.milestone ? row('Milestone', escapeHtml(m.milestone)) : ''}
                ${labels ? row('Labels', labels) : ''}
              </table>

              <div style="margin:24px 0 0;padding:18px 20px;background:${BRAND.page};border-left:4px solid ${BRAND.tan};border-radius:8px;">
                <div style="font:700 12px/1.6 ${FONT};letter-spacing:1px;text-transform:uppercase;color:${BRAND.textSecondary};margin-bottom:6px;">From the description</div>
                <div style="font:400 14px/1.65 ${FONT};color:${BRAND.text};">${excerpt}</div>
              </div>

              ${button(m.url, m.merged ? 'See the merged changes' : 'Review the pull request')}

              <p style="margin:20px 0 28px;font:400 14px/1.6 ${FONT};color:${BRAND.textSecondary};">${nextSteps}</p>
            </td>
          </tr>

          <!-- About -->
          <tr>
            <td style="background:${BRAND.tanSoft};padding:24px 32px;border-top:1px solid ${BRAND.border};">
              <div style="font:700 13px/1.6 ${FONT};letter-spacing:1px;text-transform:uppercase;color:${BRAND.redText};">About Delivery Plus</div>
              <p style="margin:6px 0 0;font:400 14px/1.65 ${FONT};color:${BRAND.text};">
                An open-source, event-driven food-delivery platform: a NestJS microservices backend with Kafka, PostgreSQL and Redis, and customer, driver and restaurant apps in Arabic and English. Everyone who reviews, tests or builds it makes it better.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background:${BRAND.text};border-radius:0 0 16px 16px;padding:28px 32px;">
              <img src="${BRAND.icon}" width="40" height="40" alt="Delivery Plus" style="display:block;width:40px;height:40px;border:0;margin:0 auto 12px;">
              <div style="font:400 13px/2 ${FONT};">
                ${FOOTER_LINKS.map(([text, href]) => `<a href="${escapeHtml(href)}" style="color:#FFFFFF;text-decoration:none;font-weight:600;">${escapeHtml(text)}</a>`).join(`<span style="color:${BRAND.textMuted};"> &nbsp;&middot;&nbsp; </span>`)}
              </div>
              <p style="margin:14px 0 0;font:400 12px/1.6 ${FONT};color:${BRAND.textMuted};">
                You're receiving this because you're on the Delivery Plus contributors and maintainers list.<br>
                Delivery Plus &middot; MIT licensed &middot; <a href="https://github.com/${ORG}" style="color:${BRAND.textMuted};">github.com/${ORG}</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

export function renderText(model) {
  const m = model;
  const lines = [
    'DELIVERY PLUS',
    '',
    `${m.merged ? 'MERGED' : 'NEW PULL REQUEST'} · ${m.repoLabel} · #${m.number}`,
    m.title,
    '',
    m.merged
      ? `${m.mergedBy ? `@${m.mergedBy} merged` : 'Merged'} this pull request by @${m.author} into ${m.base}.`
      : `@${m.author} opened a pull request into ${m.base}. It's ready for review.`,
    '',
    `Author:     @${m.author}`,
    `Repository: ${m.repository}`,
    `Branch:     ${m.head} -> ${m.base}`,
    `Changes:    +${m.additions} -${m.deletions} in ${plural(m.files, 'file', 'files')}, ${plural(m.commits, 'commit', 'commits')}`,
    `Issues:     ${m.issues.length ? m.issues.map((issue) => `${issue.repo === m.repository ? '' : issue.repo}#${issue.number}`).join(', ') : 'none linked'}`,
    ...(m.milestone ? [`Milestone:  ${m.milestone}`] : []),
    ...(m.labels.length ? [`Labels:     ${m.labels.join(', ')}`] : []),
    '',
    'From the description:',
    m.excerpt ? m.excerpt.split(HEADING).join('') : 'No description.',
    '',
    `${m.merged ? 'See the merged changes' : 'Review the pull request'}: ${m.url}`,
    '',
    '--',
    'Delivery Plus: an open-source, event-driven food-delivery platform.',
    ...FOOTER_LINKS.map(([text, href]) => `${text}: ${href}`),
    "You're receiving this because you're on the Delivery Plus contributors and maintainers list.",
  ];
  return `${lines.join('\n')}\n`;
}

async function loadPullRequest(env) {
  if (env.PR_NUMBER) {
    const response = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/pulls/${Number(env.PR_NUMBER)}`, {
      headers: { Accept: 'application/vnd.github+json', ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
    });
    if (!response.ok) throw new Error(`Could not read pull request #${env.PR_NUMBER}: ${response.status}`);
    return { pr: await response.json(), action: 'dispatch' };
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  return { pr: event.pull_request, action: event.action };
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex > 0 ? process.argv[outIndex + 1] : '.';
  const output = (name, value) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    else console.log(`${name}=${value}`);
  };

  const { pr, action } = await loadPullRequest(process.env);
  const kind = emailKind(pr, action);
  if (!kind) {
    console.log('Nothing to send (draft, bot, or closed without merging).');
    output('skip', 'true');
    return;
  }
  const model = emailModel(pr, process.env.GITHUB_REPOSITORY, kind);
  mkdirSync(outDir, { recursive: true });
  const html = join(outDir, 'email.html');
  const text = join(outDir, 'email.txt');
  writeFileSync(html, renderHtml(model));
  writeFileSync(text, renderText(model));
  console.log(`Rendered: ${model.subject}`);
  output('skip', 'false');
  output('subject', model.subject);
  output('html', html);
  output('text', text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
